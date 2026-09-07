#!/usr/bin/env python3
"""Unit tests for computer-viewer/hiperf-agent.py.

The agent is a script, not a package, so it is loaded by path with importlib.
Loading it must not start a server, spawn ffmpeg or write a log file: the
script guards all of that behind `if __name__ == '__main__'`.

Run: python3 computer-viewer/tests/test-hiperf-agent.py -v
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_PATH = os.path.join(os.path.dirname(HERE), 'hiperf-agent.py')


def load_agent_module():
    spec = importlib.util.spec_from_file_location('hiperf_agent_under_test', AGENT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError('could not build an import spec for ' + AGENT_PATH)
    module = importlib.util.module_from_spec(spec)
    # Never '__main__': main() must not run on import.
    spec.loader.exec_module(module)
    return module


agent_mod = load_agent_module()

TOKEN = 'a1b2c3d4e5f6'


def bits_to_bytes(bits: str) -> bytes:
    padded = bits + '0' * ((8 - len(bits) % 8) % 8)
    return bytes(int(padded[i:i + 8], 2) for i in range(0, len(padded), 8))


def slice_nal(nal_type: int, first_mb_bits: str, slice_type_bits: str) -> bytes:
    """One byte of NAL header plus an RBSP holding ue(first_mb) ue(slice_type)."""
    header = bytes([nal_type & 0x1F])
    return header + bits_to_bytes(first_mb_bits + slice_type_bits + '1')


class FakeRequest:
    def __init__(self, path: str) -> None:
        self.path = path


class FakeWS:
    """Async-iterable stand-in for a websockets connection."""

    # A deque plus polling, not an asyncio.Queue, so a FakeWS can be built
    # outside a running event loop.
    POLL_S = 0.001

    def __init__(self, path: str = '/stream', messages=None) -> None:
        self.request = FakeRequest(path)
        self.sent: list = []
        self.closed: list = []
        self._pending: list = list(messages or [])
        self._eof = False

    # -- recorders ---------------------------------------------------------
    async def send(self, payload) -> None:
        self.sent.append(payload)

    async def close(self, code=1000, reason='') -> None:
        self.closed.append((code, reason))
        self.eof()

    # -- test helpers ------------------------------------------------------
    def push(self, message) -> None:
        self._pending.append(message)

    def eof(self) -> None:
        self._eof = True

    def json_sent(self) -> list:
        import json

        out = []
        for item in self.sent:
            if isinstance(item, str):
                try:
                    out.append(json.loads(item))
                except ValueError:
                    pass
        return out

    def hello_count(self) -> int:
        return len([m for m in self.json_sent() if m.get('type') == 'hello'])

    # -- async iterator ----------------------------------------------------
    def __aiter__(self):
        return self

    async def __anext__(self):
        while True:
            if self._pending:
                return self._pending.pop(0)
            if self._eof:
                raise StopAsyncIteration
            await asyncio.sleep(self.POLL_S)


def auth_frame(token: str = TOKEN) -> str:
    import json

    return json.dumps({'type': 'auth', 'token': token})


def make_agent(ffmpeg: str = '') -> object:
    return agent_mod.Agent(
        ffmpeg=ffmpeg or sys.executable,
        token=TOKEN,
        fps=30,
        bitrate=1_000_000,
        display=':0',
        bind='127.0.0.1',
        port=6090,
    )


async def settle(times: int = 20) -> None:
    """Let the polling FakeWS iterator and the handler make progress."""
    for _ in range(times):
        await asyncio.sleep(0.005)


class TestExpGolomb(unittest.TestCase):
    def test_ue_vectors(self):
        vectors = [
            ('1', 0),
            ('010', 1),
            ('011', 2),
            ('00100', 3),
            ('00111', 6),
            ('0001000', 7),
        ]
        for bits, expected in vectors:
            with self.subTest(bits=bits):
                val, pos = agent_mod._ue(bits_to_bytes(bits), 0)
                self.assertEqual(val, expected)
                self.assertEqual(pos, len(bits))

    def test_ue_runs_out_of_bits(self):
        val, _pos = agent_mod._ue(bits_to_bytes('0000'), 0)
        self.assertIsNone(val)


class TestIsISlice(unittest.TestCase):
    def test_idr_is_key(self):
        self.assertTrue(agent_mod.is_i_slice(bytes([5, 0x80])))

    def test_non_idr_i_slice_type_2(self):
        # first_mb_in_slice = ue(0) = '1', slice_type = ue(2) = '011'
        self.assertTrue(agent_mod.is_i_slice(slice_nal(1, '1', '011')))

    def test_non_idr_i_slice_type_7(self):
        # slice_type = ue(7) = '0001000'
        self.assertTrue(agent_mod.is_i_slice(slice_nal(1, '1', '0001000')))

    def test_b_slice_type_1(self):
        # slice_type = ue(1) = '010'
        self.assertFalse(agent_mod.is_i_slice(slice_nal(1, '1', '010')))

    def test_b_slice_type_6(self):
        # slice_type = ue(6) = '00111'
        self.assertFalse(agent_mod.is_i_slice(slice_nal(1, '1', '00111')))


class TestAuth(unittest.TestCase):
    def run_handler(self, ws) -> None:
        async def go():
            agent = make_agent()
            await asyncio.wait_for(agent.handler(ws), timeout=5)

        asyncio.run(go())

    def test_good_auth_frame_gets_hello(self):
        ws = FakeWS('/stream', [auth_frame()])
        ws.eof()
        self.run_handler(ws)
        self.assertEqual(ws.hello_count(), 1)
        self.assertEqual(ws.closed, [])

    def test_bad_token_in_auth_frame_closes(self):
        ws = FakeWS('/stream', [auth_frame('deadbeef')])
        ws.eof()
        self.run_handler(ws)
        self.assertEqual(ws.hello_count(), 0)
        self.assertEqual([c[0] for c in ws.closed], [agent_mod.CLOSE_AUTH])

    def test_non_auth_first_frame_closes(self):
        ws = FakeWS('/stream', ['{"type":"ping"}'])
        ws.eof()
        self.run_handler(ws)
        self.assertEqual(ws.hello_count(), 0)
        self.assertEqual([c[0] for c in ws.closed], [agent_mod.CLOSE_AUTH])

    def test_garbage_first_frame_closes(self):
        ws = FakeWS('/stream', ['not json at all'])
        ws.eof()
        self.run_handler(ws)
        self.assertEqual(ws.hello_count(), 0)
        self.assertEqual([c[0] for c in ws.closed], [agent_mod.CLOSE_AUTH])

    def test_binary_first_frame_closes(self):
        ws = FakeWS('/stream', [b'\x00\x01\x02'])
        ws.eof()
        self.run_handler(ws)
        self.assertEqual(ws.hello_count(), 0)
        self.assertEqual([c[0] for c in ws.closed], [agent_mod.CLOSE_AUTH])

    def test_auth_timeout_closes(self):
        async def go():
            agent = make_agent()
            ws = FakeWS('/stream', [])  # never sends anything
            saved = agent_mod.AUTH_TIMEOUT_S
            agent_mod.AUTH_TIMEOUT_S = 0.05
            try:
                await asyncio.wait_for(agent.handler(ws), timeout=5)
            finally:
                agent_mod.AUTH_TIMEOUT_S = saved
            return ws

        ws = asyncio.run(go())
        self.assertEqual(ws.hello_count(), 0)
        self.assertEqual([c[0] for c in ws.closed], [agent_mod.CLOSE_AUTH])

    def test_legacy_query_token_still_works(self):
        ws = FakeWS('/stream?token=' + TOKEN, [])
        ws.eof()
        self.run_handler(ws)
        self.assertEqual(ws.hello_count(), 1)
        self.assertEqual(ws.closed, [])

    def test_legacy_query_token_bad_closes(self):
        ws = FakeWS('/stream?token=nope', [])
        ws.eof()
        self.run_handler(ws)
        self.assertEqual(ws.hello_count(), 0)
        self.assertEqual([c[0] for c in ws.closed], [agent_mod.CLOSE_AUTH])

    def test_wrong_path_is_not_found(self):
        ws = FakeWS('/nope', [])
        ws.eof()
        self.run_handler(ws)
        self.assertEqual([c[0] for c in ws.closed], [agent_mod.CLOSE_NOT_FOUND])


class TestClientGeneration(unittest.TestCase):
    """A superseded client must not spawn over the live client's pipeline."""

    def _run(self):
        spawns: list = []

        async def fake_exec(*argv, **kwargs):
            spawns.append(list(argv))
            raise FileNotFoundError('stubbed: no ffmpeg here')

        async def go():
            agent = make_agent()
            agent.candidates = [agent_mod.Candidate('stub', [sys.executable, '-c', 'pass'])]
            agent.cached = agent.candidates[0]
            first = FakeWS('/stream', [auth_frame()])
            second = FakeWS('/stream', [auth_frame()])

            task_a = asyncio.create_task(agent.handler(first))
            await settle()
            self.assertEqual(first.hello_count(), 1, 'first client did not attach')
            gen_a = agent.client_gen

            task_b = asyncio.create_task(agent.handler(second))
            await settle()
            self.assertEqual(second.hello_count(), 1, 'second client did not attach')
            self.assertGreater(agent.client_gen, gen_a)
            self.assertEqual(
                [c[0] for c in first.closed], [agent_mod.CLOSE_SUPERSEDED]
            )

            # The superseded client's late 'start' must spawn nothing.
            first.push('{"type":"start"}')
            await settle()
            stale_spawns = list(spawns)

            # Control: the live client's 'start' does reach the spawn.
            second.push('{"type":"start"}')
            await settle()
            live_spawns = list(spawns)

            first.eof()
            second.eof()
            await asyncio.wait_for(asyncio.gather(task_a, task_b), timeout=5)
            return stale_spawns, live_spawns

        old_exec = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            return asyncio.run(go())
        finally:
            asyncio.create_subprocess_exec = old_exec

    def test_stale_start_does_not_spawn(self):
        stale_spawns, live_spawns = self._run()
        self.assertEqual(stale_spawns, [], 'superseded client spawned a pipeline')
        self.assertEqual(len(live_spawns), 1, 'live client did not spawn')

    def test_stale_start_ffmpeg_returns_superseded(self):
        async def go():
            agent = make_agent()
            first = FakeWS('/stream')
            second = FakeWS('/stream')
            agent.client = first
            agent.client_gen = 1
            gen_a = agent.client_gen
            agent.client = second
            agent.client_gen = 2
            agent.candidates = [agent_mod.Candidate('stub', ['x'])]
            agent.cached = agent.candidates[0]
            return await agent.start_ffmpeg(first, gen_a)

        self.assertEqual(asyncio.run(go()), 'superseded')

    def test_stale_stop_ffmpeg_is_ignored(self):
        async def go():
            agent = make_agent()
            first = FakeWS('/stream')
            second = FakeWS('/stream')
            agent.client = first
            agent.client_gen = 1
            agent.drop_until_key = True
            marker = object()
            agent.proc = marker  # type: ignore[assignment]
            agent.client = second
            agent.client_gen = 2
            await agent.stop_ffmpeg(first, 1)
            return agent.proc is marker

        self.assertTrue(asyncio.run(go()), 'stale stop tore down the live pipeline')


class FakeProc:
    """Stand-in for asyncio.subprocess.Process that exits only when released."""

    def __init__(self, returncode=None) -> None:
        self.returncode = returncode
        self.stdout = None
        self.stderr = None
        self.pid = -1
        self.exit_gate = asyncio.Event()
        if returncode is not None:
            self.exit_gate.set()

    async def wait(self):
        await self.exit_gate.wait()
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class TestPipelineOwnership(unittest.TestCase):
    """A superseded client must not write into the live client's pipeline."""

    def test_probe_from_writes_no_shared_state(self):
        async def go():
            agent = make_agent()
            agent.candidates = [
                agent_mod.Candidate('a', ['a']),
                agent_mod.Candidate('b', ['b']),
            ]
            agent.cursor = 7
            agent.cached = None

            async def fake_dry_run(cand, ws=None, gen=None):
                return cand.name == 'b'

            agent._dry_run = fake_dry_run
            found = await agent.probe_from(0)
            return found, agent.cursor, agent.cached

        found, cursor, cached = asyncio.run(go())
        self.assertEqual(found[0], 1)
        self.assertEqual(found[1].name, 'b')
        self.assertEqual(cursor, 7, 'probe_from wrote the cursor')
        self.assertIsNone(cached, 'probe_from wrote cached')

    def test_paused_probe_does_not_clobber_the_new_clients_choice(self):
        """Client A parks inside its probe; B attaches and picks a candidate.

        A's probe result must be dropped, not committed over B's choice.
        """

        async def go():
            agent = make_agent()
            agent.candidates = [
                agent_mod.Candidate('a', ['a']),
                agent_mod.Candidate('b', ['b']),
            ]
            gate = asyncio.Event()

            async def fake_dry_run(cand, ws=None, gen=None):
                if cand.name == 'a':
                    await gate.wait()
                return True

            agent._dry_run = fake_dry_run
            first = FakeWS('/stream')
            second = FakeWS('/stream')
            agent.client = first
            agent.client_gen = 1
            agent.cursor = 0
            agent.cached = None

            task_a = asyncio.create_task(agent.start_ffmpeg(first, 1))
            await settle(2)  # A is parked inside the dry-run for candidate 'a'

            # B takes over and settles on candidate 'b'.
            agent.client = second
            agent.client_gen = 2
            agent.cursor = 1
            agent.cached = agent.candidates[1]

            gate.set()
            err = await asyncio.wait_for(task_a, timeout=5)
            return err, agent.cursor, agent.cached.name

        err, cursor, cached_name = asyncio.run(go())
        self.assertEqual(err, 'superseded')
        self.assertEqual(cached_name, 'b', "stale probe overwrote the live client's encoder")
        self.assertEqual(cursor, 1, "stale probe overwrote the live client's cursor")

    def test_stop_cancels_readers_before_awaiting_the_process(self):
        """The reader is cancelled first, so it cannot outlive the teardown."""

        killed: list = []

        async def go():
            agent = make_agent()
            ws = FakeWS('/stream')
            proc = FakeProc()  # never exits until released
            agent.client = ws
            agent.client_gen = 1
            agent.proc = proc
            agent.queue = asyncio.Queue(maxsize=4)

            async def forever():
                await asyncio.sleep(3600)

            reader = asyncio.create_task(forever())
            agent.tasks = [reader]
            await settle(2)

            stop = asyncio.create_task(agent.stop_ffmpeg(ws, 1))
            await settle(4)  # stop is now parked on proc.wait()
            cancelled_before_exit = reader.done()

            proc.exit_gate.set()
            await asyncio.wait_for(stop, timeout=5)
            return cancelled_before_exit, reader.cancelled()

        old_kill = agent_mod.kill_process
        agent_mod.kill_process = lambda proc, force=False: killed.append(force)
        try:
            cancelled_before_exit, was_cancelled = asyncio.run(go())
        finally:
            agent_mod.kill_process = old_kill
        self.assertTrue(
            cancelled_before_exit,
            'stop_ffmpeg awaited the process while its reader was still running',
        )
        self.assertTrue(was_cancelled)

    def test_late_frame_from_a_stale_reader_misses_the_new_queue(self):
        """A reader that survived the cancel must not reach the new pipeline."""

        async def go():
            agent = make_agent()
            first = FakeWS('/stream')
            second = FakeWS('/stream')
            proc_a = FakeProc(returncode=0)
            old_q = asyncio.Queue(maxsize=1)
            agent.client = first
            agent.client_gen = 1
            agent.proc = proc_a
            agent.queue = old_q
            old_q.put_nowait(b'old')  # full, so a stale write would set drop state

            await agent.stop_ffmpeg(first, 1)

            # B attaches with a pipeline of its own.
            new_q = asyncio.Queue(maxsize=agent_mod.QUEUE_MAX)
            agent.client = second
            agent.client_gen = 2
            agent.proc = FakeProc(returncode=0)
            agent.queue = new_q
            agent.drop_until_key = False

            # A's reader still holds (first, gen 1, proc_a, old_q).
            await agent._enqueue(first, 1, proc_a, old_q, b'\x00\x00\x00\x01\x65', True, 0)
            return new_q.qsize(), agent.drop_until_key

        new_size, drop = asyncio.run(go())
        self.assertEqual(new_size, 0, "a stale frame reached the live client's queue")
        self.assertFalse(drop, "a stale frame flipped the live client's drop state")

    def test_stale_stderr_does_not_overwrite_live_diagnostics(self):
        async def go():
            agent = make_agent()
            first = FakeWS('/stream')
            second = FakeWS('/stream')
            agent.client = second
            agent.client_gen = 2
            agent.last_stderr = 'live error'
            agent.record_stderr('stale error', ws=first, gen=1)
            stale = agent.last_stderr
            agent.record_stderr('newer error', ws=second, gen=2)
            return stale, agent.last_stderr

        stale, live = asyncio.run(go())
        self.assertEqual(stale, 'live error')
        self.assertEqual(live, 'newer error')

    def test_watch_proc_ignores_an_exit_from_a_replaced_process(self):
        """Process identity, not a global expected_exit flag, is the guard."""

        async def go():
            agent = make_agent()
            ws = FakeWS('/stream')
            agent.client = ws
            agent.client_gen = 1
            old_proc = FakeProc(returncode=0)
            agent.proc = FakeProc()  # the live one
            agent.cursor = 3
            await asyncio.wait_for(agent._watch_proc(ws, 1, old_proc), timeout=5)
            return agent.cursor, ws.json_sent(), ws.closed

        cursor, sent, closed = asyncio.run(go())
        self.assertEqual(cursor, 3, 'a replaced process advanced the live cursor')
        self.assertEqual(sent, [])
        self.assertEqual(closed, [])

    def test_agent_has_no_global_expected_exit_flag(self):
        async def go():
            return hasattr(make_agent(), 'expected_exit')

        self.assertFalse(asyncio.run(go()))


if __name__ == '__main__':
    unittest.main()
