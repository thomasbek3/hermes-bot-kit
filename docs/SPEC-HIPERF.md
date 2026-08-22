# SPEC — `computer-viewer` High-Performance Streaming Mode ("hiperf")

**Status:** Resolved spec v1.1, ready to build. v1.0 was adversarially reviewed by Grok 4.6 xhigh (26 findings, `build/grok-hiperf-review.log`); all blocker/major findings are incorporated below. Builds ON TOP of the shipped v1 plugin (`~/Documents/hermes-computer-viewer/plugin.js`, rounds 1–18 complete). Do not re-litigate decisions marked **DECIDED**. Sections marked **VERIFY AT RUNTIME** are the only genuinely unknown points; each has a prescribed fallback.

**Goal:** An optional, per-endpoint "Parsec-class" upgrade path for machines with real GPUs: hardware screen capture + hardware H.264 encode on the host, hardware decode in the plugin, 30–60fps smooth motion — while VNC remains the universal default, the input channel, and the automatic fallback. Target user: tinkerers willing to run one installer script on the remote box.

---

## 1. Positioning & rationale — DECIDED

- **VNC stays mandatory.** A hiperf endpoint is a *decorated* VNC endpoint, never a replacement. The RFB connection stays alive underneath at all times: it carries all mouse/keyboard input, serves as the instant fallback surface, and remains the master of the pane's state machine.
- **hiperf applies to `websocket`-mode endpoints only** (including probe-promoted ones). `iframe` and `session-json` endpoints ignore `hiperfEnabled` entirely — no socket attempt, no errors. (Iframe mode has no RFB surface to layer over; session-json hosts are public API hosts where a derived `ws://host:6090` URL would be both wrong and refused by the private-host guard.)
- **Why not WebRTC/UDP (the "real Parsec" transport):** on the links this plugin targets — localhost, Tailscale, LAN — packet loss is near zero, so TCP head-of-line blocking rarely bites. The dominant wins (GPU capture, GPU encode, GPU decode, no JS pixel pushing) are all delivered by H.264-over-WebSocket + WebCodecs at ~10% of the complexity of WebRTC signaling/ICE/DTLS/SRTP. WebRTC is the named v2 upgrade path (§11).
- **Why input stays on VNC:** noVNC's input path is battle-tested and already wired. The video layer renders *on top of* the live RFB canvas with `pointer-events: none`; all pointer/keyboard events fall through to the RFB surface exactly as today. Zero new input code, and if the video layer dies you're looking at live VNC within one frame.
- **No-GPU hosts (e.g. the 1-vCPU Orgo box):** ffmpeg falls back to `libx264 -preset ultrafast`. README must set expectations: hiperf pays off on machines with hardware encoders.

---

## 2. Deliverables

| File | Description |
|---|---|
| `plugin.js` | Modified in place (single-ESM constraint unchanged): hiperf client path (§6). |
| `hiperf-agent.py` | New, repo root. Single-file Python 3.10+ host agent, shared across all three OSes (§4–5). |
| `hiperf-mac.sh` | New installer (brew ffmpeg, venv, LaunchAgent). |
| `hiperf-windows.ps1` | New installer (winget ffmpeg + Python, venv, Scheduled Task). |
| `hiperf-linux.sh` | New installer (apt/dnf/yum/pacman ffmpeg — same manager detection as connect-linux.sh — venv, systemd-user). |
| `README.md` | New section "High-performance mode (optional)": what it is, per-OS one-liners, security notes, limitations. |
| `docs/SPEC-HIPERF.md` | This file, copied into the repo. |

All plugin platform constraints from SPEC.md §2 still apply verbatim (single ESM file, three import specifiers, no JSX, disposer hygiene, `node --check`). All scripts **pure ASCII, zero non-ASCII bytes** (round-17 lesson; verify with a byte scan before done). Installers are fetched via `curl`/`irm` from `RAW_REPO_URL` = `https://raw.githubusercontent.com/thomasbek3/hermes-computer-viewer/master` — exactly the value `localSetupCommand()` already uses in plugin.js.

**Installer relationship to the connect-* scripts:** mirror their *style* (idempotent re-runs, self-elevation pattern on Windows, printed endpoint values at the end) but NOT their service identity — the deltas are deliberate and listed in §5. Where this spec and a connect script disagree, this spec wins for hiperf files.

---

## 3. Architecture — DECIDED

```
HOST (remote box)                              CLIENT (plugin.js in Hermes)
┌───────────────────────────────┐   WebSocket  ┌──────────────────────────────────┐
│ hiperf-agent.py               │  ─────────►  │ HiperfClient                      │
│  ├─ token auth (query param)  │  binary AUs  │  ├─ WebCodecs VideoDecoder        │
│  ├─ spawns ffmpeg:            │  + JSON ctrl │  ├─ canvas 2D drawImage per frame │
│  │   capture+encode pipeline  │              │  └─ stats (fps, Mbps, rtt)        │
│  │   from the per-OS          │              │                                   │
│  │   candidate list (§4.1),   │              │  Layering (inside engine.         │
│  │   dry-run-probed at start  │              │  surfaceEl):                      │
│  │   → Annex-B H.264 stdout   │              │   [hiperf canvas, last child,     │
│  ├─ AU assembler + key detect │              │    pointer-events:none, z above]  │
│  └─ backpressure frame-drop   │              │   [noVNC RFB canvas] ← beneath,   │
└───────────────────────────────┘              │    receives ALL input, is the     │
                                               │    instant fallback               │
                                               └──────────────────────────────────┘
```

- One agent per host, default port **6090** (6080/6081 taken by websockify conventions), path `/stream`, token in query string. Any other path → close 4404.
- **Single viewer:** a new *authenticated* connection supersedes the old one. Ordering is fixed: auth the new socket → close the old socket (code 4409) and fully stop its ffmpeg → then send `hello` to the new client. Two ffmpeg processes must never overlap. `start` is not processed before auth succeeds.
- ffmpeg runs only while a client is attached and has sent `start`; idle agent spawns no capture process (~0 CPU).

---

## 4. Host agent — `hiperf-agent.py` — DECIDED

Python 3.10+ (same floor as connect-windows.ps1's check), exactly one third-party dependency, **pinned:** `websockets>=13,<16`. v13 changed the handler signature — use the modern API only:

```python
async def handler(websocket):
    path = websocket.request.path   # includes query string
```

`serve(handler, bind, port, compression=None, ping_interval=20, ping_timeout=20, max_size=2**20)` — `compression=None` is mandatory (deflating H.264 burns CPU and adds latency for zero gain).

**CLI:** `hiperf-agent.py --port 6090 --token-file <path> --ffmpeg <absolute-path-to-ffmpeg> [--fps 30] [--bitrate 8M] [--display :0] [--bind 0.0.0.0]`

`--ffmpeg` is **required** and always passed by the installers with an absolute path resolved at install time — service contexts (launchd, systemd-user, Scheduled Tasks) have bare PATHs that do not contain brew/winget/apt install locations. `--bitrate` accepts `8M`/`8000000`; parse to an integer (`8M` → 8_000_000) and derive `-b:v {n} -maxrate {n} -bufsize {n//2}` from the integer.

### 4.1 ffmpeg pipeline candidates per OS

Each candidate is a **complete argv** (capture + filters + encoder). At agent startup, dry-run candidates in order (`-t 1 -f null -`, **12s timeout** — hardware capture+encoder init on virtual displays exceeds 2s; live-verified 2026-08-22) and cache the first success; report it in `hello.encoder`. If the cached pipeline later dies at runtime, advance to the next candidate (a runtime death re-probes from the next entry, not from the top). Never select by `-encoders` name listing alone — Gyan's build lists `h264_nvenc` on boxes with no NVIDIA GPU; only a dry-run proves a pipeline.

Common encode tail for all candidates: `-g {fps//2} -bf 0 -an -f h264 -` (raw Annex-B to stdout; no B-frames — decode order == presentation order, required by the client). GOP = fps/2 (≈500ms at 30fps) — this is the recovery bound for the drop path (§4.3) and acceptance criterion 8; do not change one without the other. `-pix_fmt yuv420p` appears **only** in software-path candidates (it fights GPU frames). `-profile:v main` may be silently ignored by hw encoders; the client parses the real profile from the SPS (§6.2) and never relies on it.

**Windows (ordered):**
1. `-init_hw_device d3d11va -f lavfi -i ddagrab=framerate={fps}:draw_mouse=0` → `h264_nvenc -preset p1 -tune ull -zerolatency 1 -delay 0 -rc cbr -b:v ...`
2. same ddagrab input → `h264_amf -usage ultralowlatency -header_insertion_mode idr`
3. same ddagrab input + `-vf hwmap=mode=direct:derive_device=qsv,format=qsv` → `h264_qsv -preset veryfast -async_depth 1`
4. `-f gdigrab -framerate {fps} -draw_mouse 0 -i desktop` → `h264_nvenc` (same flags as candidate 1) — **live-verified essential**: on headless boxes with virtual displays (Amyuni IDD), ddagrab/DXGI duplication hangs producing no frames while gdigrab works; this candidate pairs the working capture with hardware encode (verified on the RTX 2060 SUPER box: `h264_nvenc-gdi` selected, Main-profile 1920x1080 stream healthy).
5. same gdigrab input → `h264_mf -hw_encoding true -rate_control cbr`
6. same gdigrab input → `libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p`

**macOS (ordered):** capture for all: `-f avfoundation -capture_cursor 0 -framerate {fps} -i "{screen_idx}:none"` — screen_idx discovered by parsing `-list_devices true` stderr for "Capture screen" (**VERIFY AT RUNTIME:** line format across macOS versions).
1. `h264_videotoolbox -realtime 1 -allow_sw 0`
2. `h264_videotoolbox -realtime 1 -allow_sw 1`
3. `libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p`

**Linux (ordered):** capture for all: `-f x11grab -draw_mouse 0 -framerate {fps} -i {display}` (X11 only; Wayland → the dry-runs all fail and the agent stays alive answering `error: capture-failed`, never crash-looping).
1. `h264_nvenc -preset p1 -tune ull -zerolatency 1 -delay 0 -rc cbr`
2. `-init_hw_device vaapi=va:{render_node}` + `-vf format=nv12,hwupload` → `h264_vaapi -rc_mode CBR` — probe `{render_node}` over `ls /dev/dri/renderD*` (D128 is not always the GPU); each node is its own candidate.
3. `libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p`

**Cursor is captured by NOBODY** (`draw_mouse=0` / `-capture_cursor 0` throughout): the local pointer is already visible over the video layer; an encoded cursor would render as a second, lagged cursor.

### 4.2 Subprocess hygiene — DECIDED

`asyncio.create_subprocess_exec(..., stdin=DEVNULL, stdout=PIPE, stderr=PIPE)`. A dedicated task **must drain stderr** continuously into the agent's log file — an unread stderr pipe fills at ~64KiB and blocks ffmpeg, which presents as a frozen stream with no error. On Windows add `creationflags=0x08000000` (CREATE_NO_WINDOW — Gyan ffmpeg.exe is a console app and would pop a visible window from pythonw) and kill via the process handle (`proc.kill()` + `await proc.wait()`); on POSIX use `start_new_session=True` and kill the process group. Kill + reap on: client disconnect, `stop`, supersede, agent shutdown.

If ffmpeg exits at ANY time while a client is attached (not just within 5s of spawn): send `{"type":"error","code":"ffmpeg-died","message":<last stderr line>}` , close 1011, advance the candidate cursor, and be ready for the next client. If the display resolution changes, ffmpeg dies and this same path handles it (client-side handling: §6.2 restart rule). Rate-limit pipeline restarts to one per 60s.

### 4.3 AU assembly, keyframes, SPS/PPS caching — DECIDED (one rule, verbatim)

Parse stdout on Annex-B start codes (`00 00 01` / `00 00 00 01`) into NALs. **NAL type = `nal[0] & 0x1F`** (the header byte is e.g. `0x67` for SPS, `0x65` for IDR — never compare the whole byte).

Assembly rule (build exactly this): accumulate NALs into a pending buffer. When a **VCL NAL (type 1 or 5) whose `first_mb_in_slice == 0`** arrives — `first_mb_in_slice` is `ue(v)` immediately after the NAL header byte, and `ue(0)` encodes as a leading `1` bit, so the test is simply "first bit of the RBSP payload is set" — first **emit the previously completed picture** (if any) as one AU, then start the new picture with the accumulated non-VCL NALs (SPS/PPS/SEI/AUD) + this VCL NAL. Never emit a buffer containing no VCL NAL — an `EncodedVideoChunk` must be exactly one access unit with one primary coded picture.

- AU is a **keyframe** iff it contains a NAL of type 5 (IDR).
- Cache the latest SPS (type 7) and PPS (type 8); prepend both to every keyframe AU that lacks them (required for mid-stream joins and for decoders that need headers on every key).
- Timestamps: monotonic microseconds since ffmpeg spawn (`time.monotonic()`-based), in the binary header. A pipeline restart restarts timestamps at 0 — the client handles this via the `hello` re-send rule (§4.4).

### 4.4 Protocol (WS on `/stream`)

Auth: `?token=<hex>` compared with `hmac.compare_digest` against the token file (strip whitespace/newlines on read); mismatch → close 4401. Then:

- Server → client on accept: `{"type":"hello","version":1,"os":"darwin|win32|linux","encoder":"<cached candidate name or null>","width":0,"height":0,"fps":N}` — width/height are **advisory and sent as 0** (ffmpeg has not started yet; the client derives real geometry from decoded frames and MUST ignore these fields). A **new `hello` is re-sent whenever ffmpeg (re)spawns** — on receiving a `hello` mid-session the client must `decoder.reset()`, reconfigure, and resume at the next keyframe (timestamps have restarted; WebCodecs rejects non-monotonic timestamps otherwise).
- Client → server: `{"type":"start"}` (spawns ffmpeg, begins relay) · `{"type":"stop"}` · `{"type":"ping","t":<ms>}` → echoed as `{"type":"pong","t":<same>}` every 5s for the RTT stat (the library-level `ping_interval` stays on as well).
- Server → client on pipeline failure: `{"type":"error","code":"ffmpeg-died|no-encoder|capture-failed","message":"..."}` then close 1011.
- **Binary message = one AU:** 9-byte header — `u8 flags` (bit0 = keyframe) + `u64 BE timestamp_us` — then Annex-B AU bytes.

Backpressure: writer task consumes `asyncio.Queue(maxsize=30)`. Queue full on enqueue → clear queue, discard every AU until the next keyframe, enqueue that, resume. With GOP = fps/2 this bounds latency creep to ~500ms.

Token generation: installers write 32 hex chars (`secrets.token_hex(16)`) — Windows: `C:\ProgramData\hermes-cv\hiperf-token.txt`; mac/Linux: `~/.hermes-cv/hiperf-token.txt` mode 600 (same tree as the Linux VNC password file; note macOS keeps its venv elsewhere — §5).

---

## 5. Installers — DECIDED

Shared behaviors: idempotent; ASCII-only; resolve the ffmpeg absolute path at install time and bake it into the service definition as `--ffmpeg`; write the token file; finish by printing the paste-ready values — hostname form, `.ts.net` MagicDNS form, and the `100.x` IP if `tailscale ip -4` succeeds — plus the token.

- **`hiperf-windows.ps1`:** self-elevate via the connect-windows temp-file pattern (safe under `irm|iex`). winget install `Gyan.FFmpeg` + `Python.Python.3.12` if absent; refresh process PATH; venv at `C:\ProgramData\hermes-cv\hiperf\venv`, `pip install "websockets>=13,<16"`; download `hiperf-agent.py` from `RAW_REPO_URL`. **Service identity — deliberate delta from connect-windows.ps1 (which uses SYSTEM/AtStartup):** Scheduled Task `ComputerViewerHiperf`, principal = the **installing user**, `LogonType Interactive`, trigger AtLogOn + start now, `-ExecutionTimeLimit Zero` (round-16 lesson). SYSTEM cannot capture the interactive desktop — ddagrab/gdigrab need the user session. Action = absolute `venv\Scripts\pythonw.exe` + absolute agent path + flags; agent logs to `C:\ProgramData\hermes-cv\hiperf.log` (pythonw is silent — the agent must open its own log file). ACL `C:\ProgramData\hermes-cv\hiperf\` and the token file to grant the installing user Read (the VNC password file's Admin+SYSTEM-only ACL would lock the agent out). Firewall allow TCP 6090 profile Private; README notes Tailscale's adapter often registers as Public — include the one-liner to also allow it.
- **`hiperf-mac.sh`:** brew install ffmpeg if absent; venv at `~/.hermes-cv/hiperf/venv`; run the agent once in the **foreground** first to trigger the Screen Recording TCC prompt (§9), then LaunchAgent `com.hermes-cv.hiperf`: `ProgramArguments` all-absolute (venv python, agent, flags incl. `--ffmpeg $(command -v ffmpeg)` resolved now), `EnvironmentVariables.PATH` including the brew prefix, `StandardOutPath`/`StandardErrorPath` to `~/.hermes-cv/hiperf.log` (mirroring connect-mac.sh's plist shape), `KeepAlive.SuccessfulExit=false`.
- **`hiperf-linux.sh`:** package-manager detection identical to connect-linux.sh (apt/dnf/yum/pacman); venv at `~/.hermes-cv/hiperf/venv`; systemd-user unit `hermes-cv-hiperf.service` interpolating `Environment=DISPLAY=...` and `XAUTHORITY=...` exactly like `computer-viewer-x11vnc.service`, `WantedBy=graphical-session.target`, `Restart=on-failure` with `RestartSec=10`, `loginctl enable-linger`. (The agent itself never exits on capture failure — §4.2 — so Restart only covers real crashes.)

---

## 6. Plugin client — DECIDED

### 6.1 Settings model

New `Endpoint` fields — and this is a named integration requirement, not a suggestion: **add them to `blankEndpoint`, `normalizeEndpoint`, and `persistEndpointFields` in plugin.js** (the settings pipeline is an allow-list; unknown keys are dropped on save/normalize, so skipping this step ships a toggle that silently un-sets itself):

```javascript
hiperfEnabled: boolean,   // default false — explicit opt-in per endpoint
hiperfUrl: string,        // default '' ; when empty and enabled, derive ws://<host>:6090/stream from
                          //   engine.resolvedWsUrl AFTER RFB connect (probe/rewrites included) — never
                          //   from the stored wsUrl. IPv6 hosts via formatHostForUrl (brackets).
hiperfToken: string,      // pasted from installer output. If hiperfUrl already carries ?token=, that wins.
```

`hiperfBitrate`/`hiperfFps` from spec v1.0 are **cut**: they were display-only fields masquerading as controls (the agent owns encode params via CLI flags). The endpoint editor instead shows the per-OS hiperf installer one-liner next to the existing `LocalSetupHint`, and the README documents changing fps/bitrate on the agent side.

**Do NOT add the hiperf fields to `fingerprint()`.** HiperfClient owns its own reactivity: on every settings save, it diffs `(hiperfEnabled, hiperfUrl, hiperfToken)` for the active endpoint and starts/stops/restarts itself accordingly — enabling HD on a live connection starts streaming without touching the VNC session (acceptance 12). Legacy stored endpoints without these keys must normalize to the defaults and round-trip (acceptance 10).

Private-host guard: reuse the plugin's existing `isPrivateWsHost` / `isInsecurePublicWs` helpers verbatim (they already cover RFC1918, `100.64/10`, `*.ts.net`, `.local` — a superset of SPEC.md §4.2's prose; do not re-derive from the old spec text). `ws://` hiperf URLs to non-private hosts are refused with the existing warning copy — the agent is **private-network-only by design** (§9).

### 6.2 HiperfClient — sub-engine alongside the RFB engine

Independent state machine, generation-guarded like the RFB engine: `off → connecting → streaming → fallback(code)`. Exposed via a module-level `$hiperf` atom `{phase, code, fps, mbps, rtt}` — it **never** writes to `engine.state` (the RFB machine is untouchable from here). Starts when the RFB engine reaches `connected` on a hiperf-enabled websocket-mode endpoint; torn down (socket closed, decoder closed, canvas removed) whenever the RFB engine disconnects/switches/tears down — and hiperf teardown runs **before** any `surfaceEl.replaceChildren()` in `openRfb`/`teardownRfb`, and inside plugin disposal.

**Connection sequence:**
1. Feature-detect: `!('VideoDecoder' in window)` → `fallback('webcodecs-unsupported')`, no socket.
2. Open WS. **`ws.binaryType = 'arraybuffer'`** (the default is `'blob'`, which WebCodecs cannot ingest).
3. `hello` → send `start` → buffer binary messages until the first keyframe.
4. Parse the SPS from the first keyframe: find NAL with `(nal[0] & 0x1F) === 7`; codec string = `'avc1.' + [profile_idc, constraint_flags, level_idc].map(b => b.toString(16).padStart(2, '0')).join('')` (RFC 6381 requires exactly 6 hex chars — unpadded hex is illegal).
5. ```javascript
   const { supported } = await VideoDecoder.isConfigSupported(config)   // it is ASYNC — await it
   if (!supported) return fallback('codec-unsupported')
   decoder.configure(config)                                            // only after the await
   ```
   `config = { codec, optimizeForLatency: true }` — **no `description`** (absence = Annex-B mode per the WebCodecs AVC registration). **VERIFY AT RUNTIME:** Annex-B + hw decode in the Hermes Electron build; if `configure` succeeds but decoding errors, the prescribed second attempt is: repackage AUs to length-prefixed AVCC, build an `AVCDecoderConfigurationRecord` from the cached SPS/PPS as `description`, same codec string; only then `fallback('decode-failed')`.
6. Per binary message: `flags = u8[0]`, `timestamp = Number(view.getBigUint64(1, false))` (µs, big-endian, pass the Number — not a BigInt, no /1000), AU bytes = **a fresh copy** (`data.slice(9)` into a new Uint8Array — the WS buffer is reused). `decoder.decode(new EncodedVideoChunk({type: flags & 1 ? 'key' : 'delta', timestamp, data}))`.

**Render layer (integration is exact — the shipped plugin's surface machinery is delicate):**
- Create a canvas tagged `data-hiperf-canvas`, appended as the **last child of `engine.surfaceEl`** (the node `placeLive()` moves between slot and overlay — so expand/collapse carries the video automatically; never parent it to `overlayMountEl`).
- Style: `position:absolute` **aligned to the noVNC canvas element's CSS box** — both fit and native scale modes — not to the container (native mode is 1:1 + scroll; covering the container would misalign clicks). `pointer-events:none`, z-index above the RFB canvas.
- Backing store: size from `frame.displayWidth/displayHeight` (NOT `codedWidth` — 16-aligned, e.g. 1088 for a 1080 display). `getContext('2d', {alpha: false, desynchronized: true})`; per `output(frame)`: draw, then `frame.close()` in a `finally`.
- **`measureScreen` must skip `[data-hiperf-canvas]`** (it currently does `querySelector('canvas')` — a hiperf canvas as first match would corrupt fbW/fbH and the crop math). `cropPanel` cropping applies to the video child the same as to the RFB canvas.
- The canvas is `visibility:hidden` until the first decoded frame renders (never show it in `connecting`). **Black-frame guard:** if the first frames stay near-black (mean luma < 8 sampled cheaply) for > 2s, `fallback('capture-failed')` and hide — a TCC-denied or locked-session capture produces valid black H.264 that would otherwise opaquely cover live VNC.
- **Resolution sanity:** if `displayWidth/Height` differs from `engine.state.fbW/fbH` by more than 1% (DPI/Retina mismatches between capture and VNC are real), do NOT cover the VNC canvas — stay in `fallback('resolution-mismatch')` with its quiet status line. Click accuracy beats smoothness.
- **Snapshots and screenshots while `streaming` read from the hiperf canvas**, not `rfb.toDataURL()` (VNC is running at quality 0 — §6.2 next item — and would produce garbage thumbnails for the switcher's `rememberLastFrame` and the Screenshot button).

**Runtime behaviors:**
- On entering `streaming`: set `rfb.qualityLevel = 0; rfb.compressionLevel = 9` (reduces — does not eliminate — the redundant VNC video load; input latency unaffected). On leaving `streaming`: restore the endpoint's configured values **before** hiding the video canvas (avoids flashing one rotten quality-0 frame). These mutations are runtime-only — never persisted through `persistEndpointFields`.
- Latency guard: `decoder.decodeQueueSize > 10` → stop feeding, `decoder.reset()`, reconfigure, resume at next keyframe.
- Mid-session `hello` (agent restarted ffmpeg, e.g. resolution change): `decoder.reset()`, reconfigure from the next SPS, resume at keyframe.
- Decoder `error` callback: one silent retry (fresh decoder, next keyframe; include the AVCC second attempt from step 5), then `fallback('decode-failed')`.
- **Retry policy (exhaustive):** auto-retry 3× (2s/4s/8s) ONLY for: unclean TCP close / `hiperf-unreachable` / `ffmpeg-died`. **Never** auto-retry: 4401 (`hiperf-auth`), 4409 (`superseded` — another viewer took the stream; retrying would flap both clients forever), `webcodecs-unsupported`, `codec-unsupported`, `resolution-mismatch`, `capture-failed`. Those wait for manual Retry or the next RFB reconnect.
- Fallback UX: hide the canvas (live VNC is beneath — at most a quality dip, never a black box), quiet status line, Retry affordance. Hiperf failures never touch the RFB engine.
- Stats: ping/pong every 5s → rtt; decoded frames/s → fps; received bytes/s → Mbps.

### 6.3 UI insertion points (named, because the v1 pane has no free slots)

- **Pane status:** keep `phaseLine(conn)` untouched; add one extra tertiary-colored line below it rendered from `$hiperf` (nothing when `off`).
- **Expanded controls:** `OverlayBar` gains one trailing text item when streaming: `"{fps}fps · {mbps}Mbps · {rtt}ms"`.
- **Header:** `Badge` "HD" next to the endpoint name in `ComputerSwitcher` when streaming.
- Use the SDK's `Tip` component (that is what plugin.js actually imports — SPEC.md's `Tooltip` name is stale).
- Endpoint editor Advanced section: "High-performance stream (HD)" `Switch`, URL + token `Input`s, per-OS installer one-liner block beside `LocalSetupHint`.

### 6.4 Status-line copy

| code | line |
|---|---|
| `webcodecs-unsupported` | "HD mode needs WebCodecs (not available in this build) — using VNC." |
| `codec-unsupported` | "This machine can't decode the host's H.264 profile — using VNC." |
| `hiperf-auth` | "HD stream rejected the token — check endpoint settings. Using VNC." |
| `superseded` | "HD stream taken by another viewer — using VNC." |
| `hiperf-unreachable` | "HD agent not reachable on {hiperfUrl} — using VNC." |
| `resolution-mismatch` | "HD stream resolution doesn't match VNC — using VNC." |
| `capture-failed` | "HD capture failed on the host (permissions?) — using VNC." |
| `decode-failed` / `ffmpeg-died` | "HD stream failed ({code}) — using VNC." |

---

## 7. Non-goals (v1)

Audio · WebRTC/UDP transport · TLS on the agent (private networks only, enforced) · NAT traversal / internet exposure · multi-monitor selection (primary/whole desktop; ddagrab `output_idx` is a documented manual agent flag, not plugin UI) · Wayland · HDR/10-bit · multiple simultaneous viewers · client-driven bitrate/fps control (agent CLI flags own these) · graceful dynamic-resolution streaming (handled via ffmpeg death → restart → new `hello`, ≤ 1/60s).

---

## 8. Acceptance criteria

1. `node --check plugin.js` passes; still zero static imports beyond the three allowed; all three installer scripts contain zero non-ASCII bytes (byte-scan verified).
2. **Windows live box** (`ssh user@<windows-host>`, already VNC-provisioned): `irm ... hiperf-windows.ps1 | iex` completes idempotently (second run clean); `ComputerViewerHiperf` task Running as the interactive user; agent answers `hello` on `ws://<windows-ip>:6090/stream?token=...` naming a **hardware** pipeline (this box has a GPU — `libx264` means the candidate probe is broken); `C:\ProgramData\hermes-cv\hiperf.log` exists and grows.
3. Enabling HD on the Windows endpoint: video visible within 3s of RFB connect; stats ≥ 25fps at native res; window-drag visibly smoother than VNC side-by-side.
4. Input accuracy with video active: clicks land where the cursor points in **both fit and native scale modes**, spot-checked at all four corners; exactly one cursor visible.
5. Kill the agent mid-stream → live VNC visible ≤ 2s, no black interval, fallback line shown, RFB socket untouched (devtools: same websockify connection); restart agent + Retry → HD returns, still no RFB reconnect.
6. Wrong token → `hiperf-auth` line, **no retries** (agent log shows exactly one auth failure), VNC unaffected.
7. Second client supersedes the first: first shows the `superseded` line and does **not** retry; agent log shows old ffmpeg fully reaped before the new `hello`.
8. Backpressure: with an artificially throttled link (network conditioner — not a plugin control), stream degrades via drop-to-keyframe and recovers to < 500ms latency after the burst (GOP = fps/2 makes this the bound); latency never grows unboundedly.
9. Expand/collapse with HD active: video moves with the surface (same DOM node), keeps playing, no reconnect of either socket; the **collapsed thumbnail** shows HD video too.
10. Settings round-trip: a stored-endpoints JSON fixture from v1 (no hiperf keys) loads, normalizes to defaults, saves, and reloads identically; toggling HD on/off persists across app restart.
11. `hiperfEnabled` on an iframe endpoint and a session-json endpoint: no hiperf socket opened, no errors, no status line.
12. Enable HD in settings while RFB is already connected → streaming starts with no VNC reconnect; disable while streaming → canvas removed, VNC quality restored (visible sharpening), socket closed, RFB generation unchanged.
13. Switcher snapshots and the Screenshot button during streaming show the HD frame, not quality-0 VNC mush.
14. Plugin disable while streaming: WS closed, decoder closed, no orphan canvas in the DOM, no console errors; re-enable reconnects cleanly.
15. macOS (AI-Mac-Mini, after its VNC setup is done): TCC granted path shows video; TCC denied path shows `capture-failed` fallback (not an opaque black layer over VNC).

---

## 9. Security & privacy notes (README section, verbatim-usable)

- The agent serves an **unencrypted** H.264 stream of the screen to anyone with the token, on whatever interface it binds. Designed for localhost/Tailscale/LAN only; the plugin refuses public hosts. Do not port-forward 6090.
- Token file is the secret; plaintext on disk like the VNC password files, and `hiperfToken` sits in `ctx.storage` plaintext like the VNC password — same documented caveat. Rotate = rewrite file + restart agent + re-paste.
- macOS Screen Recording TCC: the installer runs the agent once in the foreground (Terminal context) to trigger the prompt before loading the LaunchAgent. **VERIFY AT RUNTIME:** if frames are black under launchd afterwards (TCC attribution is per-responsible-process), the README documents granting Screen Recording to the relevant binary in System Settings; the client's black-frame guard (§6.2) guarantees this manifests as `capture-failed` + VNC, never a covered pane.
- Agent attack surface: no filesystem/exec beyond its fixed ffmpeg argv; constant-time token compare; single path `/stream`; 4404 anything else.

---

## 10. VERIFY AT RUNTIME (consolidated)

1. WebCodecs `VideoDecoder` + Annex-B H.264 hw decode in the Hermes Electron renderer (feature-detect; AVCC + `description` repackage is the prescribed second attempt; `fallback` path is first-class).
2. **VideoToolbox keyframe NAL type:** VT may emit non-IDR I-slices at GOP boundaries instead of type 5. Builder must `ffprobe -show_packets` one GOP on a Mac; if no type-5 appears, treat I-slices as keys AND ship the AVCC/`description` path for Mac hosts (WebCodecs Annex-B `key` chunks are specified to contain an IDR).
3. macOS TCC / launchd screen-capture attribution (§9) — covered by the black-frame guard either way.
4. `ddagrab` + `-f lavfi` availability in the winget Gyan.FFmpeg build (expected yes; gdigrab candidates are the fallback).
5. avfoundation screen-index parsing across macOS versions ("Capture screen N" stderr format).
6. Windows DDA capture from a Scheduled Task on a locked/RDP-disconnected session (expected black or error → black-frame guard / candidate advance).
7. `h264_amf` acceptance of d3d11 frames without an explicit hwmap on current Gyan builds (if refused: insert the hwmap candidate variant, same pattern as qsv).

---

## 11. v2 upgrade path (documented, not built)

WebRTC transport: GStreamer `webrtcbin` on the host reusing the same capture/encode selection logic, with the agent's WS endpoint becoming the signaling channel (the §4.4 JSON control messages are deliberately signaling-shaped). Browser `RTCPeerConnection` cannot be fed pre-encoded frames from JS, so the encoder must live inside the RTC stack — that is why v1's ffmpeg-over-WS design is not simply "WebRTC minus ICE". Audio (Opus) rides along in v2. Client-driven bitrate/fps and multi-monitor selection graduate from agent flags to `start` parameters in the same pass.
