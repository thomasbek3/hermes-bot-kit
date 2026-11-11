"""Send a draft through Composio's Gmail tools with the ``composio`` CLI.

Composio is the default sender. The plugin runs the ``composio`` CLI that is
installed and logged in on the bot's own gateway machine (the same CLI the
catalog plugin ``composio-connections`` manages accounts with), as a child
process with an argument list (never a shell), a minimal environment and a
timeout. The documented command, checked against ``composio execute --help``
on CLI 0.5.0, is::

    composio execute <TOOL_SLUG> [--account <alias|word_id|account id>] -d -

with the tool's JSON arguments on stdin (``-d -``), so nothing from the email
appears on the command line or in ``ps``. The CLI prints
``{"successful": bool, "data": ..., "error": ..., "logId": ...}`` on stdout.

One send is at most three CLI runs, in this order:

1. ``GMAIL_GET_PROFILE`` (read only) confirms which mailbox the chosen account
   is. If it is not the bot's From address, nothing is sent.
2. ``GMAIL_SEND_EMAIL`` for a new email, or ``GMAIL_REPLY_TO_THREAD`` for a reply
   with a Gmail thread id (Gmail keeps the thread's subject there).

Attachments are local paths in the tools' ``attachment`` field; the CLI uploads
them to Composio before it runs the tool.

Outcomes:

* ``successful: true``: sent.
* a clear refusal (not logged in, no connected Gmail, expired connection, rate
  limit, Composio's own approval controls, bad input): ``SendError``, nothing
  was sent, the card offers Retry.
* anything ambiguous (the CLI timed out, was killed, crashed or printed
  something unreadable, or the network dropped mid-call): ``DeliveryUnknown``.
  The draft is marked "Delivery unknown: check the Sent folder" and is never
  retried automatically.

The CLI's login is its own. A Composio user API key, when the profile has one,
is read with ``agent.secret_scope.get_secret("COMPOSIO_USER_API_KEY")`` and
handed to the child in its environment; it is never read from a file.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
from email.utils import parseaddr
from pathlib import Path
from typing import Any, Callable, Optional

from .senders import DeliveryUnknown, SendError, signed_body

SEND_TOOL = "GMAIL_SEND_EMAIL"
REPLY_TOOL = "GMAIL_REPLY_TO_THREAD"
PROFILE_TOOL = "GMAIL_GET_PROFILE"

SEND_TIMEOUT_S = 90.0
PROFILE_TIMEOUT_S = 45.0
MAX_OUTPUT_BYTES = 2_000_000
# The Gmail tools take at most 20 MiB of attachments before encoding.
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
API_KEY_ENV = "COMPOSIO_USER_API_KEY"

ACCOUNT_RE = re.compile(r"^[A-Za-z0-9_.@:+-]{1,128}$")
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
LONG_TOKEN_RE = re.compile(r"[A-Za-z0-9_\-]{40,}")

# Variables the child keeps from the gateway's environment. Everything else
# (other providers' keys, another profile's secrets) stays behind.
PASS_ENV = (
    "HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
    "SHELL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SystemRoot", "PATHEXT", "COMSPEC",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
)
# Composio settings the child may keep (never its keys: the key comes only from
# the profile's secret scope).
PASS_COMPOSIO_ENV = ("COMPOSIO_CACHE_DIR", "COMPOSIO_SESSION_DIR", "COMPOSIO_BASE_URL", "COMPOSIO_ENVIRONMENT")

# Clean refusals: the CLI said no before anything reached Gmail, or Gmail
# refused outright. Checked in order; the first match wins.
REFUSALS: tuple[tuple[str, re.Pattern, str], ...] = (
    ("not-logged-in", re.compile(r"not logged in|composio login|please log ?in|not authenticated|missing user id|no current org", re.I),
     "Composio is not logged in on the bot's machine: run `composio login` there, then Retry."),
    ("approval", re.compile(r"requires interactive approval|denied by permissions|denied by user|permission prompts are disabled", re.I),
     "Composio's approval controls stopped this send. Allow {tool} for this Gmail account in Composio, then Retry."),
    ("no-account", re.compile(r"no connected account|no active connected account|is not connected|not connected for this user|link the toolkit|composio link|connected account.*not found", re.I),
     "No connected Gmail account in Composio matches this bot{account_hint}. Connect Gmail in Composio on the bot's machine, or fix Composio account in the plugin settings, then Retry."),
    ("expired", re.compile(r"expired|invalid_grant|re-?authori[sz]e|reconnect|revoked|unauthori[sz]ed|\b401\b|invalid credentials", re.I),
     "The Gmail connection in Composio has expired or was revoked{account_hint}. Reconnect it in Composio, then Retry."),
    ("rate-limit", re.compile(r"rate.?limit|too many requests|\b429\b|quota", re.I),
     "Gmail or Composio is rate limiting sends right now. Wait a minute, then Retry."),
    ("upload", re.compile(r"upload", re.I),
     "Composio could not upload an attachment: {detail}"),
    ("input", re.compile(r"validation failed|invalid json|invalid input|wrong_tool_input|is not valid|must be|required", re.I),
     "Composio refused the email: {detail}"),
)
# Network trouble while the tool was running: it may or may not have sent.
AMBIGUOUS = re.compile(
    r"timed? ?out|timeout|etimedout|econnreset|econnrefused|socket hang up|fetch failed|network|"
    r"\b50[234]\b|bad gateway|service unavailable|gateway timeout|connection (?:reset|closed|aborted)",
    re.I,
)

UNKNOWN_TAIL = "Check the Sent folder; it will not be sent again from here."


# ── the CLI ─────────────────────────────────────────────────────────────
def _secret(name: str) -> str:
    """The profile's Composio key, if it has one. Never ``os.environ``: under
    multiplexing that could be another profile's key."""
    try:
        from agent.secret_scope import get_secret
    except Exception:
        return ""
    try:
        return get_secret(name) or ""
    except Exception:  # no scope active: go without (the CLI's own login)
        return ""


def child_env(secret: Callable[[str], str] | None = None) -> dict:
    env = {k: os.environ[k] for k in PASS_ENV if os.environ.get(k)}
    env.update({k: os.environ[k] for k in PASS_COMPOSIO_ENV if os.environ.get(k)})
    # Anything that waits for a person (Composio's approval prompt opens a
    # browser) must fail instead of hanging a gateway nobody watches.
    env["COMPOSIO_DISABLE_PERMISSION_UI"] = "true"
    env["NO_COLOR"] = "1"
    env["FORCE_COLOR"] = "0"
    key = (secret or _secret)(API_KEY_ENV)
    if key:
        env[API_KEY_ENV] = key
    return env


def find_cli(settings: dict, env: dict) -> str:
    """The configured ``composio_cli`` path, else ``composio`` on PATH, else the
    installer's usual places (a gateway started by launchd has a short PATH)."""
    configured = str(settings.get("composio_cli") or "").strip()
    if configured:
        path = os.path.expanduser(configured)
        if not os.path.isabs(path):
            raise SendError("Composio CLI path must be absolute (Settings > Plugins > Email drafts > Composio CLI)")
        if not (os.path.isfile(path) and os.access(path, os.X_OK)):
            raise SendError(f"The Composio CLI is not at {configured} on the bot's machine")
        return path
    found = shutil.which("composio", path=env.get("PATH") or os.environ.get("PATH"))
    if found:
        return found
    home = Path(env.get("HOME") or os.path.expanduser("~"))
    for candidate in (home / ".local" / "bin" / "composio", home / ".composio" / "composio"):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise SendError(
        "The Composio CLI is not installed on the bot's machine (or not on its PATH). Install it, run "
        "`composio login`, connect Gmail, then Retry (or set Composio CLI in the plugin settings)."
    )


def account_args(settings: dict) -> list[str]:
    account = str(settings.get("composio_account") or "").strip()
    if not account:
        return []
    if account.startswith("-") or not ACCOUNT_RE.match(account):
        raise SendError(f"Composio account {account!r} is not a valid alias, word id or connected-account id")
    return ["--account", account]


def _kill(proc: subprocess.Popen) -> None:
    try:
        if hasattr(os, "killpg"):
            os.killpg(proc.pid, signal.SIGKILL)
        else:  # pragma: no cover - Windows
            proc.kill()
    except (ProcessLookupError, PermissionError, OSError):
        pass


class Ran:
    """One finished CLI run."""

    def __init__(self, code: Optional[int], out: str, err: str, timed_out: bool = False, truncated: bool = False):
        self.code, self.out, self.err, self.timed_out, self.truncated = code, out, err, timed_out, truncated


def run_cli(argv: list[str], payload: dict, env: dict, timeout: float) -> Ran:
    """Run ``argv`` (a list; no shell) with ``payload`` as JSON on stdin.

    The child gets its own process group so a timeout kills it and anything it
    started. A child that cannot start raises ``SendError`` (nothing ran)."""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, shell=False, start_new_session=True, close_fds=True,
        )
    except (FileNotFoundError, PermissionError, OSError) as exc:
        raise SendError(f"The Composio CLI could not start: {type(exc).__name__}") from None
    try:
        out, err = proc.communicate(input=data, timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill(proc)
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:
            out, err = b"", b""
        return Ran(None, _text(out), _text(err), timed_out=True)
    finally:
        if proc.poll() is None:
            _kill(proc)
    truncated = len(out) > MAX_OUTPUT_BYTES or len(err) > MAX_OUTPUT_BYTES
    return Ran(proc.returncode, _text(out[:MAX_OUTPUT_BYTES]), _text(err[:MAX_OUTPUT_BYTES]), truncated=truncated)


def _text(raw: bytes) -> str:
    return ANSI_RE.sub("", (raw or b"").decode("utf-8", "replace"))


def parse_result(out: str) -> Optional[dict]:
    """The JSON object the CLI printed (the whole stdout, else the last object
    that starts at the beginning of a line)."""
    text = (out or "").strip()
    if not text:
        return None
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except ValueError:
        pass
    lines = text.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        if lines[index].startswith("{"):
            try:
                value = json.loads("\n".join(lines[index:]))
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return None


def detail(*parts: Any) -> str:
    """A short, safe line from the CLI's error text for the card."""
    text = " ".join(_flatten(p) for p in parts if p)
    text = LONG_TOKEN_RE.sub("…", " ".join(text.split()))
    return (text[:240] + "…") if len(text) > 240 else text


def _flatten(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("message", "error", "detail", "description"):
            if value.get(key):
                return _flatten(value[key])
        return json.dumps(value, ensure_ascii=False)[:400]
    return str(value)


def classify(text: str, *, tool: str, account: str) -> Optional[str]:
    """The card's message for a clear refusal, or None."""
    hint = f" ({account})" if account else ""
    for _name, pattern, message in REFUSALS:
        if pattern.search(text or ""):
            return message.format(tool=tool, account_hint=hint, detail=detail(text) or "no details")
    return None


# ── one tool call ───────────────────────────────────────────────────────
def execute(tool: str, payload: dict, settings: dict, *, timeout: float, may_have_sent: bool,
            secret: Callable[[str], str] | None = None) -> dict:
    """Run one Composio tool and return its ``data``.

    ``may_have_sent`` says whether an unclear outcome could mean the email went
    out (the send) or not (the read-only profile check, where an unclear outcome
    is a plain failure)."""
    env = child_env(secret)
    argv = [find_cli(settings, env), "execute", tool, *account_args(settings), "-d", "-"]
    account = str(settings.get("composio_account") or "").strip()
    ran = run_cli(argv, payload, env, timeout)

    def unclear(why: str) -> Exception:
        if may_have_sent:
            return DeliveryUnknown(f"Delivery unknown: {why}. {UNKNOWN_TAIL}")
        return SendError(f"Composio did not answer clearly ({why}); nothing was sent. Retry in a moment.")

    if ran.timed_out:
        raise unclear(f"Composio did not answer within {int(timeout)} s")
    result = parse_result(ran.out)
    if result is not None and result.get("successful") is True and ran.code == 0:
        data = result.get("data")
        return data if isinstance(data, dict) else {"value": data}
    error_text = detail(result.get("error") if result else "", ran.err if not result else "", ran.out if not result else "")
    if result is not None and result.get("successful") is False:
        refusal = classify(error_text, tool=tool, account=account)
        if refusal and not (may_have_sent and AMBIGUOUS.search(error_text) and not _clean_first(error_text)):
            raise SendError(refusal)
        if may_have_sent and AMBIGUOUS.search(error_text):
            raise DeliveryUnknown(f"Delivery unknown: the connection failed while Composio was sending ({error_text}). {UNKNOWN_TAIL}")
        raise SendError(f"Composio could not send it: {error_text or 'no details'}")
    # No usable answer: a crash, a signal, unreadable output or a non-zero exit
    # without a result. Only a clear "nothing happened" reason is a refusal.
    refusal = classify(error_text, tool=tool, account=account)
    if refusal and _clean_first(error_text):
        raise SendError(refusal)
    code = "killed" if ran.code is not None and ran.code < 0 else f"exit {ran.code}"
    raise unclear(f"the Composio CLI gave no readable result ({code})")


def _clean_first(text: str) -> bool:
    """Refusals that happen before any tool runs (so even an odd exit is safe).
    Input errors are left out: their words ("required", "must be") also turn up
    in crash output, which must stay "unknown"."""
    for name, pattern, _message in REFUSALS:
        if name in ("not-logged-in", "approval", "no-account", "upload") and pattern.search(text or ""):
            return True
    return False


# ── the From check and the send ─────────────────────────────────────────
def _find(value: Any, keys: tuple[str, ...], depth: int = 0) -> Optional[str]:
    if depth > 6:
        return None
    if isinstance(value, dict):
        for key in keys:
            found = value.get(key)
            if isinstance(found, str) and "@" in found:
                return found
        for child in value.values():
            hit = _find(child, keys, depth + 1)
            if hit:
                return hit
    elif isinstance(value, list):
        for child in value[:50]:
            hit = _find(child, keys, depth + 1)
            if hit:
                return hit
    return None


def _from_header(value: Any, depth: int = 0) -> Optional[str]:
    """A ``From`` header in Gmail's ``payload.headers`` shape, if any."""
    if depth > 6:
        return None
    if isinstance(value, dict):
        name = str(value.get("name") or "").lower()
        if name == "from" and isinstance(value.get("value"), str):
            return value["value"]
        for child in value.values():
            hit = _from_header(child, depth + 1)
            if hit:
                return hit
    elif isinstance(value, list):
        for child in value[:50]:
            hit = _from_header(child, depth + 1)
            if hit:
                return hit
    return None


def _address(text: str) -> str:
    return parseaddr(text or "")[1].strip().lower()


def account_address(settings: dict, secret: Callable[[str], str] | None = None) -> str:
    """The chosen account's mailbox (``GMAIL_GET_PROFILE``; read only)."""
    data = execute(PROFILE_TOOL, {"user_id": "me"}, settings, timeout=PROFILE_TIMEOUT_S, may_have_sent=False, secret=secret)
    found = _address(_find(data, ("emailAddress", "email_address", "email")) or "")
    if not found:
        raise SendError("Composio did not say which Gmail account this is; nothing was sent. Check the account in Composio, then Retry.")
    return found


def tool_arguments(draft: dict, settings: dict, attachments: list[dict]) -> tuple[str, dict]:
    to = list(draft.get("to") or [])
    body = signed_body(draft.get("body") or "", str(settings.get("signature") or ""))
    files = [item["path"] for item in attachments or []]
    thread_id = str((draft.get("in_reply_to") or {}).get("thread_id") or "").strip()
    common: dict[str, Any] = {
        "user_id": "me",
        "recipient_email": to[0],
        "extra_recipients": to[1:],
        "cc": list(draft.get("cc") or []),
        "bcc": list(draft.get("bcc") or []),
        "is_html": False,
        # The bot's own signature is already under the body (as on the card).
        "include_signature": False,
    }
    if files:
        common["attachment"] = files
    if thread_id:
        return REPLY_TOOL, {**common, "thread_id": thread_id, "message_body": body}
    return SEND_TOOL, {
        **common,
        "from_email": str(settings.get("from_address") or "").strip(),
        "subject": draft.get("subject") or "",
        "body": body,
    }


def send_composio(draft: dict, settings: dict, attachments: list[dict], *,
                  secret: Callable[[str], str] | None = None) -> dict:
    from_address = _address(str(settings.get("from_address") or ""))
    if sum(int(item.get("size") or 0) for item in attachments or []) > MAX_ATTACHMENT_BYTES:
        raise SendError("Attachments are larger than 20 MB in total, which is Composio's Gmail limit")
    account = account_address(settings, secret)
    if not from_address:
        raise SendError(f"No From address is set for this bot. Set it to {account} (Settings > Plugins > Email drafts > From address).")
    if account != from_address:
        which = str(settings.get("composio_account") or "").strip() or "the default Gmail account"
        raise SendError(
            f"From is {from_address}, but Composio's {which} is {account}. Nothing was sent. "
            "Set Composio account (or From address) in the plugin settings so they match."
        )
    tool, payload = tool_arguments(draft, settings, attachments)
    data = execute(tool, payload, settings, timeout=SEND_TIMEOUT_S, may_have_sent=True, secret=secret)
    reported = _address(_from_header(data) or _find(data, ("from", "from_email", "sender")) or "")
    receipt = {
        "backend": "composio",
        "tool": tool,
        "account": str(settings.get("composio_account") or ""),
        "message_id": None,
        "gmail_id": _id(data, "id"),
        "thread_id": _id(data, "threadId") or _id(data, "thread_id"),
    }
    if reported and reported != from_address:
        raise DeliveryUnknown(
            f"Composio sent this from {reported}, not {from_address}. Check the Sent folder of {reported}; "
            "it will not be sent again from here."
        )
    return receipt


def _id(data: Any, key: str) -> Optional[str]:
    if isinstance(data, dict):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
        for nested in ("response_data", "data"):
            inner = data.get(nested)
            if isinstance(inner, dict) and isinstance(inner.get(key), str):
                return inner[key]
    return None


__all__ = ["send_composio", "execute", "account_address", "tool_arguments", "find_cli", "child_env", "run_cli"]
