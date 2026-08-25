# Known Issues & Battle Scars

Every non-obvious failure we hit building and running this on real machines
(2 Macs, 1 Windows 11 PC, 1 Orgo cloud Linux box), with the fix that worked.
If your setup misbehaves, start here — odds are decent it's already been
fought once.

Legend: ✅ fixed in-repo · ⚠️ documented workaround · ❓ open / upstream

---

## Plugin

### ✅ Hermes chrome shows through the expanded viewer (ghost avatars)
**Symptom:** In fullscreen you can see Hermes's own session rail (chat
avatars) bleeding through the remote desktop when the picture is dark or
black.
**Cause:** The overlay used `z-index: 100`; Hermes's session rail stacks
higher, so it painted *on top* of the computer view. Invisible when the
remote image is bright, glaring when it's black.
**Fix:** Overlay raised to `z-index: 9999` with an explicit opaque black
background (commit `8622bcb`).

### ✅ HD aborts on a perfectly good dark desktop
**Symptom:** "HD capture failed on the host (permissions?)" on a machine
where permissions were fine; HD flips off ~2 s after starting whenever the
desktop is mostly dark (Hermes itself, dark-mode Windows).
**Cause:** The black-frame guard sampled average luma only. A real but dark
frame looks identical to a dead capture by that metric.
**Fix:** Sample luma **and variance**: any frame with contrast counts as
real. HD now stays up on dark desktops (commit `8622bcb`).

### ✅ HD falls back to VNC every few seconds (the flip-flop)
**Symptom:** HD connects, works briefly, drops to VNC, reconnects, repeats —
roughly every 3 seconds.
**Diagnosis:** The host agent log showed ffmpeg being restarted on the same
cadence. Two triggers in the client:
1. The agent emits a second `hello` JSON after each spawn; the client treated
   it as "reset the decoder," and resetting fires an error → fallback.
2. Any single decoder error (`decodeQueueSize` overflow, one bad P-frame)
   tore down the websocket entirely instead of resyncing at the next IDR.
**Fix:** Post-spawn `hello` is informational only; decode failures recover in
place (hide HD canvas, wait for keyframe) instead of killing the stream
(commit `3e0c64b`).

### ✅ noVNC fails against old websockify builds (handshake rejected)
**Symptom:** Connect fails immediately against some nginx/websockify stacks;
works elsewhere.
**Cause:** Legacy servers require the `binary` WebSocket subprotocol; modern
noVNC offers `binary` + others and some picky servers drop the handshake.
**Fix:** Automatic negotiation — try default first, retry once with legacy
`binary`, remember the working choice per endpoint.

### ✅ Rotating cloud endpoints fail after the machine restarts
**Symptom:** Orgo-style computers stop connecting after a VM restart even
though nothing changed client-side.
**Cause:** The VNC password/URL rotates per boot; the cached session is
stale. Also: Orgo's API field names differ from its docs (`projects` /
`desktops`, not `workspaces` / `computers`; `fly_instance_id`, not
`instance_id`).
**Fix:** Session document re-fetched on every connect; parser accepts both
the documented and live shapes; dashboard-URL UUIDs are recognized directly.

### ✅ Wrong-password errors get masked as "unreachable"
**Cause:** The trailing unclean disconnect event overwrote the precise auth
error state.
**Fix:** Auth errors latch (an `authLock`) so a wrong password always reads
as **Authentication failed**, not generic unreachable.

### ⚠️ Escape never reaches the remote desktop
Expanded mode reserves Escape for "collapse." To send Escape into the VM,
flip **View-only** off… actually: use View-only + the remote's own UI, or
type it via the on-screen keyboard of the guest OS. Accepted tradeoff for v1.

### ⚠️ Passwords sit in plugin storage as plain text
`hermes.plugin.computer-viewer.*` in Hermes's localStorage. There is no OS
keychain integration yet. Treat plugin storage as plaintext; prefer rotating
tokens for anything sensitive.

### ✅ macOS VNC connects then stalls on Apple authentication
**Symptom:** macOS Screen Sharing answers, then the connection hangs forever
or errors, even though the legacy VNC password is correct.
**Cause:** macOS advertises Apple's auth type **before** classic VNC auth;
noVNC picks the first offered type and Apple's path isn't usable from a
browser context.
**Fix:** A tiny filter service on the Mac host strips the Apple security
types from the RFB handshake so clients negotiate straight to VNC password
auth (`secfilter` launchd service installed by `connect-mac.sh`).

---

## Host setup scripts

### ✅ Windows: script won't parse ("is not recognized…" gibberish)
**Symptom:** Running via `irm … | iex` or a copied `.ps1` throws weird parse
errors about strings that look fine.
**Cause:** PowerShell 5.1 without a BOM decodes UTF-8 as ANSI; em-dashes and
arrows in comments turn into mojibake containing quote characters.
**Fix:** All repo scripts are byte-scanned ASCII-only (round 17). Rule for
contributors: **PowerShell scripts in this repo must be pure ASCII.**

### ✅ Headless Windows PC: VNC authenticates but the screen is black
**Symptom:** No monitor attached → Windows serves a 1024×768 stub display,
VNC connects, framebuffer all-black.
**Why:** Unlike macOS (which mints a virtual display), bare-metal Windows
renders nothing without physical hardware. Cloud Windows VMs don't have this
problem — the hypervisor provides the display.
**Fix chain:** detect the headless state → install signed Amyuni usbmmidd_v2
virtual display (1920×1080) → if TightVNC still captures black (known Win11
bug, SourceForge #1486/#1574) switch the VNC server to UltraVNC which grabs
it fine. If signature verification rejects the driver, the script prints the
$8 HDMI dummy-plug fallback rather than weakening driver security.

### ✅ Windows websockify silently dies after exactly 3 days
**Cause:** Task Scheduler's default `ExecutionTimeLimit` is 72 hours.
**Fix:** The installer sets the limit to zero ("never").

### ✅ TightVNC MSI sometimes ignores the password property
Known flaky installer behavior. Belt-and-braces: the script writes the DES
password hash into the registry itself post-install and restarts the
service.

### ⚠️ macOS: the script cannot enable Screen Sharing for you
`kickstart` requires sudo over SSH and kills existing GUI sessions. The one
manual step in the whole flow: toggle Screen Sharing + set the ≤8-char VNC
password by hand. Everything else is one paste.

### ✅ macOS: websockify dies because launchd has no PATH
`pip --user` installs aren't visible to LaunchAgents. The Mac script uses an
absolute venv path, `RunAtLoad` + `KeepAlive` + `ThrottleInterval`.

### ⚠️ macOS: TCC Screen Recording prompt never appears for the HD agent
A launchd-started process cannot raise the consent dialog, and
`launchctl asuser` needs root. Missing permission = ffmpeg hangs silently
with zero output (not an error!). Grant manually in System Settings →
Privacy & Security → Screen Recording for **both** the venv python and the
ffmpeg binary. If the box is headless, do it through this plugin's own VNC
view of that Mac.

### ⚠️ HD capture shows the lock screen
The Mac is at the login window, not logged in. Capture mirrors the console;
log in (you can do it through the plugin's VNC view).

### ✅ Linux Wayland (GNOME/KDE): nothing works
No stable screen-capture path for VNC. The script detects the session and
refuses with instructions to log into Xorg. wlroots compositors (Sway,
Hyprland) work via wayvnc, best-effort.

---

## HD / hiperf streaming

The H.264 side earned four separate scars in one evening:

### ✅ Electron refuses VideoToolbox's default H.264 (decode-failed)
**Cause:** ffmpeg's VideoToolbox defaults to High@L4.0 Annex-B; Hermes's
VideoDecoder throws on it.
**Fix:** Force `-profile:v constrained_baseline -level 4.0 -pix_fmt yuv420p`
and hand the decoder AVCC (+ `avcC` description) with SPS/PPS stripped from
samples.

### ✅ NVENC/x264 slice-per-thread streams also fail to decode
**Symptom:** Stream flows (~20 NALs/frame), decoder throws anyway.
**Cause:** `-tune zerolatency` makes x264 emit one slice per thread; Chromium
chokes on heavily sliced frames.
**Fix:** `-slices 1 -x264-params sliced-threads=0`. Verified live: one IDR
NAL per frame.

### ✅ Software-decode retreat made everything sluggish
During debugging the client forced `hardwareAcceleration:
'prefer-software'`. Stable, but CPU-bound. Removed once the encoder output
was fixed; hardware decode is back on.

### ✅ NVENC pipeline dead on the test box (falls back silently)
`ddagrab` (DXGI duplication) hangs on virtual displays; plain NVENC dry-run
times out. The agent advances candidates automatically — currently landing
on gdigrab+NVENC or single-slice libx264. NVENC stays first in line and will
take over automatically on boxes where it works.

### ⚠️ It will never be Parsec — architecture, not tuning
Browser plugins can't use UDP, can't render to a hardware video plane, and
capture runs at 30 fps. Parsec-level latency needs a native app per host.
Current stack: capture → encode → TCP WebSocket → JS WebCodecs decode →
canvas. Good enough for watching agents work; not a gaming stream.

### ⚠️ One HD viewer at a time
The agent supports a single active client; a second connection supersedes
the first (by design, keeps bandwidth sane). Opening the pane twice steals
the stream from the first view until it reconnects.

---

## Ops notes (learned the hard way)

- **Test on the real machine, not the simulator of your mind.** Every one of
  these bugs was invisible in code review and obvious in a log file.
- **Read the agent log before theorizing.** The 3-second restart loop was
  diagnosed from timestamps alone.
- **Probe protocols with raw sockets.** The RFB banner, the SPS bytes, and
  the NAL-type dump settled three arguments in ten minutes.
- **ASCII-only PowerShell. Always.**
- **Rotating credentials must be fetched per connect.** Caching them is the
  #1 cause of "mystery" cloud failures.

---

## Orgo cloud box (Linux)

### ⚠️ Chrome dies as root / "Missing X server"
**Symptom:** `google-chrome URL &` exits immediately. Logs say
`Running as root without --no-sandbox` or `Missing X server or $DISPLAY`.
**Cause:** Orgo's desktop is Xvnc on **`:99`**, not `:0`. Chrome also
refuses to start as root without `--no-sandbox`, and the software GPU
needs `--disable-gpu`.
**Fix:**
```
DISPLAY=:99 google-chrome --no-sandbox --disable-gpu --no-first-run URL &
```
First launch also shows a "Sign in to Chrome" interstitial — dismiss once
with Tab then Return.

### ⚠️ Direct SSH into the box is blocked
**Symptom:** Tailscale ping works; `ssh root@<tailnet-ip>` hangs.
**Cause:** Orgo uses userspace networking. Outbound works; inbound TCP
(including SSH) does not. This is platform design, not a misconfig.
**Fix:** Use `orgo-term` (WebSocket PTY) or `orgo_computer_bash` /
`orgo-hands` (screenshot/click). Hosted `orgo_computer_run` is off by
default and spends AI credits — do not enable it just to click.

