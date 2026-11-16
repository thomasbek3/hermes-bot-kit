"""Health of a profile's remote-cua machine: reachable, driver, permissions, screen awake.

Used by ``GET /api/plugins/remote-cua/status``, ``hermes remote-cua check`` and the provider's doctor.
Two SSH sessions: driver discovery, then one probe that starts a private daemon, asks it
``check_permissions`` (``prompt: false``: never a dialog on the Mac) and ``list_windows``, and stops it.
Read-only on the remote apart from that short-lived daemon and its socket.
"""
from __future__ import annotations

import shlex
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from . import remote
from .settings import OS_WINDOWS, WINDOWS_REFUSAL, ConfigError, RemoteCuaConfig

CACHE_SECONDS = 20.0
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()


def probe_script(info: remote.DriverInfo, sock: str) -> str:
    q = shlex.quote
    status = f"{q(info.path)} status --socket {q(sock)} >/dev/null 2>&1 </dev/null"
    perms = remote.call_remote_command(info.path, sock, "check_permissions", {"prompt": False})
    windows = remote.call_remote_command(info.path, sock, "list_windows", {"on_screen_only": True})
    m = remote.MARK
    return "\n".join([
        remote.serve_command(info, sock),
        "rc=$?",
        f'if [ "$rc" -ne 0 ]; then echo "{m}open_failed=$rc"; exit 0; fi',
        "i=0",
        "ready=0",
        f"while [ $i -lt {remote.START_POLL_STEPS} ]; do",
        f"  if {status}; then ready=1; break; fi",
        "  sleep 0.1",
        "  i=$((i+1))",
        "done",
        f'echo "{m}ready=$ready"',
        'if [ "$ready" = 1 ]; then',
        f'  echo "{m}perm-begin"',
        f"  {perms} 2>/dev/null",
        "  echo",
        f'  echo "{m}perm-end"',
        f'  echo "{m}win-begin"',
        f"  {windows} 2>/dev/null",
        "  echo",
        f'  echo "{m}win-end"',
        "fi",
        remote.stop_command(info.path, sock),
        f'echo "{m}end=1"',
    ]) + "\n"


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


def run_status(cfg: Optional[RemoteCuaConfig], *, runner: Optional[remote.SSHRunner] = None,
               policy: Optional[remote.DriverPolicy] = None, config_error: str = "",
               token: Optional[str] = None) -> dict[str, Any]:
    """The status payload (see computer-viewer/docs/REMOTE-CUA.md). Never raises."""
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
    sock = remote.socket_for(token or remote.new_token())
    try:
        result = runner.run(probe_script(info, sock), timeout=60.0)
    except Exception as exc:
        base.update(error=str(exc), summary=_words(base) + [f"Probe failed: {exc}"])
        return base
    marks = remote._marks(result.stdout)
    if marks.get("ready") != "1":
        why = (f"open exited {marks['open_failed']}" if "open_failed" in marks else
               remote.ssh_failure(cfg, remote.Result(result.returncode, result.stdout, result.stderr))
               if result.returncode == 255 else "its socket did not answer within 15 s")
        base.update(error=f"the cua-driver daemon did not start ({why})")
        base["summary"] = _words(base) + [f"Daemon did not start ({why}); is the user logged in at the Mac?"]
        return base
    perms = parse_permissions(remote.json_object(remote._between(result.stdout, "perm-begin", "perm-end")))
    if perms["accessibility"] is True and perms["screen_recording"] is True:
        perms_ok: Optional[bool] = True
    elif False in perms.values():
        perms_ok = False
    else:
        perms_ok = None  # the driver answered in a shape this plugin does not know
    base["permissions"] = {**perms, "ok": perms_ok}
    windows = count_windows(remote.json_object(remote._between(result.stdout, "win-begin", "win-end")))
    base["windows"] = windows
    base["screen_awake"] = None if windows is None else windows > 0
    base["ok"] = perms_ok is True and base["screen_awake"] is not False and info.logged_in is not False
    base["summary"] = _words(base)
    if not base["ok"]:
        good = ("Reachable", "Driver ready", "Permissions OK", "Screen awake")
        base["error"] = "; ".join(line for line in base["summary"] if not line.startswith(good)) or \
            "permissions could not be read from the driver"
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
    return cached_status(str(home), lambda: run_status(cfg, config_error=error), fresh=fresh)
