"""Lease file, take/release rules, and the pre_tool_call refusal."""
from __future__ import annotations

import json

import pytest

from conftest import MAC_CONFIG, mod, write_config

lease = mod("lease")


def test_missing_file_means_agent(home):
    current = lease.read(home)
    assert current.holder == lease.AGENT and current.viewer is None and current.epoch == 0


def test_take_writes_contract_shape_atomically(home):
    taken = lease.take("pane-1", home, now=1000.0)
    data = json.loads((home / "remote-cua" / "lease.json").read_text())
    assert data == {"holder": "human", "viewer": "pane-1", "since": 1000.0, "epoch": 1}
    assert taken.to_dict() == data
    assert not list((home / "remote-cua").glob(".lease-*.tmp"))


def test_take_is_idempotent_for_the_same_viewer_and_refuses_another(home):
    lease.take("pane-1", home)
    assert lease.take("pane-1", home).epoch == 1
    with pytest.raises(lease.LeaseConflict) as exc:
        lease.take("pane-2", home)
    assert exc.value.code == "held_by_other_viewer" and exc.value.lease.viewer == "pane-1"


def test_release_rules(home):
    assert lease.release("pane-1", home).holder == lease.AGENT  # already agent: no-op
    lease.take("pane-1", home)
    with pytest.raises(lease.LeaseConflict) as exc:
        lease.release("pane-2", home)
    assert exc.value.code == "not_holder"
    back = lease.release("pane-1", home)
    assert back.holder == lease.AGENT and back.viewer is None and back.epoch == 2


def test_force_release_clears_a_stuck_lease(home):
    lease.take("pane-1", home)
    assert lease.release(None, home, force=True).holder == lease.AGENT


def test_corrupt_file_reads_as_agent(home):
    (home / "remote-cua").mkdir()
    (home / "remote-cua" / "lease.json").write_text("{nope")
    assert lease.read(home).holder == lease.AGENT


def test_bad_viewer_rejected(home):
    with pytest.raises(ValueError):
        lease.take("-rf /", home)


def test_pre_tool_call_refuses_computer_use_while_human_holds(home):
    write_config(home, MAC_CONFIG)
    assert lease.pre_tool_call(tool_name="computer_use", args={"action": "capture"}) is None
    lease.take("pane-1", home)
    out = lease.pre_tool_call(tool_name="computer_use", args={"action": "capture"})
    assert out["action"] == "block" and out["message"].startswith("human_has_control")
    assert lease.pre_tool_call(tool_name="terminal", args={}) is None
    assert lease.pre_tool_call(tool_name="browser_navigate", args={}) is None  # the browser never runs on the Mac
    lease.release("pane-1", home)
    assert lease.pre_tool_call(tool_name="computer_use", args={}) is None


def test_pre_tool_call_ignores_a_profile_that_no_longer_uses_remote_cua(home, monkeypatch):
    settings = mod("settings")
    monkeypatch.setattr(settings, "load_profile_config", lambda: {"computer_use": {"backend": "cua"}})
    lease.take("pane-1", home)
    assert lease.pre_tool_call(tool_name="computer_use", args={}) is None
