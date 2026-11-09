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
from unittest.mock import AsyncMock

import pytest

if os.environ.get('HERMES_AGENT_DIR'):
    sys.path.insert(0, os.environ['HERMES_AGENT_DIR'])
try:
    from gateway.config import PlatformConfig
    from plugins.platforms.slack import adapter as bundled
except ImportError:
    pytest.skip('Hermes is not importable; run with its venv and HERMES_AGENT_DIR', allow_module_level=True)

path = Path(__file__).resolve().parents[2] / 'slack-http' / 'http_adapter.py'
spec = importlib.util.spec_from_file_location('slack_http_adapter_test', path)
http_adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(http_adapter)


def test_internals_contract():
    adapter = bundled.SlackAdapter(PlatformConfig())
    assert not [key for key in http_adapter._REQUIRED if not hasattr(adapter, key)]
    assert not [key for key in http_adapter._MODULE_REQUIRED if not hasattr(bundled, key)]


def test_socket_mode_delegates(monkeypatch):
    monkeypatch.setattr(bundled, '_get_scoped_secret', lambda _, default=None: default)
    original = AsyncMock(return_value=True)
    monkeypatch.setattr(bundled.SlackAdapter, 'connect', original)
    adapter = http_adapter.make_http_capable(bundled.SlackAdapter)(PlatformConfig())
    assert asyncio.run(adapter.connect(is_reconnect=True)) is True
    original.assert_awaited_once_with(is_reconnect=True)


def test_http_signed_and_unsigned_requests(monkeypatch, caplog):
    from aiohttp.test_utils import TestClient, TestServer
    from slack_sdk.web.async_client import AsyncWebClient

    class AuthResponse(dict):
        headers = {}

    async def exercise():
        settings = {'SLACK_CONNECTION_MODE': 'http', 'SLACK_SIGNING_SECRET': 'test-signing-secret'}
        monkeypatch.setattr(bundled, '_get_scoped_secret', lambda name, default=None: settings.get(name, default))
        monkeypatch.setattr(AsyncWebClient, 'auth_test', AsyncMock(return_value=AuthResponse(ok=True, team_id='T1', user_id='B1', bot_id='B1')))
        adapter = http_adapter.make_http_capable(bundled.SlackAdapter)(PlatformConfig(token='fake-bot-token'))
        adapter._hermes_profile_name = 'test-profile'
        adapter.gateway_runner = SimpleNamespace(_multiplex_on=lambda: True, adapters={})
        adapter._acquire_platform_lock = lambda *_: True
        adapter._release_platform_lock = lambda: None
        adapter._hint_allow_bots = lambda: None
        adapter._authenticate_workspace = AsyncMock()
        received = asyncio.Event()
        async def handle_message(event, body):
            assert event['channel_type'] == 'im'
            received.set()
        adapter._handle_slack_message = handle_message
        assert await adapter.connect()
        client = TestClient(TestServer(adapter._shared_ingress_app))
        await client.start_server()
        try:
            def headers(body):
                ts = str(int(time.time()))
                digest = hmac.new(b'test-signing-secret', b'v0:' + ts.encode() + b':' + body, hashlib.sha256).hexdigest()
                return {'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': 'v0=' + digest}
            challenge = json.dumps({'type': 'url_verification', 'challenge': 'challenge'}).encode()
            response = await client.post('/slack/events', data=challenge, headers=headers(challenge))
            assert response.status == 200 and (await response.json())['challenge'] == 'challenge'
            response = await client.post('/slack/events', data=b'{"token":"fake-do-not-log"}', headers={'Content-Type': 'application/json'})
            assert response.status == 401
            assert 'fake-do-not-log' not in caplog.text
            response = await client.post('/slack/events', data=b'{}', headers={'X-Slack-Request-Timestamp': 'invalid', 'X-Slack-Signature': 'v0=bad'})
            assert response.status == 401
            body = json.dumps({'type': 'event_callback', 'team_id': 'T1', 'api_app_id': 'A1', 'event_id': 'E1',
                               'event': {'type': 'message', 'channel_type': 'im', 'user': 'U1', 'channel': 'D1', 'text': 'hi', 'ts': '1.0'}}).encode()
            response = await client.post('/slack/events', data=body, headers=headers(body))
            assert response.status == 200
            await asyncio.wait_for(received.wait(), 3)
        finally:
            await client.close()
            await adapter.disconnect()
    asyncio.run(exercise())


def test_override_preserves_registry_fields(monkeypatch):
    package = Path(__file__).resolve().parents[2] / 'slack-http' / '__init__.py'
    package_spec = importlib.util.spec_from_file_location('slack_http_test_package', package, submodule_search_locations=[str(package.parent)])
    plugin = importlib.util.module_from_spec(package_spec)
    sys.modules[package_spec.name] = plugin
    package_spec.loader.exec_module(plugin)
    original, captured = {}, {}
    bundled.register(SimpleNamespace(register_platform=lambda **kwargs: original.update(kwargs)))
    plugin.register(SimpleNamespace(register_platform=lambda **kwargs: captured.update(kwargs)))
    assert captured.keys() == original.keys()
    for key in original.keys() - {'adapter_factory', 'required_env'}:
        assert captured[key] == original[key]
    assert captured['required_env'] == ['SLACK_BOT_TOKEN']
    assert issubclass(captured['adapter_factory'], bundled.SlackAdapter)


def test_missing_internals_fails_closed(monkeypatch):
    monkeypatch.setattr(bundled, '_get_scoped_secret', lambda name, default=None: 'http' if name == 'SLACK_CONNECTION_MODE' else default)
    adapter = http_adapter.make_http_capable(bundled.SlackAdapter)(PlatformConfig())
    adapter._set_fatal_error = lambda *args, **kwargs: setattr(adapter, 'fatal', (args, kwargs))
    monkeypatch.delattr(adapter, '_team_clients')
    assert asyncio.run(adapter.connect()) is False
    assert adapter.fatal[0][0] == 'slack_http_incompatible'
    assert adapter.fatal[1]['retryable'] is False


def test_profile_discovery_shadow_and_force_reload(tmp_path):
    import shutil
    import subprocess
    source = Path(__file__).resolve().parents[2] / 'slack-http'
    root = tmp_path / 'hermes'
    profile = root / 'profiles' / 'test'
    profile.mkdir(parents=True)
    (root / 'config.yaml').write_text('plugins:\n  enabled: []\n')
    (profile / 'config.yaml').write_text('plugins:\n  enabled: [slack-http, platforms/slack]\n')
    shutil.copytree(source, root / 'plugins' / 'slack-http', ignore=shutil.ignore_patterns('__pycache__'))
    script = r"""
from pathlib import Path
import shutil
from gateway.run import _profile_runtime_scope
from gateway.platform_registry import platform_registry
from hermes_cli.plugins import discover_plugins, get_plugin_manager
root = Path(__import__('os').environ['HERMES_HOME'])
home = root / 'profiles' / 'test'
with _profile_runtime_scope(home, hydrate_secrets=False):
    discover_plugins()
    assert platform_registry.get('slack').adapter_factory.__name__ == 'SlackAdapter'
    shutil.copytree(root / 'plugins' / 'slack-http', home / 'plugins' / 'platforms' / 'slack')
    discover_plugins()
    assert platform_registry.get('slack').adapter_factory.__name__ == 'SlackAdapter'
    discover_plugins(force=True)
    assert platform_registry.get('slack').adapter_factory.__name__ == 'HttpCapableSlackAdapter'
    winner = get_plugin_manager()._plugins['platforms/slack']
    assert winner.manifest.source == 'user' and not winner.error
"""
    import gateway
    hermes_dir = os.environ.get('HERMES_AGENT_DIR', str(Path(gateway.__file__).resolve().parent.parent))
    env = dict(os.environ, HERMES_HOME=str(root), HOME=str(tmp_path),
               HERMES_DISABLE_LAZY_INSTALLS='1', HERMES_GATEWAY_LOCK_DIR=str(root / 'locks'),
               PYTHONPATH=hermes_dir, PYTHONDONTWRITEBYTECODE='1')
    result = subprocess.run([sys.executable, '-c', script], env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
