"""Health of a profile's remote-cua machine: reachable, driver, permissions, screen awake.

Used by ``GET /api/plugins/remote-cua/status``, ``hermes remote-cua check`` and the provider's doctor.
Driver discovery, then a short-lived private daemon run through the same managed lifecycle as the
backend (:class:`remote.RemoteDaemon`: recorded before launch, stopped in ``finally``, forgotten only
when the stop is confirmed). It answers ``check_permissions`` (``prompt: false``: never a dialog on the
Mac) and ``list_windows``. Read-only on the remote apart from that daemon and its socket.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from . import remote
from .settings import OS_WINDOWS, WINDOWS_REFUSAL, ConfigError, RemoteCuaConfig

CACHE_SECONDS = 20.0
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()


def _find(value: Any, key: str, depth: int = 0) -> Any:
    if depth > 6:
        return None
    if isinstance(value, dict):
        if key in value:
            return value[key]
        for child in value.values():
            found = _find(child, key, depth + 1)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find(child, key, depth + 1)
            if found is not None:
                return found
    return None


def parse_permissions(parsed: Any) -> dict[str, Optional[bool]]:
    out: dict[str, Optional[bool]] = {}
    for key in ("accessibility", "screen_recording"):
        value = _find(parsed, key)
        out[key] = value if isinstance(value, bool) else None
    return out


def count_windows(parsed: Any) -> Optional[int]:
    if isinstance(parsed, list):
        return len(parsed)
    windows = _find(parsed, "windows")
    return len(windows) if isinstance(windows, list) else None


def _words(result: dict[str, Any]) -> list[str]:
    """One plain line per check, for the pane and the CLI."""
    lines = []
    if result.get("reachable") is False:
        return [f"Not reachable: {result.get('error') or 'SSH failed'}"]
    lines.append("Reachable over SSH")
    driver = result.get("driver") or {}
    if driver.get("ok"):
        lines.append(f"Driver ready: cua-driver {driver.get('version')}")
    elif driver:
        lines.append(f"Driver problem: {driver.get('problem')}")
    perms = result.get("permissions") or {}
    if perms.get("ok") is True:
        lines.append("Permissions OK (Accessibility and Screen Recording)")
    elif perms.get("ok") is False:
        missing = [name for key, name in (("accessibility", "Accessibility"), ("screen_recording", "Screen Recording"))
                   if perms.get(key) is False]
        lines.append("Permissions missing: " + (", ".join(missing) or "unknown") +
                     " (grant them once at the Mac: cua-driver permissions grant)")
    if result.get("logged_in") is False:
        lines.append("Nobody is logged in at the Mac's screen as this user")
    if result.get("screen_awake") is False:
        lines.append("Screen asleep or locked: no windows are visible")
    elif result.get("screen_awake") is True:
        lines.append("Screen awake")
    return lines


def probe_error(parsed: Any) -> str:
    """The driver's own error text for a logical failure (``isError``/``ok: false``), else ``""``."""
    if not isinstance(parsed, dict):
        return ""
    if parsed.get("isError") is True or parsed.get("is_error") is True or parsed.get("ok") is False:
        text = parsed.get("error") or parsed.get("message") or parsed.get("data") or "the driver reported an error"
        return str(text)[:200]
    return ""


def run_status(cfg: Optional[RemoteCuaConfig], *, runner: Optional[remote.SSHRunner] = None,
               policy: Optional[remote.DriverPolicy] = None, config_error: str = "",
               token: Optional[str] = None, home: Optional[Path] = None) -> dict[str, Any]:
    """The status payload (see computer-viewer/docs/REMOTE-CUA.md). Never raises. ``ok`` needs affirmative
    evidence: both permissions granted and at least one window visible."""
    now = time.time()
    if cfg is None:
        return {"ok": False, "configured": False, "error": config_error or "remote_cua is not configured",
                "summary": [config_error or "This bot has no remote computer configured"], "checked_at": now}
    base: dict[str, Any] = {"ok": False, "configured": True, "machine": cfg.public(), "checked_at": now,
                            "reachable": None, "driver": None, "permissions": None, "screen_awake": None,
                            "logged_in": None, "error": ""}
    if cfg.os == OS_WINDOWS:
        base.update(supported=False, error=WINDOWS_REFUSAL, summary=[WINDOWS_REFUSAL])
        return base
    base["supported"] = True
    runner = runner or remote.SSHRunner(cfg)
    try:
        if policy is None:
            policy = default_policy()
        info = remote.discover(cfg, runner, policy.pin)
    except Exception as exc:  # unreachable, or the Hermes pin/contract could not be read
        base.update(reachable=False if isinstance(exc, remote.RemoteError) else None, error=str(exc))
        base["summary"] = _words(base) if base["reachable"] is False else [str(exc)]
        return base
    base["reachable"] = True
    base["logged_in"] = info.logged_in
    problems = remote.driver_problems(cfg, info, policy)
    base["driver"] = {"found": bool(info.path), "path": info.path, "version": info.version, "pin": policy.pin,
                      "ok": not problems, "problem": "; ".join(problems)}
    if problems:
        base.update(error=base["driver"]["problem"], summary=_words(base))
        return base
    if home is None:
        from . import lease
        home = lease.hermes_home()
    daemon = remote.RemoteDaemon(cfg, policy, home=Path(home), runner=runner, token=token, at_exit=False)
    errors: list[str] = []
    perms: dict[str, Optional[bool]] = {"accessibility": None, "screen_recording": None}
    windows: Optional[int] = None
    try:
        daemon.start(info)
        try:
            parsed = daemon.call("check_permissions", {"prompt": False}, timeout=20.0)
            err = probe_error(parsed)
            if err:
                errors.append(f"permission check failed: {err}")
            else:
                perms = parse_permissions(parsed)
        except Exception as exc:
            errors.append(f"permission check failed: {exc}")
        try:
            parsed = daemon.call("list_windows", {"on_screen_only": True}, timeout=20.0)
            err = probe_error(parsed)
            if err:
                errors.append(f"window check failed: {err}")
            else:
                windows = count_windows(parsed)
                if windows is None:
                    errors.append("window check failed: the driver's answer has no window list")
        except Exception as exc:
            errors.append(f"window check failed: {exc}")
    except Exception as exc:
        errors.append(str(exc))
    finally:
        daemon.stop()
    if perms["accessibility"] is True and perms["screen_recording"] is True:
        perms_ok: Optional[bool] = True
    elif False in perms.values():
        perms_ok = False
    else:
        perms_ok = None  # not checked, or the driver answered in a shape this plugin does not know
    base["permissions"] = {**perms, "ok": perms_ok}
    base["windows"] = windows
    base["screen_awake"] = None if windows is None else windows > 0
    base["ok"] = (not errors and perms_ok is True and base["screen_awake"] is True and info.logged_in is not False)
    base["summary"] = _words(base) + [e[:1].upper() + e[1:] for e in errors]
    if not base["ok"]:
        good = ("Reachable", "Driver ready", "Permissions OK", "Screen awake")
        bad = [line for line in base["summary"] if not line.startswith(good)]
        base["error"] = "; ".join(bad) or "the probe could not confirm permissions and a visible screen"
    return base


def default_policy() -> remote.DriverPolicy:
    """The gateway's pin and Hermes's own driver checks (version-gated private imports)."""
    from . import compat
    priv = compat.private()
    return remote.DriverPolicy(pin=compat.gateway_pin(), contract_reason=priv.manifest_contract_reason,
                               bundle_id=priv.bundle_id, team_ids=tuple(priv.team_ids))


def cached_status(key: str, compute: Callable[[], dict[str, Any]], *, fresh: bool = False,
                  now: Optional[Callable[[], float]] = None) -> dict[str, Any]:
    """``compute()`` at most once per CACHE_SECONDS per profile ``key`` unless ``fresh``."""
    clock = now or time.monotonic
    with _cache_lock:
        hit = _cache.get(key)
        if hit and not fresh and clock() - hit[0] < CACHE_SECONDS:
            return {**hit[1], "cached": True}
    result = compute()
    with _cache_lock:
        _cache[key] = (clock(), result)
    return {**result, "cached": False}


def status_for_profile(config: Optional[dict[str, Any]] = None, *, fresh: bool = False,
                       home: Optional[Path] = None) -> dict[str, Any]:
    """Status of the active profile's machine (``config`` = its config.yaml mapping)."""
    from . import lease, settings
    home = Path(home or lease.hermes_home())
    try:
        config = settings.load_profile_config() if config is None else config
        cfg, error = settings.from_profile(config), ""
    except ConfigError as exc:
        cfg, error = None, str(exc)
    except Exception as exc:
        cfg, error = None, f"could not read this profile's config.yaml: {type(exc).__name__}"
    return cached_status(str(home), lambda: run_status(cfg, config_error=error, home=home), fresh=fresh)
