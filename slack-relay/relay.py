"""Narrow public Slack ingress; backend and profile state remain private."""
import asyncio
import html
import json
import logging
import os
import re
import time
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
            owner = (result.get('authed_user') or {}).get('id')
            token = result.get('access_token')
            team_name = (result.get('team') or {}).get('name') or 'Slack'
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
            status = 500
            try:
                ip = request.remote or 'unknown'
                now = time.monotonic()
                # Bound the number of identities as well as the rate.
                if len(self.buckets) > 4096:
                    self.buckets = {k: v for k, v in self.buckets.items() if now - v[1] < 600}
                    if len(self.buckets) > 4096:
                        raise web.HTTPTooManyRequests()
                tokens, previous = self.buckets.get(ip, (60.0, now))
                tokens = min(60.0, tokens + (now - previous))
                self.buckets[ip] = (max(0, tokens - 1), now)
                if tokens < 1:
                    raise web.HTTPTooManyRequests()
                response = await handler(request)
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
