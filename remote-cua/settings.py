"""remote-cua profile configuration: the ``remote_cua`` block of a profile's config.yaml.

    computer_use:
      backend: remote-cua
    remote_cua:
      host: 100.64.0.10      # ssh host (an address or a ~/.ssh/config alias)
      user: someone          # ssh user
      os: macos              # macos | windows (windows is refused for now)
      driver: ""             # optional absolute remote path to cua-driver
      vnc: ""                # optional; only the computer-viewer pane reads it

No Hermes imports at module level: Hermes executes every sibling module of a plugin when it loads it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

BACKEND_NAME = "remote-cua"
OS_MACOS = "macos"
OS_WINDOWS = "windows"
SUPPORTED_OS = (OS_MACOS, OS_WINDOWS)

WINDOWS_REFUSAL = ("Windows support coming: needs cua Session proxy. remote-cua drives macOS machines today; "
                   "a Windows PC needs cua-driver's Session-1 proxy, which this plugin does not set up yet.")

# No leading '-' (ssh would read it as an option); IPv6 needs ':'.
_HOST_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._:-]{0,252}$")
_USER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


class ConfigError(ValueError):
    """The profile's remote_cua block is missing or unusable; the message is plain words."""


@dataclass(frozen=True)
class RemoteCuaConfig:
    host: str
    user: str
    os: str = OS_MACOS
    driver: str = ""
    vnc: str = ""

    @property
    def destination(self) -> str:
        return f"{self.user}@{self.host}"

    def public(self) -> dict[str, str]:
        """What the routes and the check report back (no secrets live in this block)."""
        return {"host": self.host, "user": self.user, "os": self.os, "driver": self.driver, "vnc": self.vnc}


def _text(raw: Mapping[str, Any], key: str) -> str:
    value = raw.get(key)
    if value is None:
        return ""
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        raise ConfigError(f"remote_cua.{key} must be text")
    return str(value).strip()


def parse(raw: Any) -> RemoteCuaConfig:
    """Validate a ``remote_cua`` block. Raises ConfigError naming the bad key."""
    if raw is None:
        raise ConfigError("this profile has no remote_cua block in its config.yaml")
    if not isinstance(raw, Mapping):
        raise ConfigError("remote_cua in config.yaml must be a mapping (host, user, os)")
    host, user = _text(raw, "host"), _text(raw, "user")
    os_name = (_text(raw, "os") or OS_MACOS).lower()
    driver, vnc = _text(raw, "driver"), _text(raw, "vnc")
    if not host:
        raise ConfigError("remote_cua.host is not set")
    if not _HOST_RE.match(host):
        raise ConfigError("remote_cua.host must be a plain host name or address (letters, digits, . _ : -)")
    if not user:
        raise ConfigError("remote_cua.user is not set")
    if not _USER_RE.match(user):
        raise ConfigError("remote_cua.user must be a plain user name (letters, digits, . _ -)")
    if os_name not in SUPPORTED_OS:
        raise ConfigError(f"remote_cua.os must be one of {', '.join(SUPPORTED_OS)} (got {os_name!r})")
    if driver and (not driver.startswith("/") or _CONTROL_RE.search(driver)):
        raise ConfigError("remote_cua.driver must be an absolute path on the remote machine, e.g. "
                          "/Users/you/.hermes/tools/cua-driver-0.21.0-darwin-arm64/cua-driver")
    if _CONTROL_RE.search(vnc):
        raise ConfigError("remote_cua.vnc must be one line of text")
    return RemoteCuaConfig(host=host, user=user, os=os_name, driver=driver, vnc=vnc)


def backend_selected(config: Optional[Mapping[str, Any]]) -> bool:
    """``computer_use.backend`` names this plugin."""
    block = (config or {}).get("computer_use") if isinstance(config, Mapping) else None
    backend = block.get("backend") if isinstance(block, Mapping) else None
    return isinstance(backend, str) and backend.strip() == BACKEND_NAME


def load_profile_config() -> dict[str, Any]:
    """The active profile's config.yaml through Hermes's own read-only loader (scope-aware)."""
    from hermes_cli.config import load_config_readonly
    config = load_config_readonly() or {}
    return config if isinstance(config, dict) else {}


def from_profile(config: Optional[Mapping[str, Any]] = None) -> RemoteCuaConfig:
    """Parse the remote_cua block of ``config`` (default: the active profile's)."""
    config = load_profile_config() if config is None else config
    return parse((config or {}).get("remote_cua"))
