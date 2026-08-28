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
- Never pad. If the honest answer is one word, send one word.
- These rules come from the texting-style plugin, delivered with each message
  (they are intentionally not in your frozen system prompt). If asked whether
  the texting/SMS/short-message plugin is active in this chat: yes, it is -
  you are reading it right now. No need to investigate."""


def _candidate_dbs(profile_name: str) -> list:
    """state.db candidates, most-likely first: HERMES_HOME env, the
    hermes_cli helper, the profile derived from profile_name, then root and
    every named profile. Some builds mis-resolve the helper (returns root
    while running a named profile), so we never trust one source alone."""
    seen, out = set(), []

    def add(home) -> None:
        try:
            db = Path(home) / "state.db"
        except Exception:
            return
        key = str(db)
        if key not in seen and db.is_file():
            seen.add(key)
            out.append(db)

    env_home = os.environ.get("HERMES_HOME", "")
    if env_home:
        add(env_home)
    try:
        from hermes_cli.profiles import get_hermes_home  # type: ignore

        add(get_hermes_home())
    except Exception:
        pass
    root = Path(os.path.expanduser("~/.hermes"))
    if profile_name and profile_name != "default":
        add(root / "profiles" / profile_name)
    add(root)
    profiles_dir = root / "profiles"
    if profiles_dir.is_dir():
        try:
            for p in sorted(profiles_dir.iterdir()):
                add(p)
        except Exception:
            pass
    return out


# session_id -> db path that actually holds it (found once, reused per turn)
_db_for_session: dict = {}


def _session_row(profile_name: str, session_id: str, columns: str) -> tuple:
    """Read columns for a session, searching candidate state.dbs until the
    session id is found (cached). Empty tuple on any failure -- never crash
    a prompt build."""
    if not session_id:
        return ()
    known = _db_for_session.get(session_id)
    dbs = [known] if known else _candidate_dbs(profile_name)
    for db in dbs:
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
            try:
                row = conn.execute(
                    f"SELECT {columns} FROM sessions WHERE id = ?", (session_id,)
                ).fetchone()
            finally:
                conn.close()
        except Exception:
            continue
        if row is not None:
            if len(_db_for_session) > 512:
                _db_for_session.clear()
            _db_for_session[session_id] = db
            return tuple(row)
    return ()


def _session_title(profile_name: str, session_id: str) -> str:
    row = _session_row(profile_name, session_id, "title")
    return str(row[0]) if row and row[0] is not None else ""


def _stored_prompt_has_doctrine(session_id: str) -> bool:
    row = _session_row("", session_id, "system_prompt")
    return bool(row) and "## Texting register" in str(row[0] or "")


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

    # Self-healing for eternal Bot Chat sessions: their system prompt is
    # frozen and only rebuilds on a capability-epoch change, so a Bot Chat
    # that predates this plugin never renders the section above. This hook
    # runs each turn; when the session is a Bot Chat and the system prompt
    # does NOT already carry the doctrine, it injects the doctrine as
    # per-turn context instead. Once an epoch rebuild bakes the section in,
    # the hook goes silent automatically.
    _title_cache: dict = {}

    def _is_bot_chat(session_id: str) -> bool:
        if session_id in _title_cache:
            return _title_cache[session_id]
        title = _session_title("", session_id)
        result = title.strip() == BOT_CHAT_TITLE
        _title_cache[session_id] = result
        if len(_title_cache) > 512:
            _title_cache.clear()
        return result

    def _debug(msg: str) -> None:
        if not os.environ.get("TS_DEBUG"):
            return
        try:
            with open("/tmp/texting-style-debug.log", "a") as fh:
                fh.write(msg + "\n")
        except Exception:
            pass

    def backfill(session_id="", conversation_history=None, platform="", **kwargs):
        _debug(f"backfill called: session={session_id!r} platform={platform!r}")
        try:
            if not _cfg("enabled", True):
                return None
            allow = str(_cfg("platforms", "") or "").strip()
            if allow:
                wanted = {p.strip().lower() for p in allow.split(",") if p.strip()}
                plat = str(platform or "").lower()
                if plat and wanted and plat not in wanted:
                    return None
            if _cfg("bot_chat_only", True) and not _is_bot_chat(str(session_id or "")):
                _debug(f"blocked: not a Bot Chat (session={session_id!r})")
                return None
            history = conversation_history or []
            if history and isinstance(history[0], dict) and history[0].get("role") == "system":
                if "## Texting register" in str(history[0].get("content") or ""):
                    return None  # section already baked into the prompt
            if _stored_prompt_has_doctrine(str(session_id or "")):
                _debug("blocked: doctrine already in stored prompt")
                return None  # persisted system prompt already carries it
            _debug("INJECTING doctrine")
            text = DOCTRINE
            extra = str(_cfg("extra_rules", "") or "").strip()
            if extra:
                text = text + "\n- " + extra
            return {"context": text}
        except Exception:
            return None  # never break a turn

    ctx.register_hook("pre_llm_call", backfill)
