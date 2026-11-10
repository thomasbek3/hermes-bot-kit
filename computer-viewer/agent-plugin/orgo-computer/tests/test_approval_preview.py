"""The approval message shows the argument faithfully: control characters
escaped, up to 2000 characters, and an explicit marker when there is more."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_hands import PIN, tools  # noqa: E402  (loads the plugin modules)


class ApprovalPreviewTests(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)
        os.environ["ORGO_COMPUTER_ID"] = PIN

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def message(self, tool, args):
        hook = tools.pre_tool_call(tool, args)
        self.assertEqual(hook["action"], "approve")
        return hook["message"]

    def test_control_characters_are_escaped(self):
        msg = self.message("orgo_computer_bash", {"command": "echo MARKER #\recho hello\n\tls\x1b[2K\u202eexe.txt\x00"})
        self.assertIn("echo MARKER #\\recho hello\\n\\tls\\x1b[2K\\u202eexe.txt\\0", msg)
        for raw in ("\r", "\n", "\t", "\x1b", "\u202e", "\x00"):
            self.assertNotIn(raw, msg, repr(raw))

    def test_long_bash_shows_2000_and_says_how_much_more(self):
        command = "echo hello" + " " * 2500 + "; echo MARKER"
        msg = self.message("orgo_computer_bash", {"command": command})
        total = len(command)
        self.assertIn(command[:2000], msg)
        self.assertNotIn("MARKER", msg)
        self.assertIn(f"\u2026 [+{total - 2000} more characters, {total} total]", msg)

    def test_short_bash_shown_whole_without_marker(self):
        command = "echo hello" + " " * 250 + "; echo MARKER"
        msg = self.message("orgo_computer_bash", {"command": command})
        self.assertIn("; echo MARKER", msg, "a 200+ character command is no longer cut at 200")
        self.assertNotIn("more characters", msg)

    def test_type_and_run_use_the_same_rendering(self):
        text = "a" * 1999 + "\rB" + "c" * 100
        msg = self.message("orgo_computer_type", {"text": text})
        self.assertIn("a" * 1999 + "\\r", msg)
        self.assertIn(f"[+{len(text) - 2000} more characters, {len(text)} total]", msg)
        task = "open the site\nthen " + "x" * 3000
        msg = self.message("orgo_computer_run", {"task": task})
        self.assertIn("open the site\\nthen ", msg)
        self.assertIn(f"[+{len(task) - 2000} more characters, {len(task)} total]", msg)

    def test_click_preview_names_button_and_double(self):
        self.assertIn("10,20 button=right double", self.message("orgo_computer_click", {"x": 10, "y": 20, "button": "right", "double": True}))
        self.assertIn("1,2 button=left.", self.message("orgo_computer_click", {"x": 1, "y": 2}))

    def test_key_is_escaped_too(self):
        msg = self.message("orgo_computer_key", {"key": "Return\rctrl+alt+Delete"})
        self.assertIn("Return\\rctrl+alt+Delete", msg)


if __name__ == "__main__":
    unittest.main()
