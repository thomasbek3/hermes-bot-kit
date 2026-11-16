"""The one place remote-cua touches Hermes internals that are not a public plugin API.

Every private import goes through :func:`private`, which first checks the running Hermes version
against :data:`SUPPORTED_HERMES` and then imports each name in :data:`PRIVATE_IMPORTS`. Anything
missing raises :class:`CompatError` with "remote-cua needs Hermes <range>" instead of an
AttributeError deep inside a tool call. CONTRACT.md lists the same names; tests/test_contract.py
imports them against a real Hermes checkout.
"""
from __future__ import annotations

import importlib
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

# The Hermes releases this plugin was built and tested against. Widen only after
# tests/test_contract.py passes against the new release.
SUPPORTED_HERMES = ">=0.23.0,<0.24.0"
_SUPPORTED_MIN = (0, 23, 0)
_SUPPORTED_BELOW = (0, 24, 0)

# (module, attribute, local name). Private = underscore names and modules Hermes documents as internal.
PRIVATE_IMPORTS: tuple[tuple[str, str, str], ...] = (
    ("tools.computer_use.cua_backend", "CuaDriverBackend", "CuaDriverBackend"),
    ("tools.computer_use.cua_backend", "_computer_use_max_image_dimension", "max_image_dimension"),
    ("tools.computer_use.cua_backend_session", "_CuaDriverSession", "CuaDriverSession"),
    ("tools.computer_use.cua_backend_session", "_cli_result", "cli_result"),
    ("tools.computer_use.cua_backend_parse", "_tool_envelope", "tool_envelope"),
    ("tools.computer_use.cua_backend_driver", "_manifest_contract_reason", "manifest_contract_reason"),
    ("tools.computer_use.cua_backend_daemon", "_CUA_DRIVER_TEAM_IDS", "team_ids"),
    ("tools.computer_use.permissions", "CUA_DRIVER_BUNDLE_ID", "bundle_id"),
    ("pm", "ensure_import", "ensure_import"),
)

_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)(?:\.(\d+))?")


class CompatError(RuntimeError):
    """The running Hermes is outside the supported range or lacks an internal remote-cua uses."""


def hermes_version() -> str:
    """The running Hermes base version (``0.23.1``), or ``""`` when Hermes cannot say."""
    try:
        from hermes_cli.version_info import get_version_info
        return str(get_version_info().base_version or "")
    except Exception:
        return ""


def version_tuple(version: str) -> Optional[tuple[int, int, int]]:
    m = _VERSION_RE.match(str(version or "").strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)


def version_supported(version: str) -> bool:
    v = version_tuple(version)
    return v is not None and _SUPPORTED_MIN <= v < _SUPPORTED_BELOW


def check_version(version: Optional[str] = None) -> str:
    version = hermes_version() if version is None else version
    if not version_supported(version):
        raise CompatError(f"remote-cua needs Hermes {SUPPORTED_HERMES} (running {version or 'an unknown version'}). "
                          "Update the kit (it pins the Hermes internals it uses) or install a supported Hermes.")
    return version


_cached: Optional[SimpleNamespace] = None


def private(*, version: Optional[str] = None) -> SimpleNamespace:
    """Every private Hermes name remote-cua uses, after the version gate. Cached once it succeeds."""
    global _cached
    if _cached is not None and version is None:
        return _cached
    check_version(version)
    found = {}
    for module, attr, local in PRIVATE_IMPORTS:
        try:
            found[local] = getattr(importlib.import_module(module), attr)
        except (ImportError, AttributeError) as exc:
            raise CompatError(f"remote-cua needs Hermes {SUPPORTED_HERMES}: {module}.{attr} is missing "
                              f"({type(exc).__name__}: {exc}).") from exc
    ns = SimpleNamespace(**found)
    if version is None:
        _cached = ns
    return ns


def gateway_pin() -> str:
    """The cua-driver version Hermes's package manager pins on this gateway (``pm/lock.json``)."""
    try:
        import pm
        lock = Path(pm.__file__).resolve().parent / "lock.json"
        data = json.loads(lock.read_text(encoding="utf-8"))
    except Exception as exc:
        raise CompatError(f"remote-cua needs Hermes {SUPPORTED_HERMES}: could not read the cua-driver pin "
                          f"from pm/lock.json ({type(exc).__name__}: {exc}).") from exc
    packages = data.get("packages") if isinstance(data, dict) else None
    entry = (packages or {}).get("cua-driver") if isinstance(packages, dict) else None
    version = entry.get("version") if isinstance(entry, dict) else None
    if not isinstance(version, str) or not version_tuple(version):
        raise CompatError(f"remote-cua needs Hermes {SUPPORTED_HERMES}: pm/lock.json has no cua-driver pin.")
    return version
