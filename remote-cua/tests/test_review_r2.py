"""Regressions for the round-2 review (RCUA-R2-001 .. 003). Each fails on 211130f."""
from __future__ import annotations

import json
import socket
import stat
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from conftest import PLUGIN_DIR, FakeProc, FakeSSH, mod, needs_hermes

remote = mod("remote")
settings = mod("settings")
lease = mod("lease")

CFG = settings.parse({"host": "100.64.0.10", "user": "you", "os": "macos"})


# --- RCUA-R2-001: no dispatch at all while a human holds control --------------------------------

def _backend(home, tmp_path, monkeypatch):
    from test_backend_contract import make_backend
    return make_backend(home, tmp_path, monkeypatch)


def _transport_log(b, home, script):
    """Replace the live MCP ClientSession's call_tool (the layer under every Hermes dispatch, retries
    included) with ``script(name, args, log)``; ``log`` records (tool, lease holder at dispatch)."""
    log = []
    inner = b._session._session

    async def fake_call_tool(name, args=None, **_):
        log.append((name, lease.read(home).holder))
        return await script(name, args or {}, log)
    inner.call_tool = fake_call_tool
    return log


def _result(text, is_error=False):
    from mcp.types import CallToolResult, TextContent
    return CallToolResult(content=[TextContent(type="text", text=text)], isError=is_error)


def _human_has_control():
    from tools.bot_desktop.lease import HumanHasControl  # what Hermes's computer_use tool turns into human_has_control
    return HumanHasControl


@needs_hermes
@pytest.mark.parametrize("take_on", ["click_answer", "session_revive"])
def test_r2_001_ended_session_replay_never_dispatches_to_the_human(home, tmp_path, monkeypatch, take_on):
    """The driver says the session ended; Hermes revives it (start_session) and replays the click. The
    human takes over while the first click is answered, or during the revive: either way the click is
    sent once, never while the human holds control, and the operation raises HumanHasControl."""
    b, _ = _backend(home, tmp_path, monkeypatch)
    b.start()
    try:
        async def script(name, args, log):
            if name == "click" and len(log) == 1:
                if take_on == "click_answer":
                    lease.take("pane-1", home)
                return _result("session hermes-x has ended; call start_session to begin again", True)
            if name == "start_session" and take_on == "session_revive":
                lease.take("pane-1", home)
            return _result(json.dumps({"ok": True}))
        log = _transport_log(b, home, script)
        b._set_active_target({"pid": 9, "window_id": 7})  # as after a capture
        with pytest.raises(_human_has_control()):
            b.click(x=1, y=1)
        assert b._active_pid is None  # disarmed
        assert [n for n, h in log if h == lease.HUMAN and n not in ("start_session", "end_session")] == []
        assert [n for n, _ in log].count("click") == 1
        if take_on == "session_revive":
            assert ("start_session", lease.AGENT) in log  # Hermes did revive and attempt the replay
    finally:
        lease.release(None, home, force=True)
        b.stop()


@needs_hermes
def test_r2_001_closed_session_retry_never_dispatches_to_the_human(home, tmp_path, monkeypatch):
    b, _ = _backend(home, tmp_path, monkeypatch)
    b.start()
    try:
        async def script(name, args, log):
            lease.take("pane-1", home)
            raise EOFError("transport closed")
        log = _transport_log(b, home, script)
        monkeypatch.setattr(b._session, "_recreate_session", lambda *a, **k: None)  # reconnection stubbed
        out = b._session.call_tool("get_window_state", {"pid": 9})
        assert out["isError"] is True and out["structuredContent"]["code"] == "human_has_control"
        assert log == [("get_window_state", lease.AGENT)]
    finally:
        lease.release(None, home, force=True)
        b.stop()


@needs_hermes
def test_r2_001_operation_result_is_fenced_when_it_returns(home, tmp_path, monkeypatch):
    b, _ = _backend(home, tmp_path, monkeypatch)
    b.start()
    try:
        real = type(b)._call_capture_tool

        def take_after(self, name, args):
            out = real(self, name, args)
            lease.take("pane-1", home)  # after the last transport call, before the operation returns
            return out
        monkeypatch.setattr(type(b), "_call_capture_tool", take_after)

        async def script(name, args, log):
            return _result(json.dumps({"windows": [{"pid": 9, "window_id": 7, "app_name": "X", "title": "t"}]}))
        _transport_log(b, home, script)
        with pytest.raises(_human_has_control()):
            b.list_windows()
        assert b._active_pid is None and b._active_window_id is None  # disarmed
    finally:
        lease.release(None, home, force=True)
        b.stop()


@needs_hermes
def test_r2_001_capture_after_takeover_returns_no_frame(home, tmp_path, monkeypatch):
    b, _ = _backend(home, tmp_path, monkeypatch)
    b.start()
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    try:
        real = type(b)._call_capture_tool

        def take_after(self, name, args):
            out = real(self, name, args)
            if name != "list_windows":
                lease.take("pane-1", home)
            return out
        monkeypatch.setattr(type(b), "_call_capture_tool", take_after)

        async def script(name, args, log):
            from mcp.types import CallToolResult, ImageContent
            if name == "list_windows":
                return _result(json.dumps({"windows": [{"pid": 9, "window_id": 7, "app_name": "X", "title": "t",
                                                        "is_on_screen": True}]}))
            return CallToolResult(content=[ImageContent(type="image", data=png, mimeType="image/png")], isError=False)
        _transport_log(b, home, script)
        with pytest.raises(_human_has_control()):
            b.capture(mode="vision", pid=9, window_id=7)
    finally:
        lease.release(None, home, force=True)
        b.stop()


@needs_hermes
def test_r2_001_operation_refused_up_front_while_human_holds(home, tmp_path, monkeypatch):
    b, _ = _backend(home, tmp_path, monkeypatch)
    b.start()
    try:
        async def script(name, args, log):
            return _result(json.dumps({"ok": True}))
        log = _transport_log(b, home, script)
        lease.take("pane-1", home)
        with pytest.raises(_human_has_control()):
            b.click(x=1, y=1)
        assert log == []
    finally:
        lease.release(None, home, force=True)
        b.stop()


# --- RCUA-R2-002: only a validated "not running" acknowledges a stop ----------------------------

def _stub(tmp_path, body):
    stub = tmp_path / "cua-driver-stub"
    stub.write_text("#!/bin/sh\n" + body)
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    return stub


def _run(script):
    return subprocess.run(["/bin/sh", "-c", script], capture_output=True, text=True, check=False).stdout


@pytest.fixture
def live_socket(tmp_path):
    path = Path("/tmp") / f"rcua-r2-{time.time_ns()}.sock"  # short: AF_UNIX path limit
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(path))
    srv.listen(1)
    yield path
    srv.close()
    path.unlink(missing_ok=True)


def test_r2_002_missing_driver_is_not_a_confirmed_stop(tmp_path, live_socket):
    out = _run(remote.stop_command(str(tmp_path / "gone" / "cua-driver"), str(live_socket)))
    assert "RCUA:stopped=0" in out and live_socket.exists()


@pytest.mark.parametrize("status_body", [
    'echo "permission denied" >&2; exit 126',
    'echo "error: could not connect" >&2; exit 1',
    "exit 127",
])
def test_r2_002_ambiguous_status_is_not_a_confirmed_stop(tmp_path, live_socket, status_body):
    stub = _stub(tmp_path, f'case "$1" in stop) exit 0;; status) {status_body};; esac\nexit 0\n')
    out = _run(remote.stop_command(str(stub), str(live_socket)))
    assert "RCUA:stopped=0" in out and live_socket.exists()


def test_r2_002_validated_not_running_is_a_confirmed_stop(tmp_path, live_socket):
    stub = _stub(tmp_path, 'case "$1" in stop) exit 0;; status) echo "cua-driver daemon is not running"; exit 1;; '
                           'esac\nexit 0\n')
    out = _run(remote.stop_command(str(stub), str(live_socket)))
    assert "RCUA:stopped=1" in out and not live_socket.exists()


def test_r2_002_cleanup_and_sweep_keep_records_for_a_missing_driver(home, tmp_path, live_socket):
    """The generated scripts run for real (locally, /bin/sh) against a driver path that does not exist."""
    def local_ssh(argv, **kwargs):
        import shlex
        script = shlex.split(argv[-1][len("/bin/sh -c "):])[0]
        if "manifest-begin" in script:
            return FakeSSH.default(script)
        if "--args serve" in script:
            return FakeProc(0, "RCUA:ready=1\n")
        return subprocess.run(["/bin/sh", "-c", script], capture_output=True, text=True, check=False)
    d = remote.RemoteDaemon(CFG, remote.DriverPolicy(pin="0.21.0", contract_reason=lambda m: ""),
                            home=home, runner=remote.SSHRunner(CFG, run_fn=local_ssh), token="rcmissing")
    d.start()
    d.info.path = str(tmp_path / "removed" / "cua-driver")  # the installation went away
    d.socket_path = str(live_socket)
    remote.record(home, CFG.destination, d.info.path, d.socket_path)
    d.stop()
    assert live_socket.exists()
    entries = {e["socket"]: e for e in remote._read_registry(home)}
    assert entries[str(live_socket)]["pending"] is True
    remote.sweep(CFG, remote.SSHRunner(CFG, run_fn=local_ssh), home)
    assert str(live_socket) in {e["socket"] for e in remote._read_registry(home)} and live_socket.exists()


# --- RCUA-R2-003: registry transactions are serialized across processes -------------------------

CHILD = textwrap.dedent("""
    import importlib, importlib.util, sys, time
    from pathlib import Path
    plugin, home, op, sock, go = sys.argv[1:6]
    spec = importlib.util.spec_from_file_location("rc_child", Path(plugin) / "__init__.py",
                                                  submodule_search_locations=[plugin])
    pkg = importlib.util.module_from_spec(spec); sys.modules["rc_child"] = pkg; spec.loader.exec_module(pkg)
    remote = importlib.import_module("rc_child.remote")
    real_read = remote._read_registry
    def slow_read(h):
        data = real_read(h)
        time.sleep(0.6)  # widen the read-modify-write window
        return data
    remote._read_registry = slow_read
    while not Path(go).exists():
        time.sleep(0.005)
    if op == "record":
        remote.record(Path(home), "you@100.64.0.10", "/x/cua-driver", sock)
    else:
        remote.forget(Path(home), "you@100.64.0.10", sock)
""")


def _race(tmp_path, home, ops):
    script = tmp_path / "child.py"
    script.write_text(CHILD)
    go = tmp_path / "go"
    procs = [subprocess.Popen([sys.executable, "-I", str(script), str(PLUGIN_DIR), str(home), op, sock, str(go)])
             for op, sock in ops]
    time.sleep(0.5)  # both children loaded and waiting
    go.write_text("")
    for p in procs:
        assert p.wait(timeout=30) == 0
    return {e["socket"] for e in remote._read_registry(home)}


def test_r2_003_two_processes_recording_keep_both_entries(tmp_path, home):
    got = _race(tmp_path, home, [("record", "/tmp/hc-rcaaa.sock"), ("record", "/tmp/hc-rcbbb.sock")])
    assert got == {"/tmp/hc-rcaaa.sock", "/tmp/hc-rcbbb.sock"}


def test_r2_003_concurrent_forget_keeps_the_unrelated_entry(tmp_path, home):
    remote.record(home, "you@100.64.0.10", "/x/cua-driver", "/tmp/hc-rcold.sock")
    got = _race(tmp_path, home, [("forget", "/tmp/hc-rcold.sock"), ("record", "/tmp/hc-rcnew.sock")])
    assert got == {"/tmp/hc-rcnew.sock"}
