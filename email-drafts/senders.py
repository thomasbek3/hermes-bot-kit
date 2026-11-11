"""Hand a draft to its sender: Composio (the default), Gmail or SMTP.

Composio runs the ``composio`` CLI logged in on the bot's machine and its Gmail
tools (``composio_sender``); it takes the draft's fields, not a MIME message.

Gmail goes through Hermes: ``credentialed_provider_request("google", ...)``
attaches the token from the user's own OAuth client declared under ``oauth:``
in plugin.yaml (``hermes auth add email-drafts:google``). The plugin never sees,
stores or refreshes the token.

SMTP reads its password with ``agent.secret_scope.get_secret`` (the profile's
secret scope), and only over TLS (STARTTLS or implicit SSL).

Gmail and SMTP are looked up through ``SENDERS`` so tests swap in fakes.
"""

from __future__ import annotations

import base64
import mimetypes
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import Any, Callable

from .store import DraftError

GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
SEND_TIMEOUT_S = 60.0


DEFAULT_SENDER = "composio"
SENDER_NAMES = ("composio", "gmail", "smtp")


class SendError(Exception):
    """The backend refused or failed; nothing was sent. The text is safe to show."""


class DeliveryUnknown(Exception):
    """The backend may or may not have sent it (a timeout mid-send). The draft
    is marked delivery-unknown and never retried. The text is safe to show."""


def signed_body(body: str, signature: str) -> str:
    """The body with the signature under it (once: a body that already ends
    with the signature is left alone)."""
    text = (body or "").rstrip()
    sig = (signature or "").replace("\\n", "\n").strip()
    if not sig or text.endswith(sig):
        return text + "\n"
    return f"{text}\n\n{sig}\n"


def build_message(draft: dict, settings: dict, attachments: list[dict]) -> EmailMessage:
    from_address = str(settings.get("from_address") or "").strip()
    if not from_address:
        raise SendError("No From address is set for this bot (Settings > Plugins > Email drafts > From address)")
    msg = EmailMessage()
    name = str(settings.get("from_name") or "").strip()
    msg["From"] = formataddr((name, from_address)) if name else from_address
    if draft.get("to"):
        msg["To"] = ", ".join(draft["to"])
    if draft.get("cc"):
        msg["Cc"] = ", ".join(draft["cc"])
    if draft.get("bcc"):
        msg["Bcc"] = ", ".join(draft["bcc"])
    msg["Subject"] = draft.get("subject") or ""
    msg["Date"] = formatdate(localtime=True)
    domain = from_address.rsplit("@", 1)[-1]
    msg["Message-ID"] = make_msgid(domain=domain)
    reply = draft.get("in_reply_to") or {}
    if reply.get("message_id"):
        msg["In-Reply-To"] = reply["message_id"]
        refs = [r for r in (reply.get("references") or []) if r]
        if reply["message_id"] not in refs:
            refs.append(reply["message_id"])
        msg["References"] = " ".join(refs)
    msg.set_content(signed_body(draft.get("body") or "", str(settings.get("signature") or "")))
    for item in attachments:
        ctype, encoding = mimetypes.guess_type(item["name"])
        if ctype is None or encoding is not None:
            ctype = "application/octet-stream"
        maintype, subtype = ctype.split("/", 1)
        with open(item["path"], "rb") as handle:
            msg.add_attachment(handle.read(), maintype=maintype, subtype=subtype, filename=item["name"])
    return msg


def all_recipients(draft: dict) -> list[str]:
    return [*draft.get("to", []), *draft.get("cc", []), *draft.get("bcc", [])]


def _provider_request() -> Callable[..., Any]:
    from hermes_cli.plugin_provider_requests import credentialed_provider_request

    return credentialed_provider_request


def send_gmail(msg: EmailMessage, draft: dict, settings: dict, *, request: Callable[..., Any] | None = None) -> dict:
    """POST users/me/messages/send with the raw message (Bcc is honoured and
    stripped by Gmail). Threads into ``in_reply_to.thread_id`` when known."""
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
    payload: dict[str, Any] = {"raw": raw}
    thread_id = str((draft.get("in_reply_to") or {}).get("thread_id") or "").strip()
    if thread_id:
        payload["threadId"] = thread_id
    call = request or _provider_request()
    try:
        resp = call("google", "POST", GMAIL_SEND_URL, json=payload, timeout=SEND_TIMEOUT_S)
    except PermissionError as exc:
        raise SendError(f"Gmail is not available to this plugin: {exc}") from None
    except Exception as exc:  # ProviderNotSignedIn, AuthError, network errors
        name = type(exc).__name__
        if name == "ProviderNotSignedIn":
            raise SendError(f"Gmail is not signed in: {exc}") from None
        code = getattr(exc, "code", "")
        raise SendError(f"Gmail send failed ({code or name}): {exc}") from None
    status = int(getattr(resp, "status", 0) or 0)
    if status >= 300 or status < 200:
        text = ""
        try:
            text = str(resp.text)[:300]
        except Exception:
            pass
        raise SendError(f"Gmail refused the message ({status}): {text}")
    try:
        body = resp.json() or {}
    except Exception:
        body = {}
    return {"backend": "gmail", "message_id": msg["Message-ID"], "gmail_id": body.get("id"), "thread_id": body.get("threadId")}


def _secret(name: str) -> str:
    from agent.secret_scope import get_secret

    return get_secret(name) or ""


SMTP_CLASSES: dict[str, Any] = {"starttls": smtplib.SMTP, "ssl": smtplib.SMTP_SSL}


def send_smtp(msg: EmailMessage, draft: dict, settings: dict, *, secret: Callable[[str], str] | None = None) -> dict:
    host = str(settings.get("smtp_host") or "").strip()
    if not host:
        raise SendError("No SMTP host is set for this bot (Settings > Plugins > Email drafts)")
    security = str(settings.get("smtp_security") or "starttls")
    if security not in SMTP_CLASSES:
        raise SendError(f"SMTP security must be starttls or ssl, not {security!r}")
    port = int(settings.get("smtp_port") or (465 if security == "ssl" else 587))
    username = str(settings.get("smtp_username") or "").strip()
    password = (secret or _secret)("EMAIL_DRAFTS_SMTP_PASSWORD") if username else ""
    if username and not password:
        raise SendError("The SMTP password is not set (Settings > Plugins > Email drafts > SMTP password)")
    context = ssl.create_default_context()
    recipients = all_recipients(draft)
    try:
        if security == "ssl":
            client = SMTP_CLASSES["ssl"](host, port, timeout=SEND_TIMEOUT_S, context=context)
        else:
            client = SMTP_CLASSES["starttls"](host, port, timeout=SEND_TIMEOUT_S)
        with client:
            if security == "starttls":
                client.starttls(context=context)
            if username:
                client.login(username, password)
            refused = client.send_message(msg, from_addr=str(settings.get("from_address")), to_addrs=recipients)
    except smtplib.SMTPAuthenticationError:
        raise SendError("SMTP sign-in failed: check the username and password") from None
    except (smtplib.SMTPException, OSError) as exc:
        raise SendError(f"SMTP send failed: {type(exc).__name__}: {exc}") from None
    if refused and len(refused) >= len(recipients):
        raise SendError("The SMTP server refused every recipient")
    return {"backend": "smtp", "message_id": msg["Message-ID"], "refused": sorted(refused or {})}


SENDERS: dict[str, Callable[..., dict]] = {"gmail": send_gmail, "smtp": send_smtp}


def deliver(draft: dict, settings: dict, attachments: list[dict]) -> dict:
    backend = str(settings.get("sender") or DEFAULT_SENDER)
    if backend not in SENDER_NAMES:
        raise SendError(f"Unknown sender {backend!r} (composio, gmail or smtp)")
    if not draft.get("to"):
        raise DraftError("Add at least one To address")
    if backend == "composio":
        from .composio_sender import send_composio

        return send_composio(draft, settings, attachments)
    sender = SENDERS[backend]
    msg = build_message(draft, settings, attachments)
    return sender(msg, draft, settings)
