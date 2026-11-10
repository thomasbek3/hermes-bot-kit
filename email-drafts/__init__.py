"""email-drafts: bots write email as drafts; a person sends them.

Registers three tools for the bot (create, update, status; no send tool), the
bot instructions as a plugin skill, and the card's way in:

* ``plugin.email-drafts.api`` (plugin RPC, on a gateway that serves
  ``plugin-rpc-v1``), and
* ``/email-drafts api <op> <json>`` (a plugin slash command; Hermes Desktop's
  ``slash.exec`` runs it on every gateway this plugin supports).

Both run the same operations (engine.handle). A person typing
``/email-drafts`` sees the drafts list. Changes (send, discard, rules) are
refused from the plain CLI, where a bot's own shell could start a Hermes child.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from . import schemas
from .engine import READ_OPS, WRITE_OPS, Engine, handle
from .store import DraftError, Store

logger = logging.getLogger(__name__)

PLUGIN_NAME = "email-drafts"
TOOLSET = "email_drafts"
SETTING_KEYS = (
    "sender", "from_address", "from_name", "signature", "attachment_dirs",
    "smtp_host", "smtp_port", "smtp_security", "smtp_username",
)
# Surfaces where a slash command may change a draft: anything but the plain
# CLI (a bot's terminal tool could start `hermes chat -q "/email-drafts ..."`).
REFUSED_WRITE_PLATFORMS = {"cli"}


def _data_dir() -> Path:
    from plugins.plugin_storage import plugin_data_dir

    return plugin_data_dir(PLUGIN_NAME)


def _workspace() -> str | None:
    try:
        from agent.runtime_cwd import resolve_agent_cwd

        return str(resolve_agent_cwd())
    except Exception:
        return None


def build_engine(ctx: Any) -> Engine:
    def settings() -> dict:
        return {key: ctx.get_config(key) for key in SETTING_KEYS}

    def cron_run() -> Any:
        probe = getattr(ctx, "current_cron_execution", None)
        return probe() if callable(probe) else None

    return Engine(Store(_data_dir), settings, _workspace, cron_run)


def _tool(engine: Engine, name: str):
    def run(args: dict, **kwargs: Any) -> str:
        try:
            args = args if isinstance(args, dict) else {}
            if name == "email_draft_create":
                result = engine.create(args, session_id=str(kwargs.get("session_id") or ""))
            elif name == "email_draft_update":
                result = engine.update(args)
            else:
                result = engine.status(args)
        except DraftError as exc:
            result = {"ok": False, "error": str(exc)}
        except Exception as exc:
            logger.exception("email-drafts: %s failed", name)
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        return json.dumps(result, ensure_ascii=False)

    return run


def _describe(summary: dict) -> str:
    to = ", ".join(summary.get("to") or [])
    return f"{summary['id']}  {summary.get('status'):<9}  {summary.get('subject') or '(no subject)'}  -> {to}"


def slash_handler(engine: Engine):
    def run(raw_args: str, platform: str | None = None, **kwargs: Any) -> str:
        text = (raw_args or "").strip()
        verb, _, rest = text.partition(" ")
        if verb in ("", "list"):
            listing = engine.list({})
            rules = listing["rules"]
            lines = [f"Email drafts (rules: {rules['mode']}, {len(rules['allowed'])} allowed recipients)"]
            lines += [_describe(d) for d in listing["drafts"][:20]] or ["No drafts yet."]
            return "\n".join(lines)
        if verb == "api":
            op, _, payload = rest.strip().partition(" ")
            try:
                params = json.loads(payload) if payload.strip() else {}
            except ValueError:
                return json.dumps({"ok": False, "error": "params must be JSON"})
            if op in WRITE_OPS and str(platform or "").lower() in REFUSED_WRITE_PLATFORMS:
                return json.dumps({"ok": False, "error": "Send and rule changes happen on the draft card in Hermes Desktop."})
            surface = f"slash:{platform or 'unknown'}"
            return json.dumps(handle(engine, op, params, surface=surface), ensure_ascii=False)
        return "Usage: /email-drafts [list]  (drafts are sent from their card in the Hermes Desktop chat)"

    return run


def rpc_handler(engine: Engine):
    def run(params: Any, session_id: str | None = None, **kwargs: Any) -> dict:
        params = params if isinstance(params, dict) else {}
        op = str(params.get("op") or "")
        body = {k: v for k, v in params.items() if k not in ("op", "session_id")}
        if op not in READ_OPS and op not in WRITE_OPS:
            return {"ok": False, "error": f"Unknown operation {op!r}"}
        return handle(engine, op, body, surface="rpc")

    return run


def register(ctx: Any) -> None:
    engine = build_engine(ctx)
    for schema in (schemas.EMAIL_DRAFT_CREATE, schemas.EMAIL_DRAFT_UPDATE, schemas.EMAIL_DRAFT_STATUS):
        ctx.register_tool(
            name=schema["name"], toolset=TOOLSET, schema=schema, handler=_tool(engine, schema["name"]),
            description=schema["description"],
        )
    ctx.register_command(
        "email-drafts", slash_handler(engine),
        description="List email drafts (the draft card uses `/email-drafts api ...`)", args_hint="[list]",
    )
    # Plugin RPC is newer than the slash route; use it where the gateway has it.
    if callable(getattr(ctx, "register_rpc", None)):
        try:
            ctx.register_rpc("api", rpc_handler(engine))
        except Exception as exc:  # pragma: no cover - older or isolated hosts
            logger.debug("email-drafts: plugin RPC unavailable: %s", exc)
    skills = Path(__file__).parent / "skills"
    if callable(getattr(ctx, "register_skill", None)) and skills.is_dir():
        for child in sorted(skills.iterdir()):
            if (child / "SKILL.md").is_file():
                ctx.register_skill(child.name, child / "SKILL.md")


__all__ = ["register", "build_engine", "slash_handler", "rpc_handler"]
