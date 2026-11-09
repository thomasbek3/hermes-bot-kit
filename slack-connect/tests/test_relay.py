import asyncio
import hashlib
import hmac
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.core import issue_state
path = Path(__file__).resolve().parents[2] / 'slack-relay' / 'relay.py'
spec = importlib.util.spec_from_file_location('relay_test', path)
relay_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay_module)

KEY = 'a' * 32
SECRET = 'test-secret'


def prepare(tmp_path):
    data = tmp_path / 'slack-connect'
    pending = data / 'pending'
    pending.mkdir(parents=True)
    (data / 'state.key').write_bytes(b'k' * 32)
    (data / 'apps.json').write_text(json.dumps({KEY: {'profile': 'test-profile', 'app_id': 'A1', 'team_id': 'T1', 'bot_name': 'Test Bot'}}))
    profile = tmp_path / 'profiles' / 'test-profile'
    profile.mkdir(parents=True)
    (profile / '.env').write_text('SLACK_SIGNING_SECRET=test-secret\nSLACK_CLIENT_ID=test-client\nSLACK_CLIENT_SECRET=test-client-secret\n')
    return data


def signed(body):
    ts = str(int(time.time()))
    sig = hmac.new(SECRET.encode(), b'v0:' + ts.encode() + b':' + body, hashlib.sha256).hexdigest()
    return {'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': 'v0=' + sig}


def test_routes_auth_and_body_cap(tmp_path):
    async def exercise():
        data = prepare(tmp_path)
        seen = []
        async def forward(request):
            seen.append((request.path, await request.read()))
            return web.Response(text='accepted')
        upstream_app = web.Application()
        upstream_app.router.add_post('/p/test-profile/slack/events', forward)
        upstream = TestServer(upstream_app)
        await upstream.start_server()
        relay = relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack', upstream=str(upstream.make_url('/')).rstrip('/'))
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        try:
            for path in ('/p/x/v1/models', '/v1', '/api/anything', '/slack/p/intake/v1/models'):
                assert (await client.get(path)).status == 404
            assert (await client.get('/healthz')).status == 200
            assert (await client.get('/slack/healthz')).status == 200
            assert (await client.post('/events/' + 'b' * 32, data=b'{}')).status == 404
            assert (await client.post('/events/' + KEY, data=b'{}')).status == 401
            assert (await client.post('/events/' + KEY, data=b'x' * (1024 * 1024 + 1))).status == 413
            body = b'{"type":"event_callback"}'
            result = await client.post('/events/' + KEY, data=body, headers=signed(body))
            assert result.status == 200 and seen == [('/p/test-profile/slack/events', body)]
            challenge = b'{"type":"url_verification","challenge":"abc"}'
            assert (await client.post('/events/' + KEY, data=challenge)).status == 401
            (data / 'pending' / (KEY + '.json')).write_text(json.dumps({'phase':'pending','at':int(time.time())}))
            result = await client.post('/events/' + KEY, data=challenge)
            assert result.status == 200 and (await result.json())['challenge'] == 'abc'
        finally:
            await client.close()
            await upstream.close()
    asyncio.run(exercise())


def test_access_log_records_challenge_without_body_or_query(tmp_path, caplog):
    async def exercise():
        data = prepare(tmp_path)
        (data / 'pending' / (KEY + '.json')).write_text(json.dumps({'phase':'pending','at':int(time.time())}))
        relay = relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack', upstream='http://127.0.0.1:9999')
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        try:
            challenge = b'{"type":"url_verification","challenge":"private-challenge"}'
            assert (await client.post('/events/' + KEY + '?code=private-code', data=challenge)).status == 200
            assert (await client.post('/events/' + 'b' * 32, data=challenge)).status == 404
            assert (await client.get('/private-path-with-secret')).status == 404
        finally:
            await client.close()
    caplog.set_level('INFO', logger='slack_relay')
    asyncio.run(exercise())
    assert f'method=POST path=/events/{KEY} status=200 url_verification=True' in caplog.text
    assert f'method=POST path=/events/{"b" * 32} status=404 url_verification=True' in caplog.text
    assert 'method=GET path=/[other] status=404 url_verification=False' in caplog.text
    assert all(value not in caplog.text for value in ('private-challenge', 'private-code', 'private-path-with-secret'))


def test_oauth_success_denial_and_single_use(tmp_path):
    async def exercise():
        data = prepare(tmp_path)
        calls, writes, notifications = [], [], []
        async def slack(method, values, token):
            calls.append((method, values, token))
            if method == 'oauth.v2.access':
                return {'ok': True, 'app_id':'A1', 'team':{'id':'T1','name':'Test Team'}, 'authed_user':{'id':'U1'}, 'access_token':'fake-bot', 'bot_user_id':'B1'}
            return {'ok': True}
        async def writer(profile, values):
            writes.append((profile, values))
        async def notify(profile):
            notifications.append(profile)
        relay = relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack', upstream='http://127.0.0.1:9999', slack=slack, writer=writer, notifier=notify)
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        try:
            state = issue_state(b'k' * 32, 'test-profile', KEY, 'T1')
            response = await client.get('/oauth/callback', params={'state':state, 'code':'fake-code'})
            assert response.status == 200
            assert writes[0][0] == 'test-profile' and writes[0][1]['SLACK_ALLOWED_USERS'] == 'U1'
            assert notifications == ['test-profile']
            assert calls[1][0] == 'chat.postMessage' and calls[1][1]['channel'] == 'U1'
            assert len(json.loads(calls[1][1]['blocks'])) == 2
            assert json.loads((data / 'pending' / (KEY + '.json')).read_text())['phase'] == 'installed'
            assert (await client.get('/oauth/callback', params={'state':state, 'code':'fake-code'})).status == 400
            denied = issue_state(b'k' * 32, 'test-profile', KEY, 'T1')
            assert (await client.get('/slack/oauth/callback', params={'state':denied, 'error':'access_denied'})).status == 200
            assert json.loads((data / 'pending' / (KEY + '.json')).read_text())['phase'] == 'denied'
            assert len(writes) == 1
        finally:
            await client.close()
    asyncio.run(exercise())


def test_profile_writer_passes_values_on_stdin_only(tmp_path, monkeypatch):
    async def exercise():
        captured = {}
        class FakeProc:
            returncode = 0
            async def communicate(self, data):
                captured['stdin'] = data
        async def spawn(*args, **kwargs):
            captured['args'], captured['kwargs'] = args, kwargs
            return FakeProc()
        monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
        relay = relay_module.Relay(tmp_path, '/python', '/helper', base_url='https://example.test/slack', upstream='http://127.0.0.1:9999')
        await relay.write_profile('test-profile', {'SLACK_BOT_TOKEN':'fake-sensitive-value'})
        assert b'fake-sensitive-value' in captured['stdin']
        assert all('fake-sensitive-value' not in str(arg) for arg in captured['args'])
        assert all('fake-sensitive-value' not in str(val) for val in captured['kwargs'].values())
    asyncio.run(exercise())


def test_oauth_team_mismatch_never_writes(tmp_path):
    async def exercise():
        prepare(tmp_path)
        async def slack(*_):
            return {'ok':True, 'app_id':'A1', 'team': {'id':'T2'}}
        async def writer(*_):
            pytest.fail('must not write')
        relay = relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack', upstream='http://127.0.0.1:9999', slack=slack, writer=writer)
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        try:
            state = issue_state(b'k' * 32, 'test-profile', KEY, 'T1')
            assert (await client.get('/oauth/callback', params={'state':state, 'code':'fake-code'})).status == 502
        finally:
            await client.close()
    asyncio.run(exercise())


def test_writer_real_process_does_not_expose_values_in_ps(tmp_path):
    async def exercise():
        helper = tmp_path / 'helper.py'
        output = tmp_path / 'argv.json'
        helper.write_text('import json, os, subprocess, sys\n'
                          'json.load(sys.stdin)\n'
                          f'out = {str(output)!r}\n'
                          'args = subprocess.check_output(["ps", "-p", str(os.getpid()), "-o", "command="], text=True)\n'
                          'open(out, "w").write(json.dumps({"args": sys.argv, "ps": args}))\n')
        relay = relay_module.Relay(tmp_path, sys.executable, helper, base_url='https://example.test/slack', upstream='http://127.0.0.1:9999')
        await relay.write_profile('test-profile', {'SLACK_BOT_TOKEN': 'fake-sensitive-value'})
        captured = json.loads(output.read_text())
        assert 'fake-sensitive-value' not in json.dumps(captured)
    asyncio.run(exercise())
