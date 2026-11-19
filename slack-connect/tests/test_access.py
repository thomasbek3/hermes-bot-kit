"""Who can talk to a Slack-connected bot: default full members, explicit
restrictions, member sync, and an honest effective audience."""
import asyncio
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import access
from common.core import issue_state

path = Path(__file__).resolve().parents[2] / 'slack-relay' / 'relay.py'
spec = importlib.util.spec_from_file_location('relay_access_test', path)
relay_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay_module)

KEY = 'b' * 32
USERS = [
    {'id': 'U1', 'team_id': 'T1'},                                   # the installer
    {'id': 'U2', 'team_id': 'T1'},                                   # full member
    {'id': 'U3', 'team_id': 'T1', 'is_restricted': True},            # multi-channel guest
    {'id': 'U4', 'team_id': 'T1', 'is_ultra_restricted': True},      # single-channel guest
    {'id': 'U5', 'team_id': 'T9'},                                   # Slack Connect (other org)
    {'id': 'U6', 'team_id': 'T1', 'is_bot': True},
    {'id': 'U7', 'team_id': 'T1', 'deleted': True},
    {'id': 'USLACKBOT', 'team_id': 'T1'},
    {'id': 'U8', 'team_id': 'T1', 'is_stranger': True},
    {'id': 'W9', 'team_id': 'T1'},                                   # enterprise-style id, full member
]


def test_full_members_excludes_guests_external_bots_and_deleted():
    assert access.full_members(USERS, 'T1') == ['U1', 'U2', 'W9']


def test_chosen_ids_always_include_the_installer():
    assert access.chosen_ids('members', 'U1', ['U2']) == ['U1', 'U2']
    assert access.chosen_ids('owner', 'U1', ['U2']) == ['U1']
    assert access.chosen_ids('list', 'U1', named=['U9']) == ['U1', 'U9']
    with pytest.raises(ValueError):
        access.parse_ids('U1, not-an-id')


def test_effective_names_every_extra_grant(tmp_path):
    pairing = tmp_path / 'platforms' / 'pairing'
    pairing.mkdir(parents=True)
    (pairing / 'slack-approved.json').write_text(json.dumps({'U7': {}, 'U1': {}}))
    eff = access.effective({'SLACK_ALLOWED_USERS': 'U1,U2', 'GATEWAY_ALLOWED_USERS': 'U8'},
                           access.pairing_approved(tmp_path))
    assert not eff['open'] and eff['ids'] == ['U1', 'U2', 'U7', 'U8']
    extras = access.extra_grants(['U1', 'U2'], eff, 'p')
    assert [x['grant'] for x in extras] == ['GATEWAY_ALLOWED_USERS', 'pairing approvals']
    assert extras[0]['ids'] == ['U8'] and extras[1]['ids'] == ['U7']
    text = access.describe('members', ['U1', 'U2'], eff, 'Acme')
    assert 'plus 2 more allowed by other settings' in text and '4 people in all' in text
    opened = access.effective({'SLACK_ALLOWED_USERS': 'U1', 'SLACK_ALLOW_ALL_USERS': 'true'})
    assert opened['open'] and 'including guests' in access.describe('owner', ['U1'], opened)
    assert access.extra_grants(['U1'], opened)[0]['fixable']
    star = access.effective({'SLACK_ALLOWED_USERS': '*'})
    assert star['open']
    gw_all = access.effective({}, gateway_env={'GATEWAY_ALLOW_ALL_USERS': 'true'})
    assert gw_all['open']
    # With an allowlist set, GATEWAY_ALLOW_ALL_USERS is not consulted by Hermes.
    assert not access.effective({'SLACK_ALLOWED_USERS': 'U1'}, gateway_env={'GATEWAY_ALLOW_ALL_USERS': 'true'})['open']


def prepare(tmp_path, record=None, env=''):
    data = tmp_path / 'slack-connect'
    (data / 'pending').mkdir(parents=True)
    (data / 'state.key').write_bytes(b'k' * 32)
    item = {'profile': 'bot', 'app_id': 'A1', 'team_id': 'T1', 'bot_name': 'Helper'}
    item.update(record or {})
    (data / 'apps.json').write_text(json.dumps({KEY: item}))
    home = tmp_path / 'profiles' / 'bot'
    home.mkdir(parents=True)
    (home / '.env').write_text('SLACK_SIGNING_SECRET=s\nSLACK_CLIENT_ID=c\nSLACK_CLIENT_SECRET=x\nSLACK_APP_ID=A1\n' + env)
    return data, home


def run_callback(tmp_path, users_ok=True, record=None, env=''):
    data, home = prepare(tmp_path, record, env)
    writes, calls = [], []

    async def slack(method, values, token):
        calls.append((method, values))
        if method == 'oauth.v2.access':
            return {'ok': True, 'app_id': 'A1', 'team': {'id': 'T1', 'name': 'Acme'}, 'authed_user': {'id': 'U1'},
                    'access_token': 'fake-bot', 'bot_user_id': 'B1'}
        if method == 'users.list':
            if not users_ok:
                raise RuntimeError('Slack request failed')
            return {'ok': True, 'members': USERS}
        return {'ok': True}

    async def writer(profile, values):
        writes.append(values)
        lines = (home / '.env').read_text().splitlines()
        kept = [l for l in lines if l.split('=')[0] not in values]
        (home / '.env').write_text('\n'.join(kept + [f'{k}={v}' for k, v in values.items()]) + '\n')

    async def notify(_):
        return True

    async def exercise():
        relay = relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack',
                                   upstream='http://127.0.0.1:9999', slack=slack, writer=writer, notifier=notify)
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        try:
            response = await client.get('/oauth/callback', params={'state': issue_state(b'k' * 32, 'bot', KEY, 'T1'), 'code': 'c'})
            return response.status, await response.text(), relay
        finally:
            await client.close()
    status, page, relay = asyncio.run(exercise())
    pending = json.loads((data / 'pending' / (KEY + '.json')).read_text())
    welcome = next(v for m, v in calls if m == 'chat.postMessage')
    return status, page, writes, pending, welcome, relay


def test_default_connect_lets_full_members_talk_and_says_so(tmp_path):
    status, page, writes, pending, welcome, _ = run_callback(tmp_path)
    assert status == 200
    assert writes[0]['SLACK_ALLOWED_USERS'] == 'U1,U2,W9'
    assert pending['chosen'] == ['U1', 'U2', 'W9'] and pending['owner'] == 'U1'
    assert 'Full members of Acme (3 people; not guests or Slack Connect users)' in page
    assert 'Who can talk to me: Full members of Acme' in welcome['text']
    assert 'I only answer you' not in welcome['text']
    assert 'anyone who can talk to me' in welcome['text']


def test_owner_and_list_modes_restrict(tmp_path):
    _, page, writes, *_ = run_callback(tmp_path / 'o', record={'access': 'owner'})
    assert writes[0]['SLACK_ALLOWED_USERS'] == 'U1' and 'Only you.' in page
    _, page, writes, *_ = run_callback(tmp_path / 'l', record={'access': 'list', 'allowed': 'U2,U8'})
    assert writes[0]['SLACK_ALLOWED_USERS'] == 'U1,U2,U8' and 'The 3 people you named' in page


def test_member_list_failure_is_reported_not_hidden(tmp_path):
    _, page, writes, pending, welcome, _ = run_callback(tmp_path, users_ok=False)
    assert writes[0]['SLACK_ALLOWED_USERS'] == 'U1'
    assert "Only you for now: Slack&#x27;s member list could not be read yet" in page or "Only you for now" in page
    assert pending['audience']['synced'] is False


def test_extra_grants_are_named_on_connect(tmp_path):
    _, page, _, pending, welcome, _ = run_callback(tmp_path, env='SLACK_ALLOW_ALL_USERS=true\n')
    assert 'including guests' in page and 'SLACK_ALLOW_ALL_USERS' in page
    assert pending['audience']['open'] is True
    assert 'including guests' in welcome['text']


def test_member_sync_updates_and_never_widens_on_failure(tmp_path):
    _, _, writes, pending, _, relay = run_callback(tmp_path)
    home = tmp_path / 'profiles' / 'bot'
    USERS.append({'id': 'U10', 'team_id': 'T1'})
    try:
        assert asyncio.run(relay.sync_members_once()) == 1
        assert 'SLACK_ALLOWED_USERS=U1,U10,U2,W9' in (home / '.env').read_text()
        assert asyncio.run(relay.sync_members_once()) == 0   # unchanged: no write
    finally:
        USERS.pop()

    async def failing(method, values, token):
        raise RuntimeError('Slack request failed')
    relay.slack = failing
    assert asyncio.run(relay.sync_members_once()) == 0
    assert 'SLACK_ALLOWED_USERS=U1,U10,U2,W9' in (home / '.env').read_text()   # kept, not emptied


def test_profile_helper_accepts_member_lists_and_refuses_junk(tmp_path):
    helper = Path(__file__).resolve().parents[2] / 'slack-relay' / 'profile_helper.py'
    fake = tmp_path / 'hermes'
    (fake / 'hermes_cli').mkdir(parents=True)
    (fake / 'hermes_cli' / '__init__.py').write_text('')
    (fake / 'hermes_cli' / 'config.py').write_text('def save_env_value(k, v):\n    pass\n')

    def run(values):
        return subprocess.run([sys.executable, '-I', str(helper)], input=json.dumps(values).encode(),
                              env={'HERMES_AGENT_DIR': str(fake)}, capture_output=True)
    many = ','.join(f'U{i:010d}' for i in range(2000))
    assert run({'SLACK_ALLOWED_USERS': many}).returncode == 0
    for bad in ('U1,,U2', 'U1;rm', 'u1', 'U1\nX=1', '*'):
        assert run({'SLACK_ALLOWED_USERS': bad}).returncode != 0, bad
