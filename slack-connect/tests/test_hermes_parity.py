"""The kit's effective_access against Hermes's own gateway authorization.

Runs only with HERMES_PARITY_CHECKOUT pointing at a Hermes checkout, on an
isolated import path with a throwaway HERMES_HOME (scripts/test-with-hermes.sh
does all of that). CI never imports upstream Hermes, so this is a local and
reviewer step.

Mode: single profile, not multiplexed. The gate keys are both written to the
profile .env (what the kit reads through gate_scope, here the real Hermes
build_profile_secret_scope) and set in os.environ, which is where Hermes's
platform_gate_env reads them without a multiplexed secret scope. Pairing is
Hermes's real PairingStore on the same HERMES_HOME. The verdict compared is
GatewayRunner._principal_authorized, the allowlist decision before the bot loop
guard, on a bare runner built the way Hermes's own authz tests build it
(tests/gateway/test_slack_bot_auth_bypass.py).
"""
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

CHECKOUT = os.environ.get('HERMES_PARITY_CHECKOUT')
pytestmark = pytest.mark.skipif(not CHECKOUT, reason='needs Hermes: run scripts/test-with-hermes.sh <hermes checkout>')

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from common import access   # noqa: E402

GRANT_ENVS = ('SLACK_ALLOW_BOTS',)
USERS = ('U1', 'U2', 'U3', 'U9')
REC = {'profile': 'bot', 'access': 'members', 'owner': 'U1'}


@pytest.fixture
def hermes(tmp_path, monkeypatch):
    if str(Path(CHECKOUT).resolve()) not in map(str, (Path(p).resolve() for p in sys.path if p)):
        sys.path.insert(0, CHECKOUT)
    home = Path(os.environ.get('HERMES_HOME') or '')
    real = Path.home() / '.hermes'
    assert home.is_dir() and real not in (home, *home.parents), 'HERMES_HOME must be a throwaway directory'
    profile = tmp_path / 'profile'
    (profile / 'platforms' / 'pairing').mkdir(parents=True)
    monkeypatch.setenv('HERMES_HOME', str(profile))
    for name in access.gate_names() + GRANT_ENVS:
        monkeypatch.delenv(name, raising=False)
    from gateway.config import Platform
    from gateway.pairing import PairingStore
    from gateway.run import GatewayRunner
    from gateway.session import SessionSource

    def setup(env, approved=(), extra=None):
        (profile / '.env').write_text(''.join(f'{k}={v}\n' for k, v in env.items()))
        (profile / 'platforms' / 'pairing' / 'slack-approved.json').write_text(
            json.dumps({u: {'user_name': u, 'approved_at': 1} for u in approved}))
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        runner = object.__new__(GatewayRunner)
        runner.pairing_store = PairingStore()
        runner.adapters = {Platform.SLACK: SimpleNamespace(config=SimpleNamespace(extra=dict(extra or {})))}
        if extra:
            (profile / 'config.yaml').write_text(json.dumps({'platforms': {'slack': {'extra': extra}}}))
        eff = access.effective_access(access.gate_scope(profile), access.pairing_approved(profile), REC, team_name='Acme')
        return runner, eff

    def source(user, chat_type='dm', chat='D1', bot=False):
        return SessionSource(platform=Platform.SLACK, chat_id=chat, chat_type=chat_type, user_id=user,
                             user_name=user or '', is_bot=bot)

    def hermes_says(runner, src):
        return runner._principal_authorized(src, allow_adapter_delegation=True)
    return SimpleNamespace(setup=setup, source=source, says=hermes_says)


def kit_says(eff, user, chat=None, bot=False):
    """The kit's verdict from one effective_access result."""
    if chat and ('*' in eff['chats'] or chat in eff['chats']):
        return True
    if bot and eff['bots']:
        return True
    return bool(user) and (eff['open'] or user in eff['ids'])


DM_CASES = {
    'plain list': ({'SLACK_ALLOWED_USERS': 'U1,U2'}, ()),
    'json list': ({'SLACK_ALLOWED_USERS': '["U1", " U2 "]'}, ()),
    'malformed json is a comma list': ({'SLACK_ALLOWED_USERS': '["U1", "U2"'}, ()),
    'json wildcard in GATEWAY_ALLOWED_USERS': ({'SLACK_ALLOWED_USERS': 'U1', 'GATEWAY_ALLOWED_USERS': '["*"]'}, ()),
    'star in SLACK_ALLOWED_USERS': ({'SLACK_ALLOWED_USERS': 'U1,*'}, ()),
    'SLACK_ALLOW_ALL_USERS=true': ({'SLACK_ALLOWED_USERS': 'NOBODY', 'SLACK_ALLOW_ALL_USERS': 'true'}, ()),
    'NOBODY with GATEWAY_ALLOW_ALL_USERS=true denies': ({'SLACK_ALLOWED_USERS': 'NOBODY', 'GATEWAY_ALLOW_ALL_USERS': 'true'}, ()),
    'empty json list is still a list': ({'SLACK_ALLOWED_USERS': '[]', 'GATEWAY_ALLOW_ALL_USERS': 'true'}, ()),
    'no allowlist falls to GATEWAY_ALLOW_ALL_USERS': ({'GATEWAY_ALLOW_ALL_USERS': 'yes'}, ()),
    'no allowlist at all denies': ({}, ()),
    'gateway list adds people': ({'SLACK_ALLOWED_USERS': 'U1', 'GATEWAY_ALLOWED_USERS': 'U2,U3'}, ()),
    'pairing approval': ({'SLACK_ALLOWED_USERS': 'U1'}, ('U3',)),
}


@pytest.mark.parametrize('case', DM_CASES)
def test_dm_verdicts_match_hermes(hermes, case):
    env, approved = DM_CASES[case]
    runner, eff = hermes.setup(env, approved)
    for user in USERS:
        assert kit_says(eff, user) == hermes.says(runner, hermes.source(user)), (case, user, eff['text'])


def test_the_star_reads_as_anyone(hermes):
    _, eff = hermes.setup({'SLACK_ALLOWED_USERS': 'U1,U2', 'GATEWAY_ALLOWED_USERS': '["*"]'})
    assert eff['text'].startswith('Anyone in Slack who can message this bot')


def test_channel_grant_from_config_yaml_matches_hermes(hermes):
    runner, eff = hermes.setup({'SLACK_ALLOWED_USERS': 'U1'}, extra={'group_allowed_chats': ['C1']})
    assert eff['chats'] == ['C1'] and 'anyone posting in channels C1' in eff['text']
    for user, chat in (('U9', 'C1'), ('U9', 'C2'), ('U1', 'C2'), (None, 'C1')):
        assert kit_says(eff, user, chat) == hermes.says(runner, hermes.source(user, 'group', chat)), (user, chat)


@pytest.mark.parametrize('env, extra', [({'SLACK_ALLOW_BOTS': 'mentions'}, None), ({}, {'allow_bots': 'all'}),
                                        ({'SLACK_ALLOW_BOTS': 'none'}, {'allow_bots': 'all'}), ({}, None)])
def test_bot_grant_matches_hermes(hermes, env, extra):
    runner, eff = hermes.setup({'SLACK_ALLOWED_USERS': 'U1', **env}, extra=extra)
    src = hermes.source(None, 'group', 'C2', bot=True)
    assert kit_says(eff, None, 'C2', bot=True) == hermes.says(runner, src), (env, extra, eff['text'])


def test_the_grant_env_names_are_hermes_own(hermes):
    from gateway.platform_env import bundled_authz
    declared = bundled_authz('slack')
    assert {k: declared.get(k) or '' for k in access.SLACK_AUTHZ} == access.SLACK_AUTHZ
    assert declared.get('allowed_users_env') == 'SLACK_ALLOWED_USERS' and declared.get('allow_all_env') == 'SLACK_ALLOW_ALL_USERS'
    assert access.hermes_authz() == access.SLACK_AUTHZ


def test_coerce_allow_set_is_hermes_own(hermes):
    from gateway.authz_mixin import _coerce_allow_set
    for raw in ('U1,U2', ' ["U1", " U2 ", ""] ', '["*"]', '["U1",', '[1, 2]', '{"a": 1}', '[]', '', None, ['U1', ' '], 'NOBODY'):
        assert access.coerce_allow_set(raw) == _coerce_allow_set(raw), raw


def test_an_administrator_managed_allowlist_is_refused_and_never_committed(hermes, tmp_path, monkeypatch):
    """Hermes's real write lock: SLACK_ALLOWED_USERS pinned by a managed scope.
    save_env_value refuses by printing and returning; the helper and the
    dashboard saver ask require_env_writable first; the read-back through the
    real gate_scope catches any writer that refuses silently."""
    import subprocess
    managed = tmp_path / 'managed'
    managed.mkdir()
    (managed / '.env').write_text('SLACK_ALLOWED_USERS=U1,U2\n')
    monkeypatch.setenv('HERMES_MANAGED_DIR', str(managed))
    root = tmp_path / 'root'
    home, data = root / 'profiles' / 'bot', root / 'slack-connect'
    home.mkdir(parents=True)
    data.mkdir()
    (home / '.env').write_text('SLACK_APP_ID=A1\nSLACK_ALLOWED_USERS=U1,U2\n')
    monkeypatch.setenv('HERMES_HOME', str(home))
    from hermes_cli import config, managed_scope
    managed_scope.invalidate_managed_cache()
    record = {'profile': 'bot', 'app_id': 'A1', 'access': 'members', 'access_rev': 1}
    (data / 'apps.json').write_text(json.dumps({'k' * 32: record}))

    def silent(values):   # an older writer: Hermes's own save_env_value, nothing asked first
        for key, value in values.items():
            config.save_env_value(key, value)
    with pytest.raises(access.EnvNotApplied, match=r'Hermes kept SLACK_ALLOWED_USERS=U1,U2 \(administrator-managed\?\)'):
        access.publish_allowlist(data, 'k' * 32, access.expect_of(record), ['U1'], silent,
                                 fields={'access': 'owner', 'access_rev': 2}, read_back=lambda: access.gate_scope(home))
    assert json.loads((data / 'apps.json').read_text()) == {'k' * 32: record}
    assert (home / '.env').read_text() == 'SLACK_APP_ID=A1\nSLACK_ALLOWED_USERS=U1,U2\n'

    helper = BASE.parent / 'slack-relay' / 'profile_helper.py'
    out = subprocess.run([sys.executable, '-I', str(helper)], input=b'{"SLACK_ALLOWED_USERS": "U1"}', capture_output=True,
                         env={**os.environ, 'HERMES_AGENT_DIR': CHECKOUT, 'HERMES_HOME': str(home)})
    assert out.returncode != 0 and b'managed by your administrator' in out.stderr, out.stderr

    import importlib.util
    spec = importlib.util.spec_from_file_location('parity_plugin_api', BASE / 'dashboard' / 'plugin_api.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    with pytest.raises(access.EnvNotApplied, match='managed by your administrator'):
        api.env_saver(config.save_env_value, config)({'SLACK_ALLOWED_USERS': 'U1'})
    assert (home / '.env').read_text() == 'SLACK_APP_ID=A1\nSLACK_ALLOWED_USERS=U1,U2\n'


# ---- round 7: a failed audience change never grants access ---------------

SLACK_KEYS = ('SLACK_APP_ID', 'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'SLACK_TEAM_NAME')


@pytest.fixture
def publish(hermes, tmp_path, monkeypatch):
    """publish_allowlist on a real profile: Hermes's own save_env_value and
    remove_env_value write it, the real gate_scope reads it back, and the
    reader raises while the new list (with U7) is on disk, i.e. right after the
    write (`sticky`: from then on). Then Hermes's real reader and its real
    allowlist decision are asked about U7."""
    for name in access.gate_names() + SLACK_KEYS:
        monkeypatch.setenv(name, '')
        monkeypatch.delenv(name)   # recorded, so Hermes's own os.environ updates are undone
    root = tmp_path / 'root'
    home, data = root / 'profiles' / 'bot', root / 'slack-connect'
    home.mkdir(parents=True)
    data.mkdir()
    monkeypatch.setenv('HERMES_HOME', str(home))
    from hermes_cli import config
    from agent.secret_scope import build_profile_secret_scope

    def write(values):
        for key, value in values.items():
            if value is None:
                config.remove_env_value(key)
            else:
                config.save_env_value(key, value)

    def run(env_text, ids, sticky=False, env_extra=None):
        (home / '.env').write_text(env_text)
        config.invalidate_env_cache()
        for line in env_text.splitlines():
            monkeypatch.setenv(*line.split('=', 1))
        record = {'profile': 'bot', 'app_id': 'A1', 'access': 'members', 'access_rev': 1}
        (data / 'apps.json').write_text(json.dumps({'k' * 32: record}))
        failed = []

        def read_back():
            if failed and sticky or 'U7' in (access.read_env_file(home / '.env').get('SLACK_ALLOWED_USERS') or ''):
                failed.append(1)
                raise RuntimeError('the Hermes scope helper failed')
            return access.gate_scope(home)
        with pytest.raises(access.EnvNotApplied) as caught:
            access.publish_allowlist(data, 'k' * 32, access.expect_of(record), ids, write,
                                     fields={'access_rev': 2}, env_extra=env_extra, read_back=read_back)
        assert json.loads((data / 'apps.json').read_text()) == {'k' * 32: record}, 'nothing recorded'
        from gateway.config import Platform
        from gateway.run import GatewayRunner
        from gateway.pairing import PairingStore
        runner = object.__new__(GatewayRunner)
        runner.pairing_store = PairingStore()
        runner.adapters = {Platform.SLACK: SimpleNamespace(config=SimpleNamespace(extra={}))}
        says = {u: hermes.says(runner, hermes.source(u)) for u in ('U1', 'U7')}
        return str(caught.value), dict(build_profile_secret_scope(home)), says
    return run


def test_a_read_back_fault_after_the_write_leaves_hermes_allowlist_as_it_was(publish):
    message, scope, says = publish('SLACK_APP_ID=A1\nSLACK_BOT_TOKEN=xoxb-FAKE-bot\nSLACK_ALLOWED_USERS=U1\n',
                                   ['U1', 'U7'])
    assert scope.get('SLACK_ALLOWED_USERS') == 'U1', 'Hermes reads the previous allowlist'
    assert os.environ.get('SLACK_ALLOWED_USERS') == 'U1'
    assert says == {'U1': True, 'U7': False}, 'U7 is denied by Hermes itself'
    assert message == "Couldn't confirm Hermes applied the change; nothing was changed"


def test_a_failed_first_connect_leaves_hermes_with_no_slack_token(publish):
    creds = {'SLACK_BOT_TOKEN': 'xoxb-FAKE-bot', 'SLACK_TEAM_ID': 'T1', 'SLACK_TEAM_NAME': 'Acme'}
    message, scope, says = publish('SLACK_APP_ID=A1\n', ['U1', 'U2', 'U7'], env_extra=creds)
    assert not {'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'SLACK_ALLOWED_USERS'} & set(scope), scope.keys()
    assert says['U7'] is False
    assert message.endswith('nothing was changed')


def test_a_first_connect_whose_undo_cannot_be_confirmed_is_left_with_nobody(publish):
    creds = {'SLACK_BOT_TOKEN': 'xoxb-FAKE-bot', 'SLACK_TEAM_ID': 'T1', 'SLACK_TEAM_NAME': 'Acme'}
    message, scope, says = publish('SLACK_APP_ID=A1\n', ['U1', 'U2', 'U7'], sticky=True, env_extra=creds)
    assert scope.get('SLACK_ALLOWED_USERS') == 'NOBODY', 'never three IDs on disk'
    assert says == {'U1': False, 'U7': False}
    assert 'SLACK_ALLOWED_USERS is now NOBODY' in message
