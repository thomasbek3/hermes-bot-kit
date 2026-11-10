"""Narrow public Slack ingress; backend and profile state remain private."""
import asyncio
import html
import ipaddress
import json
import logging
import os
import re
import time
import unicodedata
from pathlib import Path
from urllib.parse import quote

from aiohttp import ClientError, ClientSession, ClientTimeout, web
from dotenv import dotenv_values
from common.core import _atomic_json, _read_json, consume_state, verify_slack_signature

LOG = logging.getLogger('slack_relay')
APP_KEY = re.compile(r'^[a-f0-9]{32}$')
PROFILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
LIMIT = 1024 * 1024
VERIFICATION_KEY = web.RequestKey('url_verification', bool)
# Set by a handler once the request proved itself (a valid Slack signature for
# a known app, or an OAuth callback with a valid state). Such a request is
# always processed and never charged to the rate limit.
AUTHENTICATED_KEY = web.RequestKey('authenticated', bool)
BUCKET_SIZE = 60.0
MAX_IDENTITIES = 4096
TEAM_NAME_MAX = 100
OWNER_RE = re.compile(r'^[A-Za-z0-9]{1,32}$')
# Characters that could end, quote or interpolate a .env value.
ENV_UNSAFE = set('"\'\\`$')


def safe_team_name(value):
    """Slack's team name, reduced to printable text that is safe in a .env
    value: no control, format or line-separator characters (CR, LF, NUL,
    escapes, bidi controls), no quote, backslash, backtick or dollar sign,
    whitespace collapsed, at most TEAM_NAME_MAX characters."""
    if not isinstance(value, str):
        return ''
    kept = []
    for ch in value:
        cat = unicodedata.category(ch)
        if cat[0] == 'C' or cat in ('Zl', 'Zp'):
            kept.append(' ')
        elif ch not in ENV_UNSAFE:
            kept.append(ch)
    return ' '.join(''.join(kept).split())[:TEAM_NAME_MAX].strip()


def safe_owner(value):
    """The installing user's Slack id, or None: it becomes the only allowed
    user, so it is never altered, only accepted as a plain id or refused."""
    return value if isinstance(value, str) and OWNER_RE.fullmatch(value) else None


def client_identity(peer, forwarded):
    """The rate-limit identity. Behind the required loopback proxy the TCP
    peer is the proxy itself, so for a loopback peer the right-most
    X-Forwarded-For address (the one the proxy appended) is used when it is
    a syntactically valid IP; otherwise the peer."""
    peer = peer or 'unknown'
    try:
        loopback = ipaddress.ip_address(peer.split('%', 1)[0]).is_loopback
    except ValueError:
        loopback = False
    if loopback and forwarded:
        last = forwarded[-1].split(',')[-1].strip()
        try:
            return str(ipaddress.ip_address(last))
        except ValueError:
            pass
    return peer


def welcome(bot, workspace):
    text = (f"👋 Hi, I'm {bot}, the bot you added to {workspace}.\n"
            '• You can DM me here, or @mention me in a channel.\n'
            '• I only answer you.\n'
            "• I have my own credentials, and if a task needs one of your accounts, I'll ask you to connect it.")
    return {'text': text, 'blocks': [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f"👋 Hi, I'm {bot}, the bot you added to {workspace}."}},
        {'type': 'rich_text', 'elements': [{'type': 'rich_text_list', 'style': 'bullet', 'elements': [
            {'type': 'rich_text_section', 'elements': [{'type': 'text', 'text': line}]} for line in (
                'You can DM me here, or @mention me in a channel.', 'I only answer you.',
                "I have my own credentials, and if a task needs one of your accounts, I'll ask you to connect it.")]}]}]}


class Relay:
    def __init__(self, root, hermes_python, helper, *, base_url, upstream, slack=None, writer=None, notifier=None):
        self.root = Path(root)
        self.data = self.root / 'slack-connect'
        self.hermes_python, self.helper = str(hermes_python), str(helper)
        self.base_url, self.upstream = base_url.rstrip('/'), upstream.rstrip('/')
        self.slack, self.writer, self.notifier = slack, writer, notifier
        self.buckets = {}

    def _tokens(self, ident, now):
        """The identity's tokens now (refilled at 1 per second, at most
        BUCKET_SIZE), without charging. The table stays bounded: identities
        whose bucket is full again are dropped (they equal a new one), and if
        that is not enough the least recently seen are evicted. A full table
        never refuses anyone."""
        if ident not in self.buckets and len(self.buckets) >= MAX_IDENTITIES:
            self.buckets = {k: v for k, v in self.buckets.items() if v[0] + (now - v[1]) < BUCKET_SIZE}
            if len(self.buckets) >= MAX_IDENTITIES:
                keep = sorted(self.buckets.items(), key=lambda item: item[1][1])[-(MAX_IDENTITIES // 2):]
                self.buckets = dict(keep)
        tokens, previous = self.buckets.get(ident, (BUCKET_SIZE, now))
        return min(BUCKET_SIZE, tokens + (now - previous))

    def _charge(self, ident, now, tokens):
        self.buckets[ident] = (max(0.0, tokens - 1), now)

    def profile_env(self, profile):
        if not PROFILE.fullmatch(profile) or profile == 'default':
            raise ValueError('invalid profile')
        return dotenv_values(self.root / 'profiles' / profile / '.env')

    def record(self, app_key):
        if not APP_KEY.fullmatch(app_key):
            return None
        item = _read_json(self.data / 'apps.json', {}).get(app_key)
        if not isinstance(item, dict) or not PROFILE.fullmatch(str(item.get('profile', ''))) or item.get('profile') == 'default':
            return None
        return item

    def pending(self, key, phase, **values):
        if not APP_KEY.fullmatch(key):
            raise ValueError('invalid key')
        _atomic_json(self.data / 'pending' / (key + '.json'), {'phase': phase, 'at': int(time.time()), **values})

    async def write_profile(self, profile, values):
        if self.writer:
            return await self.writer(profile, values)
        env = dict(os.environ, HERMES_HOME=str(self.root / 'profiles' / profile))
        proc = await asyncio.create_subprocess_exec(self.hermes_python, '-I', self.helper,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, env=env)
        await proc.communicate(json.dumps(values).encode())
        if proc.returncode:
            raise RuntimeError('profile update failed')

    async def notify(self, profile):
        if self.notifier:
            return await self.notifier(profile)
        proc = await asyncio.create_subprocess_exec(self.hermes_python, '-I', self.helper, '--notify', profile,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await proc.wait()
        return proc.returncode == 0

    async def slack_call(self, method, data, token=None):
        if self.slack:
            return await self.slack(method, data, token)
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        async with ClientSession(timeout=ClientTimeout(total=10)) as session:
            async with session.post('https://slack.com/api/' + method, data=data, headers=headers) as response:
                result = await response.json(content_type=None)
                if response.status != 200 or not result.get('ok'):
                    raise RuntimeError('Slack request failed')
                return result

    async def events(self, request):
        key = request.match_info['app_key']
        body = await request.read()
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError):
            payload = {}
        request[VERIFICATION_KEY] = isinstance(payload, dict) and payload.get('type') == 'url_verification'
        record = self.record(key)
        if record is None:
            raise web.HTTPNotFound()
        pending = _read_json(self.data / 'pending' / (key + '.json'), {})
        if (isinstance(payload, dict) and payload.get('type') == 'url_verification' and
            isinstance(payload.get('challenge'), str) and pending.get('phase') == 'pending' and
            type(pending.get('at')) is int and 0 <= time.time() - pending['at'] <= 600):
            return web.json_response({'challenge': payload['challenge']})
        env = self.profile_env(record['profile'])
        signing_secret = env.get('SLACK_SIGNING_SECRET') or ''
        if not signing_secret or not verify_slack_signature(signing_secret, request.headers.get('X-Slack-Request-Timestamp'), body, request.headers.get('X-Slack-Signature')):
            raise web.HTTPUnauthorized()
        request[AUTHENTICATED_KEY] = True
        if isinstance(payload, dict) and payload.get('type') == 'url_verification' and isinstance(payload.get('challenge'), str):
            return web.json_response({'challenge': payload['challenge']})
        headers = {key: val for key, val in request.headers.items() if key.lower().startswith('x-slack-') or key.lower() == 'content-type'}
        url = self.upstream + '/p/' + quote(record['profile'], safe='') + '/slack/events'
        try:
            async with ClientSession(timeout=ClientTimeout(total=2.5)) as session:
                async with session.post(url, data=body, headers=headers) as response:
                    status = 503 if response.status == 404 else response.status
                    return web.Response(status=status, body=await response.read(), headers={'Content-Type': response.headers.get('Content-Type', 'text/plain')})
        except (ClientError, OSError, asyncio.TimeoutError):
            raise web.HTTPServiceUnavailable()

    async def callback(self, request):
        try:
            state = consume_state((self.data / 'state.key').read_bytes(), request.query.get('state', ''), self.data / 'used-nonces.json')
            record = self.record(state['app_key'])
            if not record or record['profile'] != state['profile'] or record.get('team_id') != state['team_id']:
                raise ValueError('invalid state')
        except (ValueError, OSError, TypeError, KeyError):
            raise web.HTTPBadRequest(text='This authorization has expired or is invalid.')
        request[AUTHENTICATED_KEY] = True
        key, profile = state['app_key'], state['profile']
        if request.query.get('error'):
            self.pending(key, 'denied')
            return web.Response(text='Slack installation was cancelled. You can close this tab.', content_type='text/html')
        code = request.query.get('code')
        if not code:
            raise web.HTTPBadRequest(text='Missing authorization code.')
        try:
            env = self.profile_env(profile)
            result = await self.slack_call('oauth.v2.access', {'client_id': env['SLACK_CLIENT_ID'], 'client_secret': env['SLACK_CLIENT_SECRET'], 'code': code, 'redirect_uri': self.base_url + '/oauth/callback'})
            if not result.get('ok') or result.get('app_id') != record.get('app_id') or (result.get('team') or {}).get('id') != state['team_id']:
                raise ValueError('authorization mismatch')
            # Slack-supplied text goes into the profile's .env: refuse an odd
            # owner id, reduce the team name to safe printable text.
            owner = safe_owner((result.get('authed_user') or {}).get('id'))
            token = result.get('access_token')
            team_name = safe_team_name((result.get('team') or {}).get('name')) or 'Slack'
            if not all(isinstance(x, str) and x for x in (owner, token, team_name)):
                raise ValueError('incomplete authorization')
            existing = [x.strip() for x in (env.get('SLACK_ALLOWED_USERS') or '').split(',') if x.strip()]
            # The welcome message promises that only the installer is allowed.
            if any(x != owner for x in existing):
                raise ValueError('profile already permits other Slack users')
            await self.write_profile(profile, {'SLACK_BOT_TOKEN': token, 'SLACK_TEAM_ID': state['team_id'], 'SLACK_TEAM_NAME': team_name, 'SLACK_ALLOWED_USERS': owner})
            await self.notify(profile)
            payload = welcome(record.get('bot_name') or 'Hermes', team_name)
            payload['channel'] = owner
            await self.slack_call('chat.postMessage', {'channel': owner, 'text': payload['text'], 'blocks': json.dumps(payload['blocks'])}, token)
            self.pending(key, 'installed', team_name=team_name, bot_user_id=result.get('bot_user_id') or '')
            return web.Response(text=f"<p>{html.escape(record.get('bot_name') or 'Hermes')} is in {html.escape(team_name)}. You can close this tab and go back to Hermes.</p>", content_type='text/html')
        except Exception:
            self.pending(key, 'error')
            LOG.error('Slack authorization could not be completed')
            return web.Response(status=502, text='Slack authorization could not be completed. Return to Hermes to try again.')

    def application(self):
        @web.middleware
        async def guard(request, handler):
            # The pre-auth rate limit is charged only for outcomes that did not
            # authenticate (unknown key or path, bad signature or state,
            # malformed or oversized body, health checks). A request that
            # authenticates is always processed, whatever its bucket says, so
            # unauthenticated traffic can never lock Slack or an installer out.
            status = 500
            try:
                ident = client_identity(request.remote, request.headers.getall('X-Forwarded-For', []))
                now = time.monotonic()
                tokens = self._tokens(ident, now)
                limited = tokens < 1
                unrouted = request.match_info.http_exception is not None
                if unrouted or request.path in ('/healthz', '/slack/healthz'):
                    # These can never authenticate: charge and answer cheaply.
                    self._charge(ident, now, tokens)
                    if limited:
                        raise web.HTTPTooManyRequests()
                    response = await handler(request)
                    status = response.status
                    return response
                try:
                    response = await handler(request)
                except web.HTTPException:
                    if not request.get(AUTHENTICATED_KEY, False):
                        self._charge(ident, now, tokens)
                        if limited:
                            raise web.HTTPTooManyRequests()
                    raise
                if not request.get(AUTHENTICATED_KEY, False):
                    self._charge(ident, now, tokens)
                    if limited:
                        raise web.HTTPTooManyRequests()
                status = response.status
                return response
            except web.HTTPException as exc:
                status = exc.status
                raise
            except Exception:
                LOG.error('Slack ingress request failed')
                return web.Response(status=500)
            finally:
                # Never log query strings or untrusted paths, which may contain credentials.
                path = request.path
                if re.fullmatch(r'/(?:slack/)?events/[a-f0-9]{32}', path):
                    safe_path = path
                elif path in ('/healthz', '/slack/healthz', '/oauth/callback', '/slack/oauth/callback'):
                    safe_path = path
                else:
                    safe_path = '/[other]'
                LOG.info('request method=%s path=%s status=%d url_verification=%s',
                         request.method, safe_path, status, bool(request.get(VERIFICATION_KEY, False)))
        app = web.Application(client_max_size=LIMIT, middlewares=[guard])
        async def health(_request):
            return web.Response(text='ok')
        for prefix in ('', '/slack'):
            app.router.add_post(prefix + '/events/{app_key}', self.events)
            app.router.add_get(prefix + '/oauth/callback', self.callback)
            app.router.add_get(prefix + '/healthz', health)
        return app
