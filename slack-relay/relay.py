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
from common import access as access_module

LOG = logging.getLogger('slack_relay')
APP_KEY = re.compile(r'^[a-f0-9]{32}$')
PROFILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
LIMIT = 1024 * 1024
VERIFICATION_KEY = web.RequestKey('url_verification', bool)
# Set by a handler once the request proved itself (a valid Slack signature for
# a known app, or an OAuth callback with a valid state). Such a request is
# always processed and never charged to the rate limit.
AUTHENTICATED_KEY = web.RequestKey('authenticated', bool)
# How often the relay refreshes "full members" allowlists from Slack.
MEMBER_SYNC_SECONDS = 900
MEMBER_PAGES_MAX = 100
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


def welcome(bot, workspace, audience):
    """The installer's welcome DM. `audience` is the honest who-can-talk line."""
    lines = ('You can DM me here, or @mention me in a channel.',
             audience,
             "Whatever my tools can do, I do for anyone who can talk to me, with my own access. "
             "Change who can talk to me in my Slack window in Hermes.")
    text = f"👋 Hi, I'm {bot}, the bot you added to {workspace}.\n" + '\n'.join('• ' + line for line in lines)
    return {'text': text, 'blocks': [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f"👋 Hi, I'm {bot}, the bot you added to {workspace}."}},
        {'type': 'rich_text', 'elements': [{'type': 'rich_text_list', 'style': 'bullet', 'elements': [
            {'type': 'rich_text_section', 'elements': [{'type': 'text', 'text': line}]} for line in lines]}]}]}


class Relay:
    def __init__(self, root, hermes_python, helper, *, base_url, upstream, slack=None, writer=None, notifier=None,
                 scope_reader=None):
        self.root = Path(root)
        self.data = self.root / 'slack-connect'
        self.hermes_python, self.helper = str(hermes_python), str(helper)
        self.base_url, self.upstream = base_url.rstrip('/'), upstream.rstrip('/')
        self.slack, self.writer, self.notifier = slack, writer, notifier
        self.scope_reader = scope_reader
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
                try:
                    result = await response.json(content_type=None)
                except (ValueError, ClientError):
                    result = {}
                if response.status == 429:
                    raise access_module.SlackReadError('ratelimited', response.headers.get('Retry-After'))
                if response.status != 200 or not isinstance(result, dict) or not result.get('ok'):
                    raise access_module.SlackReadError((result or {}).get('error') if isinstance(result, dict) else None)
                return result

    async def workspace_members(self, token, team_id):
        """Full members of the workspace (not guests, not Slack Connect users,
        not bots) from users.list. All pages or nothing: any failed page
        raises SlackReadError and no partial list is ever returned."""
        users, cursor = [], ''
        for _ in range(MEMBER_PAGES_MAX):
            values = {'limit': '200'}
            if cursor:
                values['cursor'] = cursor
            result = await self.slack_call('users.list', values, token)
            if not isinstance(result, dict) or not result.get('ok'):
                raise access_module.SlackReadError((result or {}).get('error') if isinstance(result, dict) else None)
            users.extend(result.get('members') or [])
            cursor = ((result.get('response_metadata') or {}).get('next_cursor') or '').strip()
            if not cursor:
                break
        else:
            raise access_module.SlackReadError('workspace_too_large')
        return access_module.full_members(users, team_id)

    def profile_home(self, profile):
        return self.root / 'profiles' / profile

    async def gate_scope(self, profile):
        """The profile's gate keys as Hermes reads them, from the helper run
        with Hermes's own Python. If that fails, the profile .env alone
        (marked incomplete)."""
        if self.scope_reader:
            return await self.scope_reader(profile)
        home = self.profile_home(profile)
        try:
            env = dict(os.environ, HERMES_HOME=str(home))
            proc = await asyncio.create_subprocess_exec(self.hermes_python, '-I', self.helper, '--gate-scope', str(home),
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, env=env)
            out, _ = await asyncio.wait_for(proc.communicate(), 30)
            scope = json.loads(out) if proc.returncode == 0 else None
            keys = scope.get('keys') if isinstance(scope, dict) else None
            if isinstance(keys, dict) and set(keys) <= set(access_module.GATE_KEYS) and all(
                    isinstance(v, dict) and isinstance(v.get('value'), str) and isinstance(v.get('source'), str) for v in keys.values()):
                return {'keys': keys, 'complete': scope.get('complete') is True}
        except (OSError, ValueError, asyncio.TimeoutError):
            pass
        LOG.warning('Hermes gate settings could not be read; counting only the bot .env')
        return access_module.scope_from_env(access_module.read_env_file(home / '.env'), f'{home}/.env', complete=False)

    async def effective(self, key):
        """The one effective-access result for app `key` (current record)."""
        record = self.record(key) or {}
        profile = record['profile']
        env = self.profile_env(profile)
        return access_module.effective_access(await self.gate_scope(profile),
            access_module.pairing_approved(self.profile_home(profile)), record,
            team_name=env.get('SLACK_TEAM_NAME') or 'the workspace')

    async def publish(self, key, expect, ids, fields, env_extra=None):
        """publish_allowlist with the lock held across the profile write: the
        locked section runs in a thread and hands the write back to the loop."""
        loop = asyncio.get_running_loop()
        def write(values):
            asyncio.run_coroutine_threadsafe(self.write_profile(expect['profile'], values), loop).result(120)
        return await asyncio.to_thread(access_module.publish_allowlist, self.data, key, expect, ids, write,
                                       fields=fields, env_extra=env_extra)

    async def sync_app(self, key, now=None):
        """Refresh one "full members" bot's SLACK_ALLOWED_USERS. True when a
        result (success or failure) was recorded."""
        record = self.record(key)
        if record is None or access_module.mode_of(record.get('access')) != 'members':
            return False   # owner and list need no sync; legacy is never rewritten
        if _read_json(self.data / 'pending' / (key + '.json'), {}).get('phase') != 'installed':
            return False
        now = int(time.time() if now is None else now)
        wait = record.get('retry_after')
        if type(wait) is int and now < wait:
            return False   # Slack asked us to wait
        expect = access_module.expect_of(record)
        try:
            env = self.profile_env(record['profile'])
        except ValueError:
            return False
        token = env.get('SLACK_BOT_TOKEN') or ''
        if not token or env.get('SLACK_APP_ID') != record.get('app_id'):
            return False
        owner = access_module.owner_of(record)
        try:
            members = await self.workspace_members(token, record.get('team_id'))
            ids, fields = access_module.sync_success(owner, members, now)
        except Exception as exc:
            exc = exc if isinstance(exc, access_module.SlackReadError) else access_module.SlackReadError()
            LOG.warning('Slack member list could not be read for one bot: %s', exc.error)
            ids, fields = access_module.sync_failure(record, owner, exc, now)
        return await self.publish(key, expect, ids, fields)

    async def sync_members_once(self):
        """Refresh every "full members" bot. A failed read keeps the current
        list unless it is older than a day (then the verified installer, or
        nobody); a sync never overwrites an audience changed meanwhile."""
        done = 0
        for key in list(_read_json(self.data / 'apps.json', {})):
            try:
                done += bool(await self.sync_app(key))
            except Exception:
                LOG.warning('Slack member sync failed for one bot')
        return done

    async def member_sync_loop(self):
        while True:
            await asyncio.sleep(MEMBER_SYNC_SECONDS)
            try:
                await self.sync_members_once()
            except Exception:
                LOG.error('Slack member sync failed')

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
            # The chosen audience (default: the workspace's verified full
            # members) goes into SLACK_ALLOWED_USERS together with the token,
            # through the one locked write path. A first member read that
            # fails publishes NOBODY (nobody is verified yet) and says why.
            mode = access_module.mode_of(record.get('access'))
            if mode == access_module.LEGACY:
                mode = 'owner'   # an in-flight connect from an earlier release
            fields = {'owner': owner, 'access': mode, 'access_rev': max(1, access_module.rev_of(record))}
            if mode == 'members':
                try:
                    ids, synced = access_module.sync_success(owner, await self.workspace_members(token, state['team_id']), time.time())
                except Exception as exc:
                    exc = exc if isinstance(exc, access_module.SlackReadError) else access_module.SlackReadError()
                    LOG.warning('Slack member list could not be read at Connect: %s', exc.error)
                    ids, failed = access_module.sync_failure({}, owner, exc, time.time())
                    ids, synced = ids or [], {'synced_at': None, 'last_members_owner_ok': False, 'retry_after': None, **failed}
                fields.update(synced)
            else:
                named = access_module.parse_ids(record.get('allowed') or '') if mode == 'list' else ()
                ids = access_module.allowlist(mode, owner, named=named)
            creds = {'SLACK_BOT_TOKEN': token, 'SLACK_TEAM_ID': state['team_id'], 'SLACK_TEAM_NAME': team_name}
            if not await self.publish(key, access_module.expect_of(record), ids, fields, env_extra=creds):
                raise ValueError('the app record changed')
            await self.notify(profile)
            audience = await self.effective(key)
            lines = [audience['text']] + ([audience['sync']['text']] if audience['sync']['text'] else [])
            payload = welcome(record.get('bot_name') or 'Hermes', team_name, ' '.join(lines))
            payload['channel'] = owner
            await self.slack_call('chat.postMessage', {'channel': owner, 'text': payload['text'], 'blocks': json.dumps(payload['blocks'])}, token)
            self.pending(key, 'installed', team_name=team_name, bot_user_id=result.get('bot_user_id') or '')
            grants = ''.join(f"<li>{html.escape(g['what'])} ({html.escape(g['source'])}): {html.escape(g['how_to_change'])}</li>"
                             for g in audience['grants'])
            grants_html = f"<p>Other settings let people in:</p><ul>{grants}</ul>" if grants else ''
            sync_html = f"<p>{html.escape(audience['sync']['text'])}</p>" if audience['sync']['text'] else ''
            return web.Response(text=f"<p>{html.escape(record.get('bot_name') or 'Hermes')} is in {html.escape(team_name)}.</p><p>{html.escape(audience['text'])}</p>{sync_html}{grants_html}<p>You can close this tab and go back to Hermes.</p>", content_type='text/html')
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

        async def start_sync(application):
            application['member_sync'] = asyncio.ensure_future(self.member_sync_loop())

        async def stop_sync(application):
            task = application.get('member_sync')
            if task:
                task.cancel()
        app.on_startup.append(start_sync)
        app.on_cleanup.append(stop_sync)
        async def health(_request):
            return web.Response(text='ok')
        for prefix in ('', '/slack'):
            app.router.add_post(prefix + '/events/{app_key}', self.events)
            app.router.add_get(prefix + '/oauth/callback', self.callback)
            app.router.add_get(prefix + '/healthz', health)
        return app
