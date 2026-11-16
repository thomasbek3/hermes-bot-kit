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
    """Run a public backend method as one fenced operation: refused up front while a human holds the
    lease, and its result never returned if control changed hands at any point before it returns (the
    cached target is disarmed). Raises Hermes's own ``HumanHasControl``, which its computer_use tool turns
    into ``{"code": "human_has_control"}``."""
    @functools.wraps(fn)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        session = self._session
        with session.operation():
            if not session.admitted():
                # A refusal at entry disarms too: the pre-takeover target must not survive the hand-back.
                self._clear_active_target()
                raise session.human_has_control(lease.REFUSAL)
            try:
                result = fn(self, *args, **kwargs)
            except Exception as exc:
                if not session.admitted():
                    self._clear_active_target()
                    raise session.human_has_control(lease.DISCARDED) from exc
                raise
            if not session.admitted():
                self._clear_active_target()
                raise session.human_has_control(lease.DISCARDED)
            return result
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
            """One operation: a public backend method, or one session call made outside of one. Its
            admission epoch is read once, at the outermost entry; every dispatch inside it is checked
            against it (see :meth:`_dispatch_refusal`)."""
            if self._op_depth == 0:
                self._op_epoch = lease.read(self._lease_home).epoch
            self._op_depth += 1
            try:
                yield
            finally:
                self._op_depth -= 1
                if self._op_depth == 0:
                    self._op_epoch = None

        def admitted(self) -> bool:
            """The agent holds the lease and it has not moved since this operation was admitted."""
            now = lease.read(self._lease_home)
            return now.holder != lease.HUMAN and (self._op_epoch is None or now.epoch == self._op_epoch)

        @staticmethod
        def human_has_control(message: str) -> Exception:
            return priv.HumanHasControl(message)

        def _dispatch_refusal(self, name: str) -> Optional[dict[str, Any]]:
            """Checked immediately before EVERY send to the driver: Hermes's first send, its reconnect
            replay, its ended-session replay (all go through ``_call_tool_async``), and the CLI fallback.
            Lifecycle calls (start/end_session) only label the driver session and are exempt."""
            if name in self._LIFECYCLE_CALLS:
                return None
            now = lease.read(self._lease_home)
            if now.holder == lease.HUMAN:
                return _refused(priv, name, lease.REFUSAL)
            if self._op_epoch is not None and now.epoch != self._op_epoch:
                return _refused(priv, name, lease.DISCARDED)
            return None

        def _after_dispatch(self, name: str, result: dict[str, Any]) -> dict[str, Any]:
            if name not in self._LIFECYCLE_CALLS and not self.admitted():
                return _refused(priv, name, lease.DISCARDED)
            return result

        async def _call_tool_async(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
            refusal = self._dispatch_refusal(name)
            if refusal is not None:
                return refusal
            return self._after_dispatch(name, await super()._call_tool_async(name, args))

        def _call_tool_via_cli(self, name: str, args: dict[str, Any], timeout: float) -> dict[str, Any]:
            # Hermes's capture code reaches this directly (its empty-result re-fetch), not via call_tool.
            with self.operation():
                refusal = self._dispatch_refusal(name)
                if refusal is not None:
                    return refusal
                return self._after_dispatch(name, self._cli_unfenced(name, args, timeout))

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
            with self.operation():
                refusal = self._dispatch_refusal(name)
                if refusal is not None:
                    return refusal
                return self._after_dispatch(name, super().call_tool(name, args, timeout))

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
