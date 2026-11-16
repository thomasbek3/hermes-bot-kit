"""Remote command lines, discovery, the private daemon lifecycle and the stale sweep (fake ssh)."""
from __future__ import annotations

import os
import shlex

import pytest

from conftest import (MANIFEST_OK, REMOTE_APP, REMOTE_BIN, FakeProc, FakeSSH, discovery_stdout, mod)

remote = mod("remote")
settings = mod("settings")

CFG = settings.parse({"host": "100.64.0.10", "user": "you", "os": "macos"})


def policy(pin="0.21.0"):
    def contract(manifest):
        return "" if manifest and manifest.get("binary_version") else "driver manifest is missing or invalid"
    return remote.DriverPolicy(pin=pin, contract_reason=contract, team_ids=("4YEC26S9KF", "YCK386LBJ7"))


def daemon(home, fake, token="rctoken000001"):
    return remote.RemoteDaemon(CFG, policy(), home=home, runner=remote.SSHRunner(CFG, run_fn=fake), token=token)


# --- command lines ------------------------------------------------------------------------------

def test_ssh_argv_is_batch_mode_with_keepalive():
    argv = remote.ssh_argv(CFG, "true")
    assert argv[:2] == ["ssh", "-T"]
    assert "BatchMode=yes" in argv and "ServerAliveInterval=15" in argv
    assert argv[-2:] == ["you@100.64.0.10", "true"]


def test_serve_command_uses_exact_app_path_never_the_name():
    info = remote.parse_discovery(discovery_stdout())
    cmd = remote.serve_command(info, "/tmp/hc-rcabc.sock")
    assert f"/usr/bin/open -n -g -a {shlex.quote(REMOTE_APP)} --args serve --embedded --socket /tmp/hc-rcabc.sock" in cmd
    assert "--no-permissions-gate --permission-mode standard --no-overlay" in cmd
    assert "-a CuaDriver " not in cmd and not cmd.rstrip().endswith("-a CuaDriver")
    assert cmd.startswith("CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ")


def test_overlay_flag_only_when_driver_supports_it():
    info = remote.parse_discovery(discovery_stdout(no_overlay=False))
    assert "--no-overlay" not in remote.serve_command(info, "/tmp/hc-x.sock")
    assert "--no-overlay" not in remote.mcp_remote_command(info, "/tmp/hc-x.sock")


def test_mcp_invocation_is_one_ssh_session_with_remote_binary(home):
    d = daemon(home, FakeSSH())
    d.start()
    command, args = d.proxy_invocation()
    assert command == "ssh"
    assert args[:-1] == [*remote.SSH_OPTIONS, "you@100.64.0.10"]
    inner = shlex.split(args[-1][len("/bin/sh -c "):])[0]
    assert inner == (f"CUA_DRIVER_RS_TELEMETRY_ENABLED=0 exec {REMOTE_BIN} mcp --no-overlay --embedded "
                     "--socket /tmp/hc-rctoken000001.sock")
    d.stop()


def test_manifest_command_from_remote_is_never_a_local_spawn(home):
    manifest = MANIFEST_OK.replace('"/x/cua-driver"', '"/usr/local/bin/evil"')
    fake = FakeSSH(lambda s: FakeProc(0, discovery_stdout(manifest=manifest)) if "manifest-begin" in s
                   else FakeSSH.default(s))
    d = daemon(home, fake)
    d.start()
    command, args = d.proxy_invocation()
    assert command == "ssh" and "/usr/local/bin/evil" not in " ".join(args)
    d.stop()


def test_socket_token_is_fresh_per_daemon(home):
    a = remote.RemoteDaemon(CFG, policy(), home=home)
    b = remote.RemoteDaemon(CFG, policy(), home=home)
    assert a.socket_path != b.socket_path
    assert a.socket_path.startswith("/tmp/hc-rc") and a.socket_path.endswith(".sock")


def test_ssh_env_drops_secrets():
    env = remote.ssh_env({"PATH": "/bin", "HOME": "/Users/you", "OPENAI_API_KEY": "sk-x", "SSH_AUTH_SOCK": "/a"})
    assert env == {"PATH": "/bin", "HOME": "/Users/you", "SSH_AUTH_SOCK": "/a"}


# --- discovery ----------------------------------------------------------------------------------

def test_discovery_script_order_config_then_pin_then_path():
    script = remote.discovery_script("", "0.21.0")
    assert script.index('"$HOME"/.hermes/tools/cua-driver-"$pin"-darwin-*/cua-driver') < script.index("command -v cua-driver")
    assert "pin=0.21.0" in script
    assert "want=/opt/x/cua-driver" in remote.discovery_script("/opt/x/cua-driver", "0.21.0")


def test_parse_discovery():
    info = remote.parse_discovery(discovery_stdout())
    assert info.path == REMOTE_BIN and info.app == REMOTE_APP
    assert info.identifier == "com.trycua.driver" and info.team == "YCK386LBJ7"
    assert info.version == "0.21.0" and info.mcp_args == ["mcp"] and info.logged_in is True


@pytest.mark.parametrize("kwargs,needle", [
    ({"bin_path": ""}, "cua-driver not found"),
    ({"manifest": MANIFEST_OK.replace("0.21.0", "0.28.2")}, "this gateway's Hermes pins 0.21.0"),
    ({"app": ""}, "CuaDriver.app not found"),
    ({"ident": "com.example.fake"}, "is not the signed CuaDriver.app"),
    ({"team": "ABCDEFGHIJ"}, "signed by team ABCDEFGHIJ"),
    ({"manifest": "not json"}, "driver manifest is missing"),
])
def test_driver_problems(kwargs, needle):
    info = remote.parse_discovery(discovery_stdout(**kwargs))
    problems = remote.driver_problems(CFG, info, policy())
    assert any(needle in p for p in problems), problems


def test_good_driver_has_no_problems():
    assert remote.driver_problems(CFG, remote.parse_discovery(discovery_stdout()), policy()) == []


def test_unreachable_host_is_plain_words(home):
    fake = FakeSSH(lambda s: FakeProc(255, "", "ssh: connect to host 100.64.0.10 port 22: Operation timed out"))
    with pytest.raises(remote.RemoteError, match="could not reach you@100.64.0.10 over SSH .*timed out"):
        daemon(home, fake).start()


# --- lifecycle ----------------------------------------------------------------------------------

def test_start_then_stop_cleans_up(home, monkeypatch):
    registered = []
    monkeypatch.setattr(remote.atexit, "register", registered.append)
    fake = FakeSSH()
    d = daemon(home, fake)
    d.start()
    assert d.running
    start = fake.scripts()[1]
    assert "status --socket /tmp/hc-rctoken000001.sock" in start and "sleep 0.1" in start
    assert remote._read_registry(home)[0]["socket"] == "/tmp/hc-rctoken000001.sock"
    assert registered == [d.stop]
    d.stop()
    assert fake.scripts()[-1] == f"{REMOTE_BIN} stop --socket /tmp/hc-rctoken000001.sock >/dev/null 2>&1 </dev/null; rm -f /tmp/hc-rctoken000001.sock"
    assert remote._read_registry(home) == []
    n = len(fake.calls)
    d.stop()  # idempotent (atexit after an explicit stop)
    assert len(fake.calls) == n


def test_failed_start_stops_what_it_started(home):
    fake = FakeSSH(lambda s: FakeProc(0, "RCUA:ready=0\n") if "status --socket" in s else FakeSSH.default(s))
    d = daemon(home, fake)
    with pytest.raises(remote.RemoteError, match="did not start .*socket did not answer"):
        d.start()
    assert not d.running
    assert "stop --socket /tmp/hc-rctoken000001.sock" in fake.scripts()[-1]


def test_bad_driver_refuses_before_starting_anything(home):
    fake = FakeSSH(lambda s: FakeProc(0, discovery_stdout(team="ABCDEFGHIJ")) if "manifest-begin" in s
                   else FakeSSH.default(s))
    with pytest.raises(remote.RemoteError, match="signed by team"):
        daemon(home, fake).start()
    assert len(fake.calls) == 1  # discovery only: no open, no daemon


def test_stale_sweep_stops_only_dead_owners(home):
    dead, live = 999_999_99, os.getpid()
    remote._write_registry(home, [
        {"destination": "you@100.64.0.10", "bin": REMOTE_BIN, "socket": "/tmp/hc-rcdead.sock", "pid": dead},
        {"destination": "you@100.64.0.10", "bin": REMOTE_BIN, "socket": "/tmp/hc-rclive.sock", "pid": live},
        {"destination": "other@100.64.0.11", "bin": REMOTE_BIN, "socket": "/tmp/hc-rcother.sock", "pid": dead},
    ])
    fake = FakeSSH()
    d = daemon(home, fake)
    d.start()
    start = fake.scripts()[1]
    assert "stop --socket /tmp/hc-rcdead.sock" in start
    assert "hc-rclive" not in start and "hc-rcother" not in start
    sockets = {e["socket"] for e in remote._read_registry(home)}
    assert sockets == {"/tmp/hc-rclive.sock", "/tmp/hc-rcother.sock", "/tmp/hc-rctoken000001.sock"}
    d.stop()


def test_cli_call_goes_over_ssh_to_the_private_socket(home):
    fake = FakeSSH()
    d = daemon(home, fake)
    d.start()
    assert d.call("list_windows", {"on_screen_only": True}, timeout=5) == {"ok": True}
    script = fake.scripts()[-1]
    assert script.startswith(f"CUA_DRIVER_RS_TELEMETRY_ENABLED=0 {REMOTE_BIN} call list_windows ")
    assert script.endswith("--socket /tmp/hc-rctoken000001.sock </dev/null")
    d.stop()
