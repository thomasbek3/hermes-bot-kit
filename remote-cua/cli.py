"""``hermes remote-cua check [profile]``: is this bot's remote Mac ready for computer_use?

Prints reachability, the driver found and its version against the gateway's pin, the macOS
permissions (``check_permissions prompt:false``, never a dialog) and whether the screen is awake.
Exit code 0 = ready, 1 = not ready, 2 = not configured.

Without the plugin's CLI hook the same check runs as a script with Hermes's Python:

    ~/.hermes/hermes-agent/venv/bin/python ~/.hermes/plugins/remote-cua/check.py [profile]
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Optional

_PROFILE_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def hermes_root() -> Path:
    try:
        from hermes_constants import get_default_hermes_root
        return Path(get_default_hermes_root())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def profile_home(profile: Optional[str]) -> Path:
    """``default`` = the root home; a name = ``<root>/profiles/<name>``; None = the active home."""
    if not profile:
        from . import lease
        return lease.hermes_home()
    if profile == "default":
        return hermes_root()
    if not _PROFILE_RE.match(profile) or profile in (".", ".."):
        raise ValueError(f"not a profile name: {profile!r}")
    home = hermes_root() / "profiles" / profile
    if not home.is_dir():
        raise ValueError(f"no profile {profile!r} under {hermes_root() / 'profiles'}")
    return home


def read_config(home: Path) -> dict[str, Any]:
    path = home / "config.yaml"
    try:
        import yaml
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    return data if isinstance(data, dict) else {}


def check(profile: Optional[str]) -> dict[str, Any]:
    from . import settings, status
    home = profile_home(profile)
    config: Optional[dict[str, Any]] = None
    if not profile:
        try:
            config = settings.load_profile_config()
        except Exception:  # outside a Hermes process (the standalone script)
            config = None
    if config is None:
        config = read_config(home)
    result = status.status_for_profile(config, fresh=True, home=home)
    result["profile"] = profile or "(active)"
    result["backend_selected"] = settings.backend_selected(config)
    return result


def print_check(profile: Optional[str], *, as_json: bool = False) -> int:
    try:
        result = check(profile)
    except ValueError as exc:
        print(f"remote-cua: {exc}")
        return 2
    if as_json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        machine = result.get("machine") or {}
        target = f"{machine.get('user')}@{machine.get('host')}" if machine else "no machine"
        print(f"remote-cua check, profile {result['profile']}: {target}")
        if result.get("configured") and not result.get("backend_selected"):
            print("  note: computer_use.backend is not remote-cua, so the bot is not using this machine yet")
        for line in result.get("summary") or []:
            print(f"  - {line}")
        print("  READY" if result.get("ok") else "  NOT READY")
    if not result.get("configured"):
        return 2
    return 0 if result.get("ok") else 1


def setup_parser(parser: Any) -> None:
    sub = parser.add_subparsers(dest="remote_cua_command")
    chk = sub.add_parser("check", help="check a profile's remote Mac (reachable, driver, permissions, screen)")
    chk.add_argument("profile", nargs="?", default=None, help='profile name ("default" = the root profile)')
    chk.add_argument("--json", action="store_true", help="print the status payload as JSON")


def handle(args: Any) -> int:
    if getattr(args, "remote_cua_command", None) != "check":
        print("usage: hermes remote-cua check [profile] [--json]")
        return 2
    return print_check(getattr(args, "profile", None), as_json=bool(getattr(args, "json", False)))


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="remote-cua", description=__doc__.split("\n\n")[0])
    parser.add_argument("profile", nargs="?", default=None, help='profile name ("default" = the root profile)')
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    return print_check(args.profile, as_json=args.json)
