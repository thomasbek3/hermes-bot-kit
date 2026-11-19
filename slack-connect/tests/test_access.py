"""Who can talk to a Slack-connected bot: verified full members by default,
explicit restrictions, one locked write path, member sync with expiry and
Retry-After, legacy records, and one effective-access result."""
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(BASE / 'dashboard'))
from common import access
from common.core import issue_state
from service import Service

path = BASE.parent / 'slack-relay' / 'relay.py'
spec = importlib.util.spec_from_file_location('relay_access_test', path)
relay_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay_module)
HELPER = BASE.parent / 'slack-relay' / 'profile_helper.py'

KEY = 'b' * 32
NOW = 1_800_000_000
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


# ---- pure rules -----------------------------------------------------------

def test_full_members_excludes_guests_external_bots_and_deleted():
    assert access.full_members(USERS, 'T1') == ['U1', 'U2', 'W9']


def test_members_mode_is_verified_members_only_and_never_empty():
    assert access.allowlist('members', 'U1', ['U2']) == ['U2'], 'the installer is not added in members mode'
    assert access.allowlist('owner', 'U1', ['U2']) == ['U1']
    assert access.allowlist('list', 'U1', named=['U9']) == ['U1', 'U9']
    assert access.env_value([]) == access.NOBODY and access.env_value(['U2', 'U1']) == 'U2,U1'
    with pytest.raises(ValueError):
        access.parse_ids('U1, not-an-id')


def test_a_record_without_access_is_legacy():
    assert access.mode_of(None) == 'legacy' and access.mode_of('') == 'legacy'
    assert access.mode_of('members') == 'members' and access.mode_of('everyone') == 'legacy'


def scope(**values):
    return access.scope_from_env(values, '/h/.env')


def test_effective_access_counts_every_grant_with_its_source():
    rec = {'profile': 'p', 'access': 'members', 'owner': 'U1'}
    eff = access.effective_access(scope(SLACK_ALLOWED_USERS='U1,U2', GATEWAY_ALLOWED_USERS='U2,U8'), {'U7', 'U1'}, rec,
                                  NOW, 'Acme')
    assert not eff['open'] and eff['people'] == 4 and eff['ids'] == ['U1', 'U2', 'U7', 'U8']
    assert eff['text'] == ('4 people can talk to this bot: the 2 full members of Acme, '
                           'plus 1 from GATEWAY_ALLOWED_USERS (/h/.env), plus 1 from Slack pairing approvals.')
    gw, pair = eff['grants']
    assert (gw['what'], gw['source'], gw['ids']) == ('GATEWAY_ALLOWED_USERS', '/h/.env', ['U8'])
    assert 'every messaging platform' in gw['how_to_change']
    assert pair['ids'] == ['U7'] and pair['how_to_change'].startswith('hermes -p p pairing revoke slack ')
    # Only you: exactly one person, and it is the installer.
    assert access.effective_access(scope(SLACK_ALLOWED_USERS='U1'), (), {**rec, 'access': 'owner'}, NOW)['text'] == \
        'Only you can talk to this bot.'
    one = access.effective_access(scope(SLACK_ALLOWED_USERS='U2'), (), rec, NOW, 'Acme')
    assert one['text'] == '1 person can talk to this bot: the 1 full member of Acme.'


def test_effective_access_open_grants_nobody_and_fall_through():
    rec = {'profile': 'p', 'access': 'owner', 'owner': 'U1'}
    opened = access.effective_access(scope(SLACK_ALLOWED_USERS='U1', SLACK_ALLOW_ALL_USERS='true'), (), rec, NOW)
    assert opened['open'] and opened['text'] == ('Anyone in Slack who can message this bot, including guests '
                                                 '(SLACK_ALLOW_ALL_USERS=true in /h/.env).')
    assert opened['grants'][0]['how_to_change'] == 'remove SLACK_ALLOW_ALL_USERS from /h/.env'
    assert access.effective_access(scope(SLACK_ALLOWED_USERS='*'), (), rec, NOW)['open']
    assert access.effective_access(scope(GATEWAY_ALLOWED_USERS='*'), (), rec, NOW)['open']
    # No allowlist at all: Hermes falls through to GATEWAY_ALLOW_ALL_USERS.
    assert access.effective_access(scope(GATEWAY_ALLOW_ALL_USERS='true'), (), rec, NOW)['open']
    # NOBODY is an allowlist that matches no one: no fall-through, zero people.
    nobody = access.effective_access(scope(SLACK_ALLOWED_USERS='NOBODY', GATEWAY_ALLOW_ALL_USERS='true'), (), rec, NOW)
    assert not nobody['open'] and nobody['people'] == 0 and nobody['text'] == 'Nobody can talk to this bot in Slack.'
    # A value from the administrator-managed env overrides the bot's .env and says where to change it.
    managed = {'keys': {'SLACK_ALLOWED_USERS': {'value': 'U1,U5', 'source': 'administrator-managed env'}}, 'complete': True}
    eff = access.effective_access(managed, (), rec, NOW)
    assert eff['people'] == 2 and 'administrator-managed env' in eff['text']
    assert eff['grants'][0]['how_to_change'].endswith('change it there')
    assert 'only the bot' in access.effective_access(access.scope_from_env({}, '/h/.env', complete=False), (), rec, NOW)['text']


def test_sync_line_is_separate_and_names_staleness():
    rec = {'access': 'members', 'synced_at': NOW - 10, 'sync_error': None}
    assert access.sync_view(rec, NOW)['text'].startswith('Member list read ')
    stale = access.sync_view({**rec, 'synced_at': NOW - access.STALE_SECONDS - 1, 'sync_error': 'x'}, NOW)
    assert stale['stale'] and stale['text'].startswith('Member list stale since ')
    assert access.sync_view({'access': 'members', 'synced_at': None}, NOW)['text'].startswith('Member list never read')
    assert access.sync_view({'access': 'owner'}, NOW)['text'] == ''


# ---- gate scope: the profile's settings as Hermes reads them --------------

def test_gate_scope_without_hermes_reads_only_the_profile_env(tmp_path):
    home = tmp_path / 'profiles' / 'bot'
    home.mkdir(parents=True)
    (home / '.env').write_text('SLACK_ALLOWED_USERS=U1\nSLACK_BOT_TOKEN=xoxb-FAKE\nexport GATEWAY_ALLOWED_USERS="U2"\n')
    (tmp_path / '.env').write_text('GATEWAY_ALLOWED_USERS=U99\nGATEWAY_ALLOW_ALL_USERS=true\n')   # root: never counted
    got = access.gate_scope(home)
    assert got['complete'] is False
    assert got['keys'] == {'SLACK_ALLOWED_USERS': {'value': 'U1', 'source': f'{home}/.env'},
                           'GATEWAY_ALLOWED_USERS': {'value': 'U2', 'source': f'{home}/.env'}}


def test_helper_gate_scope_attributes_sources_and_prints_only_gate_keys(tmp_path):
    fake = tmp_path / 'hermes'
    (fake / 'agent').mkdir(parents=True)
    (fake / 'hermes_cli').mkdir()
    for pkg in ('agent', 'hermes_cli'):
        (fake / pkg / '__init__.py').write_text('')
    (fake / 'agent' / 'secret_scope.py').write_text(
        'def load_env_file(p):\n'
        '    return {"SLACK_ALLOWED_USERS": "U1", "SLACK_BOT_TOKEN": "xoxb-FAKE-SECRET", "GATEWAY_ALLOWED_USERS": "U2",\n'
        '            "SLACK_ALLOW_BOTS": "mentions"}\n'
        'def build_profile_secret_scope(h):\n'
        '    return {"SLACK_ALLOWED_USERS": "U1", "SLACK_BOT_TOKEN": "xoxb-FAKE-SECRET", "GATEWAY_ALLOWED_USERS": "U3",\n'
        '            "SLACK_ALLOW_ALL_USERS": "false", "SLACK_ALLOW_BOTS": "mentions", "OTHER": "x"}\n')
    (fake / 'hermes_cli' / 'env_loader.py').write_text(
        'def hydrate_profile_secret_sources(h):\n    return {}\n'
        'def get_secret_source_values(h):\n    return {"GATEWAY_ALLOWED_USERS": "U3"}\n')
    (fake / 'hermes_cli' / 'managed_scope.py').write_text(
        'def load_managed_env():\n    return {"SLACK_ALLOW_ALL_USERS": "false"}\n')
    home = tmp_path / 'profiles' / 'bot'
    home.mkdir(parents=True)
    (home / 'config.yaml').write_text('platforms:\n  slack:\n    extra:\n      group_allowed_chats: [C1, C2]\n')
    out = subprocess.run([sys.executable, '-I', str(HELPER), '--gate-scope', str(home)],
                         env={'HERMES_AGENT_DIR': str(fake), 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert 'xoxb-FAKE-SECRET' not in out.stdout and 'OTHER' not in out.stdout
    assert json.loads(out.stdout) == {'complete': True, 'keys': {
        'SLACK_ALLOWED_USERS': {'value': 'U1', 'source': f'{home}/.env'},
        'GATEWAY_ALLOWED_USERS': {'value': 'U3', 'source': 'external secret source'},
        'SLACK_ALLOW_ALL_USERS': {'value': 'false', 'source': 'administrator-managed env'},
        'SLACK_ALLOW_BOTS': {'value': 'mentions', 'source': f'{home}/.env'}},
        'authz': access.SLACK_AUTHZ,
        'extra': {'group_allowed_chats': {'value': '["C1", "C2"]', 'source': f'{home}/config.yaml'}}}


# ---- the relay: Connect and member sync -----------------------------------

def prepare(tmp_path, record=None, env='', pending=None):
    data = tmp_path / 'slack-connect'
    (data / 'pending').mkdir(parents=True)
    (data / 'state.key').write_bytes(b'k' * 32)
    item = {'profile': 'bot', 'app_id': 'A1', 'team_id': 'T1', 'bot_name': 'Helper', 'access': 'members', 'access_rev': 1}
    item.update(record or {})
    item = {k: v for k, v in item.items() if v is not None}
    (data / 'apps.json').write_text(json.dumps({KEY: item}))
    if pending:
        (data / 'pending' / (KEY + '.json')).write_text(json.dumps(pending))
    home = tmp_path / 'profiles' / 'bot'
    home.mkdir(parents=True)
    (home / '.env').write_text('SLACK_SIGNING_SECRET=s\nSLACK_CLIENT_ID=c\nSLACK_CLIENT_SECRET=x\nSLACK_APP_ID=A1\n' + env)
    return data, home


def env_of(home):
    return access.read_env_file(home / '.env')


def record_of(data):
    return json.loads((data / 'apps.json').read_text())[KEY]


def file_writer(home, writes=None):
    def write(values):
        if writes is not None:
            writes.append(dict(values))
        lines = (home / '.env').read_text().splitlines()
        kept = [l for l in lines if l.split('=')[0] not in values]
        (home / '.env').write_text('\n'.join(kept + [f'{k}={v}' for k, v in values.items()]) + '\n')
    return write


class FakeSlack:
    """users.list answers from `pages` (a list of member lists, or exceptions)."""

    def __init__(self, pages=None):
        self.pages = [USERS] if pages is None else pages
        self.calls = []

    async def __call__(self, method, values, token):
        self.calls.append((method, values))
        if method == 'oauth.v2.access':
            return {'ok': True, 'app_id': 'A1', 'team': {'id': 'T1', 'name': 'Acme'}, 'authed_user': {'id': 'U1'},
                    'access_token': 'xoxb-FAKE-bot', 'bot_user_id': 'B1'}
        if method == 'users.list':
            page = int(values.get('cursor') or 0)
            answer = self.pages[page]
            if isinstance(answer, Exception):
                raise answer
            if isinstance(answer, dict):
                return answer
            more = {'next_cursor': str(page + 1)} if page + 1 < len(self.pages) else {}
            return {'ok': True, 'members': answer, 'response_metadata': more}
        return {'ok': True}


def make_relay(tmp_path, home, slack, writes=None):
    write = file_writer(home, writes)

    async def writer(_profile, values):
        write(values)

    async def notify(_):
        return True

    async def scope_reader(_profile):
        return access.scope_from_env(env_of(home), f'{home}/.env')
    return relay_module.Relay(tmp_path, 'python', 'helper', base_url='https://example.test/slack',
                              upstream='http://127.0.0.1:9999', slack=slack, writer=writer, notifier=notify,
                              scope_reader=scope_reader)


def run_callback(tmp_path, slack=None, record=None, env=''):
    data, home = prepare(tmp_path, record, env)
    slack = slack or FakeSlack()
    writes = []

    async def exercise():
        relay = make_relay(tmp_path, home, slack, writes)
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        try:
            response = await client.get('/oauth/callback', params={'state': issue_state(b'k' * 32, 'bot', KEY, 'T1'), 'code': 'c'})
            return response.status, await response.text()
        finally:
            await client.close()
    status, page = asyncio.run(exercise())
    welcome = next(v for m, v in slack.calls if m == 'chat.postMessage')
    return status, page, writes, data, home, welcome


def test_default_connect_publishes_verified_members_and_says_so(tmp_path):
    status, page, writes, data, home, welcome = run_callback(tmp_path)
    assert status == 200
    assert writes == [{'SLACK_BOT_TOKEN': 'xoxb-FAKE-bot', 'SLACK_TEAM_ID': 'T1', 'SLACK_TEAM_NAME': 'Acme',
                       'SLACK_ALLOWED_USERS': 'U1,U2,W9'}], 'one write: token and allowlist together'
    rec = record_of(data)
    assert rec['owner'] == 'U1' and rec['access'] == 'members' and rec['access_rev'] == 1
    assert type(rec['synced_at']) is int and rec['sync_error'] is None and rec['last_members_owner_ok'] is True
    pending = json.loads((data / 'pending' / (KEY + '.json')).read_text())
    assert pending['phase'] == 'installed' and 'chosen' not in pending and 'audience' not in pending
    assert '3 people can talk to this bot: the 3 full members of Acme.' in page
    assert '3 people can talk to this bot: the 3 full members of Acme.' in welcome['text']
    assert 'anyone who can talk to me' in welcome['text']


def test_owner_and_list_modes_restrict(tmp_path):
    _, page, writes, *_ = run_callback(tmp_path / 'o', record={'access': 'owner'})
    assert writes[0]['SLACK_ALLOWED_USERS'] == 'U1' and 'Only you can talk to this bot.' in page
    _, page, writes, *_ = run_callback(tmp_path / 'l', record={'access': 'list', 'allowed': 'U2,U8'})
    assert writes[0]['SLACK_ALLOWED_USERS'] == 'U1,U2,U8' and '3 people can talk to this bot: the 3 people you named.' in page


def test_first_read_failure_at_connect_publishes_nobody_and_says_why(tmp_path):
    slack = FakeSlack([{'ok': False, 'error': 'missing_scope', 'needed': 'users:read'}])
    status, page, writes, data, home, welcome = run_callback(tmp_path, slack)
    assert status == 200 and writes[0]['SLACK_ALLOWED_USERS'] == 'NOBODY', 'not even the installer: nobody is verified'
    rec = record_of(data)
    assert rec['synced_at'] is None and rec['sync_error'] == access.MISSING_USERS_READ
    assert 'Nobody can talk to this bot in Slack.' in page
    assert 'Member list never read: the app lacks the users:read permission.' in page
    assert 'users:read' in welcome['text']


def test_extra_grants_are_named_on_connect_with_their_source(tmp_path):
    _, page, _, _, home, welcome = run_callback(tmp_path, env='SLACK_ALLOW_ALL_USERS=true\n')
    assert 'including guests' in page and f'SLACK_ALLOW_ALL_USERS=true ({home}/.env)' in page
    assert f'remove SLACK_ALLOW_ALL_USERS from {home}/.env' in page
    assert 'including guests' in welcome['text']


def installed(tmp_path, record=None, allowed='U1,U2,W9'):
    rec = {'owner': 'U1', 'synced_at': NOW - 600, 'last_members_owner_ok': True, 'installed_at': NOW - 3600}
    rec.update(record or {})
    return prepare(tmp_path, rec, f'SLACK_BOT_TOKEN=xoxb-FAKE\nSLACK_TEAM_NAME=Acme\nSLACK_ALLOWED_USERS={allowed}\n',
                   pending={'phase': 'installed', 'at': 1, 'team_name': 'Acme'})


def test_a_removed_member_and_an_installer_turned_guest_are_dropped(tmp_path):
    data, home = installed(tmp_path)
    users = [{'id': 'U1', 'team_id': 'T1', 'is_restricted': True}, {'id': 'U2', 'team_id': 'T1'}, {'id': 'U10', 'team_id': 'T1'}]
    relay = make_relay(tmp_path, home, FakeSlack([users]))
    assert asyncio.run(relay.sync_app(KEY, now=NOW)) is True
    assert env_of(home)['SLACK_ALLOWED_USERS'] == 'U10,U2', 'W9 left, U1 became a guest: both gone'
    rec = record_of(data)
    assert rec['synced_at'] == NOW and rec['sync_error'] is None and rec['last_members_owner_ok'] is False


def test_a_failed_page_publishes_nothing_and_keeps_the_list(tmp_path):
    data, home = installed(tmp_path)
    writes = []
    slack = FakeSlack([[{'id': 'U2', 'team_id': 'T1'}], access.SlackReadError('request_failed')])
    relay = make_relay(tmp_path, home, slack, writes)
    asyncio.run(relay.sync_app(KEY, now=NOW))
    assert [m for m, _ in slack.calls] == ['users.list', 'users.list']
    assert writes == [] and env_of(home)['SLACK_ALLOWED_USERS'] == 'U1,U2,W9'
    rec = record_of(data)
    assert rec['synced_at'] == NOW - 600 and rec['sync_error'] == "Slack's member list could not be read (request_failed)"


def test_retry_after_is_respected(tmp_path):
    data, home = installed(tmp_path)
    slack = FakeSlack([access.SlackReadError('ratelimited', '120')])
    relay = make_relay(tmp_path, home, slack)
    asyncio.run(relay.sync_app(KEY, now=NOW))
    assert record_of(data)['retry_after'] == NOW + 120
    assert 'Slack asked to wait' in access.sync_view(record_of(data), NOW)['text']
    assert asyncio.run(relay.sync_app(KEY, now=NOW + 60)) is False and len(slack.calls) == 1, 'skipped while waiting'
    slack.pages = [USERS]
    assert asyncio.run(relay.sync_app(KEY, now=NOW + 121)) is True and len(slack.calls) == 2
    assert record_of(data)['retry_after'] is None


def test_missing_users_read_is_named(tmp_path):
    data, home = installed(tmp_path)
    relay = make_relay(tmp_path, home, FakeSlack([{'ok': False, 'error': 'missing_scope', 'needed': 'users:read'}]))
    asyncio.run(relay.sync_app(KEY, now=NOW))
    assert record_of(data)['sync_error'] == 'the app lacks the users:read permission'
    assert env_of(home)['SLACK_ALLOWED_USERS'] == 'U1,U2,W9', 'fresh list kept'


@pytest.mark.parametrize('owner_ok, expected', [(True, 'U1'), (False, 'NOBODY')])
def test_a_list_older_than_a_day_is_not_kept_when_slack_fails(tmp_path, owner_ok, expected):
    data, home = installed(tmp_path, {'synced_at': NOW - access.STALE_SECONDS - 1, 'last_members_owner_ok': owner_ok})
    relay = make_relay(tmp_path, home, FakeSlack([access.SlackReadError('request_failed')]))
    asyncio.run(relay.sync_app(KEY, now=NOW))
    assert env_of(home)['SLACK_ALLOWED_USERS'] == expected
    view = access.sync_view(record_of(data), NOW)
    assert view['stale'] and view['text'].startswith('Member list stale since ')


def test_sync_writes_only_the_app_whose_profile_has_that_app_id(tmp_path):
    data, home = installed(tmp_path)
    (home / '.env').write_text((home / '.env').read_text().replace('SLACK_APP_ID=A1', 'SLACK_APP_ID=A2'))
    slack = FakeSlack()
    relay = make_relay(tmp_path, home, slack)
    assert asyncio.run(relay.sync_app(KEY, now=NOW)) is False and slack.calls == []
    assert env_of(home)['SLACK_ALLOWED_USERS'] == 'U1,U2,W9'
    assert access.publish_allowlist(data, KEY, access.expect_of(record_of(data)), ['U2'], pytest.fail) is False


def test_a_legacy_record_is_never_synced_or_rewritten(tmp_path):
    data, home = installed(tmp_path, {'access': None, 'access_rev': None, 'owner': None}, allowed='U1')
    slack = FakeSlack()
    relay = make_relay(tmp_path, home, slack)
    assert asyncio.run(relay.sync_members_once()) == 0 and slack.calls == []
    assert env_of(home)['SLACK_ALLOWED_USERS'] == 'U1' and 'access' not in record_of(data)


# ---- dashboard and relay together: the revision lock (blocker 1) ----------

def file_service(tmp_path, home, slack_api):
    def save(values):
        file_writer(home)(values)

    def remove(keys):
        lines = [l for l in (home / '.env').read_text().splitlines() if l.split('=')[0] not in keys]
        (home / '.env').write_text('\n'.join(lines) + '\n')
    return Service(tmp_path, 'bot', slack_api, lambda: env_of(home), save, remove, lambda: None, lambda: b'',
                   gate_scope=lambda: access.scope_from_env(env_of(home), f'{home}/.env'))


def test_a_sync_started_before_only_me_never_overwrites_it(tmp_path):
    data, home = installed(tmp_path)
    service = file_service(tmp_path, home, slack_api=None)

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()

        async def slack(method, values, token):
            assert method == 'users.list'
            entered.set()
            await release.wait()   # the sync's member read is in flight
            return {'ok': True, 'members': USERS + [{'id': 'U10', 'team_id': 'T1'}]}
        relay = make_relay(tmp_path, home, slack)
        sync = asyncio.create_task(relay.sync_app(KEY, now=NOW))
        await entered.wait()
        status = await asyncio.to_thread(service.set_access, 'owner')
        release.set()
        return await sync, status
    published, status = asyncio.run(scenario())
    assert published is False, 'the stale sync was refused'
    assert env_of(home)['SLACK_ALLOWED_USERS'] == 'U1'
    rec = record_of(data)
    assert rec['access'] == 'owner' and rec['access_rev'] == 2
    assert status['audience']['text'] == 'Only you can talk to this bot.'


def test_profile_helper_accepts_member_lists_and_nobody_and_refuses_junk(tmp_path):
    fake = tmp_path / 'hermes'
    (fake / 'hermes_cli').mkdir(parents=True)
    (fake / 'hermes_cli' / '__init__.py').write_text('')
    (fake / 'hermes_cli' / 'config.py').write_text('def save_env_value(k, v):\n    pass\n')

    def run(values):
        return subprocess.run([sys.executable, '-I', str(HELPER)], input=json.dumps(values).encode(),
                              env={'HERMES_AGENT_DIR': str(fake), 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True)
    many = ','.join(f'U{i:010d}' for i in range(2000))
    assert run({'SLACK_ALLOWED_USERS': many}).returncode == 0
    assert run({'SLACK_ALLOWED_USERS': 'NOBODY'}).returncode == 0
    for bad in ('U1,,U2', 'U1;rm', 'u1', 'U1\nX=1', '*', '', 'NOBODY,U1', 'nobody'):
        assert run({'SLACK_ALLOWED_USERS': bad}).returncode != 0, bad


# ---- round 4: welcome DM, Hermes-exact parsing, grants, writer, backoff ----

class WelcomeFails(FakeSlack):
    """chat.postMessage fails the way Relay.slack_call reports a non-ok answer."""
    async def __call__(self, method, values, token):
        if method == 'chat.postMessage':
            self.calls.append((method, values))
            raise access.SlackReadError('channel_not_found')
        return await super().__call__(method, values, token)


def test_a_failed_welcome_dm_still_connects_and_the_member_sync_revokes(tmp_path):
    data, home = prepare(tmp_path)
    slack = WelcomeFails()

    async def scenario():
        relay = make_relay(tmp_path, home, slack)
        client = TestClient(TestServer(relay.application()))
        await client.start_server()
        try:
            response = await client.get('/oauth/callback', params={'state': issue_state(b'k' * 32, 'bot', KEY, 'T1'), 'code': 'c'})
            page = (response.status, await response.text())
        finally:
            await client.close()
        assert env_of(home)['SLACK_ALLOWED_USERS'] == 'U1,U2,W9'
        slack.pages = [[u for u in USERS if u['id'] != 'W9']]   # W9 left the workspace
        return page, await relay.sync_members_once()
    (status, page), synced = asyncio.run(scenario())
    assert status == 200 and 'Helper is in Acme.' in page
    assert "The welcome message couldn't be sent to you in Slack (channel_not_found)" in page
    rec = record_of(data)
    assert type(rec['installed_at']) is int and rec['welcome'] == 'failed' and rec['welcome_error'] == 'channel_not_found'
    assert synced == 1 and env_of(home)['SLACK_ALLOWED_USERS'] == 'U1,U2', 'the removed member is revoked'
    status = file_service(tmp_path, home, slack_api=None).status(live=False)
    assert status['welcome'] == 'failed' and status['welcome_error'] == 'channel_not_found'


def test_a_sent_welcome_is_recorded(tmp_path):
    _, _, _, data, _, _ = run_callback(tmp_path)
    rec = record_of(data)
    assert rec['welcome'] == 'sent' and rec['welcome_error'] is None


@pytest.mark.parametrize('raw, expected', [
    ('U1,U2', {'U1', 'U2'}), (' U1 , ,U2 ', {'U1', 'U2'}), ('["U1", " U2 ", ""]', {'U1', 'U2'}),
    ('  ["*"]', {'*'}), ('[1, "U2"]', {'1', 'U2'}), ('["U1",', {'["U1"'}), ('[x]', {'[x]'}),
    ('{"a": 1}', {'{"a": 1}'}), ('"U1"', {'"U1"'}), ('[]', set()), ('', set()), (None, set()),
    (['U1', ' ', 'U2 '], {'U1', 'U2'}), ('*', {'*'}),
])
def test_coerce_allow_set_parses_like_hermes(raw, expected):
    assert access.coerce_allow_set(raw) == expected


def test_a_json_list_and_a_json_wildcard_read_as_hermes_reads_them():
    rec = {'profile': 'p', 'access': 'members', 'owner': 'U1'}
    anyone = access.effective_access(scope(SLACK_ALLOWED_USERS='U1,U2', GATEWAY_ALLOWED_USERS='["*"]'), (), rec, NOW, 'Acme')
    assert anyone['open'] and anyone['text'] == ('Anyone in Slack who can message this bot, including guests '
                                                 '(GATEWAY_ALLOWED_USERS=* in /h/.env).')
    listed = access.effective_access(scope(SLACK_ALLOWED_USERS='["U1", "U2"]'), (), rec, NOW, 'Acme')
    assert listed['ids'] == ['U1', 'U2'] and listed['text'] == '2 people can talk to this bot: the 2 full members of Acme.'
    # '[]' is a set allowlist that names nobody: no fall-through to GATEWAY_ALLOW_ALL_USERS.
    empty = access.effective_access(scope(SLACK_ALLOWED_USERS='[]', GATEWAY_ALLOW_ALL_USERS='true'), (), rec, NOW)
    assert not empty['open'] and empty['people'] == 0


def test_channel_and_bot_grants_qualify_the_audience_with_source_and_fix():
    rec = {'profile': 'p', 'access': 'members', 'owner': 'U1'}
    chats = {'group_allowed_chats': {'value': '["C1", "C2"]', 'source': '/h/config.yaml'}}
    eff = access.effective_access(access.scope_from_env({'SLACK_ALLOWED_USERS': 'U1,U2', 'SLACK_ALLOW_BOTS': 'Mentions'}, '/h/.env',
                                                        extra=chats), (), rec, NOW, 'Acme')
    assert eff['chats'] == ['C1', 'C2'] and eff['bots'] is True and not eff['open']
    assert eff['text'] == ('2 people can talk to this bot: the 2 full members of Acme, and anyone posting in channels '
                           'C1, C2 (group_allowed_chats in /h/config.yaml). Bots and workflows are also let in '
                           '(SLACK_ALLOW_BOTS=mentions in /h/.env).')
    grants = {g['what']: g for g in eff['grants']}
    assert grants['group_allowed_chats']['how_to_change'] == 'remove group_allowed_chats from /h/config.yaml'
    assert grants['SLACK_ALLOW_BOTS=mentions']['how_to_change'] == 'remove SLACK_ALLOW_BOTS from /h/.env'
    nobody = access.effective_access(access.scope_from_env({'SLACK_ALLOWED_USERS': 'NOBODY'}, '/h/.env',
        extra={'group_allowed_chats': {'value': '*', 'source': '/h/config.yaml'}}), (), rec, NOW)
    assert nobody['text'] == ('Only people posting in any channel it is in can talk to this bot '
                              '(group_allowed_chats in /h/config.yaml).')
    # allow_bots: a set env wins over config.yaml; without a declared env Hermes admits no bot.
    yaml_all = {'allow_bots': {'value': 'all', 'source': '/h/config.yaml'}}
    assert access.effective_access(access.scope_from_env({'SLACK_ALLOW_BOTS': 'none'}, '/h/.env', extra=yaml_all), (), rec, NOW)['bots'] is False
    assert 'allow_bots=all in /h/config.yaml' in access.effective_access(access.scope_from_env({}, '/h/.env', extra=yaml_all), (), rec, NOW)['text']
    undeclared = access.scope_from_env({'SLACK_ALLOW_BOTS': 'all'}, '/h/.env', extra=yaml_all,
                                       authz={'group_allowed_chats_env': '', 'allow_bots_env': ''})
    assert access.effective_access(undeclared, (), rec, NOW)['bots'] is False
    # A group-chat env, when Hermes declares one, is read too.
    declared = access.scope_from_env({'X_GROUP_CHATS': 'C9'}, '/h/.env', authz={'group_allowed_chats_env': 'X_GROUP_CHATS',
                                                                               'allow_bots_env': 'SLACK_ALLOW_BOTS'})
    assert access.effective_access(declared, (), rec, NOW)['chats'] == ['C9']


def test_gate_scope_without_hermes_reports_config_yaml_grants(tmp_path):
    home = tmp_path / 'profiles' / 'bot'
    home.mkdir(parents=True)
    (home / '.env').write_text('SLACK_ALLOWED_USERS=U1\nSLACK_ALLOW_BOTS=mentions\n')
    (home / 'config.yaml').write_text('slack:\n  allow_bots: all\nplatforms:\n  slack:\n    group_allowed_chats: C1,C2\n')
    got = access.gate_scope(home)
    assert got['complete'] is False and got['keys']['SLACK_ALLOW_BOTS'] == {'value': 'mentions', 'source': f'{home}/.env'}
    assert got['extra'] == {'group_allowed_chats': {'value': 'C1,C2', 'source': f'{home}/config.yaml'},
                            'allow_bots': {'value': 'all', 'source': f'{home}/config.yaml'}}
    assert access.valid_scope(json.loads(json.dumps(got))) == got
    assert access.valid_scope({**got, 'keys': {'SLACK_BOT_TOKEN': {'value': 'x', 'source': 's'}}}) is None


def test_a_timed_out_profile_writer_is_killed_before_the_lock_is_released(tmp_path, monkeypatch):
    data, home = installed(tmp_path)
    pid_file = tmp_path / 'writer.pid'
    helper = tmp_path / 'slow_writer.py'
    helper.write_text('import os, signal, sys, time\n'
                      'signal.signal(signal.SIGTERM, signal.SIG_IGN)   # ignores a polite stop\n'
                      f'open({str(pid_file)!r}, "w").write(str(os.getpid()))\n'
                      'sys.stdin.read()\n'
                      'time.sleep(30)\n')
    monkeypatch.setattr(relay_module, 'WRITE_TIMEOUT', 1)
    relay = relay_module.Relay(tmp_path, sys.executable, helper, base_url='https://example.test/slack',
                               upstream='http://127.0.0.1:9999')
    before = (data / 'apps.json').read_text()
    with pytest.raises(RuntimeError, match='timed out'):
        asyncio.run(relay.publish(KEY, access.expect_of(record_of(data)), ['U2'], {'synced_at': NOW}))
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)   # the writer is gone by the time the lock was released
    assert (data / 'apps.json').read_text() == before, 'a failed publish records nothing'


def test_backoff_never_stretches_the_24_hour_expiry(tmp_path):
    expiry = NOW + 100
    data, home = installed(tmp_path, {'synced_at': expiry - access.STALE_SECONDS, 'retry_after': NOW + 3600,
                                      'last_members_owner_ok': True})
    slack = FakeSlack()
    relay = make_relay(tmp_path, home, slack)
    assert asyncio.run(relay.sync_app(KEY, now=NOW)) is False and env_of(home)['SLACK_ALLOWED_USERS'] == 'U1,U2,W9'
    assert asyncio.run(relay.sync_app(KEY, now=expiry + 1)) is True
    assert slack.calls == [], 'no Slack call while Slack asked to wait'
    assert env_of(home)['SLACK_ALLOWED_USERS'] == 'U1', 'the expired list fell back to the verified installer'
    assert record_of(data)['retry_after'] == NOW + 3600
