"""The ``remote-cua`` computer_use backend: Hermes's own ``CuaDriverBackend`` with its daemon swapped for
:class:`remote.RemoteDaemon`, so the MCP stdio server is ``ssh … cua-driver mcp --embedded --socket …``
on the remote Mac. Everything else (tool schema, approvals, Hermes's lease fence, capture/input
mixins, session recovery) is Hermes's code, unchanged.

The Hermes classes are private, so they are imported through :func:`compat.private` (version-gated)
and the subclasses are built on first use, never at module import.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import logging
from pathlib import Path
from typing import Any, Optional

from . import lease, remote
from .settings import OS_WINDOWS, WINDOWS_REFUSAL, RemoteCuaConfig

logger = logging.getLogger(__name__)

_classes: Optional[tuple[type, type]] = None


def _refused(priv: Any, name: str, message: str) -> dict[str, Any]:
    return priv.tool_envelope(message, [], {"ok": False, "code": lease.REASON, "message": message,
                                            "operation": name}, True, [])


def classes() -> tuple[type, type]:
    """``(RemoteCuaSession, RemoteCuaBackend)``, built once against the running Hermes."""
    global _classes
    if _classes is not None:
        return _classes
    from . import compat
    priv = compat.private()

    class RemoteCuaSession(priv.CuaDriverSession):
        """Hermes's MCP session; only the spawn (ssh, not a local binary) and the CLI fallback (also over
        ssh, never a local temp file) differ. Calls are refused while a human holds this profile's lease,
        and a result produced across a take-over is discarded."""

        def __init__(self, bridge: Any, daemon: remote.RemoteDaemon, lease_home: Path):
            super().__init__(bridge, daemon)
            self._lease_home = lease_home

        async def _lifecycle_coro(self) -> None:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client

            self._shutdown_event = asyncio.Event()
            self._startup_phase = "remote-spawn"
            try:
                command, args = self._embedded_daemon.proxy_invocation()
                params = StdioServerParameters(command=command, args=args, env=self._embedded_daemon.child_env())
                async with stdio_client(params) as (read, write):
                    self._startup_phase = "mcp-initialize"
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        self._startup_phase = "capability-discovery"
                        await self._populate_capabilities(session)
                        self._session, self._startup_phase = session, "ready"
                        self._ready_event.set()
                        logger.info("remote-cua: cua-driver session ready on %s", self._embedded_daemon.cfg.host)
                        await self._shutdown_event.wait()
            except BaseException as e:
                self._setup_error = e
                self._ready_event.set()
                raise
            finally:
                self._session, self._started = None, False

        def _call_tool_via_cli(self, name: str, args: dict[str, Any], timeout: float) -> dict[str, Any]:
            call_args = {k: v for k, v in dict(args).items() if k != "screenshot_out_file"}  # remote path: never
            return priv.cli_result(self._embedded_daemon.call(name, call_args, timeout=timeout), None)

        def call_tool(self, name: str, args: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
            if name in self._LIFECYCLE_CALLS:
                return super().call_tool(name, args, timeout)
            before = lease.read(self._lease_home)
            if before.holder == lease.HUMAN:
                return _refused(priv, name, lease.REFUSAL)
            result = super().call_tool(name, args, timeout)
            if lease.read(self._lease_home).epoch != before.epoch:
                return _refused(priv, name, lease.DISCARDED)
            return result

    class RemoteCuaBackend(priv.CuaDriverBackend):
        """``CuaDriverBackend`` driving a remote Mac. Always cua-driver's ``standard`` permission mode on
        the remote: Hermes's approvals still apply on the gateway, and bounded/unrestricted would need
        their manifest and daemon flags on the remote too."""

        def __init__(self, cfg: RemoteCuaConfig, permission_mode: str = "standard", *,
                     daemon: Optional[remote.RemoteDaemon] = None, home: Optional[Path] = None):
            super().__init__("standard")
            if permission_mode != "standard":
                logger.info("remote-cua: permission mode %r requested; the remote driver runs in standard mode",
                            permission_mode)
            self.requested_permission_mode = permission_mode
            self.cfg = cfg
            self.home = Path(home or lease.hermes_home())
            if daemon is None:
                from . import status
                daemon = remote.RemoteDaemon(cfg, status.default_policy(), home=self.home)
            self._embedded_daemon = daemon
            self._session = RemoteCuaSession(self._bridge, daemon, self.home)
            self._session.set_transport_reset_callback(self._handle_transport_reset)

        def start(self) -> None:
            priv.ensure_import("computer-use")  # the MCP client SDK, lazily installed like Hermes does
            importlib.invalidate_caches()
            with contextlib.ExitStack() as rollback:
                rollback.callback(self._embedded_daemon.stop)
                self._embedded_daemon.start()
                self._session.start()
                rollback.pop_all()
            self._best_effort("start_session failed (continuing anonymous)",
                              self._session.call_tool, "start_session", {"session": self._session_id})
            if self._session._started:
                max_dim = priv.max_image_dimension()
                if max_dim:  # smaller screenshots: less over SSH and fewer tokens
                    self._best_effort("set_config(max_image_dimension) failed", self.set_config,
                                      max_image_dimension=max_dim)
                if self._embedded_daemon.no_overlay:
                    self._best_effort("set_agent_cursor_enabled failed", self.set_agent_cursor_enabled, False,
                                      cursor_id=self._session_id)

        def is_available(self) -> bool:
            return True

    _classes = (RemoteCuaSession, RemoteCuaBackend)
    return _classes


def create_backend(cfg: RemoteCuaConfig, permission_mode: str = "standard", **kwargs: Any) -> Any:
    """A fresh, unstarted backend for one Hermes session. Windows is refused here, before any SSH."""
    if cfg.os == OS_WINDOWS:
        raise RuntimeError(WINDOWS_REFUSAL)
    return classes()[1](cfg, permission_mode, **kwargs)
