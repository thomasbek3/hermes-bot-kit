#!/usr/bin/env python3
"""High-performance H.264 screen-stream agent for the Computer viewer plugin.

Python 3.10+. One third-party dependency: websockets>=13,<16.
Serves Annex-B access units over WebSocket at /stream?token=<hex>.
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import os
import signal
import struct
import sys
import time
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

def import_serve():
    try:
        from websockets.asyncio.server import serve
        return serve
    except ImportError:  # websockets 13+ ships asyncio.server
        from websockets.server import serve  # type: ignore
        return serve


LOG = logging.getLogger('hiperf')
CREATE_NO_WINDOW = 0x08000000
RESTART_WINDOW_S = 60.0
DRY_RUN_TIMEOUT_S = 12.0
QUEUE_MAX = 30
MAX_MESSAGE = 2**20
GOP_DIV = 2

# Close codes (spec 4.4 / 3)
CLOSE_AUTH = 4401
CLOSE_NOT_FOUND = 4404
CLOSE_SUPERSEDED = 4409
CLOSE_PIPELINE = 1011


def os_name() -> str:
    if sys.platform == 'darwin':
        return 'darwin'
    if sys.platform == 'win32':
        return 'win32'
    return 'linux'


def parse_bitrate(raw: str) -> int:
    text = str(raw).strip().upper().replace(',', '')
    if not text:
        raise ValueError('empty bitrate')
    if text.endswith('M'):
        return int(float(text[:-1]) * 1_000_000)
    if text.endswith('K'):
        return int(float(text[:-1]) * 1_000)
    return int(text)


def read_token(path: str) -> str:
    with open(path, 'r', encoding='ascii', errors='replace') as fh:
        return fh.read().strip()


def tokens_match(got: str, expected: str) -> bool:
    a = got.encode('utf-8')
    b = expected.encode('utf-8')
    if len(a) != len(b):
        hmac.compare_digest(b, b)
        return False
    return hmac.compare_digest(a, b)


def default_log_path(token_file: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(token_file)), 'hiperf.log')


def setup_logging(log_path: str) -> None:
    parent = os.path.dirname(log_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
    LOG.setLevel(logging.INFO)
    LOG.handlers.clear()
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    LOG.addHandler(sh)
    try:
        fh = logging.FileHandler(log_path, encoding='utf-8')
        fh.setFormatter(fmt)
        LOG.addHandler(fh)
    except OSError as exc:
        LOG.warning('could not open log file %s: %s', log_path, exc)


def bitrate_flags(n: int) -> list[str]:
    return ['-b:v', str(n), '-maxrate', str(n), '-bufsize', str(max(n // 2, 1))]


def encode_tail(fps: int, pix_fmt: Optional[str] = None) -> list[str]:
    args: list[str] = []
    if pix_fmt:
        args += ['-pix_fmt', pix_fmt]
    gop = max(fps // GOP_DIV, 1)
    args += ['-g', str(gop), '-bf', '0', '-an', '-f', 'h264', '-']
    return args


def prefix_ffmpeg(ffmpeg: str) -> list[str]:
    return [ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-y']


class Candidate:
    __slots__ = ('name', 'argv')

    def __init__(self, name: str, argv: list[str]) -> None:
        self.name = name
        self.argv = argv


def discover_mac_screen_index(ffmpeg: str) -> int:
    """Parse avfoundation -list_devices stderr for 'Capture screen'."""
    try:
        proc = __import__('subprocess').run(
            [ffmpeg, '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
            capture_output=True,
            timeout=8,
            check=False,
        )
    except Exception as exc:
        LOG.warning('avfoundation list_devices failed: %s', exc)
        return 0
    text = (proc.stderr or b'').decode('utf-8', 'replace') + (proc.stdout or b'').decode('utf-8', 'replace')
    # Typical: "[1] Capture screen 0"  -- stop at audio section.
    in_video = False
    for line in text.splitlines():
        lower = line.lower()
        if 'avfoundation video devices' in lower:
            in_video = True
            continue
        if 'avfoundation audio devices' in lower:
            in_video = False
            continue
        if not in_video and 'capture screen' not in lower:
            continue
        if 'capture screen' in lower:
            # "[1] Capture screen 0" or "Capture screen 0"
            bracket = None
            if '[' in line and ']' in line:
                inner = line[line.find('[') + 1 : line.find(']')]
                if inner.isdigit():
                    bracket = int(inner)
            if bracket is not None:
                LOG.info('avfoundation capture screen index %s', bracket)
                return bracket
    LOG.warning('no Capture screen device parsed; defaulting to 0')
    return 0


def linux_render_nodes() -> list[str]:
    dri = Path('/dev/dri')
    if not dri.is_dir():
        return []
    nodes = sorted(str(p) for p in dri.glob('renderD*'))
    return nodes


def build_candidates(ffmpeg: str, fps: int, bitrate: int, display: str) -> list[Candidate]:
    plat = os_name()
    rate = bitrate_flags(bitrate)
    out: list[Candidate] = []

    if plat == 'win32':
        dda = ['-init_hw_device', 'd3d11va', '-f', 'lavfi', '-i', f'ddagrab=framerate={fps}:draw_mouse=0']
        gdi = ['-f', 'gdigrab', '-framerate', str(fps), '-draw_mouse', '0', '-i', 'desktop']
        out.append(
            Candidate(
                'h264_nvenc',
                prefix_ffmpeg(ffmpeg)
                + dda
                + [
                    '-c:v',
                    'h264_nvenc',
                    '-preset',
                    'p1',
                    '-tune',
                    'ull',
                    '-zerolatency',
                    '1',
                    '-delay',
                    '0',
                    '-rc',
                    'cbr',
                ]
                + rate
                + encode_tail(fps),
            )
        )
        out.append(
            Candidate(
                'h264_amf',
                prefix_ffmpeg(ffmpeg)
                + dda
                + ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-header_insertion_mode', 'idr']
                + rate
                + encode_tail(fps),
            )
        )
        out.append(
            Candidate(
                'h264_qsv',
                prefix_ffmpeg(ffmpeg)
                + dda
                + [
                    '-vf',
                    'hwmap=mode=direct:derive_device=qsv,format=qsv',
                    '-c:v',
                    'h264_qsv',
                    '-preset',
                    'veryfast',
                    '-async_depth',
                    '1',
                ]
                + rate
                + encode_tail(fps),
            )
        )
        out.append(
            Candidate(
                'h264_nvenc-gdi',
                prefix_ffmpeg(ffmpeg)
                + gdi
                + [
                    '-c:v',
                    'h264_nvenc',
                    '-preset',
                    'p1',
                    '-tune',
                    'ull',
                    '-zerolatency',
                    '1',
                    '-delay',
                    '0',
                    '-rc',
                    'cbr',
                ]
                + rate
                + encode_tail(fps, 'yuv420p'),
            )
        )
        out.append(
            Candidate(
                'h264_mf',
                prefix_ffmpeg(ffmpeg)
                + gdi
                + ['-c:v', 'h264_mf', '-hw_encoding', 'true', '-rate_control', 'cbr']
                + rate
                + encode_tail(fps),
            )
        )
        out.append(
            Candidate(
                'libx264',
                prefix_ffmpeg(ffmpeg)
                + gdi
                + ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']
                + rate
                + encode_tail(fps, 'yuv420p'),
            )
        )
        return out

    if plat == 'darwin':
        idx = discover_mac_screen_index(ffmpeg)
        cap = [
            '-f',
            'avfoundation',
            '-capture_cursor',
            '0',
            '-framerate',
            str(fps),
            '-i',
            f'{idx}:none',
        ]
        out.append(
            Candidate(
                'h264_videotoolbox',
                prefix_ffmpeg(ffmpeg)
                + cap
                + ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-allow_sw', '0']
                + rate
                + encode_tail(fps),
            )
        )
        out.append(
            Candidate(
                'h264_videotoolbox_sw',
                prefix_ffmpeg(ffmpeg)
                + cap
                + ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-allow_sw', '1']
                + rate
                + encode_tail(fps),
            )
        )
        out.append(
            Candidate(
                'libx264',
                prefix_ffmpeg(ffmpeg)
                + cap
                + ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']
                + rate
                + encode_tail(fps, 'yuv420p'),
            )
        )
        return out

    # linux: X11 only
    cap = ['-f', 'x11grab', '-draw_mouse', '0', '-framerate', str(fps), '-i', display]
    out.append(
        Candidate(
            'h264_nvenc',
            prefix_ffmpeg(ffmpeg)
            + cap
            + [
                '-c:v',
                'h264_nvenc',
                '-preset',
                'p1',
                '-tune',
                'ull',
                '-zerolatency',
                '1',
                '-delay',
                '0',
                '-rc',
                'cbr',
            ]
            + rate
            + encode_tail(fps),
        )
    )
    for node in linux_render_nodes():
        out.append(
            Candidate(
                f'h264_vaapi:{node}',
                prefix_ffmpeg(ffmpeg)
                + cap
                + [
                    '-init_hw_device',
                    f'vaapi=va:{node}',
                    '-vf',
                    'format=nv12,hwupload',
                    '-c:v',
                    'h264_vaapi',
                    '-rc_mode',
                    'CBR',
                ]
                + rate
                + encode_tail(fps),
            )
        )
    out.append(
        Candidate(
            'libx264',
            prefix_ffmpeg(ffmpeg)
            + cap
            + ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']
            + rate
            + encode_tail(fps, 'yuv420p'),
        )
    )
    return out


def dry_run_argv(argv: list[str]) -> list[str]:
    out = list(argv)
    if len(out) >= 3 and out[-3:] == ['-f', 'h264', '-']:
        out[-3:] = ['-t', '1', '-f', 'null', '-']
    return out


def subprocess_kwargs(stdout=asyncio.subprocess.PIPE) -> dict:
    kwargs: dict = {
        'stdin': asyncio.subprocess.DEVNULL,
        'stdout': stdout,
        'stderr': asyncio.subprocess.PIPE,
    }
    if os.name == 'nt':
        kwargs['creationflags'] = CREATE_NO_WINDOW
    else:
        kwargs['start_new_session'] = True
    return kwargs


def kill_process(proc: asyncio.subprocess.Process, force: bool = False) -> None:
    if proc.returncode is not None:
        return
    if os.name == 'nt':
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return
    sig = signal.SIGKILL if force else signal.SIGTERM
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def nal_type(nal: bytes) -> int:
    if not nal:
        return 0
    return nal[0] & 0x1F


def first_mb_zero(nal: bytes) -> bool:
    """first_mb_in_slice == 0 iff the first RBSP bit is 1 (ue(0))."""
    if len(nal) < 2:
        return False
    return (nal[1] & 0x80) != 0


def _ue(data: bytes, bitpos: int) -> tuple[Optional[int], int]:
    zeros = 0
    nbits = len(data) * 8
    while bitpos < nbits:
        byte_i = bitpos // 8
        bit_i = 7 - (bitpos % 8)
        bit = (data[byte_i] >> bit_i) & 1
        bitpos += 1
        if bit == 1:
            break
        zeros += 1
        if zeros > 31:
            return None, bitpos
    else:
        return None, bitpos
    val = (1 << zeros) - 1
    for _ in range(zeros):
        if bitpos >= nbits:
            return None, bitpos
        byte_i = bitpos // 8
        bit_i = 7 - (bitpos % 8)
        bit = (data[byte_i] >> bit_i) & 1
        bitpos += 1
        val = (val << 1) | bit
    return val, bitpos


def is_i_slice(nal: bytes) -> bool:
    """True for IDR (type 5) or non-IDR I/SI slices. VideoToolbox may emit I-slices at GOP."""
    ntype = nal_type(nal)
    if ntype == 5:
        return True
    if ntype != 1 or len(nal) < 2:
        return False
    first_mb, pos = _ue(nal[1:], 0)
    if first_mb is None:
        return False
    st, _pos = _ue(nal[1:], pos)
    if st is None:
        return False
    return st in (2, 4, 7, 9)


def split_annexb(buf: bytes) -> tuple[list[bytes], bytes]:
    """Split complete NALs (without start codes) out of buf. Remainder keeps the last incomplete."""
    n = len(buf)
    starts: list[tuple[int, int]] = []  # (index of start code, start-code length)
    i = 0
    while i < n - 2:
        if buf[i] == 0 and buf[i + 1] == 0:
            if i + 3 < n and buf[i + 2] == 0 and buf[i + 3] == 1:
                starts.append((i, 4))
                i += 4
                continue
            if buf[i + 2] == 1:
                starts.append((i, 3))
                i += 3
                continue
        i += 1
    if not starts:
        cap = 8 * 1024 * 1024
        return [], buf[-cap:] if len(buf) > cap else buf
    complete: list[bytes] = []
    for idx, (pos, sclen) in enumerate(starts):
        nal_start = pos + sclen
        if idx + 1 < len(starts):
            nal_end = starts[idx + 1][0]
            if nal_end > nal_start:
                complete.append(buf[nal_start:nal_end])
        else:
            return complete, buf[pos:]
    return complete, b''


def pack_au(nals: list[bytes]) -> bytes:
    parts: list[bytes] = []
    for nal in nals:
        parts.append(b'\x00\x00\x00\x01')
        parts.append(nal)
    return b''.join(parts)


class AuAssembler:
    """Accumulate Annex-B NALs into one AU per primary coded picture (spec 4.3)."""

    def __init__(self) -> None:
        self.prefix: list[bytes] = []  # non-VCL waiting to start a picture
        self.picture: list[bytes] = []
        self.sps: Optional[bytes] = None
        self.pps: Optional[bytes] = None

    def reset(self) -> None:
        self.prefix = []
        self.picture = []

    def _picture_has_vcl(self) -> bool:
        return any(nal_type(n) in (1, 5) for n in self.picture)

    def push(self, nal: bytes) -> Optional[tuple[bytes, bool]]:
        if not nal:
            return None
        ntype = nal_type(nal)
        if ntype == 7:
            self.sps = nal
        elif ntype == 8:
            self.pps = nal
        is_vcl = ntype in (1, 5)
        new_pic = is_vcl and first_mb_zero(nal)
        emitted: Optional[tuple[bytes, bool]] = None
        if new_pic:
            if self._picture_has_vcl():
                emitted = self._emit(self.picture)
            self.picture = self.prefix + [nal]
            self.prefix = []
        elif is_vcl:
            if self._picture_has_vcl():
                self.picture.append(nal)
            else:
                self.picture = self.prefix + [nal]
                self.prefix = []
        else:
            if self._picture_has_vcl():
                self.prefix.append(nal)
            else:
                self.prefix.append(nal)
        return emitted

    def _emit(self, nals: list[bytes]) -> Optional[tuple[bytes, bool]]:
        if not any(nal_type(n) in (1, 5) for n in nals):
            return None
        types = {nal_type(n) for n in nals}
        is_key = (5 in types) or any(is_i_slice(n) for n in nals if nal_type(n) in (1, 5))
        out = list(nals)
        if is_key:
            have = {nal_type(n) for n in out}
            prefixed: list[bytes] = []
            if 7 not in have and self.sps is not None:
                prefixed.append(self.sps)
            if 8 not in have and self.pps is not None:
                prefixed.append(self.pps)
            out = prefixed + out
        return pack_au(out), is_key


class Agent:
    def __init__(
        self,
        ffmpeg: str,
        token: str,
        fps: int,
        bitrate: int,
        display: str,
        bind: str,
        port: int,
    ) -> None:
        self.ffmpeg = ffmpeg
        self.token = token
        self.fps = fps
        self.bitrate = bitrate
        self.display = display
        self.bind = bind
        self.port = port
        self.candidates: list[Candidate] = []
        self.cursor = 0
        self.cached: Optional[Candidate] = None
        self.client = None
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.tasks: list[asyncio.Task] = []
        self.queue: Optional[asyncio.Queue] = None
        self.drop_until_key = False
        self.last_stderr = ''
        self.expected_exit = False
        self.spawn_mono = 0.0
        self.death_mono = 0.0
        self.need_restart_gap = False
        self.lock = asyncio.Lock()

    def hello_payload(self) -> dict:
        enc = self.cached.name if self.cached is not None else None
        return {
            'type': 'hello',
            'version': 1,
            'os': os_name(),
            'encoder': enc,
            'width': 0,
            'height': 0,
            'fps': self.fps,
        }

    async def send_json(self, ws, payload: dict) -> None:
        await ws.send(json.dumps(payload, separators=(',', ':')))

    async def probe_from(self, start_idx: int) -> Optional[Candidate]:
        n = len(self.candidates)
        for i in range(start_idx, n):
            cand = self.candidates[i]
            ok = await self._dry_run(cand)
            if ok:
                self.cursor = i
                self.cached = cand
                LOG.info('pipeline ready: %s', cand.name)
                return cand
            LOG.info('dry-run failed: %s', cand.name)
        self.cached = None
        return None

    async def _dry_run(self, cand: Candidate) -> bool:
        argv = dry_run_argv(cand.argv)
        LOG.info('dry-run: %s', ' '.join(argv))
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, **subprocess_kwargs(stdout=asyncio.subprocess.DEVNULL)
            )
        except FileNotFoundError:
            LOG.warning('ffmpeg not found at %s', self.ffmpeg)
            return False
        except OSError as exc:
            LOG.warning('spawn failed (%s): %s', cand.name, exc)
            return False
        stderr_task = asyncio.create_task(self._drain_stderr(proc, tag='dry-run'))
        try:
            rc = await asyncio.wait_for(proc.wait(), timeout=DRY_RUN_TIMEOUT_S)
        except asyncio.TimeoutError:
            kill_process(proc, force=True)
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except Exception:
                pass
            LOG.info('dry-run timeout: %s', cand.name)
            rc = -1
        try:
            await asyncio.wait_for(stderr_task, timeout=1)
        except Exception:
            stderr_task.cancel()
        return rc == 0

    async def _drain_stderr(self, proc: asyncio.subprocess.Process, tag: str = 'ffmpeg') -> None:
        if proc.stderr is None:
            return
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                text = line.decode('utf-8', 'replace').rstrip()
                if text:
                    self.last_stderr = text
                    LOG.info('%s: %s', tag, text)
        except Exception as exc:
            LOG.info('stderr drain ended: %s', exc)

    async def stop_ffmpeg(self) -> None:
        proc = self.proc
        self.proc = None
        q = self.queue
        self.queue = None
        tasks = list(self.tasks)
        self.tasks = []
        self.expected_exit = True
        if q is not None:
            try:
                q.put_nowait(None)
            except Exception:
                pass
        if proc is not None and proc.returncode is None:
            kill_process(proc)
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                kill_process(proc, force=True)
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2)
                except Exception:
                    pass
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.expected_exit = False
        self.drop_until_key = False

    def advance_after_death(self) -> None:
        self.death_mono = time.monotonic()
        self.need_restart_gap = True
        nxt = self.cursor + 1
        if nxt >= len(self.candidates):
            LOG.info('candidate list exhausted; next start re-probes from the top after %ss', int(RESTART_WINDOW_S))
            self.cursor = 0
            self.cached = None
        else:
            self.cached = None
            self.cursor = nxt
            LOG.info('advance candidate cursor to %s', nxt)

    async def start_ffmpeg(self, ws) -> Optional[str]:
        """Spawn cached (or next) pipeline. Returns an error code or None on success."""
        if not os.path.isfile(self.ffmpeg):
            return 'no-encoder'
        if self.need_restart_gap:
            elapsed = time.monotonic() - self.death_mono
            if elapsed < RESTART_WINDOW_S and self.cached is None and self.cursor == 0:
                wait_s = RESTART_WINDOW_S - elapsed
                LOG.info('rate-limit: waiting %.1fs before pipeline restart', wait_s)
                try:
                    await asyncio.sleep(wait_s)
                except asyncio.CancelledError:
                    raise
                if self.client is not ws:
                    return 'capture-failed'
            self.need_restart_gap = False
        if self.cached is None:
            await self.probe_from(self.cursor)
        if self.cached is None:
            await self.probe_from(0)
        if self.cached is None:
            return 'capture-failed'
        await self.stop_ffmpeg()
        cand = self.cached
        self.last_stderr = ''
        LOG.info('starting ffmpeg (%s)', cand.name)
        try:
            proc = await asyncio.create_subprocess_exec(*cand.argv, **subprocess_kwargs())
        except FileNotFoundError:
            return 'no-encoder'
        except OSError as exc:
            LOG.warning('ffmpeg spawn failed: %s', exc)
            return 'capture-failed'
        self.proc = proc
        self.spawn_mono = time.monotonic()
        self.queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self.drop_until_key = False
        assembler = AuAssembler()
        t0 = time.monotonic()
        self.tasks = [
            asyncio.create_task(self._drain_stderr(proc), name='stderr'),
            asyncio.create_task(self._read_stdout(ws, proc, assembler, t0), name='stdout'),
            asyncio.create_task(self._writer(ws, self.queue), name='writer'),
            asyncio.create_task(self._watch_proc(ws, proc), name='watch'),
        ]
        try:
            await self.send_json(ws, self.hello_payload())
        except Exception as exc:
            LOG.warning('hello after spawn failed: %s', exc)
            await self.stop_ffmpeg()
            return 'capture-failed'
        return None

    async def _read_stdout(
        self,
        ws,
        proc: asyncio.subprocess.Process,
        assembler: AuAssembler,
        t0: float,
    ) -> None:
        if proc.stdout is None:
            return
        buf = b''
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                nals, buf = split_annexb(buf)
                now = time.monotonic()
                ts = int((now - t0) * 1_000_000)
                if ts < 0:
                    ts = 0
                for nal in nals:
                    emitted = assembler.push(nal)
                    if emitted is None:
                        continue
                    au_bytes, is_key = emitted
                    await self._enqueue(au_bytes, is_key, ts)
            if assembler._picture_has_vcl():
                flushed = assembler._emit(assembler.picture)
                assembler.reset()
                if flushed is not None:
                    now = time.monotonic()
                    ts = int((now - t0) * 1_000_000)
                    if ts < 0:
                        ts = 0
                    au_bytes, is_key = flushed
                    await self._enqueue(au_bytes, is_key, ts)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            LOG.info('stdout reader ended: %s', exc)

    async def _enqueue(self, au_bytes: bytes, is_key: bool, ts: int) -> None:
        q = self.queue
        if q is None:
            return
        flags = 1 if is_key else 0
        packet = struct.pack('>BQ', flags, ts) + au_bytes
        if self.drop_until_key:
            if not is_key:
                return
            self.drop_until_key = False
        if q.full():
            while not q.empty():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    break
            self.drop_until_key = True
            if not is_key:
                return
            self.drop_until_key = False
        try:
            q.put_nowait(packet)
        except asyncio.QueueFull:
            self.drop_until_key = not is_key
            if is_key:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(packet)
                except asyncio.QueueFull:
                    pass

    async def _writer(self, ws, queue: asyncio.Queue) -> None:
        try:
            while True:
                item = await queue.get()
                if item is None:
                    return
                if self.client is not ws:
                    return
                await ws.send(item)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            LOG.info('writer ended: %s', exc)

    async def _watch_proc(self, ws, proc: asyncio.subprocess.Process) -> None:
        try:
            rc = await proc.wait()
        except asyncio.CancelledError:
            raise
        if self.expected_exit:
            return
        if self.proc is not proc:
            return
        LOG.warning('ffmpeg exited rc=%s last=%s', rc, self.last_stderr)
        self.proc = None
        self.advance_after_death()
        if self.client is ws:
            try:
                await self.send_json(
                    ws,
                    {
                        'type': 'error',
                        'code': 'ffmpeg-died',
                        'message': self.last_stderr or f'ffmpeg exited {rc}',
                    },
                )
            except Exception:
                pass
            try:
                await ws.close(CLOSE_PIPELINE, 'ffmpeg-died')
            except Exception:
                pass

    async def handler(self, websocket) -> None:
        path = ''
        try:
            path = websocket.request.path  # includes query string
        except Exception:
            path = getattr(websocket, 'path', '') or ''
        parsed = urlparse(path)
        if parsed.path != '/stream':
            LOG.info('reject path %s', parsed.path)
            await websocket.close(CLOSE_NOT_FOUND, 'not found')
            return
        qs = parse_qs(parsed.query)
        got = (qs.get('token') or [''])[0]
        if not tokens_match(got, self.token):
            LOG.info('auth failed')
            await websocket.close(CLOSE_AUTH, 'unauthorized')
            return

        async with self.lock:
            old = self.client
            self.client = websocket
            await self.stop_ffmpeg()
            if old is not None and old is not websocket:
                try:
                    await old.close(CLOSE_SUPERSEDED, 'superseded')
                except Exception:
                    pass
            try:
                await self.send_json(websocket, self.hello_payload())
            except Exception as exc:
                LOG.warning('hello failed: %s', exc)
                if self.client is websocket:
                    self.client = None
                return

        LOG.info('client attached')
        try:
            async for message in websocket:
                if isinstance(message, (bytes, bytearray)):
                    continue
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue
                kind = data.get('type')
                if kind == 'ping':
                    try:
                        await self.send_json(websocket, {'type': 'pong', 't': data.get('t')})
                    except Exception:
                        break
                elif kind == 'start':
                    if self.client is not websocket:
                        break
                    err = await self.start_ffmpeg(websocket)
                    if err:
                        try:
                            await self.send_json(
                                websocket,
                                {
                                    'type': 'error',
                                    'code': err,
                                    'message': self.last_stderr or err,
                                },
                            )
                            await websocket.close(CLOSE_PIPELINE, err)
                        except Exception:
                            pass
                        break
                elif kind == 'stop':
                    await self.stop_ffmpeg()
        except Exception as exc:
            LOG.info('client loop ended: %s', exc)
        finally:
            async with self.lock:
                if self.client is websocket:
                    await self.stop_ffmpeg()
                    self.client = None
                    LOG.info('client detached')


async def amain(args: argparse.Namespace) -> None:
    token = read_token(args.token_file)
    if not token:
        LOG.error('token file is empty: %s', args.token_file)
        sys.exit(2)
    ffmpeg = os.path.abspath(args.ffmpeg)
    bitrate = parse_bitrate(args.bitrate)
    fps = int(args.fps)
    if fps < 1:
        fps = 30
    agent = Agent(
        ffmpeg=ffmpeg,
        token=token,
        fps=fps,
        bitrate=bitrate,
        display=args.display,
        bind=args.bind,
        port=int(args.port),
    )
    agent.candidates = build_candidates(ffmpeg, fps, bitrate, args.display)
    if not agent.candidates:
        LOG.error('no pipeline candidates for this OS')
        sys.exit(2)
    LOG.info('probing %s candidates', len(agent.candidates))
    await agent.probe_from(0)
    if agent.cached is None:
        LOG.warning('no pipeline passed dry-run; agent will answer capture-failed until one works')

    LOG.info('listening on %s:%s /stream', args.bind, args.port)
    serve = import_serve()
    async with serve(
        agent.handler,
        args.bind,
        int(args.port),
        compression=None,
        ping_interval=20,
        ping_timeout=20,
        max_size=MAX_MESSAGE,
    ):
        stop = asyncio.get_running_loop().create_future()

        def _stop(*_a: object) -> None:
            if not stop.done():
                stop.set_result(True)

        try:
            signal.signal(signal.SIGTERM, _stop)
            signal.signal(signal.SIGINT, _stop)
        except Exception:
            pass
        await stop
        await agent.stop_ffmpeg()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description='Computer viewer high-performance H.264 agent')
    p.add_argument('--port', type=int, default=6090)
    p.add_argument('--token-file', required=True)
    p.add_argument('--ffmpeg', required=True, help='absolute path to ffmpeg')
    p.add_argument('--fps', type=int, default=30)
    p.add_argument('--bitrate', default='8M')
    p.add_argument('--display', default=':0')
    p.add_argument('--bind', default='0.0.0.0')
    return p


def main() -> None:
    args = build_parser().parse_args()
    log_path = default_log_path(args.token_file)
    setup_logging(log_path)
    LOG.info('hiperf-agent starting log=%s ffmpeg=%s', log_path, args.ffmpeg)
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
