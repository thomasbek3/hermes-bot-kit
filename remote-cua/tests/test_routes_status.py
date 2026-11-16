"""The /api/plugins/remote-cua routes (FastAPI TestClient), the status probe and the check command."""
from __future__ import annotations

import importlib.util
import sys

import pytest

from conftest import (MAC_CONFIG, PLUGIN_DIR, WINDOWS_CONFIG, FakeProc, FakeSSH, discovery_stdout, mod,
                      write_config)

fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

status = mod("status")
remote = mod("remote")
settings = mod("settings")


def load_api():
    name = "hermes_dashboard_plugin_remote-cua_test"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def client(home, monkeypatch):
    api = load_api()
    # The route module loads its own copy of the package; read config through plain YAML for the test.
    api_settings = api._mod("settings")
    import yaml
    monkeypatch.setattr(api_settings, "load_profile_config",
                        lambda: yaml.safe_load((home / "config.yaml").read_text()) if (home / "config.yaml").exists() else {})
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/remote-cua")
    return TestClient(app), api


def test_lease_take_release_cycle(client, home):
    write_config(home, MAC_CONFIG)
    c, _ = client
    r = c.get("/api/plugins/remote-cua/lease").json()
    assert r["ok"] and r["lease"]["holder"] == "agent" and r["configured"] and r["machine"]["host"] == "100.64.0.10"
    r = c.post("/api/plugins/remote-cua/take", json={"viewer": "pane-1"})
    assert r.status_code == 200 and r.json()["lease"]["holder"] == "human"
    r = c.post("/api/plugins/remote-cua/take", json={"viewer": "pane-2"})
    assert r.status_code == 409 and r.json()["error"] == "held_by_other_viewer"
    r = c.post("/api/plugins/remote-cua/release", json={"viewer": "pane-2"})
    assert r.status_code == 409 and r.json()["error"] == "not_holder"
    held = c.get("/api/plugins/remote-cua/lease").json()["lease"]
    r = c.post("/api/plugins/remote-cua/release", json={"viewer": "pane-2", "force": True, "epoch": held["epoch"]})
    assert r.status_code == 200 and r.json()["lease"]["holder"] == "agent"


def test_take_refuses_an_unconfigured_profile(client, home):
    c, _ = client
    r = c.post("/api/plugins/remote-cua/take", json={"viewer": "pane-1"})
    assert r.status_code == 409 and r.json()["error"] == "not_configured"
    assert not (home / "remote-cua" / "lease.json").exists()


@pytest.mark.parametrize("body", [{}, {"viewer": ""}, {"viewer": "a b"}, {"viewer": 5}, None])
def test_bad_viewer(client, home, body):
    write_config(home, MAC_CONFIG)
    c, _ = client
    assert c.post("/api/plugins/remote-cua/take", json=body).status_code == 400


def test_forced_release_with_a_stale_epoch_is_refused(client, home):
    write_config(home, MAC_CONFIG)
    c, _ = client
    seen = c.post("/api/plugins/remote-cua/take", json={"viewer": "pane-old"}).json()["lease"]
    c.post("/api/plugins/remote-cua/release", json={"viewer": "pane-old"})
    grant = c.post("/api/plugins/remote-cua/take", json={"viewer": "pane-new"}).json()["lease"]
    r = c.post("/api/plugins/remote-cua/release", json={"viewer": "pane-x", "force": True, "epoch": seen["epoch"]})
    assert r.status_code == 409 and r.json()["error"] == "stale_force" and r.json()["lease"] == grant
    assert c.post("/api/plugins/remote-cua/release", json={"force": True, "epoch": "1"}).status_code == 400
    assert c.post("/api/plugins/remote-cua/release", json={"force": True, "epoch": True}).status_code == 400
    r = c.post("/api/plugins/remote-cua/release", json={"viewer": "pane-x", "force": True, "epoch": grant["epoch"]})
    assert r.status_code == 200 and r.json()["lease"]["holder"] == "agent"


def test_release_without_viewer_needs_force(client, home):
    write_config(home, MAC_CONFIG)
    c, _ = client
    assert c.post("/api/plugins/remote-cua/release", json={}).status_code == 400
    assert c.post("/api/plugins/remote-cua/release", json={"force": True, "epoch": 0}).status_code == 200


@pytest.mark.parametrize("body", [{"viewer": "pane-legacy", "force": True},
                                  {"viewer": "pane-legacy", "force": True, "epoch": None},
                                  {"force": True}])
def test_delayed_force_without_an_epoch_cannot_revoke_a_new_grant(client, home, monkeypatch, body):
    """INT-R2-01 through the real route: an epoch-free force (older pane or script) delayed past an
    ordinary hand back and a new take is refused with 400 force_needs_epoch; the grant and the bot's
    refusal stand. On 1c496af it returned 200 and admitted the bot."""
    write_config(home, MAC_CONFIG)
    c, api = client
    c.post("/api/plugins/remote-cua/take", json={"viewer": "pane-old"})
    c.post("/api/plugins/remote-cua/release", json={"viewer": "pane-old"})
    grant = c.post("/api/plugins/remote-cua/take", json={"viewer": "pane-new"}).json()["lease"]
    api_lease = api._mod("lease")
    monkeypatch.setattr(api_lease, "_remote_cua_selected", lambda: True)
    assert api_lease.pre_tool_call("computer_use") is not None, "precondition: the bot is refused"
    r = c.post("/api/plugins/remote-cua/release", json=body)
    assert r.status_code == 400 and r.json()["error"] == "force_needs_epoch"
    assert c.get("/api/plugins/remote-cua/lease").json()["lease"] == grant
    assert api_lease.pre_tool_call("computer_use") is not None, "the bot is still refused"


def test_status_route(client, home, monkeypatch):
    write_config(home, MAC_CONFIG)
    c, api = client
    api_status = api._mod("status")
    monkeypatch.setattr(api_status, "status_for_profile", lambda fresh=False: {"ok": True, "fresh": fresh})
    assert c.get("/api/plugins/remote-cua/status?fresh=1").json() == {"ok": True, "fresh": True}


# --- status probe -------------------------------------------------------------------------------

def policy():
    return remote.DriverPolicy(pin="0.21.0", contract_reason=lambda m: "" if m else "driver manifest is missing",
                               team_ids=("YCK386LBJ7",))


CFG = settings.parse({"host": "100.64.0.10", "user": "you"})


def run(fake, home):
    return status.run_status(CFG, runner=remote.SSHRunner(CFG, run_fn=fake), policy=policy(), token="rcprobe",
                             home=home)


def test_status_all_good(home):
    fake = FakeSSH()
    out = run(fake, home)
    assert out["ok"] and out["reachable"] and out["driver"]["ok"] and out["permissions"]["ok"]
    assert out["screen_awake"] is True and out["windows"] == 2 and out["error"] == ""
    scripts = fake.scripts()
    perms = next(s for s in scripts if " call check_permissions " in s)
    assert '"prompt": false' in perms and "--socket /tmp/hc-rcprobe.sock" in perms
    assert scripts[-1] == remote.stop_command(remote.parse_discovery(discovery_stdout()).path, "/tmp/hc-rcprobe.sock")
    assert remote._read_registry(home) == []  # the probe daemon never outlives the probe
    assert "Permissions OK (Accessibility and Screen Recording)" in out["summary"]


def test_status_permissions_missing_and_screen_asleep(home):
    def respond(script):
        if " call check_permissions " in script:
            return FakeProc(0, '{"accessibility": true, "screen_recording": false}')
        if " call list_windows " in script:
            return FakeProc(0, '{"windows": []}')
        return FakeSSH.default(script)
    out = run(FakeSSH(respond), home)
    assert not out["ok"] and out["permissions"]["ok"] is False and out["screen_awake"] is False
    assert any("Screen Recording" in line for line in out["summary"])
    assert any("asleep" in line for line in out["summary"])


def test_status_unreachable(home):
    out = run(FakeSSH(lambda s: FakeProc(255, "", "Permission denied (publickey).")), home)
    assert out["reachable"] is False and "Permission denied" in out["error"]


def test_status_wrong_driver_version_stops_before_probe(home):
    fake = FakeSSH(lambda s: FakeProc(0, discovery_stdout(manifest='{"binary_version":"0.28.2"}'))
                   if "manifest-begin" in s else FakeSSH.default(s))
    out = run(fake, home)
    assert out["driver"]["ok"] is False and "pins 0.21.0" in out["driver"]["problem"] and len(fake.calls) == 1


def test_status_windows_refused_without_ssh():
    cfg = settings.parse({"host": "100.64.0.10", "user": "you", "os": "windows"})
    fake = FakeSSH()
    out = status.run_status(cfg, runner=remote.SSHRunner(cfg, run_fn=fake), policy=policy())
    assert out["supported"] is False and "Windows support coming: needs cua Session proxy" in out["error"]
    assert fake.calls == []


def test_status_not_configured():
    out = status.run_status(None, config_error="remote_cua.host is not set")
    assert out["configured"] is False and out["error"] == "remote_cua.host is not set"


def test_status_cache():
    calls = []
    t = [100.0]
    compute = lambda: calls.append(1) or {"ok": True}  # noqa: E731
    status._cache.clear()
    assert status.cached_status("k", compute, now=lambda: t[0])["cached"] is False
    assert status.cached_status("k", compute, now=lambda: t[0])["cached"] is True
    assert status.cached_status("k", compute, fresh=True, now=lambda: t[0])["cached"] is False
    assert len(calls) == 2


# --- settings + check command -------------------------------------------------------------------

@pytest.mark.parametrize("raw,needle", [
    (None, "no remote_cua block"),
    ({"user": "you"}, "host is not set"),
    ({"host": "-oProxyCommand=x", "user": "you"}, "plain host name"),
    ({"host": "h", "user": "a b"}, "plain user name"),
    ({"host": "h", "user": "u", "os": "linux"}, "must be one of macos, windows"),
    ({"host": "h", "user": "u", "driver": "cua-driver"}, "absolute path"),
])
def test_settings_validation(raw, needle):
    with pytest.raises(settings.ConfigError, match=needle):
        settings.parse(raw)


def test_check_command_windows_and_unconfigured(home, capsys, monkeypatch):
    cli = mod("cli")
    monkeypatch.setattr(settings, "load_profile_config", lambda: (_ for _ in ()).throw(RuntimeError("no hermes")))
    status._cache.clear()
    assert cli.print_check(None) == 2
    write_config(home, WINDOWS_CONFIG)
    status._cache.clear()
    assert cli.print_check(None) == 1
    assert "Windows support coming" in capsys.readouterr().out
