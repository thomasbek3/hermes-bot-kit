"""email-drafts: drafts, sending, rules and the card's API, with fake Gmail and
SMTP backends (no real email, no Hermes needed).

    python3 -m unittest discover -s email-drafts/tests -p 'test_*.py'
"""

from __future__ import annotations

import base64
import email
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from email import policy
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _load_package():
    spec = importlib.util.spec_from_file_location(
        "email_drafts_plugin", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["email_drafts_plugin"] = mod
    spec.loader.exec_module(mod)
    return mod


plugin = _load_package()
engine_mod = sys.modules["email_drafts_plugin.engine"]
senders = sys.modules["email_drafts_plugin.senders"]
store_mod = sys.modules["email_drafts_plugin.store"]

FROM = "me@example.com"
SAM = "sam@example.com"
LEE = "lee@example.org"


class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status = status
        self._body = body if body is not None else {"id": "gm-1", "threadId": "th-1"}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class FakeGmail:
    """Stands in for credentialed_provider_request: records every call."""

    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail

    def __call__(self, provider, method, url, json=None, timeout=None, headers=None):
        self.calls.append({"provider": provider, "method": method, "url": url, "json": json})
        if self.fail:
            raise self.fail
        return FakeResponse()

    def message(self, index=-1):
        raw = self.calls[index]["json"]["raw"]
        return email.message_from_bytes(base64.urlsafe_b64decode(raw), policy=policy.default)


class FakeSMTP:
    """Stands in for smtplib.SMTP / SMTP_SSL."""

    instances = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port = host, port
        self.log = []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self, context=None):
        self.log.append("starttls")

    def login(self, user, password):
        self.log.append(("login", user, password))

    def send_message(self, msg, from_addr=None, to_addrs=None):
        self.log.append(("send", from_addr, list(to_addrs)))
        self.msg = msg
        return {}


class Rig:
    """An engine on a temp dir with a workspace and a recording backend."""

    def __init__(self, settings=None, cron=None):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.data = base / "plugin-data"
        self.workspace = base / "workspace"
        self.workspace.mkdir()
        (self.workspace / "price-sheet.csv").write_text("item,price\nkit,9.50\n")
        self.outside = base / "outside"
        self.outside.mkdir()
        (self.outside / "secret.txt").write_text("nope")
        self.settings = {"sender": "gmail", "from_address": FROM, "from_name": "Me", "signature": "Me\\nexample.com"}
        self.settings.update(settings or {})
        self.cron = cron
        self.sent = []
        self.fail_next = []
        self.delay = 0.0
        self.engine = engine_mod.Engine(
            store_mod.Store(self.data),
            lambda: self.settings,
            lambda: str(self.workspace),
            lambda: self.cron,
            deliver=self._deliver,
        )

    def _deliver(self, draft, settings, files):
        if self.delay:
            time.sleep(self.delay)
        if self.fail_next:
            raise self.fail_next.pop(0)
        self.sent.append({"draft": dict(draft), "files": files})
        return {"backend": "fake", "message_id": f"<m{len(self.sent)}@example.com>"}

    def close(self):
        self.tmp.cleanup()

    def create(self, **args):
        base = {"to": [SAM], "subject": "Pricing", "body": "Hi Sam,\n\nNumbers below."}
        base.update(args)
        return self.engine.create(base, session_id="s1")


class DraftLifecycle(unittest.TestCase):
    def setUp(self):
        self.rig = Rig()
        self.engine = self.rig.engine

    def tearDown(self):
        self.rig.close()

    def test_create_returns_a_pending_draft_the_card_can_render(self):
        result = self.rig.create(cc=[LEE], attachments=["price-sheet.csv"],
                                 in_reply_to={"message_id": "abc@example.com", "subject": "Pricing?", "from": "Sam <sam@example.com>"})
        self.assertTrue(result["ok"])
        draft = result["email_draft"]
        self.assertRegex(draft["id"], r"^ed_[0-9a-f]{16}$")
        self.assertEqual(draft["status"], "pending")
        self.assertIn("Not sent", result["message"])
        view = self.engine.get({"id": draft["id"]})["draft"]
        self.assertEqual(view["from"], FROM)
        self.assertEqual(view["to"], [SAM])
        self.assertEqual(view["cc"], [LEE])
        self.assertEqual(view["signature"], "Me\nexample.com")
        self.assertEqual(view["in_reply_to"]["message_id"], "<abc@example.com>")
        self.assertEqual([a["name"] for a in view["attachments"]], ["price-sheet.csv"])
        self.assertTrue(Path(view["attachments"][0]["path"]).is_absolute())
        self.assertEqual(view["rules"]["mode"], "approval")
        self.assertEqual(self.rig.sent, [], "creating never sends")

    def test_edit_then_send_sends_exactly_the_edited_draft(self):
        draft_id = self.rig.create()["email_draft"]["id"]
        rev = self.engine.get({"id": draft_id})["draft"]["rev"]
        result = self.engine.send({"id": draft_id, "rev": rev, "to": [SAM, LEE], "cc": "x@example.net", "body": "Edited."}, surface="rpc")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["draft"]["status"], "sent")
        self.assertEqual(result["draft"]["sent_by"], "human")
        self.assertEqual(len(self.rig.sent), 1)
        sent = self.rig.sent[0]["draft"]
        self.assertEqual(sent["to"], [SAM, LEE])
        self.assertEqual(sent["cc"], ["x@example.net"])
        self.assertEqual(sent["body"], "Edited.")
        audit = [a for a in self.engine.store.audit_lines() if a["event"] == "sent"]
        self.assertEqual(audit[0]["actor"], "human")
        self.assertEqual(audit[0]["surface"], "rpc")
        self.assertNotIn("Edited.", json.dumps(self.engine.store.audit_lines()), "the audit log holds no bodies")

    def test_sent_draft_is_read_only(self):
        draft_id = self.rig.create()["email_draft"]["id"]
        self.engine.send({"id": draft_id}, surface="rpc")
        out = engine_mod.handle(self.engine, "edit", {"id": draft_id, "body": "late"}, surface="rpc")
        self.assertFalse(out["ok"])
        self.assertFalse(engine_mod.handle(self.engine, "discard", {"id": draft_id}, surface="rpc")["ok"])
        with self.assertRaises(store_mod.DraftError):
            self.engine.update({"id": draft_id, "body": "bot edit"})

    def test_discard(self):
        draft_id = self.rig.create()["email_draft"]["id"]
        out = self.engine.discard({"id": draft_id}, surface="rpc")
        self.assertEqual(out["draft"]["status"], "discarded")
        again = self.engine.send({"id": draft_id}, surface="rpc")
        self.assertEqual(again["already"], "discarded")
        self.assertEqual(self.rig.sent, [])
        self.assertEqual(self.engine.status({"id": draft_id})["email_draft"]["status"], "discarded")

    def test_bot_update_after_the_card_loaded_blocks_the_send(self):
        draft_id = self.rig.create()["email_draft"]["id"]
        seen = self.engine.get({"id": draft_id})["draft"]["rev"]
        self.engine.update({"id": draft_id, "to": ["someone@example.net"]})
        out = engine_mod.handle(self.engine, "send", {"id": draft_id, "rev": seen}, surface="rpc")
        self.assertFalse(out["ok"])
        self.assertIn("review it again", out["error"])
        self.assertEqual(self.rig.sent, [])

    def test_double_click_sends_once(self):
        draft_id = self.rig.create()["email_draft"]["id"]
        first = self.engine.send({"id": draft_id}, surface="rpc")
        second = self.engine.send({"id": draft_id}, surface="rpc")
        self.assertEqual(first["draft"]["status"], "sent")
        self.assertEqual(second["already"], "sent")
        self.assertEqual(len(self.rig.sent), 1)

    def test_concurrent_clicks_send_once(self):
        draft_id = self.rig.create()["email_draft"]["id"]
        self.rig.delay = 0.2
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.engine.send({"id": draft_id}, surface="rpc"))) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(self.rig.sent), 1)
        self.assertEqual(sum(1 for r in results if not r.get("already")), 1)
        self.assertTrue(all(r.get("already") in ("sending", "sent") for r in results if r.get("already")))

    def test_failure_then_retry(self):
        draft_id = self.rig.create()["email_draft"]["id"]
        self.rig.fail_next.append(senders.SendError("Gmail refused the message (400): bad"))
        failed = self.engine.send({"id": draft_id}, surface="rpc")
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["draft"]["status"], "failed")
        self.assertIn("400", failed["draft"]["error"])
        retried = self.engine.send({"id": draft_id}, surface="rpc")
        self.assertTrue(retried["ok"])
        self.assertEqual(retried["draft"]["status"], "sent")
        self.assertIsNone(retried["draft"]["error"])
        events = [a["event"] for a in self.engine.store.audit_lines()]
        self.assertEqual(events.count("send_failed"), 1)
        self.assertEqual(events.count("sent"), 1)

    def test_unexpected_error_is_delivery_unknown_and_never_retried(self):
        draft_id = self.rig.create()["email_draft"]["id"]
        self.rig.fail_next.append(RuntimeError("socket closed after DATA"))
        out = self.engine.send({"id": draft_id}, surface="rpc")
        self.assertFalse(out["ok"])
        self.assertTrue(out["draft"]["delivery_unknown"])
        again = engine_mod.handle(self.engine, "send", {"id": draft_id}, surface="rpc")
        self.assertFalse(again["ok"])
        self.assertIn("Sent folder", again["error"])
        self.assertEqual(self.rig.sent, [])

    def test_missing_recipient_and_header_injection_are_refused(self):
        with self.assertRaises(store_mod.DraftError):
            self.rig.create(to=[])
        with self.assertRaises(store_mod.DraftError):
            self.rig.create(to=["sam@example.com\r\nBcc: evil@example.com"])
        draft = self.rig.create(subject="Hi\r\nBcc: evil@example.com")["email_draft"]
        self.assertNotIn("\n", draft["subject"])


class Rules(unittest.TestCase):
    def setUp(self):
        self.rig = Rig()
        self.engine = self.rig.engine

    def tearDown(self):
        self.rig.close()

    def test_allow_recipient_then_future_drafts_send_automatically(self):
        first = self.rig.create()["email_draft"]["id"]
        rules = self.engine.allow({"id": first}, surface="rpc")["rules"]
        self.assertEqual(rules, {"mode": "allow", "allowed": [SAM]})
        self.assertEqual(self.engine.get({"id": first})["draft"]["status"], "pending", "the current draft still waits")
        auto = self.rig.create(subject="Follow-up")
        self.assertEqual(auto["email_draft"]["status"], "sent")
        self.assertIn("sent automatically", auto["message"])
        self.assertEqual(auto["email_draft"]["sent_by"], "allow-rule")
        self.assertEqual(len(self.rig.sent), 1)
        audit = [a for a in self.engine.store.audit_lines() if a["event"] == "sent"]
        self.assertEqual(audit[-1]["actor"], "allow-rule")

    def test_mixed_recipients_wait_for_approval(self):
        self.engine.allow({"addresses": [SAM]}, surface="rpc")
        for extra in ({"to": [SAM, LEE]}, {"cc": [LEE]}, {"bcc": [LEE]}):
            out = self.rig.create(**extra)
            self.assertEqual(out["email_draft"]["status"], "pending", extra)
        self.assertEqual(self.rig.sent, [])

    def test_needs_approval_mode_keeps_the_list_but_sends_nothing_alone(self):
        self.engine.allow({"addresses": [SAM]}, surface="rpc")
        self.engine.set_mode({"mode": "approval"}, surface="rpc")
        out = self.rig.create()
        self.assertEqual(out["email_draft"]["status"], "pending")
        self.assertEqual(self.engine.rules({})["rules"]["allowed"], [SAM])

    def test_update_into_an_allowed_draft_sends_it(self):
        self.engine.allow({"addresses": [SAM]}, surface="rpc")
        draft_id = self.rig.create(to=[LEE])["email_draft"]["id"]
        out = self.engine.update({"id": draft_id, "to": [SAM]})
        self.assertEqual(out["email_draft"]["status"], "sent")

    def test_drafts_disabled(self):
        self.engine.set_mode({"mode": "disabled"}, surface="rpc")
        out = self.rig.create()
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], "disabled")
        self.assertIn("turned off", out["error"])
        self.assertEqual(self.engine.store.list(), [])
        tool = plugin._tool(self.engine, "email_draft_create")
        self.assertIn("turned off", json.loads(tool({"to": [SAM], "subject": "x", "body": "y"}))["error"])

    def test_manage_rules_remove_and_bad_mode(self):
        self.engine.allow({"addresses": [SAM, LEE]}, surface="rpc")
        out = self.engine.unallow({"addresses": [LEE]}, surface="rpc")
        self.assertEqual(out["rules"]["allowed"], [SAM])
        bad = engine_mod.handle(self.engine, "set_mode", {"mode": "yolo"}, surface="rpc")
        self.assertFalse(bad["ok"])

    def test_rules_are_per_profile_data_dir(self):
        other = Rig()
        try:
            self.engine.allow({"addresses": [SAM]}, surface="rpc")
            self.assertEqual(other.engine.rules({})["rules"], {"mode": "approval", "allowed": []})
        finally:
            other.close()


class Attachments(unittest.TestCase):
    def setUp(self):
        self.rig = Rig()

    def tearDown(self):
        self.rig.close()

    def test_escapes_are_rejected(self):
        outside = self.rig.outside / "secret.txt"
        link = self.rig.workspace / "link.txt"
        os.symlink(outside, link)
        hidden = self.rig.workspace / ".env"
        hidden.write_text("KEY=1")
        for path in ("../outside/secret.txt", str(outside), "link.txt", ".env", "missing.pdf", "/etc/hosts"):
            with self.assertRaises(store_mod.DraftError, msg=path):
                self.rig.create(attachments=[path])
        self.assertEqual(self.rig.engine.store.list(), [])

    def test_allowed_extra_folder(self):
        self.rig.settings["attachment_dirs"] = [str(self.rig.outside)]
        out = self.rig.create(attachments=[str(self.rig.outside / "secret.txt")])
        self.assertTrue(out["ok"])

    def test_a_file_swapped_for_a_link_is_refused_at_send(self):
        draft_id = self.rig.create(attachments=["price-sheet.csv"])["email_draft"]["id"]
        target = self.rig.workspace / "price-sheet.csv"
        target.unlink()
        os.symlink(self.rig.outside / "secret.txt", target)
        out = self.rig.engine.send({"id": draft_id}, surface="rpc")
        self.assertFalse(out["ok"])
        self.assertIn("outside", out["error"])
        self.assertEqual(self.rig.sent, [])

    def test_home_folder_is_not_a_workspace_root(self):
        roots = sys.modules["email_drafts_plugin.attachments"].allowed_roots(os.path.expanduser("~"), [])
        self.assertEqual(roots, [])


class Unattended(unittest.TestCase):
    def test_cron_context_creates_and_returns_without_waiting(self):
        rig = Rig(cron=types.SimpleNamespace(job_id="j1"))
        try:
            started = time.monotonic()
            out = rig.create()
            self.assertLess(time.monotonic() - started, 2.0)
            self.assertEqual(out["email_draft"]["status"], "pending")
            self.assertIn("scheduled run cannot send", out["message"])
            self.assertEqual(rig.engine.get({"id": out["email_draft"]["id"]})["draft"]["origin"], "cron")
            self.assertEqual(rig.sent, [])
        finally:
            rig.close()


class Backends(unittest.TestCase):
    def setUp(self):
        self.rig = Rig()

    def tearDown(self):
        self.rig.close()

    def _draft(self, **extra):
        draft_id = self.rig.create(**extra)["email_draft"]["id"]
        return self.rig.engine.store.load(draft_id)

    def test_gmail_through_hermes_provider_request(self):
        gmail = FakeGmail()
        draft = self._draft(bcc=[LEE], attachments=["price-sheet.csv"],
                            in_reply_to={"message_id": "<orig@example.com>", "references": ["<root@example.com>"], "thread_id": "th-9"})
        msg = senders.build_message(draft, self.rig.settings, draft["attachments"])
        receipt = senders.send_gmail(msg, draft, self.rig.settings, request=gmail)
        call = gmail.calls[0]
        self.assertEqual((call["provider"], call["method"], call["url"]), ("google", "POST", senders.GMAIL_SEND_URL))
        self.assertEqual(call["json"]["threadId"], "th-9")
        sent = gmail.message()
        self.assertEqual(sent["From"], f"Me <{FROM}>")
        self.assertEqual(sent["To"], SAM)
        self.assertEqual(sent["Bcc"], LEE)
        self.assertEqual(sent["In-Reply-To"], "<orig@example.com>")
        self.assertEqual(sent["References"], "<root@example.com> <orig@example.com>")
        body = sent.get_body(("plain",)).get_content()
        self.assertTrue(body.rstrip().endswith("Me\nexample.com"), body)
        names = [part.get_filename() for part in sent.iter_attachments()]
        self.assertEqual(names, ["price-sheet.csv"])
        self.assertEqual(receipt["gmail_id"], "gm-1")

    def test_gmail_not_signed_in_is_a_clean_failure(self):
        class ProviderNotSignedIn(Exception):
            pass

        gmail = FakeGmail(fail=ProviderNotSignedIn("run `hermes auth add email-drafts:google`"))
        draft = self._draft()
        msg = senders.build_message(draft, self.rig.settings, [])
        with self.assertRaises(senders.SendError) as caught:
            senders.send_gmail(msg, draft, self.rig.settings, request=gmail)
        self.assertIn("hermes auth add email-drafts:google", str(caught.exception))

    def test_gmail_http_error(self):
        class Refusing(FakeGmail):
            def __call__(self, *a, **k):
                super().__call__(*a, **k)
                return FakeResponse(403, {"error": "forbidden"})

        draft = self._draft()
        with self.assertRaises(senders.SendError):
            senders.send_gmail(senders.build_message(draft, self.rig.settings, []), draft, self.rig.settings, request=Refusing())

    def test_smtp_over_starttls_with_secret_scope_password(self):
        FakeSMTP.instances.clear()
        settings = {**self.rig.settings, "sender": "smtp", "smtp_host": "smtp.example.com", "smtp_port": 587,
                    "smtp_security": "starttls", "smtp_username": FROM}
        draft = self._draft(cc=[LEE], bcc=["b@example.net"])
        secrets_asked = []
        original = dict(senders.SMTP_CLASSES)
        senders.SMTP_CLASSES.update(starttls=FakeSMTP, ssl=FakeSMTP)
        try:
            receipt = senders.send_smtp(senders.build_message(draft, settings, []), draft, settings,
                                        secret=lambda name: secrets_asked.append(name) or "app-password")
        finally:
            senders.SMTP_CLASSES.clear()
            senders.SMTP_CLASSES.update(original)
        client = FakeSMTP.instances[0]
        self.assertEqual((client.host, client.port), ("smtp.example.com", 587))
        self.assertEqual(client.log[0], "starttls")
        self.assertEqual(client.log[1], ("login", FROM, "app-password"))
        self.assertEqual(client.log[2], ("send", FROM, [SAM, LEE, "b@example.net"]))
        self.assertEqual(secrets_asked, ["EMAIL_DRAFTS_SMTP_PASSWORD"])
        self.assertEqual(receipt["backend"], "smtp")

    def test_smtp_without_password_fails_before_connecting(self):
        settings = {**self.rig.settings, "sender": "smtp", "smtp_host": "smtp.example.com", "smtp_username": FROM}
        draft = self._draft()
        with self.assertRaises(senders.SendError):
            senders.send_smtp(senders.build_message(draft, settings, []), draft, settings, secret=lambda name: "")

    def test_no_from_address(self):
        draft = self._draft()
        with self.assertRaises(senders.SendError):
            senders.build_message(draft, {"from_address": ""}, [])

    def test_engine_with_real_deliver_and_fake_gmail(self):
        gmail = FakeGmail()
        original = senders.SENDERS["gmail"]
        senders.SENDERS["gmail"] = lambda msg, draft, settings: original(msg, draft, settings, request=gmail)
        try:
            engine = engine_mod.Engine(self.rig.engine.store, lambda: self.rig.settings, lambda: str(self.rig.workspace))
            draft_id = engine.create({"to": [SAM], "subject": "s", "body": "b"})["email_draft"]["id"]
            out = engine.send({"id": draft_id}, surface="rpc")
        finally:
            senders.SENDERS["gmail"] = original
        self.assertTrue(out["ok"], out)
        self.assertEqual(len(gmail.calls), 1)


class FakeCtx:
    profile_name = "default"

    def __init__(self, rpc=True):
        self.tools, self.commands, self.rpcs, self.skills = {}, {}, {}, {}
        self.config = {"from_address": FROM}
        if rpc:
            self.register_rpc = lambda name, handler: self.rpcs.__setitem__(name, handler)

    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools[name] = (toolset, schema, handler)

    def register_command(self, name, handler, **kw):
        self.commands[name] = handler

    def register_skill(self, name, path):
        self.skills[name] = path

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def current_cron_execution(self):
        return None


class Registration(unittest.TestCase):
    def test_register_matches_the_manifest(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        manifest = (PLUGIN_DIR / "plugin.yaml").read_text()
        for name in ctx.tools:
            self.assertIn(f"  - {name}\n", manifest)
        self.assertEqual(sorted(ctx.tools), ["email_draft_create", "email_draft_status", "email_draft_update"])
        self.assertNotIn("send", " ".join(n for n in ctx.tools if n != "email_draft_status").replace("email_draft_", ""))
        self.assertEqual(list(ctx.commands), ["email-drafts"])
        self.assertEqual(list(ctx.rpcs), ["api"])
        self.assertEqual(list(ctx.skills), ["email-drafts"])

    def test_register_without_plugin_rpc(self):
        ctx = FakeCtx(rpc=False)
        plugin.register(ctx)
        self.assertEqual(list(ctx.commands), ["email-drafts"])

    def test_manifest_oauth_is_gmail_send_only(self):
        manifest = (PLUGIN_DIR / "plugin.yaml").read_text()
        self.assertIn("https://www.googleapis.com/auth/gmail.send\n", manifest)
        self.assertEqual(manifest.count("https://www.googleapis.com/auth/"), 1)
        self.assertIn("hosts: [gmail.googleapis.com]", manifest)


class CardApi(unittest.TestCase):
    """The two ways the card reaches the plugin: plugin RPC and the slash command."""

    def setUp(self):
        self.rig = Rig()
        self.slash = plugin.slash_handler(self.rig.engine)
        self.rpc = plugin.rpc_handler(self.rig.engine)
        self.draft_id = self.rig.create()["email_draft"]["id"]

    def tearDown(self):
        self.rig.close()

    def test_slash_api_round_trip_from_desktop(self):
        got = json.loads(self.slash(f'api get {{"id": "{self.draft_id}"}}', platform="desktop"))
        self.assertEqual(got["draft"]["id"], self.draft_id)
        sent = json.loads(self.slash(f'api send {{"id": "{self.draft_id}"}}', platform="desktop"))
        self.assertEqual(sent["draft"]["status"], "sent")
        audit = [a for a in self.rig.engine.store.audit_lines() if a["event"] == "sent"][0]
        self.assertEqual(audit["surface"], "slash:desktop")

    def test_slash_writes_refused_from_the_plain_cli(self):
        out = json.loads(self.slash(f'api send {{"id": "{self.draft_id}"}}', platform="cli"))
        self.assertFalse(out["ok"])
        self.assertEqual(self.rig.sent, [])
        read = json.loads(self.slash(f'api get {{"id": "{self.draft_id}"}}', platform="cli"))
        self.assertTrue(read["ok"])

    def test_slash_list_for_people(self):
        text = self.slash("", platform="desktop")
        self.assertIn(self.draft_id, text)
        self.assertIn("pending", text)

    def test_rpc(self):
        out = self.rpc({"op": "discard", "id": self.draft_id, "session_id": "s1"}, session_id="s1")
        self.assertEqual(out["draft"]["status"], "discarded")
        self.assertFalse(self.rpc({"op": "eval"})["ok"])

    def test_bad_input(self):
        self.assertFalse(json.loads(self.slash("api get not-json", platform="desktop"))["ok"])
        self.assertFalse(json.loads(self.slash('api get {"id": "../../etc"}', platform="desktop"))["ok"])


if __name__ == "__main__":
    unittest.main()
