"""Opt-in live check against a real Mac. Skipped unless REMOTE_CUA_LIVE_HOST is set.

    REMOTE_CUA_LIVE_HOST=100.64.0.10 REMOTE_CUA_LIVE_USER=you \
      ~/.hermes/hermes-agent/venv/bin/python -m pytest -p no:cacheprovider remote-cua/tests/test_live.py

Read-only: discovery, then a short-lived private daemon that answers check_permissions (prompt: false)
and list_windows, then is stopped. No input actions.
"""
from __future__ import annotations

import os

import pytest

from conftest import mod, needs_hermes

pytestmark = [needs_hermes, pytest.mark.skipif(not os.environ.get("REMOTE_CUA_LIVE_HOST"),
                                               reason="set REMOTE_CUA_LIVE_HOST to run the live check")]


def test_live_status():
    settings, status = mod("settings"), mod("status")
    cfg = settings.parse({"host": os.environ["REMOTE_CUA_LIVE_HOST"],
                          "user": os.environ.get("REMOTE_CUA_LIVE_USER") or os.environ.get("USER", ""),
                          "driver": os.environ.get("REMOTE_CUA_LIVE_DRIVER", "")})
    result = status.run_status(cfg)
    assert result["reachable"] is True, result
    assert result["driver"]["ok"], result
    assert result["permissions"]["ok"] is True, result
