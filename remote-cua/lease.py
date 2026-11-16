"""Control lease for a remote-cua machine: who drives it, the bot or a human.

File: ``<HERMES_HOME>/remote-cua/lease.json`` (HERMES_HOME = the profile's home), shaped
``{"holder": "agent"|"human", "viewer": "<id>"|null, "since": <epoch s>, "epoch": <int>}``.
A missing file means the agent holds it. Every write is tmp + rename under an flock, and every
transition bumps ``epoch`` so a result produced across a take-over can be recognised and voided.

While a human holds it, the plugin's ``pre_tool_call`` hook refuses ``computer_use`` with
``human_has_control``, the reason Hermes's own Bot Screen lease uses.
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional

logger = logging.getLogger(__name__)

AGENT = "agent"
HUMAN = "human"
REASON = "human_has_control"
LEASE_DIR = "remote-cua"
LEASE_FILE = "lease.json"
_VIEWER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

REFUSAL = (f"{REASON}: A human has taken over this computer (they may be entering a credential). "
           "computer_use actions and captures are refused until they hand control back. "
           "Tell the user what you need in your reply.")
DISCARDED = (f"{REASON}: A human took over this computer while the action ran; its result was discarded. "
             "Tell the user what you need and re-capture once they hand back.")


class LeaseConflict(Exception):
    """Another viewer holds the lease (take), the caller does not hold it (release without force), or a
    forced release names an epoch the lease has moved past (``stale_force``)."""

    def __init__(self, code: str, lease: "Lease"):
        super().__init__(code)
        self.code = code
        self.lease = lease


@dataclass(frozen=True)
class Lease:
    holder: str = AGENT
    viewer: Optional[str] = None
    since: float = 0.0
    epoch: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {"holder": self.holder, "viewer": self.viewer, "since": self.since, "epoch": self.epoch}


def valid_viewer(viewer: Any) -> bool:
    return isinstance(viewer, str) and bool(_VIEWER_RE.match(viewer))


def hermes_home() -> Path:
    """The active profile's home (Hermes's own resolver, so a request's ``?profile=`` scope applies)."""
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:  # outside Hermes (tests, the standalone check script)
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def lease_path(home: Optional[Path] = None) -> Path:
    return Path(home or hermes_home()) / LEASE_DIR / LEASE_FILE


def _parse(data: Any) -> Lease:
    if not isinstance(data, dict):
        return Lease()
    holder = HUMAN if data.get("holder") == HUMAN else AGENT
    viewer = data.get("viewer") if isinstance(data.get("viewer"), str) else None
    try:
        since = float(data.get("since") or 0.0)
    except (TypeError, ValueError):
        since = 0.0
    try:
        epoch = int(data.get("epoch") or 0)
    except (TypeError, ValueError):
        epoch = 0
    return Lease(holder=holder, viewer=viewer if holder == HUMAN else None, since=since, epoch=epoch)


def read(home: Optional[Path] = None) -> Lease:
    """The lease now. Missing file = agent. An unreadable file is logged and also reads as agent."""
    path = lease_path(home)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return Lease()
    except OSError as exc:
        logger.warning("remote-cua: could not read %s: %s", path, exc)
        return Lease()
    try:
        return _parse(json.loads(raw))
    except ValueError:
        logger.warning("remote-cua: %s is not valid JSON; treating it as agent control", path)
        return Lease()


def _write(path: Path, lease: Lease) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".lease-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(lease.to_dict(), fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def _locked(path: Path) -> Iterator[None]:
    """Serialize read-modify-write across processes (gateway, plugin host, CLI)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import fcntl
    except ImportError:  # Windows gateway: single-process writes are still atomic (tmp + rename)
        yield
        return
    with open(path.with_suffix(".lock"), "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def take(viewer: str, home: Optional[Path] = None, *, now: Optional[float] = None) -> Lease:
    """Give control to the human at ``viewer``. Idempotent for the same viewer; LeaseConflict
    ``held_by_other_viewer`` when another viewer already holds it."""
    if not valid_viewer(viewer):
        raise ValueError("viewer must be 1-128 letters, digits, . _ : -")
    path = lease_path(home)
    with _locked(path):
        current = read(home)
        if current.holder == HUMAN:
            if current.viewer == viewer:
                return current
            raise LeaseConflict("held_by_other_viewer", current)
        lease = Lease(holder=HUMAN, viewer=viewer, since=time.time() if now is None else now, epoch=current.epoch + 1)
        _write(path, lease)
        return lease


def release(viewer: Optional[str], home: Optional[Path] = None, *, force: bool = False,
            expect_epoch: Optional[int] = None, now: Optional[float] = None) -> Lease:
    """Hand control back to the bot. Idempotent when the agent already holds it. Without ``force`` only the
    holding viewer may release (LeaseConflict ``not_holder``); ``force`` clears a stuck lease.

    ``expect_epoch`` (with ``force``): the epoch of the human lease the caller saw. The forced release
    clears only that lease; once the lease has moved on (a hand back, a new take), it is refused with
    LeaseConflict ``stale_force``, so a forced request that commits late can never revoke a later grant."""
    if viewer is not None and not valid_viewer(viewer):
        raise ValueError("viewer must be 1-128 letters, digits, . _ : -")
    if expect_epoch is not None and (isinstance(expect_epoch, bool) or not isinstance(expect_epoch, int)):
        raise ValueError("expect_epoch must be an integer")
    path = lease_path(home)
    with _locked(path):
        current = read(home)
        if current.holder == AGENT:
            return current
        if not force and current.viewer != viewer:
            raise LeaseConflict("not_holder", current)
        if force and expect_epoch is not None and current.epoch != expect_epoch:
            raise LeaseConflict("stale_force", current)
        lease = Lease(holder=AGENT, viewer=None, since=time.time() if now is None else now, epoch=current.epoch + 1)
        _write(path, lease)
        return lease


# ---------------------------------------------------------------------------
# pre_tool_call hook
# ---------------------------------------------------------------------------

def _remote_cua_selected() -> bool:
    try:
        from . import settings
        return settings.backend_selected(settings.load_profile_config())
    except Exception:
        # Config unreadable: fall back to the lease alone. A human lease only exists for a profile that
        # used remote-cua, so blocking on it is the safe side.
        return True


def is_fenced_tool(tool_name: Any) -> bool:
    """Tools the lease fences. Only ``computer_use`` acts on the remote machine: the bot's browser
    tools run where Hermes runs them (gateway or terminal sandbox), never on a remote-cua machine."""
    return isinstance(tool_name, str) and (tool_name == "computer_use" or tool_name.startswith("computer_use."))


def pre_tool_call(tool_name: Any = None, args: Any = None, **_: Any) -> Optional[dict[str, str]]:
    """``{"action": "block", ...}`` while a human holds this profile's remote-cua lease."""
    if not is_fenced_tool(tool_name):
        return None
    if read().holder != HUMAN:
        return None
    if not _remote_cua_selected():
        return None
    return {"action": "block", "message": REFUSAL}
