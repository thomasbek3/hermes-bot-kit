"""The draft lifecycle: what the bot's tools and the chat card may do.

The bot can create, update and read drafts. It cannot send: there is no send
tool. A draft is sent only when

* a person clicks Send on the card (``send`` from the Desktop, through the
  plugin's own RPC method or its slash command), or
* this bot's rules are in "allow" mode and every recipient (To, Cc and Bcc) is
  on the bot's allowed list, which only a person can add to (the card's
  "Allow recipient" and "Manage rules").

Every send attempt, discard and rule change is written to the audit log with
who caused it (``human`` click or ``allow-rule``), the surface and the time.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from . import attachments as att
from . import senders
from .store import DraftError, Store, clean_body, clean_subject, normalize_addresses, now, valid_id

logger = logging.getLogger(__name__)

SETTINGS_DEFAULTS = {
    "sender": "gmail",
    "from_address": "",
    "from_name": "",
    "signature": "",
    "attachment_dirs": [],
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_security": "starttls",
    "smtp_username": "",
}

DISABLED_MESSAGE = (
    "Email drafts are turned off for this bot. Nothing was drafted or sent. "
    "Tell the user in one line that drafting email is disabled for you, and that they can turn it back on "
    "from a draft card's rules menu (Needs approval) or ask for the text in the chat instead."
)

# A send claim older than this (the process died mid-send) shows as unknown.
STALE_SENDING_S = 10 * 60

# Fields the card may edit on a pending (or failed) draft.
EDITABLE = ("to", "cc", "bcc", "subject", "body")


class Engine:
    def __init__(
        self,
        store: Store,
        settings: Callable[[], dict],
        workspace: Callable[[], Optional[str]],
        cron_run: Callable[[], Any] = lambda: None,
        deliver: Callable[[dict, dict, list], dict] | None = None,
    ):
        self.store = store
        self._settings = settings
        self._workspace = workspace
        self._cron_run = cron_run
        self._deliver = deliver or senders.deliver

    # ── helpers ─────────────────────────────────────────────────────────
    def settings(self) -> dict:
        merged = dict(SETTINGS_DEFAULTS)
        try:
            merged.update({k: v for k, v in (self._settings() or {}).items() if v is not None})
        except Exception as exc:  # a broken config never blocks drafting
            logger.warning("email-drafts: settings unreadable: %s", exc)
        dirs = merged.get("attachment_dirs")
        merged["attachment_dirs"] = [str(d) for d in dirs] if isinstance(dirs, list) else []
        return merged

    def _roots(self, workspace: Optional[str]) -> list[str]:
        return att.allowed_roots(workspace, self.settings()["attachment_dirs"])

    def view(self, draft: dict) -> dict:
        """What the card and the tools see (no absolute roots, no audit)."""
        settings = self.settings()
        rules = self.store.rules()
        return {
            "id": draft["id"],
            "rev": draft.get("rev", 1),
            "status": draft.get("status"),
            "from": settings.get("from_address") or "",
            "from_name": settings.get("from_name") or "",
            "signature": str(settings.get("signature") or "").replace("\\n", "\n"),
            "to": draft.get("to", []),
            "cc": draft.get("cc", []),
            "bcc": draft.get("bcc", []),
            "subject": draft.get("subject", ""),
            "body": draft.get("body", ""),
            "attachments": [{"path": a["path"], "name": a["name"], "size": a.get("size")} for a in draft.get("attachments", [])],
            "in_reply_to": draft.get("in_reply_to"),
            "created_at": draft.get("created_at"),
            "updated_at": draft.get("updated_at"),
            "sent_at": draft.get("sent_at"),
            "sent_by": draft.get("sent_by"),
            "discarded_at": draft.get("discarded_at"),
            "error": draft.get("error"),
            "delivery_unknown": bool(draft.get("delivery_unknown"))
            or (draft.get("status") == "sending" and now() - float(draft.get("sending_at") or 0) > STALE_SENDING_S),
            "origin": draft.get("origin"),
            "rules": {"mode": rules["mode"], "allowed": rules["allowed"]},
            "allowed_now": self._all_allowed(draft, rules),
        }

    @staticmethod
    def _all_allowed(draft: dict, rules: dict) -> bool:
        recipients = senders.all_recipients(draft)
        allowed = set(rules["allowed"])
        return bool(draft.get("to")) and all(r.lower() in allowed for r in recipients)

    @staticmethod
    def _reply(value: Any) -> Optional[dict]:
        if not value:
            return None
        if isinstance(value, str):
            value = {"message_id": value}
        if not isinstance(value, dict):
            raise DraftError("in_reply_to must be an object")
        out: dict[str, Any] = {}
        for key in ("message_id", "subject", "from", "thread_id"):
            text = str(value.get(key) or "").replace("\r", " ").replace("\n", " ").strip()
            if text:
                out[key] = text[:998]
        refs = value.get("references")
        if isinstance(refs, str):
            refs = refs.split()
        if isinstance(refs, list):
            out["references"] = [str(r).strip() for r in refs if str(r).strip() and "\n" not in str(r)][:50]
        mid = out.get("message_id", "")
        if mid and not (mid.startswith("<") and mid.endswith(">")):
            out["message_id"] = f"<{mid.strip('<>')}>"
        return out or None

    def _fields(self, args: dict, partial: bool) -> dict:
        out: dict[str, Any] = {}
        for key in ("to", "cc", "bcc"):
            if key in args or not partial:
                out[key] = normalize_addresses(args.get(key), key)
        if "subject" in args or not partial:
            out["subject"] = clean_subject(args.get("subject"))
        if "body" in args or not partial:
            out["body"] = clean_body(args.get("body"))
        return out

    # ── bot tools ───────────────────────────────────────────────────────
    def create(self, args: dict, *, session_id: str = "") -> dict:
        rules = self.store.rules()
        if rules["mode"] == "disabled":
            return {"ok": False, "status": "disabled", "error": DISABLED_MESSAGE}
        fields = self._fields(args, partial=False)
        if not fields["to"]:
            raise DraftError("to: add at least one recipient")
        workspace = self._workspace()
        roots = self._roots(workspace)
        files = att.resolve_attachments(args.get("attachments"), roots, workspace)
        cron = self._cron_run()
        draft = self.store.create({
            **fields,
            "attachments": files,
            "roots": roots,
            "in_reply_to": self._reply(args.get("in_reply_to")),
            "session_id": str(session_id or ""),
            "origin": "cron" if cron is not None else "chat",
        })
        self.store.audit("created", id=draft["id"], origin=draft["origin"], recipients=len(senders.all_recipients(draft)))
        return self._after_write(draft, "Draft created")

    def update(self, args: dict) -> dict:
        draft_id = valid_id(args.get("id"))
        fields = self._fields(args, partial=True)
        workspace = self._workspace()
        new_files = None
        if "attachments" in args:
            roots = self._roots(workspace)
            new_files = (att.resolve_attachments(args.get("attachments"), roots, workspace), roots)
        reply = self._reply(args.get("in_reply_to")) if "in_reply_to" in args else None

        def change(draft: dict) -> None:
            if draft.get("status") != "pending":
                raise DraftError(f"Draft {draft_id} is {draft.get('status')}; only a pending draft can change")
            draft.update(fields)
            if new_files is not None:
                draft["attachments"], draft["roots"] = new_files
            if "in_reply_to" in args:
                draft["in_reply_to"] = reply
            if not draft.get("to"):
                raise DraftError("to: add at least one recipient")
            draft["rev"] = int(draft.get("rev", 1)) + 1

        draft = self.store.mutate(draft_id, change)
        return self._after_write(draft, "Draft updated")

    def status(self, args: dict) -> dict:
        draft = self.store.load(valid_id(args.get("id")))
        return {"ok": True, "email_draft": self._summary(draft)}

    def _summary(self, draft: dict) -> dict:
        return {
            "id": draft["id"],
            "status": draft.get("status"),
            "rev": draft.get("rev", 1),
            "subject": draft.get("subject", ""),
            "to": draft.get("to", []),
            "cc": draft.get("cc", []),
            "attachments": [a["name"] for a in draft.get("attachments", [])],
            **({"sent_by": draft["sent_by"], "sent_at": draft["sent_at"]} if draft.get("sent_at") else {}),
            **({"error": draft["error"]} if draft.get("error") else {}),
        }

    def _after_write(self, draft: dict, verb: str) -> dict:
        """Auto-send under the allow rule, else leave it waiting. Never waits for a person."""
        rules = self.store.rules()
        if rules["mode"] == "allow" and self._all_allowed(draft, rules):
            result = self._send(draft["id"], actor="allow-rule", surface="tool", expect_rev=draft.get("rev"))
            sent = result.get("draft") or {}
            if sent.get("status") == "sent":
                message = f"{verb} and sent automatically: every recipient is on this bot's allowed list."
            else:
                message = f"{verb}; sending it automatically failed: {sent.get('error') or result.get('error')}. It waits on the card for Retry."
            return {"ok": True, "email_draft": self._summary(self.store.load(draft["id"])), "message": message}
        where = (
            "It waits for approval: the user sends it from the draft card in their Hermes Desktop chat with this bot."
            if draft.get("origin") != "cron"
            else "It waits for approval on the draft card in the Hermes Desktop chat with this bot (a scheduled run cannot send it)."
        )
        return {
            "ok": True,
            "email_draft": self._summary(draft),
            "message": f"{verb}. Not sent. {where} Reply with one short line saying the draft is ready; do not paste the email again.",
        }

    # ── the card (a person) ─────────────────────────────────────────────
    def get(self, params: dict) -> dict:
        return {"ok": True, "draft": self.view(self.store.load(valid_id(params.get("id"))))}

    def list(self, params: dict) -> dict:
        status = params.get("status")
        rows = [d for d in self.store.list() if not status or d.get("status") == status]
        return {"ok": True, "drafts": [self._summary(d) for d in rows], "rules": self.store.rules()}

    def edit(self, params: dict, *, surface: str) -> dict:
        """The card saved its fields (To, Cc, subject, body) on a pending draft."""
        draft_id = valid_id(params.get("id"))
        fields = self._fields({k: params[k] for k in EDITABLE if k in params}, partial=True)
        expect = params.get("rev")

        def change(draft: dict) -> None:
            if draft.get("status") not in ("pending", "failed"):
                raise DraftError(f"Draft is {draft.get('status')}; it can no longer change")
            if expect is not None and int(expect) != int(draft.get("rev", 1)):
                raise DraftError("The bot changed this draft; review it again")
            draft.update(fields)
            if not draft.get("to"):
                raise DraftError("Add at least one To address")
            draft["rev"] = int(draft.get("rev", 1)) + 1

        return {"ok": True, "draft": self.view(self.store.mutate(draft_id, change))}

    def send(self, params: dict, *, surface: str) -> dict:
        """A person clicked Send (or Retry). Edits travel with the click, so
        what is sent is exactly what the card showed: if the bot changed the
        draft since (``rev`` moved), nothing is sent."""
        draft_id = valid_id(params.get("id"))
        edits = {k: params[k] for k in EDITABLE if k in params}
        if edits:
            # edit() checks the card's rev and bumps it; the send then expects
            # exactly that new rev, so a bot update in between is not sent.
            expect = self.edit({"id": draft_id, "rev": params.get("rev"), **edits}, surface=surface)["draft"]["rev"]
        else:
            expect = params.get("rev")
        return self._send(draft_id, actor="human", surface=surface, expect_rev=expect)

    def _send(self, draft_id: str, *, actor: str, surface: str, expect_rev: Any = None) -> dict:
        claim: dict[str, Any] = {}

        def take(draft: dict) -> None:
            state = draft.get("status")
            if state in ("sending", "sent", "discarded"):
                claim["already"] = state  # a second click: report, never send again
                return
            if state not in ("pending", "failed"):
                raise DraftError(f"Draft is {state}")
            if draft.get("delivery_unknown"):
                raise DraftError("Delivery of this draft is unknown: check the Sent folder; it will not be sent again from here")
            if expect_rev is not None and int(expect_rev) != int(draft.get("rev", 1)):
                raise DraftError("The bot changed this draft; review it again")
            draft["status"] = "sending"
            draft["sending_at"] = now()
            draft["sending_by"] = actor
            draft.pop("error", None)
            claim["take"] = True

        draft = self.store.mutate(draft_id, take)
        if not claim.get("take"):
            return {"ok": True, "already": claim.get("already"), "draft": self.view(draft)}
        settings = self.settings()
        try:
            files = att.recheck(draft.get("attachments", []), draft.get("roots") or self._roots(self._workspace()))
            receipt = self._deliver(draft, settings, files)
        except (senders.SendError, DraftError, OSError) as exc:
            error = str(exc) or type(exc).__name__
            self.store.audit("send_failed", id=draft_id, actor=actor, surface=surface, error=error[:300])

            def fail(d: dict) -> None:
                d["status"] = "failed"
                d["error"] = error
                d["failed_at"] = now()

            return {"ok": False, "error": error, "draft": self.view(self.store.mutate(draft_id, fail))}
        except Exception as exc:  # unknown: the backend may or may not have sent it
            error = f"Delivery unknown ({type(exc).__name__}). Check the Sent folder before sending again."
            logger.exception("email-drafts: send %s raised", draft_id)
            self.store.audit("send_unknown", id=draft_id, actor=actor, surface=surface, error=error)

            def unknown(d: dict) -> None:
                d["status"] = "failed"
                d["error"] = error
                d["delivery_unknown"] = True
                d["failed_at"] = now()

            return {"ok": False, "error": error, "draft": self.view(self.store.mutate(draft_id, unknown))}

        def done(d: dict) -> None:
            d["status"] = "sent"
            d["sent_at"] = now()
            d["sent_by"] = actor
            d["receipt"] = receipt
            d.pop("delivery_unknown", None)

        sent = self.store.mutate(draft_id, done)
        self.store.audit(
            "sent", id=draft_id, actor=actor, surface=surface, backend=receipt.get("backend"),
            recipients=len(senders.all_recipients(sent)), message_id=receipt.get("message_id"),
        )
        return {"ok": True, "draft": self.view(sent)}

    def discard(self, params: dict, *, surface: str) -> dict:
        draft_id = valid_id(params.get("id"))

        def change(draft: dict) -> None:
            if draft.get("status") == "discarded":
                return
            if draft.get("status") not in ("pending", "failed"):
                raise DraftError(f"Draft is {draft.get('status')}; it cannot be discarded")
            draft["status"] = "discarded"
            draft["discarded_at"] = now()

        draft = self.store.mutate(draft_id, change)
        self.store.audit("discarded", id=draft_id, surface=surface)
        return {"ok": True, "draft": self.view(draft)}

    # ── rules (a person) ────────────────────────────────────────────────
    def rules(self, params: dict) -> dict:
        return {"ok": True, "rules": self.store.rules()}

    def set_mode(self, params: dict, *, surface: str) -> dict:
        mode = str(params.get("mode") or "")

        def change(rules: dict) -> None:
            rules["mode"] = mode

        rules = self.store.update_rules(change)
        self.store.audit("rules_mode", mode=mode, surface=surface)
        return {"ok": True, "rules": rules}

    def allow(self, params: dict, *, surface: str) -> dict:
        """"Allow recipient": the draft's To addresses (or ``addresses``) join
        the allowed list and the mode becomes allow. The draft itself still
        waits for Send: the rule applies to future drafts."""
        addresses = params.get("addresses")
        if addresses is None and params.get("id"):
            addresses = self.store.load(valid_id(params.get("id"))).get("to", [])
        found = normalize_addresses(addresses, "addresses")
        if not found:
            raise DraftError("No address to allow")

        def change(rules: dict) -> None:
            rules["allowed"] = [*rules["allowed"], *[a.lower() for a in found]]
            rules["mode"] = "allow"

        rules = self.store.update_rules(change)
        self.store.audit("rules_allow", added=[a.lower() for a in found], surface=surface)
        return {"ok": True, "rules": rules}

    def unallow(self, params: dict, *, surface: str) -> dict:
        found = {a.lower() for a in normalize_addresses(params.get("addresses"), "addresses")}

        def change(rules: dict) -> None:
            rules["allowed"] = [a for a in rules["allowed"] if a not in found]

        rules = self.store.update_rules(change)
        self.store.audit("rules_remove", removed=sorted(found), surface=surface)
        return {"ok": True, "rules": rules}


# Operations the card may call, and whether they change anything.
READ_OPS = {"get", "list", "rules"}
WRITE_OPS = {"edit", "send", "discard", "set_mode", "allow", "unallow"}


def handle(engine: Engine, op: str, params: dict, *, surface: str) -> dict:
    """One card call. Refusals come back as ``{"ok": false, "error"}``."""
    if not isinstance(params, dict):
        return {"ok": False, "error": "params must be an object"}
    try:
        if op in READ_OPS:
            return getattr(engine, op)(params)
        if op in WRITE_OPS:
            return getattr(engine, op)(params, surface=surface)
        return {"ok": False, "error": f"Unknown operation {op!r}"}
    except DraftError as exc:
        return {"ok": False, "error": str(exc)}
