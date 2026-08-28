"""texting-style plugin -- SMS-register doctrine as a system-prompt section.

Registers one bounded, cache-safe system prompt section (frozen per session)
that makes the bot reply like a person texting: short by default, mirroring
the user's length, expanding only for real work output or when asked.

No tools, no hooks, no network. Config: enabled / platforms / extra_rules.
"""

from __future__ import annotations

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


def register(ctx) -> None:
    def _cfg(key, default):
        try:
            value = ctx.get_config(key, default=default)
        except Exception:
            return default
        return default if value is None else value

    def section(session_info) -> str:
        if not _cfg("enabled", True):
            return ""
        allow = str(_cfg("platforms", "") or "").strip()
        if allow:
            wanted = {p.strip().lower() for p in allow.split(",") if p.strip()}
            platform = str((session_info or {}).get("platform", "") or "").lower()
            if platform and wanted and platform not in wanted:
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
