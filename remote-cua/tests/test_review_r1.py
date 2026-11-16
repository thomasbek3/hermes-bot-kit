"""Regressions for the round-1 review (RCUA-R1-001 .. 006). Each fails on 590fde7."""
from __future__ import annotations

import base64
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import (MAC_CONFIG, PLUGIN_DIR, REMOTE_BIN, FakeProc, FakeSSH, mod, needs_hermes, write_config)

remote = mod("remote")
settings = mod("settings")
lease = mod("lease")
status = mod("status")

CFG = settings.parse({"host": "100.64.0.10", "user": "you", "os": "macos"})


def policy():
    return remote.DriverPolicy(pin="0.21.0", contract_reason=lambda m: "" if m else "driver manifest is missing",
                               team_ids=("YCK386LBJ7",))


def daemon(home, fake, token="rctoken000001"):
    return remote.RemoteDaemon(CFG, policy(), home=home, runner=remote.SSHRunner(CFG, run_fn=fake), token=token)


def no_atexit(monkeypatch):
    monkeypatch.setattr(remote.atexit, "register", lambda fn: None)


# --- RCUA-R1-001: every transport is fenced, the CLI refetch included ---------------------------

def _backend(home, tmp_path, monkeypatch):
    from test_backend_contract import FakeDaemon, make_backend  # noqa: F401
    return make_backend(home, tmp_path, monkeypatch)


@needs_hermes
def test_r1_001_refetch_after_takeover_is_refused(home, tmp_path, monkeypatch):
    b, daemon_ = _backend(home, tmp_path, monkeypatch)
    daemon_.call = lambda tool, args, *, timeout: (daemon_.cli_calls.append((tool, args)) or
                                                   {"windows": [{"pid": 9, "window_id": 7, "title": "HUMAN"}]})
    b.start()
    try:
        real = type(b)._call_capture_tool

        def take_after(self, name, args):
            out = real(self, name, args)
            lease.take("pane-1", home)  # the human takes over right after the empty MCP answer
            return out
        monkeypatch.setattr(type(b), "_call_capture_tool", take_after)
        from tools.bot_desktop.lease import HumanHasControl
        with pytest.raises(HumanHasControl):  # round 2: the operation itself is refused, not just emptied
            b.list_windows()
        assert daemon_.cli_calls == []
    finally:
        lease.release(None, home, force=True, expect_epoch=lease.read(home).epoch)
        b.stop()


@needs_hermes
def test_r1_001_full_takeover_cycle_between_calls_voids_the_refetch(home, tmp_path, monkeypatch):
    b, daemon_ = _backend(home, tmp_path, monkeypatch)
    b.start()
    try:
        real = type(b)._call_capture_tool

        def cycle_after(self, name, args):
            out = real(self, name, args)
            lease.take("pane-1", home)
            lease.release("pane-1", home)  # handed back before the refetch: still the human's turn
            return out
        monkeypatch.setattr(type(b), "_call_capture_tool", cycle_after)
        from tools.bot_desktop.lease import HumanHasControl
        with pytest.raises(HumanHasControl):
            b.list_windows()
        assert daemon_.cli_calls == []
        monkeypatch.setattr(type(b), "_call_capture_tool", real)
        out = b._session.call_tool("list_windows", {})
        assert out["isError"] is False
    finally:
        b.stop()


@needs_hermes
def test_r1_001_direct_cli_call_refused_while_human_holds(home, tmp_path, monkeypatch):
    b, daemon_ = _backend(home, tmp_path, monkeypatch)
    lease.take("pane-1", home)
    out = b._session._call_tool_via_cli("get_window_state", {"pid": 1}, 5.0)
    assert out["isError"] is True and out["structuredContent"]["code"] == "human_has_control"
    assert daemon_.cli_calls == []


# --- RCUA-R1-002: a remote file path is never read on the gateway -------------------------------

@needs_hermes
def test_r1_002_remote_screenshot_path_is_not_read_locally(home, tmp_path, monkeypatch):
    sentinel = tmp_path / "gateway-only.png"
    sentinel.write_bytes(b"GATEWAY_ONLY_SENTINEL")
    b, daemon_ = _backend(home, tmp_path, monkeypatch)
    daemon_.call = lambda tool, args, *, timeout: {"screenshot_file_path": str(sentinel), "tree_markdown": "x"}
    out = b._session._call_tool_via_cli("get_window_state", {}, 1.0)
    assert out["images"] == []
    assert base64.b64encode(b"GATEWAY_ONLY_SENTINEL").decode() not in str(out)


# --- RCUA-R1-003: interrupted start / probe never leaves an untracked daemon --------------------

def _timeout_on(marker):
    def respond(script):
        if marker in script and "manifest-begin" not in script:
            raise subprocess.TimeoutExpired("ssh", 60)
        return FakeSSH.default(script)
    return respond


def test_r1_003_start_timeout_stops_and_keeps_ownership_until_confirmed(home, monkeypatch):
    no_atexit(monkeypatch)
    fake = FakeSSH(_timeout_on("--args serve"))
    d = daemon(home, fake)
    with pytest.raises(remote.RemoteError):
        d.start()
    scripts = fake.scripts()
    assert any("stop --socket /tmp/hc-rctoken000001.sock" in s for s in scripts[2:])
    assert remote._read_registry(home) == []  # cleanup confirmed by the fake


def test_r1_003_start_timeout_with_failed_cleanup_is_recorded_and_swept_later(home, monkeypatch):
    no_atexit(monkeypatch)
    state = {"down": True}

    def respond(script):
        if state["down"] and "manifest-begin" not in script:
            raise subprocess.TimeoutExpired("ssh", 60)
        return FakeSSH.default(script)
    d = daemon(home, FakeSSH(respond))
    with pytest.raises(remote.RemoteError):
        d.start()
    entries = remote._read_registry(home)
    assert [e["socket"] for e in entries] == ["/tmp/hc-rctoken000001.sock"] and entries[0]["pending"] is True
    state["down"] = False
    fake2 = FakeSSH()
    d2 = daemon(home, fake2, token="rctoken000002")  # same live process: the pending entry is still swept
    d2.start()
    assert any("stop --socket /tmp/hc-rctoken000001.sock" in s for s in fake2.scripts())
    assert {e["socket"] for e in remote._read_registry(home)} == {"/tmp/hc-rctoken000002.sock"}
    d2.stop()


def test_r1_003_probe_timeout_still_stops_the_probe_daemon(home):
    fake = FakeSSH(_timeout_on("check_permissions"))
    runner = remote.SSHRunner(CFG, run_fn=fake)
    out = status.run_status(CFG, runner=runner, policy=policy(), token="rcprobe", home=home)
    assert out["ok"] is False
    assert any("stop --socket /tmp/hc-rcprobe.sock" in s for s in fake.scripts())
    assert remote._read_registry(home) == []


def test_r1_003_probe_scripts_carry_an_exit_trap():
    info = remote.parse_discovery(__import__("conftest").discovery_stdout())
    script = remote.start_script(info, "/tmp/hc-x.sock")
    assert "trap " in script and "stop --socket /tmp/hc-x.sock" in script.split("trap ", 1)[1]


# --- RCUA-R1-004: shutdown is acknowledged before it is forgotten -------------------------------

def test_r1_004_failed_stop_keeps_the_record_and_retries(home, monkeypatch):
    no_atexit(monkeypatch)
    state = {"down": False}

    def respond(script):
        if state["down"]:
            return FakeProc(255, "", "ssh: connect to host 100.64.0.10 port 22: Network is unreachable")
        return FakeSSH.default(script)
    fake = FakeSSH(respond)
    d = daemon(home, fake)
    d.start()
    state["down"] = True
    d.stop()
    entries = remote._read_registry(home)
    assert len(entries) == 1 and entries[0]["pending"] is True
    n = len(fake.calls)
    state["down"] = False
    d.stop()  # atexit / a later stop retries
    assert len(fake.calls) == n + 1 and remote._read_registry(home) == []


def _stub(tmp_path, stop_rc, status_rc):
    stub = tmp_path / "cua-driver-stub"
    # A stopped daemon's status says so (what Hermes's cua_daemon_listening relies on).
    gone = 'echo "cua-driver daemon is not running"; ' if status_rc else ""
    stub.write_text(f"#!/bin/sh\ncase \"$1\" in stop) exit {stop_rc};; status) {gone}exit {status_rc};; esac\nexit 0\n")
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    return stub


def _run_stop(tmp_path, stub):
    sock = tmp_path / "hc-marker.sock"
    sock.write_text("")
    out = subprocess.run(["/bin/sh", "-c", remote.stop_command(str(stub), str(sock))], capture_output=True, text=True,
                         check=False)
    return sock.exists(), out.stdout


def test_r1_004_failed_driver_stop_keeps_a_live_daemons_socket(tmp_path):
    exists, stdout = _run_stop(tmp_path, _stub(tmp_path, stop_rc=7, status_rc=0))  # still answering
    assert exists and "RCUA:stopped=0" in stdout


def test_r1_004_stopped_daemon_socket_is_removed(tmp_path):
    exists, stdout = _run_stop(tmp_path, _stub(tmp_path, stop_rc=0, status_rc=1))
    assert not exists and "RCUA:stopped=1" in stdout


def test_r1_004_stale_entries_are_forgotten_only_after_confirmed_stop(home, monkeypatch):
    no_atexit(monkeypatch)
    remote._write_registry(home, [{"destination": "you@100.64.0.10", "bin": REMOTE_BIN,
                                   "socket": "/tmp/hc-rcdead.sock", "pid": 999_999_99}])

    def respond(script):
        if "hc-rcdead" in script:
            return FakeProc(0, "RCUA:stale0=0\n")  # the driver would not stop
        return FakeSSH.default(script)
    d = daemon(home, FakeSSH(respond))
    d.start()
    assert "/tmp/hc-rcdead.sock" in {e["socket"] for e in remote._read_registry(home)}
    d.stop()


# --- RCUA-R1-005: unknown screen state is not READY ---------------------------------------------

def test_r1_005_window_probe_error_is_not_ready(home):
    def respond(script):
        if " call list_windows " in script:
            return FakeProc(0, '{"isError": true, "error": "cannot enumerate screen"}')
        return FakeSSH.default(script)
    out = status.run_status(CFG, runner=remote.SSHRunner(CFG, run_fn=FakeSSH(respond)), policy=policy(), home=home)
    assert out["ok"] is False and out["screen_awake"] is None
    assert "cannot enumerate screen" in out["error"]


def test_r1_005_garbage_window_output_is_not_ready(home):
    def respond(script):
        if " call list_windows " in script:
            return FakeProc(0, "")
        return FakeSSH.default(script)
    out = status.run_status(CFG, runner=remote.SSHRunner(CFG, run_fn=FakeSSH(respond)), policy=policy(), home=home)
    assert out["ok"] is False and out["error"]


def test_r1_005_permission_probe_error_is_not_ready(home):
    def respond(script):
        if " call check_permissions " in script:
            return FakeProc(0, '{"isError": true, "error": "daemon gone"}')
        return FakeSSH.default(script)
    out = status.run_status(CFG, runner=remote.SSHRunner(CFG, run_fn=FakeSSH(respond)), policy=policy(), home=home)
    assert out["ok"] is False and out["permissions"]["ok"] is None and "daemon gone" in out["error"]


# --- RCUA-R1-006: the installer gates on the Hermes version before touching anything ------------

def _fixture_hermes(root: Path, version: str) -> Path:
    agent = root / "agent"
    (agent / "hermes_cli").mkdir(parents=True)
    (agent / "hermes_cli" / "__init__.py").write_text("")
    (agent / "hermes_cli" / "version_info.py").write_text(
        "class _V:\n    base_version = %r\n\ndef get_version_info():\n    return _V()\n" % version)
    hermes = root / "hermes-stub"
    hermes.write_text(f"#!/bin/sh\necho \"$HERMES_HOME $*\" >> {root / 'hermes-calls.log'}\n")
    hermes.chmod(0o755)
    return agent


def _install(tmp_path, version):
    agent = _fixture_hermes(tmp_path, version)
    home = tmp_path / "home"
    (home / "profiles" / "helper").mkdir(parents=True)
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_AGENT_DIR": str(agent), "HERMES_PYTHON": sys.executable,
           "HERMES_BIN": str(tmp_path / "hermes-stub")}
    out = subprocess.run(["bash", str(PLUGIN_DIR / "install.sh"), "--profiles", "helper"], capture_output=True,
                         text=True, env=env, check=False)
    return out, home


def test_r1_006_unsupported_hermes_refused_before_copying(tmp_path):
    out, home = _install(tmp_path, "0.24.0")
    assert out.returncode != 0
    assert "remote-cua needs Hermes >=0.23.0,<0.24.0 (running 0.24.0)" in out.stderr + out.stdout
    assert not (home / "profiles" / "helper" / "plugins").exists()


def test_r1_006_supported_hermes_enables_through_the_public_cli(tmp_path):
    out, home = _install(tmp_path, "0.23.1")
    assert out.returncode == 0, out.stderr
    assert (home / "profiles" / "helper" / "plugins" / "remote-cua" / "remote.py").is_file()
    log = (tmp_path / "hermes-calls.log").read_text()
    assert log.strip() == f"{home / 'profiles' / 'helper'} plugins enable remote-cua"
    assert "plugins_cmd" not in (PLUGIN_DIR / "install.sh").read_text()
