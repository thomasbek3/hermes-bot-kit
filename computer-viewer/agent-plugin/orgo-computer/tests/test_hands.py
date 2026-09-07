"""Mocked contract tests for OpenMausBot-style Orgo hands."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _load_plugin_modules():
    import importlib.util
    import types

    pkg = types.ModuleType("orgo_computer")
    pkg.__path__ = [str(PLUGIN_DIR)]
    pkg.__package__ = "orgo_computer"
    sys.modules["orgo_computer"] = pkg
    for name in ("schemas", "tools"):
        spec = importlib.util.spec_from_file_location(
            f"orgo_computer.{name}",
            PLUGIN_DIR / f"{name}.py",
        )
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = "orgo_computer"
        sys.modules[f"orgo_computer.{name}"] = mod
        spec.loader.exec_module(mod)
        setattr(pkg, name, mod)
    return pkg.schemas, pkg.tools


schemas, tools = _load_plugin_modules()


PIN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000"
    "ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432"
    "ffc0000b080001000101011100"
    "ffc4001f0000010501010101010100000000000000000102030405060708090a0b"
    "ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa"
    "ffda00080001010100063f00"
    "d2cf20"
    "ffd9"
)


class FakeResponse:
    def __init__(
        self,
        status=200,
        payload=None,
        content=b"",
        content_type="application/json",
        chunks=None,
        content_length=None,
    ):
        self.status_code = status
        self._payload = payload
        self.content = content
        self.is_success = 200 <= status < 300
        self.headers = {"content-type": content_type}
        if content_length is not None:
            self.headers["content-length"] = str(content_length)
        self._chunks = chunks
        self.read_started = False

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    async def aiter_bytes(self):
        """Mimic httpx: the body is only produced once iteration starts."""
        self.read_started = True
        for chunk in self._chunks if self._chunks is not None else [self.content]:
            yield chunk


class FakeStream:
    """`async with client.stream(...) as resp:` for FakeClient."""

    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, tb):
        return False


class FakeClient:
    def __init__(self, router):
        self.router = router
        self.posts = []
        self.gets = []
        self.get_headers = []
        self.streams = []

    async def get(self, url, headers=None):
        self.gets.append(url)
        self.get_headers.append(headers or {})
        return self.router("GET", url, None)

    def stream(self, method, url, headers=None):
        self.gets.append(url)
        self.get_headers.append(headers or {})
        response = self.router(method, url, None)
        self.streams.append(response)
        return FakeStream(response)

    async def post(self, url, headers=None, json=None):
        self.posts.append((url, json))
        return self.router("POST", url, json)

    async def aclose(self):
        return None


class FakeHttpx:
    Timeout = lambda *a, **k: None
    HTTPError = type("HTTPError", (Exception,), {})
    TimeoutException = type("TimeoutException", (Exception,), {})

    def __init__(self, router):
        self._router = router
        self.client = None

    def AsyncClient(self, **kwargs):
        self.client = FakeClient(self._router)
        return self.client


class HandsTests(unittest.TestCase):
    def setUp(self):
        self._home = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._home.name
        os.environ["ORGO_API_KEY"] = "test-key"
        os.environ["ORGO_COMPUTER_ID"] = PIN
        os.environ.pop("ORGO_DEFAULT_COMPUTER_ID", None)
        os.environ.pop("ORGO_API_BASE_URL", None)
        os.environ.pop("ORGO_ALLOW_INSECURE_HTTP", None)
        tools.bind_context(None)
        tools._PROCESS_LOCKS.clear()

    def tearDown(self):
        self._home.cleanup()
        os.environ.pop("HERMES_HOME", None)
        os.environ.pop("ORGO_API_KEY", None)
        os.environ.pop("ORGO_COMPUTER_ID", None)
        os.environ.pop("ORGO_API_BASE_URL", None)
        os.environ.pop("ORGO_ALLOW_INSECURE_HTTP", None)

    def test_pin_reads_orgo_computer_id(self):
        self.assertEqual(tools._resolve_computer_id(), PIN)

    def test_hosted_run_default_off(self):
        self.assertFalse(tools.hosted_run_enabled())

    def test_identity_omits_run_when_disabled(self):
        text = tools.computer_identity_section()
        self.assertIn("orgo_computer_bash", text)
        self.assertIn("orgo_computer_screenshot", text)
        self.assertNotIn("orgo_computer_run", text)

    def test_identity_includes_run_when_enabled(self):
        class Ctx:
            def get_config(self, key, default=None):
                if key == "hosted_run":
                    return True
                return default

        tools.bind_context(Ctx())
        text = tools.computer_identity_section()
        self.assertIn("LAST RESORT", text)

    def test_register_skips_run_by_default(self):
        import importlib.util
        import types

        pkg = types.ModuleType("orgo_computer")
        pkg.__path__ = [str(PLUGIN_DIR)]
        sys.modules["orgo_computer"] = pkg
        sys.modules["orgo_computer.tools"] = tools
        sys.modules["orgo_computer.schemas"] = schemas
        spec = importlib.util.spec_from_file_location(
            "orgo_computer",
            PLUGIN_DIR / "__init__.py",
            submodule_search_locations=[str(PLUGIN_DIR)],
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules["orgo_computer"] = mod
        spec.loader.exec_module(mod)

        names = []

        class Ctx:
            def register_tool(self, **kwargs):
                names.append(kwargs["name"])

            def register_hook(self, *a, **k):
                return None

            def register_system_prompt_section(self, **k):
                return None

            def register_command(self, *a, **k):
                return None

            def register_cli_command(self, **k):
                return None

            def register_skill(self, *a, **k):
                return None

            def get_config(self, key, default=None):
                return default

        mod.register(Ctx())
        self.assertIn("orgo_computer_bash", names)
        self.assertIn("orgo_computer_screenshot", names)
        self.assertIn("orgo_computer_click", names)
        self.assertNotIn("orgo_computer_run", names)

    def test_screenshot_multimodal_no_storage_leak(self):
        leak = f"/api/storage/{PIN}/secret.jpg"

        def router(method, url, body):
            if method == "GET" and url.endswith("/screenshot"):
                return FakeResponse(200, {"success": True, "image": leak})
            if method == "GET" and "storage" in url:
                self.assertIn("www.orgo.ai", url)
                return FakeResponse(
                    200, payload=None, content=TINY_JPEG, content_type="image/jpeg"
                )
            self.fail(url)

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            result = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertIsInstance(result, dict)
        self.assertTrue(result["_multimodal"])
        blob = json.dumps(result)
        self.assertNotIn(PIN, result["text_summary"])
        self.assertNotIn("/api/storage/", result["text_summary"])
        self.assertNotIn("/api/storage/", result["content"][0]["text"])
        self.assertIn("data:image/jpeg;base64,", result["content"][1]["image_url"]["url"])
        self.assertIn("1x1", result["text_summary"])
        cached = Path(self._home.name) / "cache" / "orgo-computer" / "screen.jpg"
        self.assertTrue(cached.is_file())
        self.assertEqual(cached.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(leak, blob)

    def test_png_screenshot_reports_size(self):
        png = (
            b"\x89PNG\r\n\x1a\n"
            + bytes.fromhex("0000000d4948445200000002000000020802000000fdd4a3")
            + b"\x00" * 20
        )
        # valid-enough header for IHDR parse; don't need a full decode
        png = bytearray(png)
        png[16:24] = (2).to_bytes(4, "big") + (2).to_bytes(4, "big")
        png = bytes(png)

        def router(method, url, body):
            if url.endswith("/screenshot"):
                return FakeResponse(200, {"success": True, "image": "/api/storage/x.png"})
            return FakeResponse(200, payload=None, content=png, content_type="image/png")

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            result = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertIn("2x2 png", result["text_summary"])
        self.assertTrue(result["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_click_posts_xy_and_surfaces_false(self):
        def router(method, url, body):
            self.assertTrue(url.endswith("/click"))
            self.assertEqual(body["x"], 10)
            self.assertEqual(body["y"], 20)
            return FakeResponse(
                200,
                {
                    "success": False,
                    "action": "click",
                    "details": {"x": 10, "y": 20},
                },
            )

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            raw = asyncio.run(tools.orgo_computer_click({"x": 10, "y": 20}))
        payload = json.loads(raw)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["details"]["x"], 10)

    def test_click_blocked_when_run_lock_held(self):
        lock = tools._in_process_lock(PIN)
        lock.acquire()
        try:
            hook = tools.pre_tool_call("orgo_computer_click", {"x": 1, "y": 2})
            self.assertEqual(hook["action"], "block")
            raw = asyncio.run(tools.orgo_computer_click({"x": 1, "y": 2}))
            self.assertIn("Another agent is controlling", raw)
        finally:
            lock.release()

    def test_screenshot_hook_is_open(self):
        self.assertIsNone(tools.pre_tool_call("orgo_computer_screenshot", {}))

    def test_hands_401_has_no_incident_date(self):
        self.assertNotIn("2026-08-22", tools.PIN_401_ERROR)
        self.assertNotIn("credits", tools._hands_error_message(402, "click").lower())

    def test_image_origin_follows_api_base(self):
        os.environ["ORGO_API_BASE_URL"] = "https://example.test/api"
        self.assertEqual(tools._image_origin(), "https://example.test")
        self.assertEqual(
            tools._absolute_image_url("/api/storage/x.jpg"),
            "https://example.test/api/storage/x.jpg",
        )

    def test_jpeg_size(self):
        self.assertEqual(tools._jpeg_size(TINY_JPEG), (1, 1))

    def _image_headers(self, fake):
        self.assertGreaterEqual(len(fake.client.get_headers), 2)
        return fake.client.get_headers[1]

    def test_screenshot_relative_image_sends_bearer(self):
        def router(method, url, body):
            if method == "GET" and url.endswith("/screenshot"):
                return FakeResponse(200, {"success": True, "image": "/api/storage/x.jpg"})
            return FakeResponse(
                200, payload=None, content=TINY_JPEG, content_type="image/jpeg"
            )

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            result = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertTrue(result["_multimodal"])
        auth = self._image_headers(fake).get("Authorization")
        self.assertTrue(str(auth or "").startswith("Bearer "))

    def test_screenshot_absolute_https_cdn_omits_bearer(self):
        def router(method, url, body):
            if method == "GET" and url.endswith("/screenshot"):
                return FakeResponse(
                    200, {"success": True, "image": "https://cdn.example/x.jpg"}
                )
            if url == "https://cdn.example/x.jpg":
                return FakeResponse(
                    200, payload=None, content=TINY_JPEG, content_type="image/jpeg"
                )
            self.fail(url)

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            result = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertTrue(result["_multimodal"])
        self.assertNotIn("Authorization", self._image_headers(fake))

    def test_screenshot_absolute_http_cdn_rejected(self):
        def router(method, url, body):
            if method == "GET" and url.endswith("/screenshot"):
                return FakeResponse(
                    200, {"success": True, "image": "http://cdn.example/x.jpg"}
                )
            self.fail(url)

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            raw = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertIn("insecure screenshot URL", raw)

    def test_http_api_base_public_host_rejected(self):
        os.environ["ORGO_API_BASE_URL"] = "http://example.com/api"
        raw = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertIn("must use https://", raw)
        self.assertIn("ORGO_ALLOW_INSECURE_HTTP", raw)

    def test_http_api_base_loopback_proceeds(self):
        os.environ["ORGO_API_BASE_URL"] = "http://127.0.0.1:8000/api"

        def router(method, url, body):
            self.assertTrue(url.startswith("http://127.0.0.1:8000/"))
            if method == "GET" and url.endswith("/screenshot"):
                return FakeResponse(200, {"success": True, "image": "/api/storage/x.jpg"})
            return FakeResponse(
                200, payload=None, content=TINY_JPEG, content_type="image/jpeg"
            )

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            result = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertTrue(result["_multimodal"])

    def test_http_api_base_public_with_opt_in_proceeds(self):
        os.environ["ORGO_API_BASE_URL"] = "http://example.com/api"
        os.environ["ORGO_ALLOW_INSECURE_HTTP"] = "1"

        def router(method, url, body):
            self.assertTrue(url.startswith("http://example.com/"))
            if method == "GET" and url.endswith("/screenshot"):
                return FakeResponse(200, {"success": True, "image": "/api/storage/x.jpg"})
            return FakeResponse(
                200, payload=None, content=TINY_JPEG, content_type="image/jpeg"
            )

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            result = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertTrue(result["_multimodal"])

    def test_client_kwargs_disables_redirects(self):
        fake = FakeHttpx(lambda *a, **k: None)
        with patch.object(tools, "_import_httpx", return_value=fake):
            self.assertIs(tools._client_kwargs(5.0)["follow_redirects"], False)

    def test_screenshot_rejects_oversized_content_length_without_reading(self):
        body = FakeResponse(
            200,
            payload=None,
            content=b"x" * 16,
            content_type="image/jpeg",
            content_length=tools.MAX_SCREENSHOT_BYTES + 1,
        )

        def router(method, url, body_json):
            if url.endswith("/screenshot"):
                return FakeResponse(200, {"success": True, "image": "/api/storage/x.jpg"})
            return body

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            raw = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertIn("too large to attach", raw)
        self.assertFalse(body.read_started)

    def test_screenshot_aborts_when_chunks_exceed_cap(self):
        chunk = b"x" * 100_000
        count = (tools.MAX_SCREENSHOT_BYTES // len(chunk)) + 2
        body = FakeResponse(
            200,
            payload=None,
            content_type="image/jpeg",
            chunks=[chunk] * count,
        )

        def router(method, url, body_json):
            if url.endswith("/screenshot"):
                return FakeResponse(200, {"success": True, "image": "/api/storage/x.jpg"})
            return body

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            raw = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertIn("too large to attach", raw)
        self.assertTrue(body.read_started)

    def test_screenshot_streams_chunked_body(self):
        half = len(TINY_JPEG) // 2
        body = FakeResponse(
            200,
            payload=None,
            content_type="image/jpeg",
            chunks=[TINY_JPEG[:half], b"", TINY_JPEG[half:]],
            content_length=len(TINY_JPEG),
        )

        def router(method, url, body_json):
            if url.endswith("/screenshot"):
                return FakeResponse(200, {"success": True, "image": "/api/storage/x.jpg"})
            return body

        fake = FakeHttpx(router)
        with patch.object(tools, "_import_httpx", return_value=fake):
            result = asyncio.run(tools.orgo_computer_screenshot({}))
        self.assertTrue(result["_multimodal"])
        self.assertIn("1x1", result["text_summary"])

    def _hold_lock_file(self):
        """Take the flock on the run-lock file from a second descriptor."""
        handle = tools._lock_path(PIN).open("a+", encoding="utf-8")
        tools.fcntl.flock(handle.fileno(), tools.fcntl.LOCK_EX | tools.fcntl.LOCK_NB)
        return handle

    def test_cancelled_wait_releases_the_run_lock(self):
        if tools.fcntl is None:
            self.skipTest("flock unavailable")
        holder = self._hold_lock_file()

        async def main():
            lock = tools._ComputerRunLock(PIN, 30.0)
            task = asyncio.ensure_future(lock.__aenter__())
            await asyncio.sleep(0.4)
            self.assertTrue(tools._in_process_lock(PIN).locked())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertIsNone(lock._file)

        try:
            asyncio.run(main())
            self.assertFalse(tools._in_process_lock(PIN).locked())
        finally:
            tools.fcntl.flock(holder.fileno(), tools.fcntl.LOCK_UN)
            holder.close()
        self.assertFalse(tools._run_lock_is_held(PIN))

    def test_run_lock_timeout_raises_busy_not_attribute_error(self):
        if tools.fcntl is None:
            self.skipTest("flock unavailable")
        holder = self._hold_lock_file()

        async def main():
            lock = tools._ComputerRunLock(PIN, 0.0)
            with self.assertRaises(tools.OrgoAgentRequestError) as caught:
                await lock.__aenter__()
            self.assertIn("Another agent is controlling", str(caught.exception))

        try:
            asyncio.run(main())
        finally:
            tools.fcntl.flock(holder.fileno(), tools.fcntl.LOCK_UN)
            holder.close()
        self.assertFalse(tools._in_process_lock(PIN).locked())
        self.assertFalse(tools._run_lock_is_held(PIN))

    def test_run_lock_open_failure_releases_process_lock(self):
        if tools.fcntl is None:
            self.skipTest("flock unavailable")

        def boom(*args, **kwargs):
            raise OSError("cannot open lock file")

        async def main():
            lock = tools._ComputerRunLock(PIN, 5.0)
            lock._path = SimpleNamespace(open=boom)
            with self.assertRaises(OSError):
                await lock.__aenter__()
            self.assertIsNone(lock._file)

        asyncio.run(main())
        self.assertFalse(tools._in_process_lock(PIN).locked())
        self.assertFalse(tools._run_lock_is_held(PIN))

    def test_schemas_exist(self):
        self.assertEqual(schemas.ORGO_COMPUTER_CLICK["name"], "orgo_computer_click")
        self.assertIn("LAST RESORT", schemas.ORGO_COMPUTER_RUN["description"])


if __name__ == "__main__":
    unittest.main()
