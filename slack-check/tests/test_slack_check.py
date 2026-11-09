"""slack-check backend tests. No network: every Slack call goes through a fake opener.

Run with Hermes's venv so the real profile helpers are used:
    ~/.hermes/hermes-agent/venv/bin/python -m pytest -p no:cacheprovider slack-check/tests
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import sys
import urllib.error
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
# Hermes's source root. Its venv's editable install does not map every top-level module (e.g.
# ``hermes_yaml``), so put the checkout itself on the path, as the running backend has it.
HERMES_SRC = Path(os.environ.get("HERMES_AGENT_DIR", Path.home() / ".hermes" / "hermes-agent"))
if (HERMES_SRC / "hermes_cli").is_dir() and str(HERMES_SRC) not in sys.path:
    sys.path.insert(0, str(HERMES_SRC))
API_FILE = PLUGIN_DIR / "dashboard" / "plugin_api.py"

FAKE_BOT = "xoxb-1111-2222-FAKEbotTOKENvalue"
FAKE_BOT_2 = "xoxb-3333-4444-SECONDtokenVALUE"
FAKE_APP = "xapp-1-A111-2222-FAKEappTOKENvalue"
FAKE_OTHER = "xoxb-9999-8888-OTHERprofileTOKEN"


def _load_module():
    name = "hermes_dashboard_plugin_slack_check_test"
    spec = importlib.util.spec_from_file_location(name, API_FILE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod  # as Hermes does, so FastAPI resolves string annotations
    spec.loader.exec_module(mod)
    return mod


api = _load_module()


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSlack:
    """Records requests; answers per Slack method from ``answers`` (dict or exception)."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, req, timeout=None):
        method = req.full_url.rsplit("/", 1)[-1]
        self.calls.append({"method": method, "url": req.full_url, "timeout": timeout,
                           "auth": req.get_header("Authorization"), "verb": req.get_method()})
        answer = self.answers[method]
        if isinstance(answer, BaseException):
            raise answer
        return FakeResp(json.dumps(answer).encode())


AUTH_OK = {"ok": True, "url": "https://acme-workspace.slack.com/", "team": "Acme Workspace",
           "user": "intake", "team_id": "T0EXAMPLE01", "user_id": "U0BOT", "bot_id": "B0BOT"}
APPS_OK = {"ok": True, "url": "wss://wss-primary.slack.com/link/?ticket=SECRET-TICKET&app_id=A1"}


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A fresh Hermes root as the process home, with no Slack vars leaking from os.environ."""
    root = tmp_path / "hermes"
    (root / "logs").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(root))
    for var in ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    return root


def _write_env(home: Path, **values):
    home.mkdir(parents=True, exist_ok=True)
    (home / ".env").write_text("".join(f"{k}={v}\n" for k, v in values.items()))


# --- profile env resolution ----------------------------------------------------------------

def test_reads_tokens_from_profile_env(home):
    _write_env(home, SLACK_BOT_TOKEN=FAKE_BOT, SLACK_APP_TOKEN=FAKE_APP)
    assert api.read_tokens() == (FAKE_BOT, FAKE_APP)


def test_bot_token_first_comma_entry(home):
    _write_env(home, SLACK_BOT_TOKEN=f"{FAKE_BOT},{FAKE_BOT_2}")
    assert api.read_tokens() == (FAKE_BOT, "")


def test_scoped_profile_home_wins_over_root(home):
    """Under Hermes's per-request home override (what the profile scope sets), the TARGET profile's
    .env is read, not the root's."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    _write_env(home, SLACK_BOT_TOKEN=FAKE_OTHER)
    profile = home / "profiles" / "intake"
    _write_env(profile, SLACK_BOT_TOKEN=FAKE_BOT)
    token = set_hermes_home_override(str(profile))
    try:
        assert api._profile_home() == profile
        assert api.read_tokens()[0] == FAKE_BOT
    finally:
        reset_hermes_home_override(token)
    assert api.read_tokens()[0] == FAKE_OTHER


# --- endpoint logic ------------------------------------------------------------------------

def test_missing_token_makes_no_call(home):
    fake = FakeSlack({})
    assert api.run_check(fake) == {"ok": False, "configured": False}
    assert fake.calls == []


def test_auth_test_ok_and_app_token(home):
    _write_env(home, SLACK_BOT_TOKEN=FAKE_BOT, SLACK_APP_TOKEN=FAKE_APP)
    fake = FakeSlack({"auth.test": AUTH_OK, "apps.connections.open": APPS_OK})
    result = api.run_check(fake)
    assert result == {"ok": True, "configured": True, "bot": "@intake", "bot_id": "B0BOT",
                      "team": "Acme Workspace", "team_id": "T0EXAMPLE01",
                      "url": "https://acme-workspace.slack.com/", "app_token_ok": True}
    assert [c["method"] for c in fake.calls] == ["auth.test", "apps.connections.open"]
    bot_call, app_call = fake.calls
    assert bot_call["auth"] == f"Bearer {FAKE_BOT}" and app_call["auth"] == f"Bearer {FAKE_APP}"
    assert all(c["timeout"] == 8.0 and c["verb"] == "POST" for c in fake.calls)
    assert all("xox" not in c["url"] and "xapp" not in c["url"] for c in fake.calls)
    dumped = json.dumps(result)
    assert FAKE_BOT not in dumped and FAKE_APP not in dumped and "wss://" not in dumped


def test_auth_test_error(home):
    _write_env(home, SLACK_BOT_TOKEN=FAKE_BOT)
    fake = FakeSlack({"auth.test": {"ok": False, "error": "invalid_auth"}})
    assert api.run_check(fake) == {"ok": False, "configured": True, "error": "invalid_auth"}
    assert len(fake.calls) == 1  # no app token -> no apps.connections.open


def test_app_token_error_reported(home):
    _write_env(home, SLACK_BOT_TOKEN=FAKE_BOT, SLACK_APP_TOKEN=FAKE_APP)
    fake = FakeSlack({"auth.test": AUTH_OK, "apps.connections.open": {"ok": False, "error": "invalid_auth"}})
    result = api.run_check(fake)
    assert result["ok"] is True and result["app_token_ok"] is False
    assert result["app_token_error"] == "invalid_auth"


def test_transport_errors_are_scrubbed(home):
    _write_env(home, SLACK_BOT_TOKEN=FAKE_BOT)
    fake = FakeSlack({"auth.test": urllib.error.URLError(f"boom near {FAKE_BOT}")})
    result = api.run_check(fake)
    assert result["ok"] is False and result["configured"] is True
    assert FAKE_BOT not in json.dumps(result) and "[redacted]" in result["error"]

    fake = FakeSlack({"auth.test": TimeoutError(f"timed out with {FAKE_APP}")})
    result = api.run_check(fake)
    assert FAKE_APP not in json.dumps(result) and result["error"].startswith("TimeoutError")


def test_slack_error_text_is_scrubbed(home):
    _write_env(home, SLACK_BOT_TOKEN=FAKE_BOT)
    fake = FakeSlack({"auth.test": {"ok": False, "error": f"weird {FAKE_BOT}"}})
    assert FAKE_BOT not in json.dumps(api.run_check(fake))


@pytest.mark.parametrize("text", [FAKE_BOT, FAKE_APP, "xoxp-12-34-abc", "xoxe.xoxp-1-zz", "xoxa-2-q"])
def test_scrub_patterns(text):
    out = api.scrub(f"before {text} after")
    assert "[redacted]" in out and "xoxb-1111" not in out and "xapp-1-" not in out
    assert out.startswith("before ") and out.endswith(" after")


def test_scrub_leaves_plain_text():
    assert api.scrub("invalid_auth for team T0EXAMPLE01") == "invalid_auth for team T0EXAMPLE01"


# --- gateway log tail ----------------------------------------------------------------------

LOG = """\
2026-11-08 09:00:00,001 INFO gateway.run: starting
2026-11-08 09:00:01,100 INFO plugins.platforms.slack.adapter: [Slack] Authenticated as @intake in workspace Acme Workspace (team: T0EXAMPLE01)
2026-11-08 09:00:02,200 INFO plugins.platforms.slack.adapter: [Slack] Socket Mode connected (1 workspace(s))
2026-11-08 10:00:00,000 WARNING plugins.platforms.slack.adapter: [Slack] Socket Mode unhealthy (token {tok} rejected); reconnecting
2026-11-08 10:00:05,000 INFO gateway.run: unrelated [Telegram] Socket Mode connected
"""


def test_last_log_picks_newest_slack_line_and_scrubs(home):
    (home / "logs" / "gateway.log").write_text(LOG.format(tok=FAKE_BOT))
    last = api.last_log_line(home / "logs" / "gateway.log")
    assert last["ts"] == "2026-11-08 10:00:00,000"
    assert last["text"].startswith("[Slack] Socket Mode unhealthy")
    assert FAKE_BOT not in last["text"] and "[redacted]" in last["text"]


def test_last_log_only_reads_tail(home):
    log = home / "logs" / "gateway.log"
    first_two = "".join(LOG.splitlines(keepends=True)[:3])
    log.write_text(first_two + "x" * 5000 + "\n")
    assert api.last_log_line(log, max_bytes=1000) is None
    assert api.last_log_line(log, max_bytes=100_000)["text"].startswith("[Slack] Socket Mode connected")


def test_last_log_missing_file(home):
    assert api.last_log_line(home / "logs" / "nope.log") is None


def test_run_check_includes_last_log(home):
    (home / "logs" / "gateway.log").write_text(LOG.format(tok="x"))
    result = api.run_check(FakeSlack({}))
    assert result["configured"] is False and result["last_log"]["ts"] == "2026-11-08 10:00:00,000"


# --- router mounting -----------------------------------------------------------------------

def test_router_mounts_and_serves(home, monkeypatch):
    testclient = pytest.importorskip("fastapi.testclient")
    from fastapi import FastAPI
    _write_env(home, SLACK_BOT_TOKEN=FAKE_BOT)
    fake = FakeSlack({"auth.test": AUTH_OK})
    monkeypatch.setattr(api.urllib.request, "urlopen", fake)
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/slack-check")
    resp = testclient.TestClient(app).get("/api/plugins/slack-check/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True and body["bot"] == "@intake" and body["team"] == "Acme Workspace"
    assert FAKE_BOT not in resp.text and len(fake.calls) == 1


def test_route_honours_profile_scope_dependency(tmp_path, monkeypatch):
    """Mounted like Hermes mounts it (a dependency entering ``_config_profile_scope(profile)``), a
    ``?profile=`` request reads that profile's token. Isolated in a subprocess: entering another
    profile's scope flips the process to multi-profile hosting."""
    pytest.importorskip("fastapi.testclient")
    import subprocess
    root = tmp_path / "hermes"
    _write_env(root, SLACK_BOT_TOKEN=FAKE_OTHER)
    _write_env(root / "profiles" / "intake", SLACK_BOT_TOKEN=FAKE_BOT)
    (root / "config.yaml").write_text("{}\n")
    (root / "profiles" / "intake" / "config.yaml").write_text("{}\n")
    script = f"""
import importlib.util, io, json, sys
sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE
sys.path.insert(0, {str(HERMES_SRC)!r})
from typing import Optional
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_slack_check", {str(API_FILE)!r})
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
seen = []
class R(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False
def fake(req, timeout=None):
    seen.append(req.get_header("Authorization"))
    return R(json.dumps({{"ok": True, "user": "intake", "team": "Acme Workspace"}}).encode())
mod.urllib.request.urlopen = fake
from hermes_cli.web_server_profiles import _config_profile_scope
async def scope(profile: Optional[str] = None):
    with _config_profile_scope(profile):
        yield
app = FastAPI()
app.include_router(mod.router, prefix="/api/plugins/slack-check", dependencies=[Depends(scope)])
c = TestClient(app)
r1 = c.get("/api/plugins/slack-check/test?profile=intake").json()
print(json.dumps({{"r1": r1, "seen": [s.endswith({FAKE_BOT[-8:]!r}) for s in seen]}}))
"""
    env = {"HERMES_HOME": str(root), "PATH": "/usr/bin:/bin", "HOME": str(tmp_path)}
    proc = subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True,
                          env=env, cwd=str(tmp_path), timeout=120)
    assert proc.returncode == 0, proc.stderr[-2000:]
    out = json.loads(proc.stdout.strip().splitlines()[-1])
    assert out["r1"]["ok"] is True and out["r1"]["bot"] == "@intake"
    assert out["seen"] == [True]  # the intake profile's token, not the root's
    assert FAKE_BOT not in proc.stdout and FAKE_OTHER not in proc.stdout


def test_hermes_discovers_manifest_with_api(tmp_path):
    """Hermes's own discovery accepts the manifest: ``api`` passes the path validator, the tab is
    hidden, and the backend mounts only once ``slack-check`` is in plugins.enabled."""
    dash = pytest.importorskip("hermes_cli.web_server_dashboard")
    root = tmp_path / "plugins"
    shutil.copytree(PLUGIN_DIR / "dashboard", root / "slack-check" / "dashboard")
    (entry,) = dash._discover_dashboard_plugins([(root, "user")])
    assert entry["name"] == "slack-check" and entry["has_api"] is True
    assert entry["_api_file"] == "plugin_api.py" and entry["tab"]["hidden"] is True
    assert dash._plugin_api_mount_skip_reason(entry, set(), set()) == "not in plugins.enabled"
    assert dash._plugin_api_mount_skip_reason(entry, {"slack-check"}, set()) is None
