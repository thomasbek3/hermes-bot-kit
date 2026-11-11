"""email-drafts: the Composio sender, against a fake ``composio`` executable.

The fake stands in for the CLI: it records its argv, stdin and environment and
answers from a scenario file. No real CLI runs and no email is sent.

    python3 -m unittest discover -s email-drafts/tests -p 'test_*.py'
"""

from __future__ import annotations

import importlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_email_drafts import FROM, LEE, SAM, Rig, engine_mod, plugin, senders, store_mod  # noqa: E402

composio = importlib.import_module("email_drafts_plugin.composio_sender")
PLUGIN_DIR = Path(__file__).resolve().parents[1]

FAKE_CLI = textwrap.dedent('''\
    #!{python}
    """A fake composio CLI: records the call, answers from scenario.json."""
    import json, os, sys, time
    here = os.path.dirname(os.path.abspath(__file__))
    argv = sys.argv[1:]
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = raw
    tool = argv[1] if len(argv) > 1 else ""
    with open(os.path.join(here, "calls.jsonl"), "a") as log:
        log.write(json.dumps({{"argv": sys.argv, "payload": payload, "pid": os.getpid(), "env": dict(os.environ)}}) + "\\n")
    with open(os.path.join(here, "scenario.json")) as handle:
        scenario = json.load(handle)
    answer = scenario.get(tool) or scenario.get("*") or {{}}
    if answer.get("sleep"):
        time.sleep(answer["sleep"])
    if "stdout" in answer:
        out = answer["stdout"]
        sys.stdout.write(out if isinstance(out, str) else json.dumps(out, indent=2))
    sys.stderr.write(answer.get("stderr", ""))
    sys.exit(answer.get("code", 0))
''')


def ok(data):
    return {"stdout": {"successful": True, "data": data, "error": None, "logId": "log_1"}}


def refused(error, code=1):
    return {"stdout": {"successful": False, "data": {}, "error": error, "logId": "log_2"}, "code": code}


PROFILE_OK = ok({"emailAddress": FROM, "messagesTotal": 3, "threadsTotal": 2, "historyId": "9"})
SEND_OK = ok({"id": "gm-42", "threadId": "th-42", "labelIds": ["SENT"]})


@unittest.skipIf(os.name == "nt", "the fake CLI is a POSIX script")
class ComposioBase(unittest.TestCase):
    def setUp(self):
        self.rig = Rig({"sender": "composio"})
        self.addCleanup(self.rig.close)
        self.bin = Path(self.rig.tmp.name) / "bin"
        self.bin.mkdir()
        self.cli = self.bin / "composio"
        self.cli.write_text(FAKE_CLI.format(python=sys.executable))
        self.cli.chmod(self.cli.stat().st_mode | stat.S_IXUSR)
        self.rig.settings["composio_cli"] = str(self.cli)
        self.scenario({"GMAIL_GET_PROFILE": PROFILE_OK, "GMAIL_SEND_EMAIL": SEND_OK, "GMAIL_REPLY_TO_THREAD": SEND_OK})
        # A real engine with the real deliver(): only the CLI is fake.
        self.engine = engine_mod.Engine(
            self.rig.engine.store, lambda: self.rig.settings, lambda: str(self.rig.workspace), lambda: None,
        )
        self.secret = lambda name: ""

    def scenario(self, answers):
        (self.bin / "scenario.json").write_text(json.dumps(answers))

    def calls(self):
        log = self.bin / "calls.jsonl"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]

    def tools(self):
        return [call["argv"][2] for call in self.calls()]

    def draft(self, **extra):
        args = {"to": [SAM], "subject": "Price sheet", "body": "Hi Sam,\n\nHere it is."}
        args.update(extra)
        return self.engine.store.load(self.engine.create(args)["email_draft"]["id"])

    def send_direct(self, draft=None, settings=None, attachments=None):
        draft = draft or self.draft()
        return composio.send_composio(draft, settings or self.engine.settings(), attachments or [], secret=self.secret)


class Success(ComposioBase):
    def test_default_sender_is_composio(self):
        self.assertEqual(engine_mod.SETTINGS_DEFAULTS["sender"], "composio")
        self.assertEqual(senders.DEFAULT_SENDER, "composio")
        manifest = (PLUGIN_DIR / "plugin.yaml").read_text()
        self.assertIn("choices: [composio, gmail, smtp]\n    default: composio", manifest)
        # A bot with no sender configured goes through Composio.
        seen = []
        with mock.patch.object(composio, "send_composio", lambda d, s, a: seen.append(s.get("sender")) or {"backend": "composio"}):
            senders.deliver({"to": [SAM]}, {"from_address": FROM}, [])
        self.assertEqual(seen, [None])

    def test_card_send_goes_through_the_cli(self):
        draft = self.draft(cc=[LEE], bcc=["b@example.net"])
        out = self.engine.send({"id": draft["id"]}, surface="rpc")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["draft"]["status"], "sent")
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE", "GMAIL_SEND_EMAIL"])
        profile, send = self.calls()
        self.assertEqual(profile["argv"][1:], ["execute", "GMAIL_GET_PROFILE", "-d", "-"])
        self.assertEqual(profile["payload"], {"user_id": "me"})
        self.assertEqual(send["argv"][1:], ["execute", "GMAIL_SEND_EMAIL", "-d", "-"])
        payload = send["payload"]
        self.assertEqual(payload["recipient_email"], SAM)
        self.assertEqual(payload["extra_recipients"], [])
        self.assertEqual(payload["cc"], [LEE])
        self.assertEqual(payload["bcc"], ["b@example.net"])
        self.assertEqual(payload["subject"], "Price sheet")
        self.assertEqual(payload["from_email"], FROM)
        self.assertEqual(payload["body"], "Hi Sam,\n\nHere it is.\n\nMe\nexample.com\n")
        self.assertIs(payload["is_html"], False)
        self.assertIs(payload["include_signature"], False)
        self.assertNotIn("attachment", payload)
        receipt = self.engine.store.load(draft["id"])["receipt"]
        self.assertEqual(receipt["backend"], "composio")
        self.assertEqual(receipt["tool"], "GMAIL_SEND_EMAIL")
        self.assertEqual((receipt["gmail_id"], receipt["thread_id"]), ("gm-42", "th-42"))
        last = self.engine.store.audit_lines()[-1]
        self.assertEqual((last["event"], last["actor"], last["backend"]), ("sent", "human", "composio"))

    def test_several_to_addresses(self):
        draft = self.draft(to=[SAM, LEE, "c@example.net"])
        self.send_direct(draft)
        payload = self.calls()[-1]["payload"]
        self.assertEqual(payload["recipient_email"], SAM)
        self.assertEqual(payload["extra_recipients"], [LEE, "c@example.net"])

    def test_reply_threads_with_reply_to_thread(self):
        draft = self.draft(in_reply_to={"message_id": "<orig@example.com>", "subject": "Prices", "thread_id": "18c2f0a1b2c3d4e5"})
        receipt = self.send_direct(draft)
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE", "GMAIL_REPLY_TO_THREAD"])
        payload = self.calls()[-1]["payload"]
        self.assertEqual(payload["thread_id"], "18c2f0a1b2c3d4e5")
        self.assertTrue(payload["message_body"].startswith("Hi Sam,"))
        self.assertNotIn("subject", payload)
        self.assertNotIn("body", payload)
        self.assertEqual(receipt["tool"], "GMAIL_REPLY_TO_THREAD")

    def test_cli_found_on_path_when_not_configured(self):
        self.rig.settings["composio_cli"] = ""
        with mock.patch.dict(os.environ, {"PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}"}):
            self.send_direct()
        self.assertEqual(self.calls()[0]["argv"][0], str(self.cli))


class Attachments(ComposioBase):
    def test_attachments_are_local_paths_the_cli_uploads(self):
        draft = self.draft(attachments=["price-sheet.csv"])
        out = self.engine.send({"id": draft["id"]}, surface="rpc")
        self.assertTrue(out["ok"], out)
        payload = self.calls()[-1]["payload"]
        self.assertEqual(payload["attachment"], [os.path.realpath(self.rig.workspace / "price-sheet.csv")])

    def test_attachments_over_composio_limit_are_refused_before_any_call(self):
        big = [{"path": str(self.rig.workspace / "price-sheet.csv"), "name": "x.bin", "size": 21 * 1024 * 1024}]
        with self.assertRaises(senders.SendError) as caught:
            self.send_direct(attachments=big)
        self.assertIn("20 MB", str(caught.exception))
        self.assertEqual(self.calls(), [])

    def test_attachment_path_escape_still_rejected(self):
        with self.assertRaises(store_mod.DraftError):
            self.draft(attachments=[str(self.rig.outside / "secret.txt")])
        self.assertEqual(self.calls(), [])


class AccountSelection(ComposioBase):
    def test_account_is_passed_to_every_call(self):
        self.rig.settings["composio_account"] = "work"
        self.send_direct()
        for call in self.calls():
            self.assertEqual(call["argv"][3:5], ["--account", "work"])
            self.assertEqual(call["argv"][-2:], ["-d", "-"])

    def test_empty_account_uses_the_cli_default(self):
        self.send_direct()
        self.assertTrue(all("--account" not in call["argv"] for call in self.calls()))

    def test_bad_account_values_never_reach_the_cli(self):
        for bad in ("--skip-checks", "work; rm -rf /", "a b", "x" * 200):
            self.rig.settings["composio_account"] = bad
            with self.assertRaises(senders.SendError):
                self.send_direct()
        self.assertEqual(self.calls(), [])

    def test_from_must_match_the_account_and_nothing_is_sent_otherwise(self):
        self.scenario({"GMAIL_GET_PROFILE": ok({"emailAddress": "other@example.org"}), "GMAIL_SEND_EMAIL": SEND_OK})
        draft = self.draft()
        out = self.engine.send({"id": draft["id"]}, surface="rpc")
        self.assertFalse(out["ok"])
        self.assertIn("other@example.org", out["error"])
        self.assertIn(FROM, out["error"])
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE"])
        self.assertFalse(out["draft"]["delivery_unknown"])  # Retry stays possible

    def test_profile_reply_wrapped_in_response_data(self):
        self.scenario({"GMAIL_GET_PROFILE": ok({"response_data": {"emailAddress": FROM.upper()}}), "GMAIL_SEND_EMAIL": SEND_OK})
        self.send_direct()
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE", "GMAIL_SEND_EMAIL"])

    def test_no_from_address_names_the_account(self):
        self.rig.settings["from_address"] = ""
        with self.assertRaises(senders.SendError) as caught:
            self.send_direct()
        self.assertIn(FROM, str(caught.exception))
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE"])

    def test_profile_without_an_address_fails_closed(self):
        self.scenario({"GMAIL_GET_PROFILE": ok({"messagesTotal": 3}), "GMAIL_SEND_EMAIL": SEND_OK})
        with self.assertRaises(senders.SendError):
            self.send_direct()
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE"])

    def test_composio_reporting_a_different_from_is_a_clear_failure_never_resent(self):
        self.scenario({"GMAIL_GET_PROFILE": PROFILE_OK, "GMAIL_SEND_EMAIL": ok({
            "id": "gm-1", "payload": {"headers": [{"name": "From", "value": "Someone <other@example.org>"}]},
        })})
        draft = self.draft()
        out = self.engine.send({"id": draft["id"]}, surface="rpc")
        self.assertFalse(out["ok"])
        self.assertIn("other@example.org", out["error"])
        self.assertTrue(out["draft"]["delivery_unknown"])
        with self.assertRaises(store_mod.DraftError):
            self.engine.send({"id": draft["id"]}, surface="rpc")
        self.assertFalse(engine_mod.handle(self.engine, "send", {"id": draft["id"]}, surface="rpc")["ok"])
        self.assertEqual(self.tools().count("GMAIL_SEND_EMAIL"), 1)


class Errors(ComposioBase):
    CASES = {
        "not logged in": ({"stderr": "You are not logged in yet. Please run `composio login`.\n", "code": 1}, "composio login"),
        "no connected gmail": (refused('No connected account matched "work" for toolkit "gmail". Available accounts: home.'),
                               "No connected Gmail account"),
        "token expired": (refused("Connected account is EXPIRED: the refresh token was revoked, reauthorize the connection"),
                          "expired"),
        "rate limit": (refused({"message": "429 Too Many Requests: rate limit exceeded"}), "rate limiting"),
        "approval controls": (refused("Tool execution requires interactive approval, but permission prompts are disabled in this "
                                      "environment (CI/VITEST, or COMPOSIO_DISABLE_PERMISSION_UI): GMAIL_SEND_EMAIL"),
                              "approval controls"),
        "gmail refused input": (refused("Invalid recipient_email: must be a full user@domain address"), "refused the email"),
    }

    def test_each_error_is_a_clear_failure_with_retry(self):
        for name, (answer, expected) in self.CASES.items():
            with self.subTest(name):
                self.scenario({"GMAIL_GET_PROFILE": PROFILE_OK, "GMAIL_SEND_EMAIL": answer})
                draft = self.draft()
                out = self.engine.send({"id": draft["id"]}, surface="rpc")
                self.assertFalse(out["ok"], out)
                self.assertEqual(out["draft"]["status"], "failed")
                self.assertIn(expected, out["error"])
                self.assertFalse(out["draft"]["delivery_unknown"], out["error"])
                # Fixed on the machine: Retry sends it, once.
                self.scenario({"GMAIL_GET_PROFILE": PROFILE_OK, "GMAIL_SEND_EMAIL": SEND_OK})
                before = self.tools().count("GMAIL_SEND_EMAIL")
                retry = self.engine.send({"id": draft["id"]}, surface="rpc")
                self.assertTrue(retry["ok"], retry)
                self.assertEqual(self.tools().count("GMAIL_SEND_EMAIL"), before + 1)

    def test_errors_at_the_profile_check_also_stop_before_sending(self):
        self.scenario({"GMAIL_GET_PROFILE": self.CASES["not logged in"][0], "GMAIL_SEND_EMAIL": SEND_OK})
        with self.assertRaises(senders.SendError) as caught:
            self.send_direct()
        self.assertIn("composio login", str(caught.exception))
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE"])

    def test_cli_missing(self):
        self.rig.settings["composio_cli"] = str(self.bin / "nope")
        with self.assertRaises(senders.SendError) as caught:
            self.send_direct()
        self.assertIn("not at", str(caught.exception))
        self.rig.settings["composio_cli"] = ""
        with mock.patch.dict(os.environ, {"PATH": str(Path(self.rig.tmp.name) / "empty"), "HOME": str(self.rig.workspace)}):
            with self.assertRaises(senders.SendError) as caught:
                self.send_direct()
        self.assertIn("not installed", str(caught.exception))
        self.assertEqual(self.calls(), [])

    def test_relative_cli_path_refused(self):
        self.rig.settings["composio_cli"] = "bin/composio"
        with self.assertRaises(senders.SendError):
            self.send_direct()


class Unknown(ComposioBase):
    def test_timeout_is_delivery_unknown_and_never_retried(self):
        self.scenario({"GMAIL_GET_PROFILE": PROFILE_OK, "GMAIL_SEND_EMAIL": {"sleep": 30, **SEND_OK}})
        draft = self.draft()
        started = time.monotonic()
        with mock.patch.object(composio, "SEND_TIMEOUT_S", 1.0):
            out = self.engine.send({"id": draft["id"]}, surface="rpc")
        self.assertLess(time.monotonic() - started, 15)
        self.assertFalse(out["ok"])
        self.assertTrue(out["draft"]["delivery_unknown"])
        self.assertIn("Delivery unknown", out["error"])
        self.assertIn("Sent folder", out["error"])
        stored = self.engine.store.load(draft["id"])
        self.assertTrue(stored["delivery_unknown"])
        # The CLI was killed, not left running.
        pid = self.calls()[-1]["pid"]
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        # No automatic or manual resend.
        with self.assertRaises(store_mod.DraftError):
            self.engine.send({"id": draft["id"]}, surface="rpc")
        self.assertFalse(engine_mod.handle(self.engine, "send", {"id": draft["id"]}, surface="rpc")["ok"])
        self.assertEqual(self.tools().count("GMAIL_SEND_EMAIL"), 1)
        audit = (self.rig.data / "audit.jsonl").read_text()
        self.assertIn("send_unknown", audit)

    def test_profile_timeout_is_a_plain_failure(self):
        self.scenario({"GMAIL_GET_PROFILE": {"sleep": 30, **PROFILE_OK}, "GMAIL_SEND_EMAIL": SEND_OK})
        with mock.patch.object(composio, "PROFILE_TIMEOUT_S", 1.0):
            with self.assertRaises(senders.SendError):
                self.send_direct()
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE"])

    def test_unclear_results_are_unknown(self):
        cases = {
            "crash, no output": {"code": 1, "stderr": "Segmentation fault\n"},
            "exit 0, unreadable": {"stdout": "Executing tool...\nnot json", "code": 0},
            "network dropped mid-send": refused("fetch failed: ECONNRESET socket hang up"),
            "gateway timeout": refused("502 Bad Gateway"),
        }
        for name, answer in cases.items():
            with self.subTest(name):
                self.scenario({"GMAIL_GET_PROFILE": PROFILE_OK, "GMAIL_SEND_EMAIL": answer})
                with self.assertRaises(senders.DeliveryUnknown):
                    self.send_direct()

    def test_result_after_log_lines_is_parsed(self):
        lines = "◇ Executing tool \"GMAIL_SEND_EMAIL\"...\n" + json.dumps(SEND_OK["stdout"], indent=2)
        self.scenario({"GMAIL_GET_PROFILE": PROFILE_OK, "GMAIL_SEND_EMAIL": {"stdout": lines}})
        self.assertEqual(self.send_direct()["gmail_id"], "gm-42")


class NoShell(ComposioBase):
    def test_arguments_never_pass_through_a_shell(self):
        marker = Path(self.rig.tmp.name) / "pwned"
        nasty = f"$(touch {marker}) `touch {marker}` ; touch {marker} && echo | sh"
        self.rig.settings["signature"] = ""
        draft = self.draft(subject=nasty, body=nasty)
        real_popen = subprocess.Popen
        seen = []

        def spy(*args, **kwargs):
            seen.append((args, kwargs))
            return real_popen(*args, **kwargs)

        with mock.patch.object(composio.subprocess, "Popen", spy):
            self.send_direct(draft)
        self.assertFalse(marker.exists())
        self.assertEqual(len(seen), 2)
        for args, kwargs in seen:
            self.assertIsInstance(args[0], list)
            self.assertIs(kwargs.get("shell"), False)
            self.assertTrue(kwargs.get("start_new_session"))
            self.assertNotIn(nasty, " ".join(args[0]))  # the email is on stdin only
        payload = self.calls()[-1]["payload"]
        self.assertEqual(payload["subject"], nasty)
        self.assertEqual(payload["body"].rstrip("\n"), nasty)

    def test_child_environment_is_minimal_and_the_key_comes_from_the_secret_scope(self):
        asked = []
        self.secret = lambda name: asked.append(name) or "uak_profile_key"
        with mock.patch.dict(os.environ, {"COMPOSIO_USER_API_KEY": "env-must-not-win", "OPENAI_API_KEY": "sk-other",
                                          "COMPOSIO_CACHE_DIR": str(self.bin)}):
            self.send_direct()
        env = self.calls()[-1]["env"]
        self.assertEqual(env["COMPOSIO_USER_API_KEY"], "uak_profile_key")
        self.assertEqual(env["COMPOSIO_DISABLE_PERMISSION_UI"], "true")
        self.assertEqual(env["COMPOSIO_CACHE_DIR"], str(self.bin))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertIn("COMPOSIO_USER_API_KEY", asked)

    def test_without_a_profile_key_the_cli_login_is_used(self):
        with mock.patch.dict(os.environ, {"COMPOSIO_USER_API_KEY": "env-must-not-win"}):
            self.send_direct()
        self.assertNotIn("COMPOSIO_USER_API_KEY", self.calls()[-1]["env"])


class NeverTwice(ComposioBase):
    def test_double_click_sends_once(self):
        self.scenario({"GMAIL_GET_PROFILE": PROFILE_OK, "GMAIL_SEND_EMAIL": {"sleep": 0.5, **SEND_OK}})
        draft = self.draft()
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.engine.send({"id": draft["id"]}, surface="rpc")))
                   for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(self.tools().count("GMAIL_SEND_EMAIL"), 1)
        self.assertEqual(self.engine.store.load(draft["id"])["status"], "sent")

    def test_allow_rule_auto_send_goes_through_composio(self):
        self.engine.allow({"addresses": [SAM]}, surface="rpc")
        out = self.engine.create({"to": [SAM], "subject": "s", "body": "b"})
        self.assertEqual(out["email_draft"]["status"], "sent")
        self.assertIn("sent automatically", out["message"])
        self.assertEqual(self.tools(), ["GMAIL_GET_PROFILE", "GMAIL_SEND_EMAIL"])


class Registration(unittest.TestCase):
    def test_settings_keys_include_composio(self):
        self.assertIn("composio_account", plugin.SETTING_KEYS)
        self.assertIn("composio_cli", plugin.SETTING_KEYS)

    def test_skill_and_readme_say_email_goes_through_composio(self):
        needle = "Email goes through Composio. Use email_draft_create; never send email any other way."
        self.assertIn(needle, (PLUGIN_DIR / "skills" / "email-drafts" / "SKILL.md").read_text())
        self.assertIn(needle, (PLUGIN_DIR / "README.md").read_text())


if __name__ == "__main__":
    unittest.main()
