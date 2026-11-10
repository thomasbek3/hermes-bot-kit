import importlib.util
import json
import sys
import time
from types import SimpleNamespace
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(BASE / 'dashboard'))
from service import Service

spec = importlib.util.spec_from_file_location('dashboard_test_api', BASE / 'dashboard' / 'plugin_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class Slack:
    class IconUnavailable(Exception):
        pass

    def __init__(self):
        self.calls = []
        self.fail_icon = False
        self.delete_result = {'ok': True}
        self.fail_create = False
        self.unsupported_icon = False
    def rotate(self, value):
        self.calls.append('rotate')
        return {'ok':True, 'team_id':'T1', 'token':'fake-access-next', 'refresh_token':'fake-refresh-next', 'exp':int(time.time())+4000}
    def create(self, token, manifest):
        self.calls.append('create')
        self.created_manifest = manifest
        if self.fail_create:
            raise TimeoutError()
        return {'ok':True, 'app_id':'A1', 'credentials':{'client_id':'C1', 'client_secret':'fake-client-secret', 'signing_secret':'fake-signing-secret'}}
    def set_icon(self, token, app_id, image):
        self.calls.append('icon')
        if self.unsupported_icon:
            raise self.IconUnavailable('missing_scope')
        if self.fail_icon:
            raise RuntimeError()
    def update(self, token, app_id, manifest):
        self.calls.append(('update', app_id))
        return {'ok': True}
    def delete(self, token, app_id):
        self.calls.append(('delete', app_id))
        return self.delete_result


@pytest.fixture
def context(tmp_path, monkeypatch):
    data = tmp_path / 'slack-connect'
    data.mkdir()
    (data / 'state.key').write_bytes(b'k'*32)
    config = data / 'config.json'
    config.write_text(json.dumps({'public_url':'https://example.test/slack','gateway_url':'http://127.0.0.1:8642','relay_bind':'127.0.0.1','relay_port':8655}))
    config.chmod(0o600)
    (data / 'config-tokens.json').write_text(json.dumps({'T1':{'access':'fake-access', 'refresh':'fake-refresh', 'exp':int(time.time())+3600}}))
    slack, vault, env, notifications = Slack(), None, {}, []
    def save(values): env.update(values)
    def remove(keys):
        for key in keys: env.pop(key, None)
    lifecycle = SimpleNamespace(install=lambda: None, remove=lambda: None)
    service = api.service_module.Service(tmp_path, 'test-profile', slack, lambda: dict(env), save, remove, lambda: notifications.append(True), lambda: b'fake-png', lifecycle=lifecycle)
    monkeypatch.setattr(api, 'make_service', lambda: service)
    monkeypatch.setattr(api, 'homes', lambda: (tmp_path, tmp_path / 'profiles/test-profile'))
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        yield client, slack, vault, env, data, notifications


def test_bootstrap_valid_unknown_traversal_and_idempotence(tmp_path, monkeypatch):
    from types import ModuleType
    root = tmp_path / 'root'
    profile = root / 'profiles' / 'test-profile'
    profile.mkdir(parents=True)
    monkeypatch.setattr(api, 'homes', lambda: (root, root))
    module = ModuleType('pm.environments')
    module.project_python = lambda project: project / 'venv/bin/python'
    monkeypatch.setitem(sys.modules, 'pm.environments', module)
    calls = []
    monkeypatch.setattr(api.subprocess, 'run', lambda argv, **kwargs: calls.append((argv, kwargs)) or SimpleNamespace(returncode=0))
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        assert client.get('/status').json()['mode'] == 'bootstrap'
        for _ in range(2):
            assert client.post('/bootstrap', json={'profile': 'test-profile'}).json() == {'ok': True}
        assert client.post('/bootstrap', json={'profile': 'unknown'}).status_code == 404
        assert client.post('/bootstrap', json={'profile': '../test-profile'}).status_code == 400
        (root / 'profiles' / 'alias').symlink_to(profile, target_is_directory=True)
        assert client.post('/bootstrap', json={'profile': 'alias'}).status_code == 404
    assert len(calls) == 2
    assert all(call[1]['env']['HERMES_HOME'] == str(profile) for call in calls)


def test_routes_connect_status_delete(context):
    client, slack, vault, env, data, notifications = context
    assert client.get('/workspaces').json()[0]['team_id'] == 'T1'
    assert client.get('/status').json()['phase'] == 'none'
    result = client.post('/connect', json={'team_id':'T1','bot_name':'Test'})
    assert result.status_code == 200 and result.json()['authorize_url'].startswith('https://slack.com/oauth/v2/authorize?')
    assert slack.calls[:2] == ['create','icon']
    assert slack.calls.count(('update', 'A1')) == 1
    status = client.get('/status').json()
    assert status['phase'] == 'created'
    assert status['icon_result'] == 'ok' and status['manifest_update_result'] == 'ok'
    assert client.post('/connect', json={'team_id':'T1','bot_name':'Test'}).status_code == 409
    assert client.delete('/connect').json() == {'ok':True}
    assert not env and notifications == [True]
    assert ('delete','A1') in slack.calls
    assert json.loads((data / 'apps.json').read_text()) == {}


def test_socket_mode_is_never_changed(context):
    client, slack, vault, env, _, _ = context
    env['SLACK_APP_TOKEN'] = 'fake-existing-app'
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 409
    assert client.delete('/connect').status_code == 409
    assert slack.calls == [] and env['SLACK_APP_TOKEN'] == 'fake-existing-app'


def test_reload_precedes_creation_and_failure_is_reported(context):
    client, slack, _, env, data, _ = context
    service = api.make_service()
    def refused():
        raise api.platform_module.GatewayReloadError('Gateway refused or did not answer the plugin reload')
    service.lifecycle.install = refused
    response = client.post('/connect', json={'team_id':'T1'})
    assert response.status_code == 503 and 'Gateway refused' in response.json()['detail']
    assert slack.calls == [] and env == {}
    assert json.loads((data / 'apps.json').read_text()) == {}


def test_selection_uses_hermes_application_python_not_host_interpreter(tmp_path, monkeypatch):
    from types import ModuleType
    module = ModuleType('pm.environments')
    module.project_python = lambda project: project / 'selected-env/bin/python'
    monkeypatch.setitem(sys.modules, 'pm.environments', module)
    calls = []
    monkeypatch.setattr(api.subprocess, 'run', lambda argv, **kwargs: calls.append((argv, kwargs)) or SimpleNamespace(returncode=0))
    root, home = tmp_path / 'root', tmp_path / 'root/profiles/test-profile'
    api.set_platform_enabled(home, root, True)
    argv, kwargs = calls[0]
    assert argv[0] == str(root / 'hermes-agent/selected-env/bin/python')
    assert argv[-1] == 'enable' and kwargs['env']['HERMES_HOME'] == str(home)
    assert kwargs['env']['HERMES_DISABLE_LAZY_INSTALLS'] == '1'


def test_removal_retry_after_reload_failure(context):
    client, slack, _, env, data, _ = context
    service = api.make_service()
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    def refused():
        raise api.platform_module.GatewayReloadError('Gateway refused or did not answer the plugin reload')
    service.lifecycle.remove = refused
    assert client.delete('/connect').status_code == 503
    assert env == {} and len(json.loads((data / 'apps.json').read_text())) == 1
    service.lifecycle.remove = lambda: None
    slack.delete_result = {'ok':False, 'error':'app_not_found'}
    assert client.delete('/connect').json() == {'ok':True}
    assert json.loads((data / 'apps.json').read_text()) == {}


def test_removal_recycles_live_profile_and_retries_after_failure(context):
    client, slack, _, env, data, _ = context
    service = api.make_service()
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    calls = []
    env['SLACK_BOT_TOKEN'] = 'fake-bot-token'
    service.check_idle = lambda: calls.append('idle')
    def recycle():
        assert 'SLACK_APP_ID' not in env
        calls.append('recycle')
        if calls.count('recycle') == 1:
            raise api.platform_module.GatewayReloadError('retry')
    service.recycle_profile = recycle
    assert client.delete('/connect').status_code == 503
    assert list(json.loads((data / 'apps.json').read_text()).values())[0]['recycle_pending'] is True
    slack.delete_result = {'ok':False, 'error':'app_not_found'}
    assert client.delete('/connect').status_code == 200
    assert calls == ['idle', 'recycle', 'idle', 'recycle']
    assert json.loads((data / 'apps.json').read_text()) == {}


def test_busy_bot_is_not_removed(context):
    client, slack, _, env, _, _ = context
    service = api.make_service()
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    env['SLACK_BOT_TOKEN'] = 'fake-bot-token'
    def busy():
        raise api.platform_module.GatewayReloadError('Wait for this bot to finish its work')
    service.check_idle = busy
    assert client.delete('/connect').status_code == 503
    assert ('delete', 'A1') not in slack.calls and 'SLACK_APP_ID' in env


def test_icon_failure_rolls_back_created_app(context):
    client, slack, _, env, data, _ = context
    slack.fail_icon = True
    result = client.post('/connect', json={'team_id':'T1','bot_name':'Test'})
    assert result.status_code == 503 and ('delete','A1') in slack.calls
    assert env == {} and json.loads((data / 'apps.json').read_text()) == {}


def test_failed_rollback_keeps_app_identity(context):
    client, slack, _, _, data, _ = context
    slack.fail_icon = True
    slack.delete_result = {'ok':False, 'error':'unavailable'}
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 503
    assert list(json.loads((data / 'apps.json').read_text()).values())[0]['app_id'] == 'A1'


def test_delete_not_found_is_success(context):
    client, slack, _, env, _, _ = context
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    slack.delete_result = {'ok':False, 'error':'app_not_found'}
    assert client.delete('/connect').json() == {'ok':True} and not env


def test_ambiguous_create_cannot_be_retried(context):
    client, slack, _, _, data, _ = context
    slack.fail_create = True
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 503
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 409
    assert slack.calls.count('create') == 1
    assert list(json.loads((data / 'apps.json').read_text()).values())[0].get('app_id') is None


def test_explicit_slack_refusal_is_plain_and_can_be_retried(context):
    client, slack, _, env, data, _ = context
    slack.create = lambda *_: {'ok': False, 'error': 'not_allowed'}
    response = client.post('/connect', json={'team_id':'T1'})
    assert response.status_code == 409
    assert response.json()['detail'] == 'Slack refused to create the app. Check workspace permissions and try again.'
    assert json.loads((data / 'apps.json').read_text()) == {} and not env


def test_add_workspace_commits_pair_before_return(context):
    client, slack, _, _, data, _ = context
    result = client.post('/workspaces', json={'refresh_token':'xoxe-fake-refresh'})
    assert result.json() == {'team_id':'T1'}
    entry = json.loads((data / 'config-tokens.json').read_text())['T1']
    assert entry['refresh'] == 'fake-refresh-next'
    assert not (data / 'workspace-rotation-pending.json').exists()


def test_unsupported_icon_keeps_app(context, caplog):
    caplog.set_level('INFO')
    client, slack, _, _, _, _ = context
    slack.unsupported_icon = True
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    assert slack.calls.count('icon') == 1 and ('delete', 'A1') not in slack.calls
    assert 'Slack app icon unavailable: missing_scope' in caplog.text
    assert client.get('/status').json()['icon_result'] == 'missing_scope'


def test_manifest_update_runs_after_secret_and_mapping_exist(context, caplog):
    client, slack, _, env, data, _ = context
    def update(token, app_id, manifest):
        assert env['SLACK_SIGNING_SECRET'] == 'fake-signing-secret'
        assert next(iter(json.loads((data / 'apps.json').read_text()).values()))['app_id'] == app_id
        assert manifest == slack.created_manifest
        return {'ok': False, 'error': 'invalid_auth'}
    slack.update = update
    caplog.set_level('INFO')
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    assert 'Slack manifest update: invalid_auth' in caplog.text
    assert client.get('/status').json()['manifest_update_result'] == 'invalid_auth'


def test_rejected_refresh_reports_expired(context):
    client, slack, _, _, _, _ = context
    slack.rotate = lambda _: {'ok':False, 'error':'invalid_refresh_token'}
    response = client.post('/workspaces', json={'refresh_token':'xoxe-fake-refresh'})
    assert response.status_code == 409
    assert response.json()['detail'] == 'Slack setup token expired, add a new one'


def test_json_never_contains_token_shapes(context):
    client, slack, _, env, _, _ = context
    env['SLACK_CLIENT_SECRET'] = 'xoxe.fake-secret'
    bodies = [client.get('/workspaces').text, client.get('/status').text]
    bodies.append(client.post('/connect', json={'team_id':'T1'}).text)
    bodies.append(client.delete('/connect').text)
    assert all('xoxe' not in body and 'xoxb-' not in body and 'xapp-' not in body and 'fake-client-secret' not in body for body in bodies)


def test_installed_only_becomes_connected_with_live_proof(context):
    client, _, _, env, data, _ = context
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    record = next(iter(json.loads((data / 'apps.json').read_text())))
    (data / 'pending' / (record + '.json')).write_text(json.dumps({'phase':'installed','team_name':'Team'}))
    assert client.get('/status').json()['phase'] == 'installed'
    api.make_service().live = lambda _: True
    assert client.get('/status').json()['phase'] == 'connected'


def test_delete_preserves_preexisting_allowed_users(context):
    client, _, _, env, _, _ = context
    env['SLACK_ALLOWED_USERS'] = 'U1'
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    env['SLACK_ALLOWED_USERS'] = 'U1'
    assert client.delete('/connect').status_code == 200
    assert env == {'SLACK_ALLOWED_USERS':'U1'}


def test_invalid_request_never_echoes_input(context):
    client, *_ = context
    value = 'xoxe-fake-secret-value'
    for body in ([value], {'refresh_token':[value]}, {'team_id':[value]}):
        path = '/connect' if isinstance(body, dict) and 'team_id' in body else '/workspaces'
        response = client.post(path, json=body)
        assert response.status_code == 400 and value not in response.text


def test_live_probe_signs_challenge_and_checks_echo():
    import hashlib, hmac
    class Response:
        status = 200
        def __init__(self, body): self.body = body
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, limit): return self.body
    def opener(request, timeout):
        assert request.full_url == 'http://127.0.0.1:8642/p/test-profile/slack/events'
        assert timeout == 2.5
        timestamp = request.get_header('X-slack-request-timestamp')
        expected = 'v0=' + hmac.new(b'fake-signing', b'v0:' + timestamp.encode() + b':' + request.data, hashlib.sha256).hexdigest()
        assert request.get_header('X-slack-signature') == expected
        return Response(json.dumps({'challenge':json.loads(request.data)['challenge']}).encode())
    assert api.http_adapter_ready('test-profile', 'fake-signing', 'http://127.0.0.1:8642', opener)
    assert not api.http_adapter_ready('../other', 'fake-signing', 'http://127.0.0.1:8642', opener)
    assert not api.http_adapter_ready('test-profile', '', 'http://127.0.0.1:8642', opener)
    assert not api.http_adapter_ready('test-profile', 'fake-signing', 'http://127.0.0.1:8642', lambda *a, **k: (_ for _ in ()).throw(OSError()))


def test_slack_icon_error_name_is_preserved_without_credentials():
    from slack_api import SlackAPI
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, *args): return b'{"ok":false,"error":"missing_scope"}'
    api = SlackAPI(opener=lambda *args, **kwargs: Response())
    with pytest.raises(api.IconUnavailable, match='^missing_scope$'):
        api.set_icon('fake-token', 'A1', b'png')


def test_readiness_missing_config_relay_public_and_workspace(tmp_path, monkeypatch):
    root = tmp_path
    assert api.readiness(root)['missing'] == 'config'
    data = root / 'slack-connect'
    data.mkdir()
    config = data / 'config.json'
    config.write_text(json.dumps({'public_url': 'https://example.test/slack', 'gateway_url': 'http://127.0.0.1:8642', 'relay_bind': '127.0.0.1', 'relay_port': 8655}))
    config.chmod(0o600)
    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, _): return b'ok'
    def offline(url, timeout):
        raise OSError()
    assert api.readiness(root, offline)['missing'] == 'relay'
    def public_offline(url, timeout):
        if url.startswith('https:'): raise OSError()
        return Response()
    assert api.readiness(root, public_offline)['missing'] == 'public_url'
    monkeypatch.setattr(api, 'workspace_service', lambda: SimpleNamespace(workspaces=lambda: []))
    ready = api.readiness(root, lambda *args, **kwargs: Response())
    assert ready == {'ready': False, 'infrastructure_ready': True, 'workspace_ready': False, 'missing': 'workspace_token'}
    monkeypatch.setattr(api, 'workspace_service', lambda: SimpleNamespace(workspaces=lambda: [{'ok': True}]))
    assert api.readiness(root, lambda *args, **kwargs: Response())['ready'] is True


class Switch:
    """Fake platforms.slack.enabled: None = key absent."""
    def __init__(self, value):
        self.value, self.calls = value, []
    def is_off(self):
        self.calls.append('get')
        return self.value is False
    def set(self, enabled):
        self.calls.append(('set', enabled))
        self.value = enabled


def with_switch(value):
    switch = Switch(value)
    api.make_service().slack_switch = switch
    return switch


def apps_entry(data):
    return next(iter(json.loads((data / 'apps.json').read_text()).values()))


def test_connect_turns_explicitly_disabled_slack_on_and_records_it(context):
    client, _, _, _, data, _ = context
    switch = with_switch(False)
    order = []
    api.make_service().lifecycle.install = lambda: order.append(switch.value)
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    assert switch.value is True and order == [True]
    assert apps_entry(data)['prior_slack_enabled'] is False


@pytest.mark.parametrize('value', [None, True])
def test_connect_leaves_absent_or_enabled_slack_alone(context, value):
    client, _, _, _, data, _ = context
    switch = with_switch(value)
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    assert switch.calls == ['get'] and switch.value is value
    assert 'prior_slack_enabled' not in apps_entry(data)
    assert client.delete('/connect').status_code == 200
    assert switch.calls == ['get']


def test_connect_rollbacks_restore_disabled_slack(context):
    client, slack, _, env, data, _ = context
    service = api.make_service()
    # Gateway reload refused.
    switch = with_switch(False)
    def refused():
        raise api.platform_module.GatewayReloadError('Gateway refused or did not answer the plugin reload')
    service.lifecycle.install = refused
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 503
    assert switch.value is False and switch.calls == ['get', ('set', True), ('set', False)]
    assert json.loads((data / 'apps.json').read_text()) == {}
    service.lifecycle.install = lambda: None
    # Slack refused to create the app.
    switch = with_switch(False)
    create = slack.create
    slack.create = lambda *_: {'ok': False, 'error': 'not_allowed'}
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 409
    assert switch.value is False and json.loads((data / 'apps.json').read_text()) == {}
    slack.create = create
    # Created app rolled back after a later failure.
    switch = with_switch(False)
    slack.fail_icon = True
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 503
    assert ('delete', 'A1') in slack.calls and env == {}
    assert switch.value is False and json.loads((data / 'apps.json').read_text()) == {}


def test_remove_restores_disabled_slack(context):
    client, _, _, env, data, _ = context
    switch = with_switch(False)
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    assert switch.value is True
    assert client.delete('/connect').json() == {'ok': True}
    assert switch.value is False and switch.calls[-1] == ('set', False)
    assert json.loads((data / 'apps.json').read_text()) == {} and not env


def test_remove_keeps_record_when_restore_fails(context):
    client, _, _, _, data, _ = context
    switch = with_switch(False)
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    def broken(enabled):
        raise api.platform_module.GatewayReloadError("Could not change this bot's Slack setting.")
    switch.set = broken
    assert client.delete('/connect').status_code == 503
    assert apps_entry(data)['prior_slack_enabled'] is False
    switch.set = Switch.set.__get__(switch)
    assert client.delete('/connect').status_code == 200
    assert switch.value is False


def test_slack_switch_runs_hermes_python_isolated_without_values_in_output(tmp_path, monkeypatch):
    from types import ModuleType
    module = ModuleType('pm.environments')
    module.project_python = lambda project: project / 'selected-env/bin/python'
    monkeypatch.setitem(sys.modules, 'pm.environments', module)
    calls, codes = [], [3, 0, 0, 7]
    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return SimpleNamespace(returncode=codes.pop(0))
    root, home = tmp_path / 'root', tmp_path / 'root/profiles/test-profile'
    switch = api.SlackSwitch(home, root, run)
    assert switch.is_off() is True
    assert switch.is_off() is False
    switch.set(True)
    with pytest.raises(api.platform_module.GatewayReloadError):
        switch.is_off()
    for argv, kwargs in calls:
        assert argv[0] == str(root / 'hermes-agent/selected-env/bin/python') and argv[1] == '-I'
        assert argv[2].endswith('slack_switch.py') and argv[3] == str(root / 'hermes-agent')
        assert kwargs['env']['HERMES_HOME'] == str(home)
        assert kwargs['stdout'] is api.subprocess.DEVNULL and kwargs['stderr'] is api.subprocess.DEVNULL
    assert calls[2][0][4:] == ['set', 'true']


def test_slack_switch_script_reads_only_explicit_false(tmp_path):
    import subprocess as sp
    agent = tmp_path / 'agent'
    agent.mkdir()
    (agent / 'hermes_constants.py').write_text('import os\ndef get_hermes_home():\n    return os.environ["HERMES_HOME"]\n')
    home = tmp_path / 'home'
    home.mkdir()
    script = BASE / 'dashboard' / 'slack_switch.py'
    def get(text):
        if text is None:
            (home / 'config.yaml').unlink(missing_ok=True)
        else:
            (home / 'config.yaml').write_text(text)
        result = sp.run([sys.executable, str(script), str(agent), 'get'], env={'HERMES_HOME': str(home), 'PATH': ''},
                        capture_output=True, text=True)
        assert result.stdout == '' and result.stderr == ''
        return result.returncode
    pytest.importorskip('yaml')
    assert get(None) == 0
    assert get('model: x\n') == 0
    assert get('platforms:\n  slack:\n    extra:\n      rich_blocks: true\n') == 0
    assert get('platforms:\n  slack:\n    enabled: true\n') == 0
    assert get('platforms:\n  slack:\n    enabled: false\n    extra:\n      rich_blocks: true\n') == 3
    assert get('platforms:\n  slack:\n    enabled: "false"\n') == 3
