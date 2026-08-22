# Build notes — hiperf (SPEC-HIPERF v1.1)

Built from `SPEC-HIPERF.md` (resolved v1.1) plus the user addendum (one-click **HD** header toggle). Working copy: this `build-hiperf/` tree only. v1 platform constraints from `SPEC.md` §2 are unchanged.

## What shipped

| File | Role |
|---|---|
| `plugin.js` | In-place: `hiperfEnabled` / `hiperfUrl` / `hiperfToken` on the settings allow-list; `HiperfClient` (`$hiperf` atom, WebCodecs, overlay canvas); UI (header HD toggle, switcher badge, overlay stats, pane status line, Advanced HD section). |
| `hiperf-agent.py` | Single-file Python 3.10+ agent: token auth, ffmpeg candidate dry-run, Annex-B AU assembler, backpressure queue, one viewer. |
| `hiperf-mac.sh` | brew ffmpeg, `~/.hermes-cv/hiperf/venv`, LaunchAgent `com.hermes-cv.hiperf`, foreground TCC probe. |
| `hiperf-windows.ps1` | winget Gyan.FFmpeg + Python 3.12, venv under `C:\ProgramData\hermes-cv\hiperf`, Scheduled Task `ComputerViewerHiperf` as the interactive user. |
| `hiperf-linux.sh` | apt/dnf/yum/pacman (same detection as `connect-linux.sh`), venv, systemd-user `hermes-cv-hiperf.service`. |
| `README.md` | New **High-performance mode (optional)** section. |
| `docs/SPEC-HIPERF.md` | Copy of the spec. |

## Self-checks

Run from `build-hiperf/`.

| Check | Result |
|---|---|
| `node --check plugin.js` | **PASS** |
| `grep -n "^import" plugin.js` | Three specifiers only: `@hermes/plugin-sdk` (named + namespace), `react`, `react/jsx-runtime`. |
| Non-ASCII bytes in `hiperf-agent.py` + three installers | **PASS** (0 bytes > 127). macOS `/usr/bin/grep` has no `-P`; equivalent scan: `python3` walking file bytes. |
| `python3 -m py_compile hiperf-agent.py` | **PASS** |
| `bash -n hiperf-mac.sh` | **PASS** |
| `bash -n hiperf-linux.sh` | **PASS** |

Assembler smoke (synthetic SPS/PPS/IDR/P): NAL type is `nal[0] & 0x1F`; a `first_mb_in_slice == 0` VCL emits the previous picture; SPS/PPS are prepended on keys.

## Acceptance criteria 1, 10, 11 (code walk)

**1.** `node --check` passes. Static imports are only the three allowed specifiers. Installer + agent sources are ASCII-only (byte scan above). Live-box installer runs are out of scope here.

**10.** `normalizeEndpoint` fills `hiperfEnabled: false`, `hiperfUrl: ''`, `hiperfToken: ''` when keys are missing. `persistEndpointFields` / `saveAndConnect` always go through `normalizeEndpoint`, so a v1 endpoints array round-trips to the same records plus those defaults. `fingerprint()` does **not** include hiperf fields, so toggling HD does not reconnect VNC. The header toggle and the Advanced switch persist through `persistHiperfFields` → `ctx.storage`.

**11.** `hiperfApplies(endpoint)` is `hiperfEnabled && mode === 'websocket'`. iframe and session-json never open a hiperf socket, never write `$hiperf` except `off`, and the header HD toggle is not rendered. Probe-promoted endpoints stay `websocket` and are eligible.

## High-risk points (review list)

- NAL type: agent `nal[0] & 0x1F`; client `nal[0] & 0x1f` (same mask).
- `await VideoDecoder.isConfigSupported(config)` before `decoder.configure`.
- `ws.binaryType = 'arraybuffer'`; AU bytes `new Uint8Array(data.slice(9))` (copy off the reused WS buffer).
- Timestamps `Number(view.getBigUint64(1, false))`.
- hiperf fields in `blankEndpoint` / `normalizeEndpoint`; **not** in `fingerprint()`.
- hiperf canvas is last child of `engine.surfaceEl` (`data-hiperf-canvas`); `measureScreen` uses `canvas:not([data-hiperf-canvas])`; `hiperfTeardown()` runs at the top of `teardownRfb()` before `replaceChildren()`.
- Python: `websockets>=13,<16`, one-arg `handler(websocket)`, `compression=None`.
- stderr drain task on every ffmpeg spawn; Windows `creationflags=0x08000000`.
- Scheduled Task principal = installing user, `LogonType Interactive`, never SYSTEM.

## Deviations (spec impossible to follow literally, or small extras)

1. **User addendum (in scope).** Header **HD** toggle next to `ComputerSwitcher` on websocket endpoints. Unconfigured (no token and no explicit URL) opens the editor scrolled to the HD section instead of toggling. Streaming shows an active (accent) state.
2. **I-slices as keys (VERIFY AT RUNTIME #2).** This workspace did not capture a live VideoToolbox GOP with `ffprobe -show_packets`. The agent and client treat IDR (type 5) **and** non-IDR I/SI slices (`slice_type` 2/4/7/9) as keys, and the client ships the AVCC + `description` path as the prescribed second attempt after Annex-B. Extra keys are harmless if VT already emits IDR.
3. **Empty pipeline cache.** If every dry-run fails at process start (typical: macOS TCC not yet granted), `start` re-probes from the cursor / from the top rather than permanently answering `capture-failed`. Needed so a later Allow actually works.
4. **Restart rate-limit.** "One pipeline restart per 60s" is applied when the candidate list wraps back to the top after a death. Advancing to the *next* candidate on a death is immediate so the client's 2s/4s/8s `ffmpeg-died` retries can try the next encoder (resolution-change recovery).
5. **Log path.** Spec CLI has no `--log-file`. The agent logs to `hiperf.log` next to `--token-file` (`C:\ProgramData\hermes-cv\hiperf.log` / `~/.hermes-cv/hiperf.log`), and also to stderr (launchd/systemd capture).
6. **Agent download fallback.** Installers fetch `hiperf-agent.py` from `RAW_REPO_URL`. If that 404s (file not on GitHub yet) and a copy sits next to the installer, they copy it. Production path is still the raw URL.
7. **Windows ACL.** Spec says grant the installing user Read on `hiperf\` and the token. The task also needs to *run* `pythonw.exe` and *write* `hiperf.log`, so the installer grants `ReadAndExecute` (inherited) on `hiperf\`, `Read` on the token, and `Modify` on the log file.
8. **websockets import is lazy** (`import_serve()` inside `amain`) so helper functions can be imported without the dependency installed. Runtime still requires `websockets>=13,<16`.
9. **Last-picture flush.** On ffmpeg stdout EOF, a picture that already contains a VCL NAL is emitted. Spec forbids emitting a no-VCL buffer; it does not forbid flushing a completed last frame.
10. **HD fields persist immediately** in the editor when the endpoint already exists (`touchHiperf` → `persistHiperfFields`). That is how enabling HD in settings starts the stream with no VNC reconnect (acceptance 12) even though Connect would otherwise call `connect()`.
11. **`position: relative` on `engine.surfaceEl`.** Needed so the hiperf canvas (`position: absolute`) is aligned to the noVNC canvas box inside the surface, not to the overlay/slot. `resetLiveCropStyles` restores `relative` on the surface instead of clearing position.

## VERIFY AT RUNTIME (not exercised in this workspace)

Live Windows box, macOS TCC/launchd, Annex-B vs AVCC in the Hermes Electron build, `ddagrab` in Gyan ffmpeg, avfoundation screen-index across macOS versions, and locked-session DDA are listed in spec §10 and need the live-box pass. Prescribed fallbacks are implemented: feature-detect WebCodecs, AVCC second attempt, black-frame guard → `capture-failed`, private-host guard, VNC always underneath.

## Post-build live-verification patches (Claude, 2026-08-22, Windows box round)

1. `DRY_RUN_TIMEOUT_S` 2.0 -> 12.0: hardware capture+encoder init exceeds 2s;
   all ddagrab candidates were failing as "timeout" before ffmpeg could start.
2. New Windows candidate `h264_nvenc-gdi` (gdigrab capture + NVENC encode)
   inserted before `h264_mf`: on the live headless box (RTX 2060 SUPER +
   Amyuni IDD virtual display) ddagrab/DXGI duplication hangs producing no
   frames while gdigrab works; this candidate delivers hardware encode with
   the working capture. Live result: `pipeline ready: h264_nvenc-gdi`,
   Main-profile 1920x1080 stream verified healthy from a WS test client
   (session-1 capture confirmed via SPS resolution).
   Spec SPEC-HIPERF.md section 4.1 updated to match (candidates 4-6).
