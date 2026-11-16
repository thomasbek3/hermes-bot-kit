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
import functools
import importlib
import inspect
import logging
from pathlib import Path
from typing import Any, Iterator, Optional

from . import lease, remote
from .settings import OS_WINDOWS, WINDOWS_REFUSAL, RemoteCuaConfig

logger = logging.getLogger(__name__)

_classes: Optional[tuple[type, type]] = None

# Response/request keys that carry a file path on the remote Mac (never read on the gateway).
_REMOTE_PATH_FIELDS = frozenset({"screenshot_file_path", "screenshot_out_file"})
_NOT_OPERATIONS = frozenset({"start", "stop", "is_available"})


def _operation_methods(cls: type) -> list[str]:
    """Public methods of Hermes's backend that act on the machine (everything but the lifecycle)."""
    return sorted(name for name in dir(cls) if not name.startswith("_") and name not in _NOT_OPERATIONS
                  and inspect.isfunction(getattr(cls, name, None)))


def _as_operation(fn: Any) -> Any:
    @functools.wraps(fn)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        with self._session.operation():
            return fn(self, *args, **kwargs)
    return wrapper


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
            self._op_depth = 0
            self._op_epoch: Optional[int] = None

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

        @contextlib.contextmanager
        def operation(self) -> Iterator[None]:
            """One backend operation (a capture, a click ...). Its admission epoch is taken once, at the
            outermost entry, and every transport call inside it, MCP or CLI fallback, is checked against
            it: a take-over at any point, even a full take-over and hand-back between two calls, voids the
            rest of the operation."""
            if self._op_depth == 0:
                self._op_epoch = lease.read(self._lease_home).epoch
            self._op_depth += 1
            try:
                yield
            finally:
                self._op_depth -= 1
                if self._op_depth == 0:
                    self._op_epoch = None

        def _fenced(self, name: str, call: Any) -> dict[str, Any]:
            """Refuse while a human holds the lease; refuse/discard when it moved since admission."""
            now = lease.read(self._lease_home)
            if now.holder == lease.HUMAN:
                return _refused(priv, name, lease.REFUSAL)
            admitted = self._op_epoch if self._op_epoch is not None else now.epoch
            if now.epoch != admitted:
                return _refused(priv, name, lease.DISCARDED)
            result = call()
            if lease.read(self._lease_home).epoch != admitted:
                return _refused(priv, name, lease.DISCARDED)
            return result

        def _call_tool_via_cli(self, name: str, args: dict[str, Any], timeout: float) -> dict[str, Any]:
            # Hermes's capture code reaches this directly (its empty-result refetch), not via call_tool,
            # so it is fenced here too.
            return self._fenced(name, lambda: self._cli_unfenced(name, args, timeout))

        def _cli_unfenced(self, name: str, args: dict[str, Any], timeout: float) -> dict[str, Any]:
            call_args = {k: v for k, v in dict(args).items() if k not in _REMOTE_PATH_FIELDS}
            parsed = self._embedded_daemon.call(name, call_args, timeout=timeout)
            if isinstance(parsed, dict):
                # A path in the answer names a file on the remote Mac. Hermes's parser would open it on
                # the gateway, so it never sees one: only inline images are used.
                parsed = {k: v for k, v in parsed.items() if k not in _REMOTE_PATH_FIELDS}
            return priv.cli_result(parsed, None)

        def call_tool(self, name: str, args: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
            if name in self._LIFECYCLE_CALLS:
                return super().call_tool(name, args, timeout)
            return self._fenced(name, lambda: super(RemoteCuaSession, self).call_tool(name, args, timeout))

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

    # Every public backend method is one fenced operation (see RemoteCuaSession.operation).
    for attr in _operation_methods(priv.CuaDriverBackend):
        setattr(RemoteCuaBackend, attr, _as_operation(getattr(priv.CuaDriverBackend, attr)))

    _classes = (RemoteCuaSession, RemoteCuaBackend)
    return _classes


def create_backend(cfg: RemoteCuaConfig, permission_mode: str = "standard", **kwargs: Any) -> Any:
    """A fresh, unstarted backend for one Hermes session. Windows is refused here, before any SSH."""
    if cfg.os == OS_WINDOWS:
        raise RuntimeError(WINDOWS_REFUSAL)
    return classes()[1](cfg, permission_mode, **kwargs)
