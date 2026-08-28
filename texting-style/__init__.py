"""texting-style plugin -- SMS-register doctrine as a system-prompt section.

Registers one bounded, cache-safe system prompt section (frozen per session)
that makes the bot reply like a person texting: short by default, mirroring
the user's length, expanding only for real work output or when asked.

By default the doctrine applies ONLY to Bot Mode chats: the desktop's
canonical per-bot conversation is the session titled "Bot Chat" (the same
gate Hermes core uses in tools/bot_mode_probe.py), so regular Sessions keep
stock behavior even in the same profile. Set config ``bot_chat_only: false``
to apply everywhere.

No tools, no hooks, no network. Config: enabled / bot_chat_only / platforms
/ extra_rules.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

# Must match tools/bot_mode_probe.py BOT_CHAT_TITLE (the desktop's
# createCanonicalChat title and the `-c "Bot Chat"` resume target).
BOT_CHAT_TITLE = "Bot Chat"

DOCTRINE = """## Texting register

This chat is a texting thread, not a document. Reply the way a sharp, warm
human texts:

- Default reply: 1-2 short sentences. If nothing needs more, stay under 25 words.
- Mirror the user's energy and length - a five-word message gets a short reply.
- No headers, no bullet lists, no numbered sections in chat replies. Plain sentences.
- Skip preamble, greetings, restating the question, and sign-offs. Just answer.
- Ask at most one question per reply, and only when you actually need the answer.
- Casual register is fine (contractions, "yep", "on it"). Clear, never sloppy.
- Doing real work? Quick ack first ("on it"), do the work, then report the
  outcome in a few short lines - lead with the result, not the process.
- Go long ONLY when the user explicitly asks for detail, a plan, or a document,
  or when the deliverable itself is long (code, drafts, reports). Even then,
  open with a one-line summary.
- Never pad. If the honest answer is one word, send one word."""


def _profile_home(profile_name: str) -> Path:
    """Profile home dir. Prefer the live HERMES_HOME helper; fall back to
    the standard layout derived from profile_name."""
    try:
        from hermes_cli.profiles import get_hermes_home  # type: ignore

        home = Path(get_hermes_home())
        if home.exists():
            return home
    except Exception:
        pass
    root = Path(os.path.expanduser("~/.hermes"))
    if profile_name and profile_name != "default":
        return root / "profiles" / profile_name
    return root


def _session_title(profile_name: str, session_id: str) -> str:
    """Read the session's title from the profile's state.db (read-only).
    Empty string on any failure -- never crash a prompt build."""
    if not session_id:
        return ""
    db = _profile_home(profile_name) / "state.db"
    if not db.is_file():
        return ""
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        try:
            row = conn.execute(
                "SELECT title FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        finally:
            conn.close()
    except Exception:
        return ""
    return str(row[0]) if row and row[0] is not None else ""


def register(ctx) -> None:
    def _cfg(key, default):
        try:
            value = ctx.get_config(key, default=default)
        except Exception:
            return default
        return default if value is None else value

    def section(session_info) -> str:
        info = session_info or {}
        if not _cfg("enabled", True):
            return ""
        allow = str(_cfg("platforms", "") or "").strip()
        if allow:
            wanted = {p.strip().lower() for p in allow.split(",") if p.strip()}
            platform = str(info.get("platform", "") or "").lower()
            if platform and wanted and platform not in wanted:
                return ""
        if _cfg("bot_chat_only", True):
            title = _session_title(
                str(info.get("profile_name", "") or ""),
                str(info.get("session_id", "") or ""),
            )
            if title.strip() != BOT_CHAT_TITLE:
                return ""
        text = DOCTRINE
        extra = str(_cfg("extra_rules", "") or "").strip()
        if extra:
            text = text + "\n- " + extra
        return text

    ctx.register_system_prompt_section(
        "texting-style.sms-register",
        section,
        position="after_memory",
        max_chars=4000,
    )
