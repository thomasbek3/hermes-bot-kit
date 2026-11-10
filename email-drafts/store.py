"""Draft, rule and audit storage for email-drafts.

Everything lives in the profile's plugin data dir (``<HERMES_HOME>/plugin-data/
email-drafts/``), resolved on each call so a gateway serving several profiles
never mixes them:

    drafts/<id>.json   one draft per file (atomic replace)
    drafts/<id>.lock   its lock (the send claim is taken under it)
    rules.json         {"mode": "approval" | "allow" | "disabled", "allowed": [...]}
    audit.jsonl        one line per send attempt, discard and rule change

States: pending -> sending -> sent | failed; pending | failed -> discarded;
failed -> sending (Retry). ``sending`` is the durable claim that makes a second
click, a second window or a lost reply unable to send twice: only the request
that moved the draft out of pending (or failed) sends.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

DRAFT_ID_RE = re.compile(r"^ed_[0-9a-f]{16}$")
STATES = ("pending", "sending", "sent", "discarded", "failed")
MODES = ("approval", "allow", "disabled")
EMAIL_RE = re.compile(r"^[^@\s<>,;\"]+@[^@\s<>,;\"]+\.[^@\s<>,;\"]+$")
MAX_RECIPIENTS = 50
MAX_SUBJECT = 998
MAX_BODY = 200_000
LOCK_TIMEOUT_S = 10.0


class DraftError(Exception):
    """A refusal the caller shows as is (bad input, wrong state, not found)."""


def now() -> float:
    return time.time()


def new_draft_id() -> str:
    return "ed_" + secrets.token_hex(8)


def valid_id(draft_id: Any) -> str:
    value = str(draft_id or "").strip()
    if not DRAFT_ID_RE.match(value):
        raise DraftError(f"Unknown draft id {value!r}")
    return value


def normalize_addresses(value: Any, field: str) -> list[str]:
    """A list (or comma/semicolon separated string) of plain addresses.

    ``Name <addr>`` keeps only the address. Duplicates are dropped (case-blind).
    Anything that is not a single address with no header-breaking characters
    is refused, so a recipient can never smuggle a header line in."""
    if value is None or value == "":
        return []
    items = value if isinstance(value, list) else re.split(r"[,;]", str(value))
    out: list[str] = []
    seen: set[str] = set()
    for raw in items:
        text = str(raw or "").strip()
        if not text:
            continue
        match = re.match(r"^.*<([^<>]+)>\s*$", text)
        addr = (match.group(1) if match else text).strip()
        if "\r" in addr or "\n" in addr or not EMAIL_RE.match(addr):
            raise DraftError(f"{field}: {text!r} is not an email address")
        key = addr.lower()
        if key not in seen:
            seen.add(key)
            out.append(addr)
    if len(out) > MAX_RECIPIENTS:
        raise DraftError(f"{field}: at most {MAX_RECIPIENTS} addresses")
    return out


def clean_subject(value: Any) -> str:
    text = re.sub(r"[\r\n]+", " ", str(value or "")).strip()
    if len(text) > MAX_SUBJECT:
        raise DraftError("subject is too long")
    return text


def clean_body(value: Any) -> str:
    text = str(value or "").replace("\r\n", "\n")
    if len(text) > MAX_BODY:
        raise DraftError("body is too long")
    return text


def _atomic_write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def file_lock(path: Path, timeout: float = LOCK_TIMEOUT_S) -> Iterator[None]:
    """An exclusive inter-process lock on ``path`` (flock on POSIX, msvcrt on Windows)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    deadline = time.monotonic() + timeout
    try:
        if os.name == "nt":  # pragma: no cover - exercised on Windows only
            import msvcrt

            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise DraftError("The draft is busy; try again")
                    time.sleep(0.05)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise DraftError("The draft is busy; try again")
                    time.sleep(0.05)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


class Store:
    """Drafts, rules and the audit log under one root (the plugin data dir)."""

    def __init__(self, root: Callable[[], Path] | Path):
        self._root = root

    @property
    def root(self) -> Path:
        root = self._root() if callable(self._root) else self._root
        return Path(root)

    # ── drafts ──────────────────────────────────────────────────────────
    def _draft_path(self, draft_id: str) -> Path:
        return self.root / "drafts" / f"{valid_id(draft_id)}.json"

    def _lock_path(self, draft_id: str) -> Path:
        return self.root / "drafts" / f"{valid_id(draft_id)}.lock"

    def load(self, draft_id: str) -> dict:
        path = self._draft_path(draft_id)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise DraftError(f"Unknown draft id {draft_id!r}") from None
        except (OSError, ValueError) as exc:
            raise DraftError(f"Draft {draft_id} could not be read: {exc}") from None
        if not isinstance(data, dict) or data.get("id") != draft_id:
            raise DraftError(f"Draft {draft_id} is damaged")
        return data

    def save(self, draft: dict) -> dict:
        draft["updated_at"] = now()
        _atomic_write(self._draft_path(draft["id"]), draft)
        return draft

    def create(self, draft: dict) -> dict:
        draft_id = new_draft_id()
        while self._draft_path(draft_id).exists():  # pragma: no cover - 64-bit collision
            draft_id = new_draft_id()
        draft = {**draft, "id": draft_id, "rev": 1, "status": "pending", "created_at": now()}
        with self.locked(draft_id):
            return self.save(draft)

    @contextlib.contextmanager
    def locked(self, draft_id: str) -> Iterator[None]:
        with file_lock(self._lock_path(draft_id)):
            yield

    def mutate(self, draft_id: str, change: Callable[[dict], Optional[dict]]) -> dict:
        """Load, change and save one draft under its lock. ``change`` edits the
        dict in place (or returns a replacement); a DraftError aborts."""
        with self.locked(draft_id):
            draft = self.load(draft_id)
            result = change(draft)
            if result is not None:
                draft = result
            return self.save(draft)

    def list(self, limit: int = 50) -> list[dict]:
        folder = self.root / "drafts"
        if not folder.is_dir():
            return []
        rows = []
        for path in folder.glob("ed_*.json"):
            with contextlib.suppress(OSError, ValueError):
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and DRAFT_ID_RE.match(str(data.get("id") or "")):
                    rows.append(data)
        rows.sort(key=lambda d: float(d.get("created_at") or 0), reverse=True)
        return rows[:limit]

    # ── rules ───────────────────────────────────────────────────────────
    def _rules_path(self) -> Path:
        return self.root / "rules.json"

    def rules(self) -> dict:
        try:
            data = json.loads(self._rules_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        mode = data.get("mode") if isinstance(data, dict) else None
        allowed = data.get("allowed") if isinstance(data, dict) else None
        return {
            "mode": mode if mode in MODES else "approval",
            "allowed": sorted({str(a).lower() for a in allowed if isinstance(a, str) and EMAIL_RE.match(a)})
            if isinstance(allowed, list) else [],
        }

    def update_rules(self, change: Callable[[dict], None]) -> dict:
        with file_lock(self.root / "rules.lock"):
            rules = self.rules()
            change(rules)
            rules["allowed"] = sorted({a.lower() for a in rules["allowed"]})
            if rules["mode"] not in MODES:
                raise DraftError(f"Unknown mode {rules['mode']!r}")
            _atomic_write(self._rules_path(), rules)
            return rules

    # ── audit ───────────────────────────────────────────────────────────
    def audit(self, event: str, **fields: Any) -> None:
        """Append one JSON line. Never holds message bodies or credentials."""
        line = json.dumps({"at": now(), "event": event, **fields}, ensure_ascii=False, sort_keys=True)
        path = self.root / "audit.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with file_lock(self.root / "audit.lock"):
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")

    def audit_lines(self) -> list[dict]:
        path = self.root / "audit.jsonl"
        if not path.is_file():
            return []
        out = []
        for line in path.read_text(encoding="utf-8").splitlines():
            with contextlib.suppress(ValueError):
                out.append(json.loads(line))
        return out
