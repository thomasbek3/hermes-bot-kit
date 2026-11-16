"""remote-cua lease and status routes, mounted by Hermes at ``/api/plugins/remote-cua/``.

    GET  /lease                      who holds this profile's remote machine
    POST /take     {"viewer": id}    the human at ``viewer`` takes over
    POST /release  {"viewer": id, "force": false} | {"viewer": id, "force": true, "epoch": n}   hand back
    GET  /status[?fresh=1]           reachable, driver, permissions, screen awake

Profile scope: ``?profile=<name>`` (Hermes binds that profile's home before the handler runs), else
the launch profile. Auth: Hermes's own gate for every ``/api/`` route (dashboard session token, or the
desktop's native ticket), plus the plugin's ``plugins.enabled`` consent. Request and response shapes
are documented in computer-viewer/docs/REMOTE-CUA.md.
"""
from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

router = APIRouter()

_PACKAGE = "hermes_remote_cua_kit"


def _pkg():
    """The plugin directory as a package (this file is imported on its own, by path)."""
    if _PACKAGE not in sys.modules:
        here = Path(__file__).resolve().parent.parent
        spec = importlib.util.spec_from_file_location(_PACKAGE, here / "__init__.py",
                                                      submodule_search_locations=[str(here)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[_PACKAGE] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(_PACKAGE, None)
            raise
    return sys.modules[_PACKAGE]


def _mod(name: str):
    _pkg()
    return importlib.import_module(f"{_PACKAGE}.{name}")


def _machine() -> tuple[Any, str]:
    """``(public machine dict | None, config error)`` of the scoped profile."""
    settings = _mod("settings")
    try:
        cfg = settings.from_profile()
    except settings.ConfigError as exc:
        return None, str(exc)
    except Exception as exc:
        return None, f"could not read this profile's config.yaml ({type(exc).__name__})"
    return cfg.public(), ""


def _answer(status_code: int, **body: Any) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=body)


def _payload_viewer(payload: Any) -> Any:
    return payload.get("viewer") if isinstance(payload, dict) else None


@router.get("/lease")
def get_lease() -> JSONResponse:
    lease = _mod("lease")
    machine, error = _machine()
    return _answer(200, ok=True, lease=lease.read().to_dict(), configured=machine is not None,
                   machine=machine, **({"error": error} if error else {}))


@router.post("/take")
def take(payload: Any = Body(default=None)) -> JSONResponse:
    lease = _mod("lease")
    viewer = _payload_viewer(payload)
    if not lease.valid_viewer(viewer):
        return _answer(400, ok=False, error="bad_viewer", message="viewer must be 1-128 letters, digits, . _ : -")
    machine, error = _machine()
    if machine is None:
        return _answer(409, ok=False, error="not_configured", message=error, lease=lease.read().to_dict())
    try:
        current = lease.take(viewer)
    except lease.LeaseConflict as exc:
        return _answer(409, ok=False, error=exc.code, message="Another viewer has control of this computer",
                       lease=exc.lease.to_dict())
    return _answer(200, ok=True, lease=current.to_dict())


@router.post("/release")
def release(payload: Any = Body(default=None)) -> JSONResponse:
    lease = _mod("lease")
    viewer = _payload_viewer(payload)
    force = isinstance(payload, dict) and payload.get("force") is True
    if viewer is not None and not lease.valid_viewer(viewer):
        return _answer(400, ok=False, error="bad_viewer", message="viewer must be 1-128 letters, digits, . _ : -")
    if viewer is None and not force:
        return _answer(400, ok=False, error="bad_viewer", message="send the viewer that took control, or force: true")
    # A forced release must name the epoch of the lease it saw: it clears only that lease (stale_force once
    # it has moved on), so a late commit can never revoke a later grant. No epoch, no force.
    epoch = payload.get("epoch") if isinstance(payload, dict) else None
    if epoch is not None and (isinstance(epoch, bool) or not isinstance(epoch, int)):
        return _answer(400, ok=False, error="bad_epoch", message="epoch must be an integer")
    if force and epoch is None:
        return _answer(400, ok=False, error="force_needs_epoch",
                       message="force needs the epoch of the lease to clear: GET /lease and send its epoch")
    try:
        current = lease.release(viewer, force=force, expect_epoch=epoch if force else None)
    except lease.LeaseConflict as exc:
        message = ("Control changed since this hand back was sent; nothing was released"
                   if exc.code == "stale_force" else "This viewer does not hold control; use force to hand back anyway")
        return _answer(409, ok=False, error=exc.code, message=message, lease=exc.lease.to_dict())
    return _answer(200, ok=True, lease=current.to_dict())


@router.get("/status")
def get_status(fresh: bool = False) -> JSONResponse:
    try:
        result = _mod("status").status_for_profile(fresh=fresh)
    except Exception as exc:  # never a traceback to the client
        return _answer(200, ok=False, configured=None, error=f"status check failed: {type(exc).__name__}: {exc}"[:300])
    return _answer(200, **result)
