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
    home_env = f'{tmp_path}/profiles/test-profile/.env'
    service = api.service_module.Service(tmp_path, 'test-profile', slack, lambda: dict(env), save, remove, lambda: notifications.append(True), lambda: b'fake-png', lifecycle=lifecycle,
                                         gate_scope=lambda: api.service_module.access_module.scope_from_env(dict(env), home_env))
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
    assert client.post('/remove', json={'confirm': True}).status_code == 503
    assert list(json.loads((data / 'apps.json').read_text()).values())[0]['recycle_pending'] is True
    slack.delete_result = {'ok':False, 'error':'app_not_found'}
    assert client.post('/remove', json={'confirm': True}).status_code == 200
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
    assert client.post('/remove', json={'confirm': True}).status_code == 503
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


def was_off(data):
    return any((data / 'slack-was-off').glob('*'))


def apps_entry(data):
    return next(iter(json.loads((data / 'apps.json').read_text()).values()))


def test_connect_turns_explicitly_disabled_slack_on_and_records_it(context):
    client, _, _, _, data, _ = context
    switch = with_switch(False)
    order = []
    api.make_service().lifecycle.install = lambda: order.append(switch.value)
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    assert switch.value is True and order == [True]
    assert was_off(data)


@pytest.mark.parametrize('value', [None, True])
def test_connect_leaves_absent_or_enabled_slack_alone(context, value):
    client, _, _, _, data, _ = context
    switch = with_switch(value)
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    assert switch.calls == ['get'] and switch.value is value
    assert not was_off(data)
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
    assert was_off(data)
    switch.set = Switch.set.__get__(switch)
    assert client.delete('/connect').status_code == 200
    assert switch.value is False and not was_off(data)


def test_failed_rollback_restore_keeps_the_off_record_for_remove_and_reconnect(context):
    client, _, _, _, data, _ = context
    service = api.make_service()
    switch = with_switch(False)
    def refused():
        raise api.platform_module.GatewayReloadError('Gateway refused or did not answer the plugin reload')
    service.lifecycle.install = refused
    def broken(enabled):
        if enabled is False:
            raise OSError('config write failed')
        switch.value = enabled
    switch.set = broken
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 503
    # The app record is gone, Slack is still on, but the off record survives.
    assert json.loads((data / 'apps.json').read_text()) == {}
    assert switch.value is True and was_off(data)
    # A later Connect still knows Slack was off originally, even though it now reads on.
    service.lifecycle.install = lambda: None
    switch.set = Switch.set.__get__(switch)
    assert client.post('/connect', json={'team_id':'T1'}).status_code == 200
    assert was_off(data)
    assert client.delete('/connect').status_code == 200
    assert switch.value is False and not was_off(data)


def test_remove_without_an_app_retries_a_failed_rollback_restore(context):
    client, _, _, _, data, _ = context
    switch = with_switch(True)
    marker = data / 'slack-was-off' / 'test-profile'
    marker.parent.mkdir()
    marker.write_text('off\n')
    assert client.delete('/connect').status_code == 200
    assert switch.value is False and not marker.exists()


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


def _installed(data, env, ids, access='members', owner='U1', **record):
    key = 'c' * 32
    (data / 'pending').mkdir(exist_ok=True)
    item = {'profile': 'test-profile', 'app_id': 'A1', 'team_id': 'T1', 'bot_name': 'Helper', 'access': access,
            'access_rev': 1, 'owner': owner, 'installed_at': 1, **record}
    (data / 'apps.json').write_text(json.dumps({key: {k: v for k, v in item.items() if v is not None}}))
    (data / 'pending' / (key + '.json')).write_text(json.dumps({'phase': 'installed', 'at': 1}))
    env.update({'SLACK_APP_ID': 'A1', 'SLACK_BOT_TOKEN': 'fake-bot', 'SLACK_TEAM_NAME': 'Acme', 'SLACK_ALLOWED_USERS': ','.join(ids)})
    return key


def _record(data):
    return json.loads((data / 'apps.json').read_text())['c' * 32]


def test_connect_rejects_unknown_access_and_empty_list(context):
    client, slack, vault, env, data, _ = context
    assert client.post('/connect', json={'team_id': 'T1', 'access': 'everyone'}).status_code == 400
    assert client.post('/connect', json={'team_id': 'T1', 'access': 'list', 'allowed': ''}).status_code == 400
    assert client.post('/connect', json={'team_id': 'T1', 'access': 'list', 'allowed': 'bad id'}).status_code == 400


def test_connect_stores_the_access_explicitly(context):
    client, slack, vault, env, data, _ = context
    assert client.post('/connect', json={'team_id': 'T1'}).status_code == 200
    item = next(iter(json.loads((data / 'apps.json').read_text()).values()))
    assert item['access'] == 'members' and item['access_rev'] == 1 and item['synced_at'] is None


def test_status_tells_the_effective_audience_and_every_grant(context, tmp_path):
    client, slack, vault, env, data, _ = context
    _installed(data, env, ['U1', 'U2'], synced_at=int(time.time()))
    body = client.get('/status').json()
    assert body['access'] == 'members' and body['owner_known'] is True and 'legacy' not in body
    assert body['audience']['text'] == '2 people can talk to this bot: the 2 full members of Acme.'
    assert body['audience']['people'] == 2 and 'ids' not in body['audience']
    assert body['audience']['grants'] == [] and body['audience']['sync']['text'].startswith('Member list read ')
    env['SLACK_ALLOW_ALL_USERS'] = 'true'
    pairing = tmp_path / 'profiles' / 'test-profile' / 'platforms' / 'pairing'
    pairing.mkdir(parents=True)
    (pairing / 'slack-approved.json').write_text(json.dumps({'U9': {}}))
    body = client.get('/status').json()
    assert body['audience']['open'] is True and 'including guests' in body['audience']['text']
    grants = {g['what']: g for g in body['audience']['grants']}
    assert set(grants) == {'SLACK_ALLOW_ALL_USERS=true', 'Slack pairing approvals'}
    assert grants['Slack pairing approvals']['how_to_change'].startswith('hermes -p test-profile pairing revoke slack')
    assert grants['SLACK_ALLOW_ALL_USERS=true']['source'] == f'{tmp_path}/profiles/test-profile/.env'


def test_there_is_no_remove_the_extra_access_route(context):
    client, *_ = context
    assert client.post('/access/fix', json={}).status_code in (404, 405)


def test_set_access_owner_list_and_members(context):
    client, slack, vault, env, data, _ = context
    _installed(data, env, ['U1', 'U2'])
    body = client.post('/access', json={'access': 'owner'}).json()
    assert env['SLACK_ALLOWED_USERS'] == 'U1' and body['audience']['text'] == 'Only you can talk to this bot.'
    assert _record(data)['access_rev'] == 2
    slack.users_list = lambda token: [{'id': 'U1', 'team_id': 'T1'}, {'id': 'U3', 'team_id': 'T1'},
                                      {'id': 'U4', 'team_id': 'T1', 'is_restricted': True}]
    body = client.post('/access', json={'access': 'members'}).json()
    assert env['SLACK_ALLOWED_USERS'] == 'U1,U3' and body['access'] == 'members'
    assert _record(data)['last_members_owner_ok'] is True and _record(data)['access_rev'] == 3
    body = client.post('/access', json={'access': 'list', 'allowed': 'U7, U8'}).json()
    assert env['SLACK_ALLOWED_USERS'] == 'U1,U7,U8' and 'the 3 people you named' in body['audience']['text']


def test_set_access_members_when_slack_fails(context):
    client, slack, vault, env, data, _ = context
    _installed(data, env, ['U1', 'U2'], access='list', allowed='U2', last_members_owner_ok=True)
    def refused(token):
        raise api.service_module.access_module.SlackReadError('missing_scope')
    slack.users_list = refused
    body = client.post('/access', json={'access': 'members'}).json()
    # No verified list yet: only the installer, because Slack last said they are a member.
    assert env['SLACK_ALLOWED_USERS'] == 'U1'
    assert body['audience']['sync']['error'] == 'the app lacks the users:read permission'
    assert body['audience']['sync']['text'].startswith('Member list never read')


def test_legacy_record_is_shown_and_kept_until_the_owner_chooses(context):
    client, slack, vault, env, data, _ = context
    # An earlier release wrote no installed_at, access or owner. Its list was
    # edited to two people since, so the installer cannot be told from it.
    _installed(data, env, ['U1', 'U2'], access=None, access_rev=None, owner=None, installed_at=None)
    body = client.get('/status').json()
    assert body['access'] == 'legacy' and body['owner_known'] is False
    assert body['legacy']['ids'] == ['U1', 'U2']
    assert body['legacy']['text'] == 'Allowed now: U1, U2 (from the earlier version)'
    assert body['audience']['text'] == '2 people can talk to this bot: the 2 people in SLACK_ALLOWED_USERS.'
    assert env['SLACK_ALLOWED_USERS'] == 'U1,U2', 'nothing rewrote it'
    assert client.post('/access', json={'access': 'owner'}).json()['detail'] == (
        'The installer of this bot is not known. To choose Only me, reconnect the bot.'), 'Only me needs a known installer'
    body = client.post('/access', json={'access': 'list', 'allowed': 'U1,U2'}).json()   # Keep these people
    assert body['access'] == 'list' and env['SLACK_ALLOWED_USERS'] == 'U1,U2'
    assert _record(data)['access'] == 'list' and _record(data)['access_rev'] == 1


# What v2026.11.16.3 (the published release) left behind for a connected bot,
# copied from its code: the record from slack-connect/dashboard/service.py:157-158
# (apps[key] = {...}), :192-193 (app_id, icon_result) and :209
# (manifest_update_result); the pending file from slack-relay/relay.py:234
# (self.pending(key, 'installed', team_name=..., bot_user_id=...)); the .env from
# service.py:187-189 (save_env) and relay.py:229 (write_profile, the installer
# as the only SLACK_ALLOWED_USERS). No installed_at, access, access_rev or owner.
PUBLISHED_RECORD = {'profile': 'test-profile', 'team_id': 'T1', 'bot_name': 'Helper', 'prior_allowed_users': None,
                    'app_id': 'A1', 'icon_result': 'ok', 'manifest_update_result': 'ok'}
PUBLISHED_PENDING = {'phase': 'installed', 'at': 1763300000, 'team_name': 'Acme', 'bot_user_id': 'B1'}
PUBLISHED_ENV = {'SLACK_CONNECTION_MODE': 'http', 'SLACK_APP_ID': 'A1', 'SLACK_CLIENT_ID': 'C1',
                 'SLACK_CLIENT_SECRET': 'fake-client-secret', 'SLACK_SIGNING_SECRET': 'fake-signing-secret',
                 'SLACK_BOT_TOKEN': 'xoxb-FAKE-bot', 'SLACK_TEAM_ID': 'T1', 'SLACK_TEAM_NAME': 'Acme',
                 'SLACK_ALLOWED_USERS': 'U1'}


def _published(data, env, **env_changes):
    (data / 'pending').mkdir(exist_ok=True)
    (data / 'apps.json').write_text(json.dumps({'c' * 32: PUBLISHED_RECORD}))
    (data / 'pending' / ('c' * 32 + '.json')).write_text(json.dumps(PUBLISHED_PENDING))
    env.update({**PUBLISHED_ENV, **env_changes})


def test_a_published_release_connection_is_migrated_and_its_audience_can_change(context):
    client, slack, vault, env, data, _ = context
    _published(data, env)
    body = client.get('/status').json()
    assert body['phase'] == 'installed' and body['access'] == 'legacy'
    # Round 6: a single ID is never taken as the installer.
    assert body['owner_known'] is False, 'no owner recorded by a Connect: Only me is not offered'
    assert body['legacy']['text'] == 'Allowed now: U1 (from the earlier version)'
    rec = _record(data)
    assert type(rec['installed_at']) is int and rec['migrated'] is True and 'owner' not in rec
    assert 'access' not in rec and 'access_rev' not in rec, 'migration never chooses an audience'
    assert env['SLACK_ALLOWED_USERS'] == 'U1'
    response = client.post('/access', json={'access': 'owner'})
    assert response.status_code == 409 and response.json()['detail'] == (
        'The installer of this bot is not known. To choose Only me, reconnect the bot.')
    assert env['SLACK_ALLOWED_USERS'] == 'U1' and 'access' not in _record(data), 'the list unchanged'
    response = client.post('/access', json={'access': 'list', 'allowed': 'U1'})   # Keep these people
    assert response.status_code == 200 and env['SLACK_ALLOWED_USERS'] == 'U1', 'exactly that ID kept'
    assert (_record(data)['access'], _record(data)['allowed'], _record(data)['access_rev']) == ('list', 'U1', 1)
    response = client.post('/access', json={'access': 'list', 'allowed': 'U2'})
    assert response.status_code == 200 and env['SLACK_ALLOWED_USERS'] == 'U2', 'the allowlist changed'


def test_a_record_of_another_app_is_not_a_connection(context):
    client, slack, vault, env, data, _ = context
    _published(data, env, SLACK_APP_ID='A2')   # this profile's .env belongs to another app
    response = client.post('/access', json={'access': 'list', 'allowed': 'U2'})
    assert response.status_code == 409 and response.json()['detail'] == 'Connect the bot to Slack first'
    client.get('/status')
    assert _record(data) == PUBLISHED_RECORD, 'not migrated'
    assert env['SLACK_ALLOWED_USERS'] == 'U1'


def test_a_save_that_hermes_silently_refused_commits_nothing(context):
    client, slack, vault, env, data, _ = context
    _installed(data, env, ['U1', 'U2'])
    before = _record(data)
    api.make_service().save_env = lambda values: None   # save_env_value printed a refusal and returned
    response = client.post('/access', json={'access': 'owner'})
    assert response.status_code == 409
    assert response.json()['detail'] == 'Hermes kept SLACK_ALLOWED_USERS=U1,U2 (administrator-managed?)'
    assert _record(data) == before and env['SLACK_ALLOWED_USERS'] == 'U1,U2'


def test_a_refusal_from_require_env_writable_fails_the_save_and_names_it(context):
    client, slack, vault, env, data, _ = context
    _installed(data, env, ['U1', 'U2'])
    before = _record(data)
    refusal = ('Cannot set SLACK_ALLOWED_USERS: it is managed by your administrator (/etc/hermes/.env) '
               'and cannot be changed.')
    def require_env_writable(key, action):
        assert action == 'set'
        if key == 'SLACK_ALLOWED_USERS':
            raise ValueError(refusal)
    written = []
    save = api.env_saver(lambda key, value: written.append(key),
                         SimpleNamespace(require_env_writable=require_env_writable))
    api.make_service().save_env = save
    response = client.post('/access', json={'access': 'owner'})
    assert response.status_code == 409 and response.json()['detail'] == refusal
    assert written == [] and _record(data) == before and env['SLACK_ALLOWED_USERS'] == 'U1,U2'
    # Older Hermes has no require_env_writable: the save goes straight through.
    api.env_saver(lambda key, value: written.append(key), SimpleNamespace())({'SLACK_ALLOWED_USERS': 'U1'})
    assert written == ['SLACK_ALLOWED_USERS']


def test_set_access_with_a_failed_save_leaves_the_record_as_it_was(context):
    client, slack, vault, env, data, _ = context
    _installed(data, env, ['U1', 'U2'])
    before = _record(data)
    def broken(values):
        raise OSError('disk full')
    api.make_service().save_env = broken
    response = client.post('/access', json={'access': 'list', 'allowed': 'U7'})
    assert response.status_code == 503 and 'disk full' not in response.text
    after = _record(data)
    assert after == before, 'mode, list and revision move only with the .env'
    assert (after['access'], after.get('allowed'), after['access_rev']) == ('members', None, 1)
    assert env['SLACK_ALLOWED_USERS'] == 'U1,U2'


def test_audience_route_is_local_only_and_status_stays_live(context):
    client, slack, vault, env, data, _ = context
    _installed(data, env, ['U1', 'U2'], synced_at=int(time.time()), welcome='failed', welcome_error='channel_not_found')
    live_checks = []
    api.make_service().live = lambda _env: live_checks.append(1) or True
    def users_list(token):
        raise AssertionError('no Slack call')
    slack.users_list = users_list
    body = client.get('/audience').json()
    assert live_checks == [] and slack.calls == [], 'the 20 s poll makes no Slack call'
    assert body['audience']['text'] == '2 people can talk to this bot: the 2 full members of Acme.'
    assert body['phase'] == 'installed' and 'readiness' not in body
    assert (body['welcome'], body['welcome_error']) == ('failed', 'channel_not_found')
    assert client.get('/status').json()['phase'] == 'connected' and live_checks == [1], 'open and Test connection stay live'


# ---- round 6: Cancel never deletes an installed app; read-back is authoritative

@pytest.mark.parametrize('phase', ['installed', 'error', 'created', 'denied'])
def test_cancel_never_deletes_an_upgraded_app_with_an_installed_token(context, phase):
    client, slack, vault, env, data, _ = context
    _published(data, env)
    (data / 'pending' / ('c' * 32 + '.json')).write_text(json.dumps({**PUBLISHED_PENDING, 'phase': phase}))
    assert client.get('/status').json()['token_installed'] is True
    response = client.delete('/connect')
    assert response.status_code == 409 and response.json()['detail'] == 'This Slack app is installed; use Remove from Slack'
    assert not any(isinstance(c, tuple) and c[0] == 'delete' for c in slack.calls), 'no delete call'
    assert env['SLACK_BOT_TOKEN'] == 'xoxb-FAKE-bot' and 'c' * 32 in json.loads((data / 'apps.json').read_text())


def test_remove_needs_an_explicit_confirm(context):
    client, slack, vault, env, data, notifications = context
    _installed(data, env, ['U1'])
    for body in ({}, {'confirm': False}, {'confirm': 'yes'}):
        response = client.post('/remove', json=body)
        assert response.status_code == 409 and response.json()['detail'] == 'Confirm removing this Slack app'
    assert ('delete', 'A1') not in slack.calls and 'SLACK_BOT_TOKEN' in env
    assert client.post('/remove', json={'confirm': True}).json() == {'ok': True}
    assert ('delete', 'A1') in slack.calls and 'SLACK_BOT_TOKEN' not in env
    assert json.loads((data / 'apps.json').read_text()) == {}


def test_a_stale_error_record_with_a_working_token_reads_as_installed(context):
    client, slack, vault, env, data, _ = context
    _published(data, env)
    pending_path = data / 'pending' / ('c' * 32 + '.json')
    pending_path.write_text(json.dumps({'phase': 'error', 'at': 1763300000}))   # the welcome DM failed
    checks = []
    api.make_service().auth_test = lambda token: checks.append(token) or {'ok': True, 'team_id': 'T1'}
    assert client.get('/audience').json()['phase'] == 'error' and checks == [], 'never on the 20 s poll'
    assert 'installed_at' not in _record(data)
    body = client.get('/status').json()
    assert checks == ['xoxb-FAKE-bot'] and body['phase'] == 'installed' and body['team_name'] == 'Acme'
    assert type(_record(data)['installed_at']) is int and _record(data)['migrated'] is True
    assert json.loads(pending_path.read_text())['phase'] == 'installed'
    client.get('/status')
    assert checks == ['xoxb-FAKE-bot'], 'once: it is installed now'


@pytest.mark.parametrize('answer', [{'ok': False, 'error': 'invalid_auth'}, {'ok': True, 'team_id': 'T9'}, RuntimeError()])
def test_a_stale_error_record_whose_token_fails_auth_test_is_not_adopted(context, answer):
    client, slack, vault, env, data, _ = context
    _published(data, env)
    pending_path = data / 'pending' / ('c' * 32 + '.json')
    pending_path.write_text(json.dumps({'phase': 'error', 'at': 1763300000}))
    def auth_test(_token):
        if isinstance(answer, Exception):
            raise answer
        return answer
    api.make_service().auth_test = auth_test
    body = client.get('/status').json()
    assert body['phase'] == 'error' and body['token_installed'] is True
    assert _record(data) == PUBLISHED_RECORD and json.loads(pending_path.read_text())['phase'] == 'error'


def test_a_current_failed_connect_is_not_adopted_or_reconciled(context):
    client, slack, vault, env, data, _ = context
    assert client.post('/connect', json={'team_id': 'T1'}).status_code == 200
    key, item = next(iter(json.loads((data / 'apps.json').read_text()).items()))
    assert item['kit_format'] == 2
    env.update({'SLACK_BOT_TOKEN': 'xoxb-FAKE-bot', 'SLACK_TEAM_NAME': 'Acme'})   # the token landed, the commit did not
    (data / 'pending' / (key + '.json')).write_text(json.dumps({'phase': 'error', 'at': 1}))
    api.make_service().auth_test = lambda _token: pytest.fail('a current record is never reconciled')
    assert client.get('/status').json()['phase'] == 'error'
    assert client.post('/access', json={'access': 'members'}).json()['detail'] == 'Connect the bot to Slack first'
    assert 'installed_at' not in json.loads((data / 'apps.json').read_text())[key]


@pytest.mark.parametrize('scope', ['raises', 'incomplete'])
def test_an_access_change_hermes_could_not_confirm_is_not_recorded(context, scope):
    client, slack, vault, env, data, _ = context
    _installed(data, env, ['U1', 'U2'])
    before = _record(data)
    def unconfirmed():
        if scope == 'raises':
            raise RuntimeError('the Hermes scope helper failed')
        return api.service_module.access_module.scope_from_env(dict(env), '/h/.env', complete=False)
    api.make_service().gate_scope = unconfirmed
    response = client.post('/access', json={'access': 'list', 'allowed': 'U7'})
    assert response.status_code == 409
    assert response.json()['detail'] == "Couldn't confirm Hermes applied the change; nothing was recorded"
    assert _record(data) == before
