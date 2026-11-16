"""The backend on top of Hermes's real CuaDriverBackend, the private-import guard, and Hermes's own loaders.

Needs a Hermes checkout (HERMES_AGENT_DIR, default ~/.hermes/hermes-agent) and its venv. The
contract smoke test (test_every_private_import_resolves) is the one CONTRACT.md refers to.
"""
from __future__ import annotations

import importlib
import json
import shutil
import sys
from pathlib import Path

import pytest

from conftest import MAC_CONFIG, PLUGIN_DIR, WINDOWS_CONFIG, mod, needs_hermes, write_config

pytestmark = needs_hermes

compat = mod("compat")
settings = mod("settings")
lease = mod("lease")

CFG = settings.parse({"host": "100.64.0.10", "user": "you"})


# --- contract -----------------------------------------------------------------------------------

def test_every_private_import_resolves():
    for module, attr, _ in compat.PRIVATE_IMPORTS:
        assert hasattr(importlib.import_module(module), attr), f"{module}.{attr}"
    ns = compat.private()
    assert callable(ns.manifest_contract_reason) and ns.bundle_id == "com.trycua.driver"


def test_running_hermes_is_supported_and_pin_is_read():
    assert compat.version_supported(compat.hermes_version()), compat.hermes_version()
    assert compat.version_tuple(compat.gateway_pin()) is not None


def test_guard_refuses_unsupported_version():
    with pytest.raises(compat.CompatError, match=r"remote-cua needs Hermes >=0.23.0,<0.24.0 \(running 0.22.9\)"):
        compat.private(version="0.22.9")
    with pytest.raises(compat.CompatError, match="remote-cua needs Hermes"):
        compat.private(version="0.24.0")


def test_guard_names_a_missing_internal(monkeypatch):
    monkeypatch.setattr(compat, "PRIVATE_IMPORTS", (("tools.computer_use.cua_backend", "_gone_in_next_release", "x"),))
    with pytest.raises(compat.CompatError, match="cua_backend._gone_in_next_release is missing"):
        compat.private(version=compat.hermes_version())


def test_plugin_yaml_is_a_standalone_plugin_for_hermes():
    from hermes_cli.plugins_manifest import _manifest_kind, requires_hermes_error
    import yaml
    data = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text())
    assert _manifest_kind(data, "remote-cua", PLUGIN_DIR) == "standalone"
    assert requires_hermes_error(data) is None


def test_hermes_computer_use_discovery_loads_the_provider(home, monkeypatch):
    plugins = home / "plugins"
    plugins.mkdir()
    shutil.copytree(PLUGIN_DIR, plugins / "remote-cua", ignore=shutil.ignore_patterns("tests", "__pycache__"))
    write_config(home, MAC_CONFIG)
    import plugins.computer_use as cu
    for name in [n for n in sys.modules if n.startswith("_hermes_user_computer_use")]:
        monkeypatch.delitem(sys.modules, name)
    assert ("remote-cua" in [n for n, _ in cu.discover_computer_use_providers()])
    assert cu.configured_backend_name() == "remote-cua"
    provider = cu.get_active_provider()
    assert provider.name == "remote-cua" and provider.is_available() is True


# --- backend ------------------------------------------------------------------------------------

class FakeDaemon:
    """The RemoteDaemon surface, spawning tests/fake_mcp_driver.py locally instead of ssh."""

    def __init__(self, log: Path):
        self.cfg, self.log, self.socket_path = CFG, log, "/tmp/hc-rcfake.sock"
        self.running, self.no_overlay, self.events, self.cli_calls = False, True, [], []

    def start(self):
        self.events.append("start")
        self.running = True

    def stop(self):
        self.events.append("stop")
        self.running = False

    def proxy_invocation(self):
        return sys.executable, [str(Path(__file__).with_name("fake_mcp_driver.py")), str(self.log)]

    def child_env(self):
        return {}

    def call(self, tool, args, *, timeout):
        self.cli_calls.append((tool, args))
        return {"ok": True}


def calls(log: Path):
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def make_backend(home, tmp_path, monkeypatch):
    backend = mod("backend")
    monkeypatch.setattr(compat.private(), "ensure_import", lambda name: None)
    daemon = FakeDaemon(tmp_path / "mcp.log")
    return backend.create_backend(CFG, "unrestricted", daemon=daemon, home=home), daemon


def test_windows_refused_before_any_ssh():
    backend = mod("backend")
    cfg = settings.parse({"host": "h", "user": "u", "os": "windows"})
    with pytest.raises(RuntimeError, match="Windows support coming: needs cua Session proxy"):
        backend.create_backend(cfg)


def test_provider_refuses_windows_from_profile_config(home):
    write_config(home, WINDOWS_CONFIG)
    provider = mod("provider").make_provider()
    with pytest.raises(RuntimeError, match="Windows support coming"):
        provider.create_backend(permission_mode="standard")


def test_backend_runs_hermes_session_over_the_daemon_and_cleans_up(home, tmp_path, monkeypatch):
    b, daemon = make_backend(home, tmp_path, monkeypatch)
    assert b.permission_mode == "standard" and b.requested_permission_mode == "unrestricted"
    b.start()
    try:
        tools = [c["tool"] for c in calls(daemon.log)]
        assert tools[0] == "start_session" and "set_config" in tools and "set_agent_cursor_enabled" in tools
        assert b._session.call_tool("list_windows", {})["isError"] is False
    finally:
        b.stop()
    assert daemon.events == ["start", "stop"]
    assert calls(daemon.log)[-1]["tool"] == "end_session"


def test_session_refuses_while_human_holds_and_voids_across_takeover(home, tmp_path, monkeypatch):
    b, daemon = make_backend(home, tmp_path, monkeypatch)
    b.start()
    try:
        lease.take("pane-1", home)
        out = b._session.call_tool("click", {"x": 1, "y": 1})
        assert out["isError"] is True and out["structuredContent"]["code"] == "human_has_control"
        assert "click" not in [c["tool"] for c in calls(daemon.log)]
        lease.release("pane-1", home)
        parent = type(b._session).__mro__[1]
        real = parent.call_tool

        def takeover_mid_call(self, name, args, timeout=30.0):
            result = real(self, name, args, timeout)
            lease.take("pane-2", home)
            return result
        monkeypatch.setattr(parent, "call_tool", takeover_mid_call)
        out = b._session.call_tool("list_windows", {})
        assert out["isError"] is True and "result was discarded" in out["data"]
        monkeypatch.setattr(parent, "call_tool", real)
        lease.release("pane-2", home)
    finally:
        b.stop()


def test_cli_fallback_goes_to_the_remote_and_drops_local_file_paths(home, tmp_path, monkeypatch):
    b, daemon = make_backend(home, tmp_path, monkeypatch)
    out = b._session._call_tool_via_cli("get_window_state", {"pid": 1, "screenshot_out_file": "/tmp/x.png"}, 5.0)
    assert daemon.cli_calls == [("get_window_state", {"pid": 1})]
    assert out["isError"] is False


def test_failed_daemon_start_leaves_nothing_running(home, tmp_path, monkeypatch):
    b, daemon = make_backend(home, tmp_path, monkeypatch)

    def boom():
        daemon.events.append("start")
        raise RuntimeError("daemon did not start")
    daemon.start = boom
    with pytest.raises(RuntimeError, match="daemon did not start"):
        b.start()
    assert daemon.events == ["start", "stop"]


def test_register_wires_hook_cli_and_provider():
    pkg = mod("lease") and sys.modules["remote_cua_under_test"]

    class Ctx:
        def __init__(self):
            self.hooks, self.cli, self.provider = [], [], None

        def register_hook(self, name, fn):
            self.hooks.append(name)

        def register_cli_command(self, name, help, setup_fn, handler_fn, description=""):
            self.cli.append(name)

        def register_computer_use_provider(self, provider):
            self.provider = provider

    ctx = Ctx()
    pkg.register(ctx)
    assert ctx.hooks == ["pre_tool_call"] and ctx.cli == ["remote-cua"] and ctx.provider.name == "remote-cua"
