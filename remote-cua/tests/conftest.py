"""Shared fixtures. No network: every ssh call goes to FakeSSH.

Run with Hermes's venv so the real Hermes internals are used:
    ~/.hermes/hermes-agent/venv/bin/python -m pytest -p no:cacheprovider remote-cua/tests
"""
from __future__ import annotations

import importlib
import importlib.util
import os
import sys
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
HERMES_SRC = Path(os.environ.get("HERMES_AGENT_DIR", Path.home() / ".hermes" / "hermes-agent"))
if (HERMES_SRC / "hermes_cli").is_dir() and str(HERMES_SRC) not in sys.path:
    sys.path.insert(0, str(HERMES_SRC))

PKG = "remote_cua_under_test"


def load_pkg():
    if PKG not in sys.modules:
        spec = importlib.util.spec_from_file_location(PKG, PLUGIN_DIR / "__init__.py",
                                                      submodule_search_locations=[str(PLUGIN_DIR)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[PKG] = mod
        spec.loader.exec_module(mod)
    return sys.modules[PKG]


def mod(name: str):
    load_pkg()
    return importlib.import_module(f"{PKG}.{name}")


def hermes_available() -> bool:
    try:
        import hermes_cli  # noqa: F401
        import tools.computer_use.cua_backend  # noqa: F401
    except Exception:
        return False
    return True


needs_hermes = pytest.mark.skipif(not hermes_available(), reason="needs a Hermes checkout (HERMES_AGENT_DIR)")

MANIFEST_OK = ('{"binary_version":"0.21.0","mcp_invocation":{"command":"/x/cua-driver","args":["mcp"]},'
               '"subcommands":[{"name":"mcp","args":[{"name":"--socket"},{"name":"--grant"}]},'
               '{"name":"serve","args":[{"name":"--socket"},{"name":"--permission-mode"},'
               '{"name":"--capability-manifest"},{"name":"--approve-capability-manifest"},{"name":"--embedded"}]},'
               '{"name":"stop","args":[{"name":"--socket"}]}]}')
REMOTE_BIN = "/Users/you/.hermes/tools/cua-driver-0.21.0-darwin-arm64/cua-driver"
REMOTE_APP = "/Users/you/.hermes/tools/cua-driver-0.21.0-darwin-arm64/CuaDriver.app"


def discovery_stdout(*, bin_path: str = REMOTE_BIN, app: str = REMOTE_APP, ident: str = "com.trycua.driver",
                     team: str = "YCK386LBJ7", manifest: str = MANIFEST_OK, no_overlay: bool = True,
                     me: str = "you", console: str = "you") -> str:
    lines = [f"RCUA:me={me}", f"RCUA:console_user={console}", f"RCUA:bin={bin_path}"]
    if bin_path:
        lines += [f"RCUA:app={app}"]
        if app:
            lines += [f"RCUA:sig_Identifier={ident}", f"RCUA:sig_TeamIdentifier={team}"]
        lines += [f"RCUA:no_overlay={1 if no_overlay else 0}", "RCUA:manifest-begin", manifest, "", "RCUA:manifest-end"]
    lines.append("RCUA:end=1")
    return "\n".join(lines) + "\n"


class FakeProc:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


class FakeSSH:
    """Stands in for subprocess.run. ``responder(script) -> FakeProc`` answers each remote script."""

    def __init__(self, responder: Optional[Callable[[str], FakeProc]] = None):
        self.calls: list[dict[str, Any]] = []
        self.responder = responder or self.default

    @staticmethod
    def default(script: str) -> FakeProc:
        import re
        if "manifest-begin" in script:
            return FakeProc(0, discovery_stdout())
        if "--args serve" in script:  # start script (its HUP trap also names a stop)
            return FakeProc(0, "RCUA:ready=1\n")
        marks = re.findall(r'echo "RCUA:(\w+)=1"', script)
        if marks:  # stop / sweep scripts: every daemon confirmed gone
            return FakeProc(0, "".join(f"RCUA:{m}=1\n" for m in marks))
        if " call check_permissions " in script:
            return FakeProc(0, '{"accessibility": true, "screen_recording": true}')
        if " call list_windows " in script:
            return FakeProc(0, '{"windows": [{"pid": 1}, {"pid": 2}]}')
        if " call " in script:
            return FakeProc(0, '{"ok": true}')
        return FakeProc(0, "")

    def __call__(self, argv, **kwargs):
        import shlex
        remote = argv[-1]
        assert remote.startswith("/bin/sh -c "), remote
        script = shlex.split(remote[len("/bin/sh -c "):])[0]
        self.calls.append({"argv": list(argv), "script": script, "kwargs": kwargs})
        return self.responder(script)

    def scripts(self) -> list[str]:
        return [c["script"] for c in self.calls]


@pytest.fixture(autouse=True)
def _no_real_atexit(monkeypatch):
    """A test's fake daemon must never be 'stopped' again by the real interpreter exit."""
    from types import SimpleNamespace
    # Only remote-cua's own reference: the real atexit module stays untouched for pytest itself.
    monkeypatch.setattr(mod("remote"), "atexit", SimpleNamespace(register=lambda *a, **k: None))


@pytest.fixture
def home(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    root.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(root))
    return root


def write_config(home: Path, text: str) -> None:
    (home / "config.yaml").write_text(text, encoding="utf-8")


MAC_CONFIG = """computer_use:
  backend: remote-cua
remote_cua:
  host: 100.64.0.10
  user: you
  os: macos
"""
WINDOWS_CONFIG = MAC_CONFIG.replace("os: macos", "os: windows")
