"""slack-check dashboard plugin backend, mounted at /api/plugins/slack-check/.

GET /test answers "does this profile's Slack bot really work?" from Hermes's backend, where the
profile's Slack tokens live (desktop plugins never see them):

- reads SLACK_BOT_TOKEN (first entry when comma-separated) and SLACK_APP_TOKEN from the profile the
  request is scoped to (Hermes binds that scope before this handler runs: ``?profile=`` in-process,
  or the profile's own plugin host);
- calls Slack's read-only ``auth.test`` with the bot token;
- checks the app token with ``apps.connections.open``, which only mints a Socket Mode URL and does
  not connect (the URL is discarded, never returned);
- adds the newest Slack connection line from the profile's ``logs/gateway.log``.

Tokens are never returned or logged, and token-shaped text is scrubbed from every error.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter

router = APIRouter()

SLACK_API = "https://slack.com/api/"
TIMEOUT_SECS = 8.0
LOG_TAIL_BYTES = 200 * 1024

# xoxb-/xoxp-/xoxa-/xoxe-... and xapp-... tokens; long enough to never match prose.
_TOKEN_RE = re.compile(r"\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]+")
_LOG_MATCH_RE = re.compile(r"\[Slack\] (?:Socket Mode connected|Authenticated as|.*unhealthy)")
_LOG_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[,.]\d{1,6})?)")


def scrub(text: Any) -> str:
    """``text`` as a string with every Slack-token-shaped run replaced."""
    return _TOKEN_RE.sub("[redacted]", str(text))


# ---------------------------------------------------------------------------
# Profile env
# ---------------------------------------------------------------------------

def _profile_home() -> Path:
    """The home of the profile this request is scoped to (Hermes's own resolver)."""
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


def _secret(name: str) -> str:
    """``name`` from the scoped profile: Hermes's secret scope first (it also covers secret-manager
    sources), then the profile's ``.env`` via ``load_env`` (reads ``get_env_path()`` of the scope)."""
    value = ""
    try:
        from agent.secret_scope import get_secret
        value = get_secret(name, "") or ""
    except Exception:  # UnscopedSecretError or an older Hermes: fall back to the .env file
        value = ""
    if not value.strip():
        try:
            from hermes_cli.config import load_env
            value = load_env().get(name, "") or ""
        except Exception:
            value = ""
    return value.strip()


def read_tokens() -> tuple[str, str]:
    """``(bot_token, app_token)`` of the scoped profile; the bot token's first comma entry."""
    bot = _secret("SLACK_BOT_TOKEN").split(",")[0].strip()
    app = _secret("SLACK_APP_TOKEN").split(",")[0].strip()
    return bot, app


# ---------------------------------------------------------------------------
# Slack calls (stdlib only)
# ---------------------------------------------------------------------------

def _slack_call(method: str, token: str, opener: Optional[Callable] = None) -> dict[str, Any]:
    """POST ``method`` with ``token`` as a Bearer header (never in the URL). Returns Slack's JSON, or
    ``{"ok": False, "error": <scrubbed text>}`` on a transport/parse failure."""
    opener = opener or urllib.request.urlopen
    req = urllib.request.Request(
        SLACK_API + method, data=b"", method="POST",
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/x-www-form-urlencoded",
                 "User-Agent": "hermes-slack-check/1.0"})
    try:
        with opener(req, timeout=TIMEOUT_SECS) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": scrub(f"http_{exc.code}")}
    except urllib.error.URLError as exc:
        return {"ok": False, "error": scrub(f"network: {exc.reason}")}
    except Exception as exc:  # timeout, ssl, anything else: one scrubbed line
        return {"ok": False, "error": scrub(f"{type(exc).__name__}: {exc}")}
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return {"ok": False, "error": "bad_response"}
    return data if isinstance(data, dict) else {"ok": False, "error": "bad_response"}


def check_bot(token: str, opener: Optional[Callable] = None) -> dict[str, Any]:
    data = _slack_call("auth.test", token, opener)
    if not data.get("ok"):
        return {"ok": False, "error": scrub(data.get("error") or "unknown_error")}
    user = str(data.get("user") or "")
    return {
        "ok": True,
        "bot": f"@{user}" if user else "",
        "bot_id": scrub(data.get("bot_id") or data.get("user_id") or ""),
        "team": scrub(data.get("team") or ""),
        "team_id": scrub(data.get("team_id") or ""),
        "url": scrub(data.get("url") or ""),
    }


def check_app(token: str, opener: Optional[Callable] = None) -> dict[str, Any]:
    """``apps.connections.open`` mints a one-time wss URL without connecting; we drop the URL."""
    data = _slack_call("apps.connections.open", token, opener)
    if data.get("ok"):
        return {"app_token_ok": True}
    return {"app_token_ok": False, "app_token_error": scrub(data.get("error") or "unknown_error")}


# ---------------------------------------------------------------------------
# Gateway log
# ---------------------------------------------------------------------------

def last_log_line(log_path: Path, max_bytes: int = LOG_TAIL_BYTES) -> Optional[dict[str, str]]:
    """Newest ``[Slack]`` connect/auth/unhealthy line in the last ``max_bytes`` of ``log_path``."""
    try:
        with open(log_path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            chunk = fh.read(max_bytes)
    except OSError:
        return None
    for line in reversed(chunk.decode("utf-8", "replace").splitlines()):
        m = _LOG_MATCH_RE.search(line)
        if not m:
            continue
        ts = _LOG_TS_RE.match(line)
        return {"ts": ts.group(1) if ts else "", "text": scrub(line[m.start():].strip())[:300]}
    return None


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

def run_check(opener: Optional[Callable] = None) -> dict[str, Any]:
    home = _profile_home()
    bot_token, app_token = read_tokens()
    result: dict[str, Any]
    if not bot_token:
        result = {"ok": False, "configured": False}
    else:
        result = {"configured": True, **check_bot(bot_token, opener)}
        if app_token:
            result.update(check_app(app_token, opener))
    last = last_log_line(home / "logs" / "gateway.log")
    if last:
        result["last_log"] = last
    return result


@router.get("/test")
def slack_test() -> dict[str, Any]:
    # Sync on purpose: FastAPI runs it in a worker thread with the request's profile scope copied in.
    try:
        return run_check()
    except Exception as exc:  # never let a traceback (which could carry locals) reach the client
        return {"ok": False, "configured": None, "error": scrub(f"{type(exc).__name__}: {exc}")}
