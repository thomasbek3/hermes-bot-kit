"""Standalone launcher for the remote-cua check, for when ``hermes remote-cua check`` is not available:

    ~/.hermes/hermes-agent/venv/bin/python ~/.hermes/plugins/remote-cua/check.py [profile] [--json]

Hermes executes every module of a plugin directory when it loads the plugin, so this file does
nothing on import; it only acts when run as a script.
"""
from __future__ import annotations


def _load_package():
    import importlib.util
    import sys
    from pathlib import Path

    here = Path(__file__).resolve().parent
    name = "remote_cua_kit_check"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, here / "__init__.py", submodule_search_locations=[str(here)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


if __name__ == "__main__":
    import importlib
    import sys

    _load_package()
    sys.exit(importlib.import_module("remote_cua_kit_check.cli").main())
