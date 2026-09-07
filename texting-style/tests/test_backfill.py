"""Tests for the texting-style backfill hook and its session-title cache."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _load_plugin():
    spec = importlib.util.spec_from_file_location(
        "texting_style_plugin", PLUGIN_DIR / "__init__.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["texting_style_plugin"] = mod
    spec.loader.exec_module(mod)
    return mod


plugin = _load_plugin()


class FakeCursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class FakeConn:
    """Answers `SELECT <column> FROM sessions WHERE id = ?` from a dict."""

    def __init__(self, values):
        self._values = values
        self.closed = False

    def execute(self, sql, params):
        column = sql.split("SELECT ", 1)[1].split(" FROM", 1)[0].strip()
        if column not in self._values:
            return FakeCursor(None)
        return FakeCursor((self._values[column],))

    def close(self):
        self.closed = True


class FakeCtx:
    def __init__(self, config=None):
        self.config = config or {}
        self.hooks = {}
        self.section = None

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_system_prompt_section(self, name, fn, **kwargs):
        self.section = fn

    def register_hook(self, name, fn):
        self.hooks[name] = fn


class BackfillTests(unittest.TestCase):
    def setUp(self):
        plugin._db_for_session.clear()
        self._retry = getattr(plugin, "LOOKUP_RETRY_SECONDS", 30.0)
        self.ctx = FakeCtx()
        plugin.register(self.ctx)
        self.backfill = self.ctx.hooks["pre_llm_call"]
        patcher = patch.object(
            plugin, "_candidate_dbs", return_value=[Path("/nonexistent/state.db")]
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        plugin.LOOKUP_RETRY_SECONDS = self._retry
        plugin._db_for_session.clear()

    def _connect(self, values):
        return lambda *a, **k: FakeConn(values)

    def _raise(self, *a, **k):
        raise plugin.sqlite3.OperationalError("database is locked")

    def test_transient_failure_is_not_cached_forever(self):
        plugin.LOOKUP_RETRY_SECONDS = 0.0
        with patch.object(plugin.sqlite3, "connect", side_effect=self._raise):
            self.assertIsNone(self.backfill(session_id="s1"))
        with patch.object(
            plugin.sqlite3,
            "connect",
            side_effect=self._connect({"title": "Bot Chat", "system_prompt": ""}),
        ):
            result = self.backfill(session_id="s1")
        self.assertIsInstance(result, dict)
        self.assertIn("## Texting register", result["context"])

    def test_failure_is_negatively_cached_for_the_retry_window(self):
        calls = []

        def raising(*a, **k):
            calls.append(1)
            raise plugin.sqlite3.OperationalError("database is locked")

        with patch.object(plugin.sqlite3, "connect", side_effect=raising):
            self.assertIsNone(self.backfill(session_id="s2"))
            self.assertIsNone(self.backfill(session_id="s2"))
        self.assertEqual(len(calls), 1)

    def test_confirmed_empty_title_stays_cached(self):
        with patch.object(
            plugin.sqlite3, "connect", side_effect=self._connect({"title": ""})
        ):
            self.assertIsNone(self.backfill(session_id="s3"))
        # Even a later Bot Chat title does not re-open the question: the first
        # answer was confirmed, so no second lookup happens.
        with patch.object(
            plugin.sqlite3, "connect", side_effect=self._raise
        ) as never_used:
            self.assertIsNone(self.backfill(session_id="s3"))
            self.assertEqual(never_used.call_count, 0)

    def test_session_title_distinguishes_failure_from_empty(self):
        with patch.object(plugin.sqlite3, "connect", side_effect=self._raise):
            self.assertIsNone(plugin._session_title("", "s4"))
        with patch.object(
            plugin.sqlite3, "connect", side_effect=self._connect({"title": None})
        ):
            self.assertEqual(plugin._session_title("", "s4"), "")

    def test_section_stays_empty_when_lookup_fails(self):
        with patch.object(plugin.sqlite3, "connect", side_effect=self._raise):
            self.assertEqual(self.ctx.section({"session_id": "s5"}), "")

    def test_backfill_skips_when_prompt_already_has_doctrine(self):
        with patch.object(
            plugin.sqlite3,
            "connect",
            side_effect=self._connect(
                {"title": "Bot Chat", "system_prompt": plugin.DOCTRINE}
            ),
        ):
            self.assertIsNone(self.backfill(session_id="s6"))

    def test_backfill_skips_history_that_already_carries_doctrine(self):
        history = [{"role": "system", "content": plugin.DOCTRINE}]
        with patch.object(
            plugin.sqlite3,
            "connect",
            side_effect=self._connect({"title": "Bot Chat", "system_prompt": ""}),
        ):
            self.assertIsNone(
                self.backfill(session_id="s7", conversation_history=history)
            )


if __name__ == "__main__":
    unittest.main()
