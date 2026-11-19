"""Required-scope check and manifest repair. No network: a fake Slack client and a fake opener."""
import copy
import email.message
import io
import json
import sys
import time
from pathlib import Path

import pytest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(BASE / 'dashboard'))
from common import scopes  # noqa: E402
from service import Service  # noqa: E402
import scope_repair  # noqa: E402

FAKE_BOT = 'xoxb-1111-2222-FAKEbotTOKENvalue'
GRANTED_NO_REACTIONS = 'app_mentions:read,chat:write,im:history,im:read,im:write,users:read'
GRANTED_ALL = GRANTED_NO_REACTIONS + ',reactions:write'
AUTH_OK = {'ok': True, 'team_id': 'T0EXAMPLE01', 'bot_id': 'B0EXAMPLE01', 'user': 'helper'}

# A hand-made Socket Mode app: user scopes, slash commands, URLs and settings that must survive.
BEFORE = {
    '_metadata': {'major_version': 1, 'minor_version': 1},
    'display_information': {'name': 'Helper', 'description': 'An example bot'},
    'features': {'bot_user': {'display_name': 'helper', 'always_online': True},
                 'app_home': {'messages_tab_enabled': True, 'messages_tab_read_only_enabled': False},
                 'slash_commands': [{'command': '/helper', 'description': 'Ask', 'should_escape': False}]},
    'oauth_config': {'redirect_urls': ['https://example.test/callback'],
                     'scopes': {'bot': ['app_mentions:read', 'chat:write', 'im:history', 'users:read'],
                                'user': ['search:read']}},
    'settings': {'event_subscriptions': {'bot_events': ['app_mention', 'message.im']},
                 'interactivity': {'is_enabled': True}, 'org_deploy_enabled': False,
                 'socket_mode_enabled': True, 'token_rotation_enabled': False},
}


class FakeResp(io.BytesIO):
    def __init__(self, body, headers=None):
        super().__init__(body)
        if headers is not None:
            self.headers = email.message.Message()
            for key, value in headers.items():
                self.headers[key] = value

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def opener_for(answer, scope_header):
    calls = []

    def opener(request, timeout=None):
        calls.append({'url': request.full_url, 'auth': request.get_header('Authorization'),
                      'verb': request.get_method()})
        headers = {'X-OAuth-Scopes': scope_header} if scope_header is not None else {}
        return FakeResp(json.dumps(answer).encode(), headers)
    opener.calls = calls
    return opener


class FakeSlack:
    """The parts of SlackAPI the repair uses, over one stored app manifest."""
    class IconUnavailable(Exception):
        pass

    def __init__(self, manifest, *, fail_update=None, fail_validate=None, app_id='A0EXAMPLE01'):
        self.app_id, self.manifest = app_id, copy.deepcopy(manifest)
        self.fail_update, self.fail_validate = fail_update, fail_validate
        self.calls, self.sent = [], []

    def post(self, method, token, values):
        self.calls.append(method)
        assert token == 'fake-config-access'
        if method == 'apps.manifest.export':
            assert values == {'app_id': self.app_id}
            return {'ok': True, 'manifest': copy.deepcopy(self.manifest)}
        if method == 'apps.manifest.validate':
            json.loads(values['manifest'])
            return {'ok': False, 'error': self.fail_validate} if self.fail_validate else {'ok': True}
        raise AssertionError('unexpected method ' + method)

    def update(self, token, app_id, data):
        self.calls.append('apps.manifest.update')
        self.sent.append(copy.deepcopy(data))
        if self.fail_update:
            return {'ok': False, 'error': self.fail_update}
        self.manifest = copy.deepcopy(data)
        return {'ok': True, 'permissions_updated': True}


def keep(store):
    def save(app_id, manifest):
        store.append((app_id, copy.deepcopy(manifest)))
        return f'/backups/{app_id}.json'
    return save


# ---------------------------------------------------------------- check

def test_check_missing_required_scope_warns():
    opener = opener_for(AUTH_OK, GRANTED_NO_REACTIONS)
    result = scopes.check_token(FAKE_BOT, opener)
    assert result['ok'] is True and result['scopes_known'] is True
    assert result['missing'] == [{'scope': 'reactions:write', 'reason': 'acknowledge messages with an emoji'}]
    assert 'reactions:write' in result['warning'] and 'repair' in result['warning']
    assert result['team_id'] == 'T0EXAMPLE01' and result['bot_id'] == 'B0EXAMPLE01'
    assert opener.calls == [{'url': 'https://slack.com/api/auth.test', 'auth': 'Bearer ' + FAKE_BOT, 'verb': 'POST'}]
    assert FAKE_BOT not in json.dumps(result)


def test_check_granted_and_unknown_and_failed():
    assert scopes.check_token(FAKE_BOT, opener_for(AUTH_OK, GRANTED_ALL))['missing'] == []
    unknown = scopes.check_token(FAKE_BOT, opener_for(AUTH_OK, None))
    assert unknown['ok'] is True and unknown['scopes_known'] is False and unknown['missing'] == []
    failed = scopes.check_token(FAKE_BOT, opener_for({'ok': False, 'error': 'invalid_auth'}, None))
    assert failed == {'ok': False, 'error': 'invalid_auth', 'scopes_known': False, 'missing': [], 'warning': ''}

    def boom(request, timeout=None):
        raise OSError('network down ' + FAKE_BOT)
    broken = scopes.check_token(FAKE_BOT, boom)
    assert broken['error'] == 'request_failed' and FAKE_BOT not in json.dumps(broken)


def test_required_list_is_small_and_within_defaults():
    from common.core import BOT_SCOPES
    assert [scope for scope, _ in scopes.REQUIRED_BOT_SCOPES] == ['reactions:write']
    assert all(reason for _, reason in scopes.REQUIRED_BOT_SCOPES)
    assert {scope for scope, _ in scopes.REQUIRED_BOT_SCOPES} <= set(BOT_SCOPES)
    # Optional default scopes never count as missing.
    assert scopes.missing_required({'reactions:write'}) == []


# ---------------------------------------------------------------- repair

def test_repair_adds_only_the_missing_scope_and_nothing_else():
    slack, backups = FakeSlack(BEFORE), []
    result = scopes.repair_app(slack, 'fake-config-access', 'A0EXAMPLE01', keep(backups))
    assert result['ok'] and result['changed'] and result['added'] == ['reactions:write']
    assert result['rest_unchanged'] is True and result['scopes_present'] is True
    assert result['reinstall_url'] == 'https://api.slack.com/apps/A0EXAMPLE01/oauth'
    assert slack.calls == ['apps.manifest.export', 'apps.manifest.validate', 'apps.manifest.update',
                           'apps.manifest.export']
    sent = slack.sent[0]
    assert sent['oauth_config']['scopes']['bot'] == BEFORE['oauth_config']['scopes']['bot'] + ['reactions:write']
    # Byte-compare everything but the bot scope list.
    expected = copy.deepcopy(BEFORE)
    expected['oauth_config']['scopes']['bot'].append('reactions:write')
    assert scopes.canonical(sent) == scopes.canonical(expected)
    assert sent['oauth_config']['scopes']['user'] == ['search:read']
    assert backups == [('A0EXAMPLE01', BEFORE)] and result['backup'] == '/backups/A0EXAMPLE01.json'


def test_repair_is_idempotent_when_scope_present():
    present = copy.deepcopy(BEFORE)
    present['oauth_config']['scopes']['bot'].append('reactions:write')
    slack, backups = FakeSlack(present), []
    result = scopes.repair_app(slack, 'fake-config-access', 'A0EXAMPLE01', keep(backups))
    assert result['changed'] is False and result['added'] == []
    assert result['reinstall_url'].endswith('/A0EXAMPLE01/oauth')
    assert slack.calls == ['apps.manifest.export'] and backups == [] and slack.sent == []
    # A second run after a real repair is a no-op too.
    slack = FakeSlack(BEFORE)
    scopes.repair_app(slack, 'fake-config-access', 'A0EXAMPLE01', keep([]))
    again = scopes.repair_app(slack, 'fake-config-access', 'A0EXAMPLE01', keep([]))
    assert again['changed'] is False and len(slack.sent) == 1


def test_update_failure_leaves_manifest_untouched():
    slack, backups = FakeSlack(BEFORE, fail_update='invalid_manifest'), []
    with pytest.raises(scopes.RepairError) as raised:
        scopes.repair_app(slack, 'fake-config-access', 'A0EXAMPLE01', keep(backups))
    assert raised.value.stage == 'update' and raised.value.error == 'invalid_manifest'
    assert slack.manifest == BEFORE
    assert backups == [('A0EXAMPLE01', BEFORE)]  # the rollback copy was saved before the write


def test_validate_failure_and_dry_run_never_update():
    slack = FakeSlack(BEFORE, fail_validate='invalid_manifest')
    with pytest.raises(scopes.RepairError):
        scopes.repair_app(slack, 'fake-config-access', 'A0EXAMPLE01', keep([]))
    assert 'apps.manifest.update' not in slack.calls and slack.manifest == BEFORE
    slack, backups = FakeSlack(BEFORE), []
    result = scopes.repair_app(slack, 'fake-config-access', 'A0EXAMPLE01', keep(backups), dry_run=True)
    assert result['dry_run'] is True and result['added'] == ['reactions:write'] and result['changed'] is False
    assert slack.calls == ['apps.manifest.export', 'apps.manifest.validate'] and backups == []


def test_restore_puts_the_saved_manifest_back():
    slack = FakeSlack(BEFORE)
    scopes.repair_app(slack, 'fake-config-access', 'A0EXAMPLE01', keep([]))
    assert scopes.restore_app(slack, 'fake-config-access', 'A0EXAMPLE01', BEFORE)['restored'] is True
    assert slack.manifest == BEFORE


def test_only_scopes_added_detects_other_changes():
    after = copy.deepcopy(BEFORE)
    after['oauth_config']['scopes']['bot'].append('reactions:write')
    assert scopes.only_scopes_added(BEFORE, after, ['reactions:write'])
    after['settings']['socket_mode_enabled'] = False
    assert not scopes.only_scopes_added(BEFORE, after, ['reactions:write'])
    with pytest.raises(ValueError):
        scopes.reinstall_url('../x')


# ---------------------------------------------------------------- CLI

class CliSlack(FakeSlack):
    def rotate(self, refresh):
        return {'ok': True, 'team_id': 'T0EXAMPLE01', 'token': 'fake-config-access',
                'refresh_token': 'fake-refresh-next', 'exp': int(time.time()) + 4000}

    def post(self, method, token, values):
        if method == 'bots.info':
            assert token == FAKE_BOT and values == {'bot': 'B0EXAMPLE01'}
            return {'ok': True, 'bot': {'id': 'B0EXAMPLE01', 'app_id': self.app_id}}
        return super().post(method, token, values)


@pytest.fixture
def hermes(tmp_path):
    root = tmp_path / 'hermes'
    home = root / 'profiles' / 'helper'
    home.mkdir(parents=True)
    (home / '.env').write_text(f'SLACK_BOT_TOKEN="{FAKE_BOT}"\nOTHER=1\n')
    (root / 'profiles' / 'quiet').mkdir()
    data = root / 'slack-connect'
    data.mkdir()
    # Expiring soon: the CLI must rotate it through the plugin's own store, as Connect does.
    (data / 'config-tokens.json').write_text(json.dumps(
        {'T0EXAMPLE01': {'access': 'fake-config-stale', 'refresh': 'fake-refresh', 'exp': int(time.time()) + 60}}))
    return root


def run_cli(capsys, argv, slack, opener, root):
    code = scope_repair.main(argv, slack=slack, opener=opener, root=root)
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    return code, lines


def test_cli_check_lists_slack_profiles_read_only(hermes, capsys):
    slack = CliSlack(BEFORE)
    code, lines = run_cli(capsys, ['check'], slack, opener_for(AUTH_OK, GRANTED_NO_REACTIONS), hermes)
    assert code == 1 and [row['profile'] for row in lines] == ['helper']
    assert lines[0]['app_id'] == 'A0EXAMPLE01' and lines[0]['missing'][0]['scope'] == 'reactions:write'
    assert slack.calls == [] and slack.sent == []
    assert FAKE_BOT not in json.dumps(lines)


def test_cli_repair_then_verify(hermes, capsys):
    slack = CliSlack(BEFORE)
    code, lines = run_cli(capsys, ['repair', '--profile', 'helper'], slack,
                          opener_for(AUTH_OK, GRANTED_NO_REACTIONS), hermes)
    assert code == 0 and lines[0]['changed'] is True and lines[0]['added'] == ['reactions:write']
    assert lines[0]['reinstall_url'] == 'https://api.slack.com/apps/A0EXAMPLE01/oauth'
    assert 'verify --profile helper' in lines[0]['verify'] and lines[0]['granted_now'] is False
    backup = Path(lines[0]['backup'])
    assert backup.parent == hermes / 'slack-connect' / 'manifest-backups'
    assert json.loads(backup.read_text()) == BEFORE and backup.stat().st_mode & 0o077 == 0
    tokens = json.loads((hermes / 'slack-connect' / 'config-tokens.json').read_text())
    assert tokens['T0EXAMPLE01']['access'] == 'fake-config-access'  # rotated under the plugin's lock
    assert 'fake-config' not in json.dumps(lines) and FAKE_BOT not in json.dumps(lines)
    # Before the human clicks Reinstall the grant is still missing; afterwards verify passes.
    code, _ = run_cli(capsys, ['verify', '--profile', 'helper'], slack, opener_for(AUTH_OK, GRANTED_NO_REACTIONS), hermes)
    assert code == 1
    code, lines = run_cli(capsys, ['verify', '--profile', 'helper'], slack, opener_for(AUTH_OK, GRANTED_ALL), hermes)
    assert code == 0 and lines[0]['missing'] == []


def test_cli_update_failure_reports_stage_and_changes_nothing(hermes, capsys):
    slack = CliSlack(BEFORE, fail_update='invalid_manifest')
    code, lines = run_cli(capsys, ['repair', '--profile', 'helper'], slack,
                          opener_for(AUTH_OK, GRANTED_NO_REACTIONS), hermes)
    assert code == 3 and lines == [{'ok': False, 'stage': 'update', 'error': 'invalid_manifest'}]
    assert slack.manifest == BEFORE


def test_cli_restore_from_backup(hermes, capsys):
    slack = CliSlack(BEFORE)
    _, lines = run_cli(capsys, ['repair', '--profile', 'helper'], slack, opener_for(AUTH_OK, GRANTED_NO_REACTIONS), hermes)
    code, out = run_cli(capsys, ['restore', '--app-id', 'A0EXAMPLE01', '--team', 'T0EXAMPLE01',
                                 '--from', lines[0]['backup']], slack, None, hermes)
    assert code == 0 and out[0]['restored'] is True and slack.manifest == BEFORE


def test_cli_rejects_bad_profile_and_missing_token(hermes, capsys):
    code, lines = run_cli(capsys, ['repair', '--profile', '../x'], CliSlack(BEFORE), None, hermes)
    assert code == 3 and lines[0]['ok'] is False
    code, lines = run_cli(capsys, ['repair', '--profile', 'quiet'], CliSlack(BEFORE), None, hermes)
    assert code == 3 and lines[0]['error'] == 'no_bot_token'


# ---------------------------------------------------------------- status surface

def test_status_reports_missing_scope_without_blocking(tmp_path):
    data = tmp_path / 'slack-connect'
    (data / 'pending').mkdir(parents=True)
    (data / 'apps.json').write_text(json.dumps({'k' * 32: {'profile': 'helper', 'bot_name': 'Helper', 'app_id': 'A1'}}))
    (data / 'pending' / ('k' * 32 + '.json')).write_text(json.dumps({'phase': 'installed', 'team_name': 'Team'}))
    answer = scopes.check_token(FAKE_BOT, opener_for(AUTH_OK, GRANTED_NO_REACTIONS))
    service = Service(tmp_path, 'helper', None, lambda: {'SLACK_BOT_TOKEN': FAKE_BOT}, None, None, None, None,
                      live=lambda env: answer)
    status = service.status()
    assert status['phase'] == 'connected'
    assert status['missing_scopes'] == [{'scope': 'reactions:write', 'reason': 'acknowledge messages with an emoji'}]
    assert 'repair' in status['scope_warning'] and FAKE_BOT not in json.dumps(status)
    plain = Service(tmp_path, 'helper', None, lambda: {}, None, None, None, None, live=lambda env: True).status()
    assert plain['phase'] == 'connected' and 'missing_scopes' not in plain
