"""Everything remote-cua runs on the remote Mac, over plain OpenSSH.

The pattern is Hermes's own private-daemon path (``tools/computer_use/cua_backend_daemon.py``), moved
to the far end of an SSH connection:

1. find the driver: ``remote_cua.driver``, else ``~/.hermes/tools/cua-driver-<pin>-darwin-*/cua-driver``
   matching the gateway's PM pin, else ``cua-driver`` on the remote PATH; read its ``manifest`` and
   the ``codesign -dv`` identity of the CuaDriver.app that carries it (one SSH session);
2. start a private daemon through that exact app (never ``open -a CuaDriver`` by name, which lets
   LaunchServices pick another install):
   ``open -n -g -a <app> --args serve --embedded --socket /tmp/hc-<token>.sock --no-permissions-gate
   --permission-mode standard [--no-overlay]``, then poll ``<bin> status --socket`` (one SSH session);
3. the MCP stdio server is ``ssh -T -o BatchMode=yes -o ServerAliveInterval=15 … user@host
   '… exec <bin> mcp --no-overlay --embedded --socket <sock>'``: one persistent session per run;
4. stop: ``<bin> stop --socket <sock>; rm -f <sock>`` (on stop, at exit, and for sockets an earlier,
   dead gateway process left behind, which this profile's registry recorded).

No Hermes imports here: the pieces that need Hermes (version pin, manifest contract, signing
teams) are passed in, so this module is testable with a fake ssh.
"""
from __future__ import annotations

import atexit
import contextlib
import json
import logging
import os
import shlex
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .settings import RemoteCuaConfig

logger = logging.getLogger(__name__)

SSH = "ssh"
SSH_OPTIONS: tuple[str, ...] = (
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
)
# Only what ssh itself needs: an agent socket, a home for ~/.ssh, a PATH. Never Hermes's provider keys.
_SSH_ENV_KEYS = ("PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "LANG", "LC_ALL", "TMPDIR")
TELEMETRY_ENV = "CUA_DRIVER_RS_TELEMETRY_ENABLED=0"
OPEN = "/usr/bin/open"
SOCKET_DIR = "/tmp"
START_POLL_STEPS = 150  # x 0.1 s = the 15 s cap Hermes uses for its own private daemon
REGISTRY_FILE = "daemons.json"
MARK = "RCUA:"


class RemoteError(RuntimeError):
    """A remote step failed; the message is plain words for the bot, the doctor and the pane."""


@dataclass
class Result:
    returncode: int
    stdout: str
    stderr: str


def ssh_env(base: Optional[dict[str, str]] = None) -> dict[str, str]:
    base = os.environ if base is None else base
    return {k: base[k] for k in _SSH_ENV_KEYS if base.get(k)}


def remote_sh(script: str) -> str:
    """Run ``script`` under /bin/sh on the remote whatever the user's login shell is (zsh would
    abort on an unmatched glob)."""
    return "/bin/sh -c " + shlex.quote(script)


def ssh_argv(cfg: RemoteCuaConfig, remote_command: str) -> list[str]:
    return [SSH, *SSH_OPTIONS, cfg.destination, remote_command]


def new_token() -> str:
    return "rc" + uuid.uuid4().hex[:12]


def socket_for(token: str) -> str:
    return f"{SOCKET_DIR}/hc-{token}.sock"


class SSHRunner:
    """Runs one remote /bin/sh script per call. ``run_fn`` is ``subprocess.run`` (tests pass a fake)."""

    def __init__(self, cfg: RemoteCuaConfig, *, run_fn: Callable[..., Any] = subprocess.run):
        self.cfg = cfg
        self._run = run_fn

    def run(self, script: str, *, timeout: float) -> Result:
        argv = ssh_argv(self.cfg, remote_sh(script))
        try:
            proc = self._run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
                             timeout=timeout, stdin=subprocess.DEVNULL, env=ssh_env(), check=False)
        except subprocess.TimeoutExpired as exc:
            raise RemoteError(f"{self.cfg.host} did not answer over SSH within {timeout:.0f} s") from exc
        except OSError as exc:
            raise RemoteError(f"could not run ssh: {exc}") from exc
        return Result(int(proc.returncode), proc.stdout or "", proc.stderr or "")


def ssh_failure(cfg: RemoteCuaConfig, result: Result) -> str:
    """Plain words for an ssh exit 255 (connection/auth), with the last stderr line."""
    tail = (result.stderr or "").strip().splitlines()
    detail = tail[-1][:200] if tail else "no error output"
    return f"could not reach {cfg.destination} over SSH ({detail})"


def _marks(stdout: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in stdout.splitlines():
        if line.startswith(MARK) and "=" in line:
            key, _, value = line[len(MARK):].partition("=")
            out.setdefault(key.strip(), value.strip())
    return out


def _between(stdout: str, begin: str, end: str) -> str:
    _, found, rest = stdout.partition(MARK + begin + "\n")
    return rest.partition(MARK + end)[0] if found else ""


def json_object(text: str) -> Optional[Any]:
    """First JSON object/array in ``text`` (drivers may print a warning line before it)."""
    text = (text or "").strip()
    starts = [i for i in (text.find("{"), text.find("[")) if i != -1]
    if not starts:
        return None
    try:
        return json.loads(text[min(starts):])
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# 1. Driver discovery
# ---------------------------------------------------------------------------

def discovery_script(driver: str, pin: str) -> str:
    want, pin_q = shlex.quote(driver), shlex.quote(pin)
    return f"""want={want}
pin={pin_q}
bin=""
if [ -n "$want" ]; then
  bin="$want"
else
  for cand in "$HOME"/.hermes/tools/cua-driver-"$pin"-darwin-*/cua-driver; do
    if [ -x "$cand" ]; then bin="$cand"; fi
  done
  if [ -z "$bin" ]; then bin=$(command -v cua-driver 2>/dev/null || true); fi
fi
echo "{MARK}me=$(id -un 2>/dev/null)"
echo "{MARK}console_user=$(stat -f %Su /dev/console 2>/dev/null)"
if [ -z "$bin" ] || [ ! -x "$bin" ]; then echo "{MARK}bin="; echo "{MARK}end=1"; exit 0; fi
echo "{MARK}bin=$bin"
app=""
case "$bin" in
  *.app/Contents/MacOS/*) app="${{bin%%.app/Contents/MacOS/*}}.app" ;;
esac
if [ -z "$app" ] && [ -d "$(dirname "$bin")/CuaDriver.app" ]; then app="$(dirname "$bin")/CuaDriver.app"; fi
echo "{MARK}app=$app"
if [ -n "$app" ]; then
  codesign -dv "$app" 2>&1 | grep -E '^(Identifier|TeamIdentifier)=' | sed 's/^/{MARK}sig_/'
fi
if "$bin" --help 2>&1 </dev/null | grep -q -- --no-overlay; then echo "{MARK}no_overlay=1"; else echo "{MARK}no_overlay=0"; fi
echo "{MARK}manifest-begin"
"$bin" manifest 2>/dev/null </dev/null
echo
echo "{MARK}manifest-end"
echo "{MARK}end=1"
"""


@dataclass
class DriverInfo:
    path: str = ""
    app: str = ""
    identifier: str = ""
    team: str = ""
    no_overlay: bool = False
    manifest: Optional[dict[str, Any]] = None
    me: str = ""
    console_user: str = ""

    @property
    def version(self) -> str:
        v = (self.manifest or {}).get("binary_version")
        return str(v).strip() if v else ""

    @property
    def mcp_args(self) -> list[str]:
        """The remote manifest's MCP args (default ``["mcp"]``). Its ``command`` is never used: the
        remote absolute path is run on the remote, and nothing from it is spawned locally."""
        inv = (self.manifest or {}).get("mcp_invocation")
        args = inv.get("args") if isinstance(inv, dict) else None
        return list(args) if isinstance(args, list) and args and all(isinstance(a, str) for a in args) else ["mcp"]

    @property
    def logged_in(self) -> Optional[bool]:
        if not self.console_user or not self.me:
            return None
        return self.console_user == self.me


def parse_discovery(stdout: str) -> DriverInfo:
    marks = _marks(stdout)
    manifest = json_object(_between(stdout, "manifest-begin", "manifest-end"))
    return DriverInfo(path=marks.get("bin", ""), app=marks.get("app", ""), identifier=marks.get("sig_Identifier", ""),
                      team=marks.get("sig_TeamIdentifier", ""), no_overlay=marks.get("no_overlay") == "1",
                      manifest=manifest if isinstance(manifest, dict) else None, me=marks.get("me", ""),
                      console_user=marks.get("console_user", ""))


def discover(cfg: RemoteCuaConfig, runner: SSHRunner, pin: str) -> DriverInfo:
    result = runner.run(discovery_script(cfg.driver, pin), timeout=30.0)
    if result.returncode == 255 or MARK + "end=1" not in result.stdout:
        raise RemoteError(ssh_failure(cfg, result))
    return parse_discovery(result.stdout)


@dataclass
class DriverPolicy:
    """What the driver must satisfy. ``contract_reason`` is Hermes's own 0.20-contract check."""
    pin: str
    contract_reason: Callable[[Optional[dict[str, Any]]], str]
    bundle_id: str = "com.trycua.driver"
    team_ids: tuple[str, ...] = ()


def driver_problems(cfg: RemoteCuaConfig, info: DriverInfo, policy: DriverPolicy) -> list[str]:
    """Why this driver cannot be used, in plain words; empty when it can."""
    host = cfg.host
    if not info.path:
        where = (f"remote_cua.driver ({cfg.driver}) is not an executable" if cfg.driver else
                 f"no cua-driver {policy.pin} under ~/.hermes/tools and none on the PATH")
        return [f"cua-driver not found on {host}: {where}. Install the pinned driver there "
                f"(`hermes computer-use install` on that Mac) or set remote_cua.driver."]
    problems = []
    reason = policy.contract_reason(info.manifest)
    if reason:
        problems.append(f"cua-driver on {host} ({info.path}) is not usable: {reason}")
    elif info.version != policy.pin:
        problems.append(f"cua-driver on {host} is {info.version}, but this gateway's Hermes pins {policy.pin}. "
                        f"Install cua-driver {policy.pin} on {host} or point remote_cua.driver at it.")
    if not info.app:
        problems.append(f"CuaDriver.app not found next to {info.path} on {host}; the private daemon must start "
                        "through the app that carries the driver (its macOS permissions are attached to it)")
    elif info.identifier != policy.bundle_id:
        problems.append(f"{info.app} on {host} is not the signed CuaDriver.app "
                        f"(identifier {info.identifier or 'missing'}, expected {policy.bundle_id})")
    elif policy.team_ids and info.team not in policy.team_ids:
        problems.append(f"{info.app} on {host} is signed by team {info.team or 'none'}, "
                        f"expected one of {', '.join(policy.team_ids)}")
    return problems


# ---------------------------------------------------------------------------
# 2-4. Private daemon commands
# ---------------------------------------------------------------------------

def serve_command(info: DriverInfo, sock: str) -> str:
    args = ["serve", "--embedded", "--socket", sock, "--no-permissions-gate", "--permission-mode", "standard"]
    if info.no_overlay:
        args.append("--no-overlay")
    return " ".join([TELEMETRY_ENV, OPEN, "-n", "-g", "-a", shlex.quote(info.app), "--args",
                     *(shlex.quote(a) for a in args)])


def stop_command(binary: str, sock: str) -> str:
    return (f"{shlex.quote(binary)} stop --socket {shlex.quote(sock)} >/dev/null 2>&1 </dev/null; "
            f"rm -f {shlex.quote(sock)}")


def start_script(info: DriverInfo, sock: str, stale: list[tuple[str, str]] = ()) -> str:
    """Stop stale daemons this profile recorded, start ours, poll until its socket answers."""
    lines = [stop_command(b, s) for b, s in stale]
    status = f"{shlex.quote(info.path)} status --socket {shlex.quote(sock)} >/dev/null 2>&1 </dev/null"
    lines += [
        serve_command(info, sock),
        "rc=$?",
        f'if [ "$rc" -ne 0 ]; then echo "{MARK}open_failed=$rc"; exit 0; fi',
        "i=0",
        f"while [ $i -lt {START_POLL_STEPS} ]; do",
        f'  if {status}; then echo "{MARK}ready=1"; exit 0; fi',
        "  sleep 0.1",
        "  i=$((i+1))",
        "done",
        f'echo "{MARK}ready=0"',
    ]
    return "\n".join(lines) + "\n"


def mcp_remote_command(info: DriverInfo, sock: str) -> str:
    args = [*info.mcp_args]
    if info.no_overlay and "--no-overlay" not in args:
        args.append("--no-overlay")
    args += ["--embedded", "--socket", sock]
    return remote_sh(" ".join([TELEMETRY_ENV, "exec", shlex.quote(info.path), *(shlex.quote(a) for a in args)]))


def call_remote_command(binary: str, sock: str, tool: str, args: dict[str, Any]) -> str:
    """``cua-driver call`` against the private daemon (CLI fallback transport, status probes)."""
    return " ".join([TELEMETRY_ENV, shlex.quote(binary), "call", shlex.quote(tool), shlex.quote(json.dumps(args)),
                     "--socket", shlex.quote(sock), "</dev/null"])


# ---------------------------------------------------------------------------
# Registry of daemons this profile started (for the stale sweep)
# ---------------------------------------------------------------------------

_registry_lock = threading.Lock()


def _registry_path(home: Path) -> Path:
    return Path(home) / "remote-cua" / REGISTRY_FILE


def _read_registry(home: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(_registry_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def _write_registry(home: Path, entries: list[dict[str, Any]]) -> None:
    path = _registry_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".daemons-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(entries, fh)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except (OSError, TypeError, ValueError):
        return False
    return True


def take_stale(home: Path, destination: str, *, alive: Callable[[Any], bool] = _pid_alive) -> list[tuple[str, str]]:
    """``(bin, socket)`` of daemons this profile started on ``destination`` from a gateway process that is
    gone; they are removed from the registry (the start script stops them). A live owner is never touched."""
    with _registry_lock:
        entries = _read_registry(home)
        stale = [e for e in entries if e.get("destination") == destination and not alive(e.get("pid"))]
        if stale:
            _write_registry(home, [e for e in entries if e not in stale])
    return [(str(e.get("bin") or ""), str(e.get("socket") or "")) for e in stale if e.get("bin") and e.get("socket")]


def record(home: Path, destination: str, binary: str, sock: str) -> None:
    with _registry_lock:
        entries = [e for e in _read_registry(home) if e.get("socket") != sock or e.get("destination") != destination]
        entries.append({"destination": destination, "bin": binary, "socket": sock, "pid": os.getpid(),
                        "started": time.time()})
        _write_registry(home, entries)


def forget(home: Path, destination: str, sock: str) -> None:
    with _registry_lock:
        entries = _read_registry(home)
        kept = [e for e in entries if not (e.get("socket") == sock and e.get("destination") == destination)]
        if kept != entries:
            _write_registry(home, kept)


# ---------------------------------------------------------------------------
# The daemon stand-in Hermes's _CuaDriverSession drives
# ---------------------------------------------------------------------------

class RemoteDaemon:
    """The remote counterpart of Hermes's ``_EmbeddedCuaDaemon``: same ``start/stop/proxy_invocation/
    child_env/socket_path`` surface, so Hermes's MCP session and backend run unchanged on top of it."""

    def __init__(self, cfg: RemoteCuaConfig, policy: DriverPolicy, *, home: Path,
                 runner: Optional[SSHRunner] = None, token: Optional[str] = None):
        self.cfg, self.policy, self.home = cfg, policy, Path(home)
        self.runner = runner or SSHRunner(cfg)
        self.permission_mode = "standard"
        self.token = token or new_token()
        self.socket_path = socket_for(self.token)
        self.info: Optional[DriverInfo] = None
        self._running = False
        self._atexit = False
        self._lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self._running

    @property
    def no_overlay(self) -> bool:
        return bool(self.info and self.info.no_overlay)

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            info = discover(self.cfg, self.runner, self.policy.pin)
            problems = driver_problems(self.cfg, info, self.policy)
            if problems:
                raise RemoteError("; ".join(problems))
            stale = take_stale(self.home, self.cfg.destination)
            result = self.runner.run(start_script(info, self.socket_path, stale), timeout=60.0)
            marks = _marks(result.stdout)
            if result.returncode == 255 and not marks:
                raise RemoteError(ssh_failure(self.cfg, result))
            self.info = info
            if marks.get("ready") != "1":
                why = (f"open exited {marks['open_failed']}" if "open_failed" in marks else
                       "its socket did not answer within 15 s")
                self._stop_remote()  # nothing left half-started
                raise RemoteError(f"the cua-driver daemon on {self.cfg.host} did not start ({why}). "
                                  "Is the user logged in at the Mac's screen?")
            self._running = True
            record(self.home, self.cfg.destination, info.path, self.socket_path)
            if not self._atexit:
                atexit.register(self.stop)
                self._atexit = True

    def proxy_invocation(self) -> tuple[str, list[str]]:
        if not self._running or self.info is None:
            raise RuntimeError("remote cua-driver daemon is not running")
        return SSH, [*SSH_OPTIONS, self.cfg.destination, mcp_remote_command(self.info, self.socket_path)]

    def child_env(self) -> dict[str, str]:
        return ssh_env()

    def call(self, tool: str, args: dict[str, Any], *, timeout: float) -> Any:
        """``cua-driver call`` over a fresh SSH session; returns the parsed JSON or raises."""
        if not self._running or self.info is None:
            raise RuntimeError("remote cua-driver daemon is not running")
        result = self.runner.run(call_remote_command(self.info.path, self.socket_path, tool, args),
                                 timeout=max(15.0, timeout))
        if result.returncode == 255:
            raise RemoteError(ssh_failure(self.cfg, result))
        parsed = json_object(result.stdout)
        if parsed is None:
            tail = (result.stdout or result.stderr).strip()[-200:]
            raise RemoteError(f"cua-driver call {tool} on {self.cfg.host} returned no JSON: {tail}")
        return parsed

    def _stop_remote(self) -> None:
        if self.info is None:
            return
        with contextlib.suppress(Exception):
            self.runner.run(stop_command(self.info.path, self.socket_path), timeout=15.0)

    def stop(self) -> None:
        with self._lock:
            was_running, self._running = self._running, False
            if not was_running:
                return
            self._stop_remote()
            with contextlib.suppress(Exception):
                forget(self.home, self.cfg.destination, self.socket_path)
