"""Slack manifest, request authentication and durable OAuth state."""
import base64
import fcntl
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

BOT_SCOPES = (
    'app_mentions:read', 'assistant:write', 'canvases:write', 'channels:history',
    'channels:read', 'chat:write', 'commands', 'files:read', 'files:write',
    'groups:history', 'groups:read', 'groups:write', 'groups:write.invites',
    'groups:write.topic', 'im:history', 'im:read', 'im:write', 'mpim:history',
    'mpim:read', 'reactions:read', 'usergroups:read', 'usergroups:write', 'users:read',
)
BOT_EVENTS = tuple(sorted(('app_mention', 'message.channels', 'message.groups',
    'message.im', 'message.mpim', 'reaction_added', 'reaction_removed',
    'app_context_changed', 'app_home_opened')))
ENV_KEYS = ('SLACK_CONNECTION_MODE', 'SLACK_APP_ID', 'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN',
    'SLACK_TEAM_ID', 'SLACK_TEAM_NAME', 'SLACK_ALLOWED_USERS')


def manifest(bot_name, public_base, app_key):
    """Build an Events API manifest; URLs may not carry query or fragment data."""
    parsed = urlsplit(public_base)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError('public base must be an HTTPS URL')
    if not isinstance(app_key, str) or len(app_key) != 32 or any(c not in '0123456789abcdef' for c in app_key):
        raise ValueError('invalid app key')
    base = public_base.rstrip('/')
    event_url = f'{base}/events/{app_key}'
    name = str(bot_name or '').strip() or 'Hermes'
    return {
        '_metadata': {'major_version': 1, 'minor_version': 1},
        'display_information': {'name': name[:35], 'description': f'{name}, your Hermes bot'[:140], 'background_color': '#1a1a2e'},
        'features': {'app_home': {'home_tab_enabled': False, 'messages_tab_enabled': True,
                                  'messages_tab_read_only_enabled': False},
                     'bot_user': {'display_name': name[:80], 'always_online': True},
                     'agent_view': {'agent_description': 'Chat with Hermes in Slack Messages.'}},
        'oauth_config': {'redirect_urls': [f'{base}/oauth/callback'], 'scopes': {'bot': list(BOT_SCOPES)}},
        'settings': {'event_subscriptions': {'request_url': event_url, 'bot_events': list(BOT_EVENTS)},
                     'interactivity': {'is_enabled': True, 'request_url': event_url},
                     'org_deploy_enabled': False, 'socket_mode_enabled': False, 'token_rotation_enabled': False},
    }


def verify_slack_signature(secret, timestamp, body, signature, *, now=None, tolerance=300):
    try:
        ts = int(timestamp)
        if abs((time.time() if now is None else now) - ts) > tolerance:
            return False
        if not isinstance(body, bytes) or not isinstance(signature, str):
            return False
        raw = b'v0:' + str(timestamp).encode('ascii') + b':' + body
        expected = 'v0=' + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)
    except (ValueError, TypeError, UnicodeError, AttributeError):
        return False


def _atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.slack-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class LockedFile:
    def __init__(self, path):
        self.path = Path(path)

    def __enter__(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *args):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


def _read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def _encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def issue_state(key, profile, app_key, team_id, *, now=None, ttl=600):
    if len(key) < 32 or not all(isinstance(x, str) and x for x in (profile, app_key, team_id)) or not 0 < ttl <= 600:
        raise ValueError('invalid state parameters')
    payload = {'profile': profile, 'app_key': app_key, 'team_id': team_id,
               'nonce': secrets.token_urlsafe(24), 'exp': int(time.time() if now is None else now) + ttl}
    data = _encode(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode())
    return data + '.' + _encode(hmac.new(key, data.encode(), hashlib.sha256).digest())


def consume_state(key, state, nonce_path, *, now=None):
    """Verify and atomically consume a nonce across processes and restarts."""
    now = int(time.time() if now is None else now)
    try:
        data, sig = state.split('.')
        expected = _encode(hmac.new(key, data.encode('ascii'), hashlib.sha256).digest())
        if len(key) < 32 or not hmac.compare_digest(expected, sig):
            raise ValueError('invalid state')
        payload = json.loads(base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)))
        if (not isinstance(payload, dict) or type(payload.get('exp')) is not int or
            payload['exp'] <= now or payload['exp'] > now + 600 or
            not all(isinstance(payload.get(k), str) and payload[k] for k in ('profile', 'app_key', 'team_id', 'nonce'))):
            raise ValueError('invalid state')
        path = Path(nonce_path)
        with LockedFile(str(path) + '.lock'):
            used = _read_json(path, {})
            used = {nonce: exp for nonce, exp in used.items() if type(exp) is int and exp > now}
            if payload['nonce'] in used:
                raise ValueError('state already used')
            used[payload['nonce']] = payload['exp']
            _atomic_json(path, used)
        return payload
    except (TypeError, KeyError, UnicodeError, json.JSONDecodeError, base64.binascii.Error) as exc:
        raise ValueError('invalid state') from exc
