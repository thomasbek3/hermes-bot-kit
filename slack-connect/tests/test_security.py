"""Security fixes: the relay's rate limit never blocks authentic Slack traffic,
Slack-supplied text is safe before the .env write, and the HTTP adapter binds
loopback only unless the operator opts in."""
import asyncio
import hashlib
import hmac
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.core import issue_state

ROOT = Path(__file__).resolve().parents[2]


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


relay_module = load('relay_security_test', 'slack-relay/relay.py')
http_adapter = load('http_adapter_security_test', 'slack-http/http_adapter.py')

KEY = 'a' * 32
SECRET = 'test-secret'


def prepare(tmp_path):
    data = tmp_path / 'slack-connect'
    (data / 'pending').mkdir(parents=True)
    (data / 'state.key').write_bytes(b'k' * 32)
    (data / 'apps.json').write_text(json.dumps({KEY: {'profile': 'test-profile', 'app_id': 'A1', 'team_id': 'T1', 'bot_name': 'Test Bot'}}))
    profile = tmp_path / 'profiles' / 'test-profile'
    profile.mkdir(parents=True)
    (profile / '.env').write_text('SLACK_SIGNING_SECRET=test-secret\nSLACK_CLIENT_ID=test-client\nSLACK_CLIENT_SECRET=test-client-secret\n')
    return data


def signed(body, **extra):
    ts = str(int(time.time()))
    sig = hmac.new(SECRET.encode(), b'v0:' + ts.encode() + b':' + body, hashlib.sha256).hexdigest()
    return {'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': 'v0=' + sig, **extra}


# ── client identity ─────────────────────────────────────────────────────────

def test_identity_uses_rightmost_forwarded_ip_only_behind_loopback():
    ident = relay_module.client_identity
    assert ident('127.0.0.1', ['198.51.100.1, 203.0.113.9']) == '203.0.113.9'
    assert ident('::1', ['198.51.100.1', '2001:db8::5']) == '2001:db8::5', 'the last header, right-most entry'
    assert ident('127.0.0.1', ['203.0.113.9, not-an-ip']) == '127.0.0.1', 'a junk right-most entry falls back to the peer'
    assert ident('127.0.0.1', []) == '127.0.0.1'
    assert ident('192.0.2.7', ['203.0.113.9']) == '192.0.2.7', 'a non-loopback peer is never overridden by a header'
    assert ident(None, ['203.0.113.9']) == 'unknown'


# ── the rate limit ──────────────────────────────────────────────────────────

def test_exhausted_bucket_never_blocks_signed_events_or_valid_callbacks(tmp_path):
    async def exercise():
        prepare(tmp_path)
        seen = []
        async def forward(request):
            seen.append(await request.read())
            return web.Response(text='accepted')
        upstream_app = web.Application()
        upstream_app.router.add_post('/p/test-profile/slack/events', forward)
        upstream = TestServer(upstream_app)
        await upstream.start_server()
        async def slack(method, values, token):
            if method == 'oauth.v2.access':
                return {'ok': True, 'app_id': 'A1', 'team': {'id': 'T1', 'name': 'Test Team'}, 'authed_user': {'id': 'U1'}, 'access_token': 'fake-bot'}
            return {'ok': True}
        async def writer(*_):
            return None
        async def notify(*_):
            return True
        relay = relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack',
                                   upstream=str(upstream.make_url('/')).rstrip('/'), slack=slack, writer=writer, notifier=notify)
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        attacker = {'X-Forwarded-For': '198.51.100.1'}
        try:
            # One client drains its bucket with requests that never authenticate.
            statuses = [(await client.get('/slack/healthz', headers=attacker)).status for _ in range(61)]
            assert statuses[:60] == [200] * 60 and statuses[60] == 429
            assert (await client.get('/nowhere', headers=attacker)).status == 429
            assert (await client.post('/events/' + KEY, data=b'{}', headers=attacker)).status == 429, 'a bad signature while limited'
            assert (await client.post('/events/' + 'b' * 32, data=b'{}', headers=attacker)).status == 429, 'an unknown key while limited'
            assert (await client.get('/oauth/callback', params={'state': 'junk'}, headers=attacker)).status == 429
            # The same exhausted client's authentic requests still go through.
            body = b'{"type":"event_callback"}'
            result = await client.post('/events/' + KEY, data=body, headers=signed(body, **attacker))
            assert result.status == 200 and seen == [body], 'a signed delivery is always processed'
            state = issue_state(b'k' * 32, 'test-profile', KEY, 'T1')
            assert (await client.get('/oauth/callback', params={'state': state, 'code': 'fake-code'}, headers=attacker)).status == 200
            # Other clients behind the same loopback proxy have their own bucket.
            assert (await client.get('/slack/healthz', headers={'X-Forwarded-For': '203.0.113.9'})).status == 200
            assert (await client.post('/events/' + KEY, data=b'{}', headers={'X-Forwarded-For': '203.0.113.9'})).status == 401
            # Authenticated requests are not charged: the signed one left no debt.
            assert relay.buckets['198.51.100.1'][0] < 1
        finally:
            await client.close()
            await upstream.close()
    asyncio.run(exercise())


def test_unauthenticated_outcomes_are_charged_authenticated_are_not(tmp_path):
    async def exercise():
        prepare(tmp_path)
        async def forward(_request):
            return web.Response(text='accepted')
        upstream_app = web.Application()
        upstream_app.router.add_post('/p/test-profile/slack/events', forward)
        upstream = TestServer(upstream_app)
        await upstream.start_server()
        relay = relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack', upstream=str(upstream.make_url('/')).rstrip('/'))
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        who = {'X-Forwarded-For': '192.0.2.50'}
        try:
            body = b'{"type":"event_callback"}'
            for _ in range(70):
                assert (await client.post('/events/' + KEY, data=body, headers=signed(body, **who))).status == 200
            assert '192.0.2.50' not in relay.buckets, 'signed deliveries never touch the bucket'
            assert (await client.post('/events/' + KEY, data=b'not json', headers=who)).status == 401
            assert (await client.post('/events/' + KEY, data=b'x' * (1024 * 1024 + 1), headers=who)).status == 413, 'the 1 MiB cap stays'
            assert relay.buckets['192.0.2.50'][0] == pytest.approx(58, abs=0.1)
        finally:
            await client.close()
            await upstream.close()
    asyncio.run(exercise())


def test_identity_table_stays_bounded_and_never_refuses_a_new_client(tmp_path):
    prepare(tmp_path)
    relay = relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack', upstream='http://127.0.0.1:9')
    now = 1000.0
    for i in range(relay_module.MAX_IDENTITIES):
        relay.buckets[f'id-{i}'] = (0.0, now)  # all drained, none stale
    tokens = relay._tokens('newcomer', now)
    assert tokens == relay_module.BUCKET_SIZE, 'a new client starts with a full bucket'
    assert len(relay.buckets) <= relay_module.MAX_IDENTITIES
    relay._charge('newcomer', now, tokens)
    assert len(relay.buckets) <= relay_module.MAX_IDENTITIES
    # Identities whose bucket is full again are dropped first.
    relay.buckets = {f'id-{i}': (0.0, now - 100) for i in range(relay_module.MAX_IDENTITIES)}
    relay._tokens('another', now)
    assert relay.buckets == {}


# ── Slack-supplied text before the .env write ───────────────────────────────

def test_team_name_and_owner_are_safe_before_the_env_write():
    clean = relay_module.safe_team_name
    assert clean('Acme Corp') == 'Acme Corp'
    assert clean('Acme\r\nSLACK_ALLOWED_USERS=U666') == 'Acme SLACK_ALLOWED_USERS=U666', 'no line break survives'
    assert '\x00' not in clean('a\x00b') and '\x1b' not in clean('a\x1b[2Jb')
    assert clean('quote" back\\slash `tick` $HOME') == 'quote backslash tick HOME'
    assert clean('rtl‮override line') == 'rtl override line'
    assert len(clean('x' * 500)) == relay_module.TEAM_NAME_MAX
    assert clean('\r\n\x00') == '' and clean(None) == ''
    assert relay_module.safe_owner('U012AB3CD') == 'U012AB3CD'
    for bad in ('U1\nU2', 'U1,U2', 'U1\x00', '', 'U' * 33, None, 7):
        assert relay_module.safe_owner(bad) is None, repr(bad)


def test_callback_writes_a_cleaned_team_name_and_refuses_an_odd_owner(tmp_path):
    async def exercise(owner, team, root):
        prepare(root)
        writes = []
        async def slack(method, values, token):
            if method == 'oauth.v2.access':
                return {'ok': True, 'app_id': 'A1', 'team': {'id': 'T1', 'name': team}, 'authed_user': {'id': owner}, 'access_token': 'fake-bot'}
            return {'ok': True}
        async def writer(profile, values):
            writes.append(values)
        async def notify(*_):
            return True
        relay = relay_module.Relay(root, 'python', 'helper', base_url='https://example.test/slack', upstream='http://127.0.0.1:9',
                                   slack=slack, writer=writer, notifier=notify)
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        try:
            state = issue_state(b'k' * 32, 'test-profile', KEY, 'T1')
            status = (await client.get('/oauth/callback', params={'state': state, 'code': 'fake-code'})).status
        finally:
            await client.close()
        return status, writes
    status, writes = asyncio.run(exercise('U1', 'Team\r\nSLACK_ALLOWED_USERS=U666', tmp_path / 'one'))
    assert status == 200 and writes[0]['SLACK_TEAM_NAME'] == 'Team SLACK_ALLOWED_USERS=U666'
    assert all('\n' not in v and '\r' not in v for v in writes[0].values())
    status, writes = asyncio.run(exercise('U1\nU666', 'Team', tmp_path / 'two'))
    assert status == 502 and writes == [], 'an owner id with a line break is refused, never written'


def test_profile_helper_refuses_control_characters(tmp_path):
    # A stand-in for Hermes's save_env_value records what would be written.
    fake = tmp_path / 'hermes' / 'hermes_cli'
    fake.mkdir(parents=True)
    (fake / '__init__.py').write_text('')
    out = tmp_path / 'written.json'
    (fake / 'config.py').write_text(
        'import json\n'
        f'OUT = {str(out)!r}\n'
        'def save_env_value(key, value):\n'
        '    data = json.load(open(OUT)) if __import__("os").path.exists(OUT) else {}\n'
        '    data[key] = value\n'
        '    json.dump(data, open(OUT, "w"))\n')
    helper = ROOT / 'slack-relay' / 'profile_helper.py'
    env = {'HERMES_AGENT_DIR': str(tmp_path / 'hermes'), 'PATH': '/usr/bin:/bin'}
    run = lambda values: subprocess.run([sys.executable, '-I', str(helper)], input=json.dumps(values).encode(), env=env, capture_output=True)
    for bad in ('Team\nSLACK_ALLOWED_USERS=U666', 'a\rb', 'a\x00b', 'a\x1bb', 'a b', 'x' * 513):
        assert run({'SLACK_TEAM_NAME': bad}).returncode == 2, repr(bad[:20])
    assert not out.exists(), 'nothing written for a refused value'
    assert run({'SLACK_TEAM_NAME': 'Acme Corp', 'SLACK_ALLOWED_USERS': 'U1'}).returncode == 0
    assert json.loads(out.read_text()) == {'SLACK_TEAM_NAME': 'Acme Corp', 'SLACK_ALLOWED_USERS': 'U1'}


# ── slack-http listener host ────────────────────────────────────────────────

def test_http_adapter_binds_loopback_unless_opted_in():
    allowed = http_adapter.listen_host_allowed
    for host in ('127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost', 'LOCALHOST'):
        assert allowed(host, None), host
    for host in ('0.0.0.0', '::', '192.0.2.10', '100.64.0.1', 'example.com', ''):
        assert not allowed(host, None), host
        assert not allowed(host, '0'), host
        assert not allowed(host, 'yes'), host
        assert allowed(host, '1'), host


def test_http_adapter_connect_refuses_nonloopback_with_a_clear_error(monkeypatch, caplog):
    class Base:
        def __init__(self):
            self.config = type('C', (), {'token': 'xoxb-fake'})()
            self.fatal = None
        async def connect(self, *, is_reconnect=False):
            raise AssertionError('Socket Mode path must not run')
        def _set_fatal_error(self, code, message, retryable=False):
            self.fatal = (code, message, retryable)
        def _fatal_missing_env(self, name):
            raise AssertionError(name)
    module = sys.modules[Base.__module__]
    secrets = {'SLACK_CONNECTION_MODE': 'http', 'SLACK_SIGNING_SECRET': 'fake', 'SLACK_HTTP_HOST': '0.0.0.0'}
    monkeypatch.setattr(module, '_get_scoped_secret', lambda name, default=None: secrets.get(name, default), raising=False)
    for name in http_adapter._MODULE_REQUIRED:
        if not hasattr(module, name):
            monkeypatch.setattr(module, name, object(), raising=False)
    cls = http_adapter.make_http_capable(Base)
    for name in http_adapter._REQUIRED:
        if not hasattr(cls, name):
            setattr(cls, name, None)
    adapter = cls()
    caplog.set_level('ERROR')
    assert asyncio.run(adapter.connect()) is False
    assert adapter.fatal[0] == 'slack_http_nonloopback' and adapter.fatal[2] is False
    assert 'SLACK_HTTP_ALLOW_NONLOOPBACK=1' in caplog.text and "'0.0.0.0'" in caplog.text
