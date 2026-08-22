# Build notes — `computer-viewer`

Built from `SPEC.md` (resolved). Korgo sources in `references/korgo/` were studied for the portal/expand pattern, generation guard, canvas `MutationObserver`, event wiring, and session-fetch shape. No Korgo code was copied verbatim.

## Static checks (this workspace)

| Check | Result |
|---|---|
| `node --check build/plugin.js` | Pass (re-run after the last edits). |
| Static `import` specifiers | Only `@hermes/plugin-sdk` (named + namespace), `react`, `react/jsx-runtime`. |
| JSX syntax | None. UI is `jsx` / `jsxs` via a local `el()` helper. |
| Default export | `{ id: 'computer-viewer', name: 'Computer', defaultEnabled: true, register(ctx) }`. |

## Acceptance criteria (§10)

1. **`node --check` + import allowlist** — **PASS** (verified in this workspace).
2. Drop into `~/.hermes/desktop-plugins/computer-viewer/plugin.js`, appears in Settings → Plugins, Computer pane docks right, disable/enable is clean — **needs a live Hermes Desktop app**.
3. Local `x11vnc` / Docker + `websockify 6080 localhost:5900`: live thumbnail, expand without a second websocket, Escape, mouse/keyboard, view-only — **needs live Hermes + a VNC target**.
4. Kill websockify → backoff → `unreachable` → Reconnect after restart — **needs live Hermes + a VNC target**.
5. Wrong password → `vnc-auth-failed`; empty password against a password-requiring server → `password-required` — **needs live Hermes + a VNC target**. (`authLock` is in place so a following unclean `disconnect` cannot rewrite these as `unreachable`.)
6. Iframe mode against `http://127.0.0.1:6080/vnc.html`, reload, expand/collapse without losing the iframe node — **needs live Hermes + a noVNC page**.
7. Settings persist across restart/hot reload; per-bot override switches the connection — **needs live Hermes with two profiles**.
8. Simulated CSP failure (`NOVNC_URL` pointed at garbage) → `cdn-blocked`, iframe still works — **needs live Hermes**. (Loader tries jsDelivr then `esm.sh`, then `cdn-blocked`; iframe `connect()` never calls `loadRFB()`.)
9. Theme variables on pane chrome, no hardcoded hex in chrome (letterbox black exempt) — **needs live Hermes across themes**. Statically: pane chrome uses `--ui-text-*`, `--ui-stroke-secondary`, `--ui-accent`, `--ui-editor-surface-background`, `--ui-surface-hover`. Overlay chrome is light-on-dark (see deviations).

## VERIFY AT RUNTIME (spec fallbacks honoured)

- **`createPortal`:** `@hermes/plugin-sdk` does not export it (confirmed against `apps/desktop/src/sdk/index.ts`). The plugin feature-detects `HermesSdk.createPortal` at runtime. If present, the overlay is portaled to `document.body`. If not, the overlay node is moved onto `document.body` and the live RFB/iframe node is moved between the pane slot (collapsed) and that overlay (expanded). Moving the node does not reconnect.
- **`host.paneVisibility`:** treated as read-only unless the atom exposes `.set`. Status-bar / palette “toggle pane” writes visibility when possible; otherwise it expands/collapses the overlay.
- **Dynamic `import()` of the noVNC CDN:** wrapped in try/catch with a second URL (`esm.sh`). Failure → `cdn-blocked`. Iframe mode does not load noVNC.

## Deviations (and why)

1. **`el()` helper** — thin wrapper around `jsx`/`jsxs` so the single-file UI is readable. Still only those two create-element functions; no JSX, no extra imports.
2. **`Tip` instead of composing `Tooltip` + Trigger + Content** — `Tip` is the SDK’s drop-in `title=` replacement and is what core chrome uses. Spec listed `Tooltip`; same kit, less boilerplate.
3. **Overlay control bar is light-on-dark** (`bg-black/70`, `text-white`) — same reason Korgo hardens fullscreen chrome: ghost buttons inherit theme text tokens and would paint dark-on-black in light mode. Pane chrome (header, status line, dialog, empty/error) uses theme variables only. Canvas/letterbox black is spec-exempt.
4. **Opening settings collapses the overlay** — the expanded surface is `z-[100]` on `document.body`. Leaving it up would cover the settings `Dialog`. Collapse is local UI state; it does not reconnect.
5. **`authLock` on `password-required` / `vnc-auth-failed`** — noVNC still fires `disconnect` after those events. Without a lock, unclean disconnect would start backoff and eventually show `unreachable`, violating §10.5.
6. **`new RFB(...)` throw** — mapped straight to `unreachable` (no socket existed to back off on).
7. **Namespace + named import of the same SDK specifier** — required to feature-detect `createPortal` without adding a fourth specifier.

No intentional omissions from §3–§7. Non-goals in §9 were not built (`resizeSession` toggle, file clipboard, audio, recording, secret storage, agent `plugin.yaml`).

## Fix round 1

No-portal overlay fallback moved the React-owned overlay node onto `document.body` and never put it back, so pane unmount/`insertBefore` hit `NotFoundError` (`removeChild` on the pane root while the node lived under `body`). Layout-effect cleanup now records the React parent and appends the node back before React detaches it; if that parent is gone, it removes the node from `body` and swallows a `removeChild` mismatch. Overlay is the last child of the pane root so sibling updates are less likely to use the moved node as an `insertBefore` reference. Portal path unchanged. Live surface/iframe still only `appendChild`-moves between slot and overlay mount (no reconnect). `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 2

Pane crashed on first render (`error-boundary:contrib:computer-viewer:pane`): `TypeError: Cannot read properties of undefined (reading 'get')` at the `useValue(...)` calls in `ComputerPane`. This Hermes build does not expose every documented `host.state.*` atom (in particular `focusedSessionProfile` is missing from the current SDK `host.state` object). `useValue` is `@nanostores/react`'s `useStore`, which calls `store.get()` immediately then `store.listen()` to subscribe — `useValue(undefined)` throws during render. Added a module-level `$absent = atom(null)` and `safeAtom()` that duck-types `.get` + `.listen` and otherwise returns `$absent`. Every `useValue(host.state.X)` in the file now goes through it, so a missing atom renders as `null` instead of crashing. Profile name still falls back to `'default'` (`focused || profile || 'default'`), so per-bot overrides act global when those atoms are absent; a null viewport only skips re-measure on window resize. Existing non-hook guards (`readProfileName`, `.listen` feature-detection in `attachEngine`) left unchanged. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 3

Live probe of jlesage/firefox (jlesage baseimage-gui nginx `websockify_pass` at `ws://host:5800/websockify`): handshake without `Sec-WebSocket-Protocol` → HTTP 400; with `binary` → HTTP 101. noVNC 1.7.0 sends no subprotocol, so every websocket connect died in handshake, exhausted the 5-step backoff, and showed `unreachable`. The pane/backoff/error UX was fine — the endpoint is subprotocol-picky.

Websocket and session-json connect now track a per-endpoint remembered variant (`none` default vs `binary`) in a module-level `Map`, persisted as `ctx.storage` key `wsProtocolByEndpoint`. Attempt 1 uses the remembered variant (no `wsProtocols` unless `binary`). An unclean `disconnect` before the RFB `connect` event retries once inline with the other variant — same generation, no backoff tick, no user-visible error. A later `connect` records that variant. Mid-session unclean drops (after `connect`) still go through existing backoff unchanged. Both handshake variants failing falls through to backoff as before. Iframe mode, error copy, and settings UI are untouched. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 4

session-json parse now accepts an Orgo computer document: no usable `websocketUrl` but a non-empty string `instance_id` builds `wss://{host}/desktops/{id}/ws/websockify?token=…` from `vnc_password ?? password` and host from `connection_url` → body `hostname` → session URL host (never hardcoded). Empty password omits `?token=`. Non-running `status` values fail as `session-failed` with `Computer status: {status}. Start it in Orgo first.` — only on this construction path; plain `{websocketUrl}` bodies are unchanged. README Rotating APIs has an Orgo subsection. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 5

Session JSON endpoint editor now has in-app Orgo computer discovery: **Find my Orgo computer** (enabled when the draft bearer is non-empty) GETs `/api/workspaces`, then each workspace detail in parallel (`Promise.all`, cap 10). No list-computers call (`GET /api/computers?workspace_id=` is HTTP 405). Results render in a `Select`; picking fills `sessionUrl` (`{origin}/api/computers/{id}`, origin from the draft Session URL or `https://www.orgo.ai`) and a default-ish name (`Local box` / `Untitled` / empty). Errors stay inline (401/403, network/CORS, empty). Discovery state is component-only — nothing is fetched until click, nothing is persisted. Other modes and fields are unchanged. README Orgo subsection leads with this flow; manual Session URL remains the fallback. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 6

Live Orgo shapes (captured with a real key) differ from the docs. Session-json construction now takes instance id from `instance_id` / `instanceId` / `fly_instance_id` / `flyInstanceId` (first non-empty string matching `/^[a-zA-Z0-9-]+$/`), else the last path segment of `connection_url`. Empty `vnc_password ?? password` falls back to `GET {origin}/api/computers/{id}/vnc-password` (same bearer; `password ?? vnc_password`, possibly `data`-wrapped); that call is non-fatal and omits `?token=` if it also fails. Status gate and host resolution are unchanged.

The finder reads workspaces from `projects` / `workspaces` / `data` / `items` / `results` (or a bare array) and computers from `desktops` / `computers` / `data` / `items` / `results`. Embedded computers on the list response are used directly; `GET /api/workspaces/{id}` only runs for workspaces that omit that array (that route 404s on a desktop id). If the list yields zero computers and the draft Session URL contains a UUID, `GET /api/computers/{uuid}` is offered as a single pick (`project_name` as the workspace label). Empty copy distinguishes no workspaces vs workspaces-but-no-computers. Values-free `console.info('[computer-viewer] orgo discovery', …)` logs statuses, key names, and counts. README documents `fly_instance_id` vs documented `instance_id`. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 7

Collapsed thumbnail crops the remote XFCE panel bar. Crop fraction is Korgo's `Math.min(0.12, 28/fbH)` (`SCREEN_PANEL_PX = 28`), applied only when `fbW/fbH > 0`. The slot keeps its aspect box; the shared live surface is bottom-anchored at the true framebuffer aspect and scaled so the slot's existing overflow:hidden trims the top strip. Fullscreen is uncropped. Per-endpoint `cropPanel` (default `true`) lives in the endpoint editor ("Crop remote panel bar in thumbnail") and `normalizeEndpoint`. `placeLive` / `applyRfbDisplay` reparenting is unchanged; crop styles are applied after place and cleared on expand.

Fullscreen overlay keeps the auto-fading control bar and adds a persistent top-right collapse pill (`aria-label: Collapse`, `bg-black/50`, does not fade). Collapsed thumbnail gets a matching hover-only expand pill in the top-right corner. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 8

Expand/collapse chrome now follows the Grok Bot thumbnail pattern. The pane-header expand icon and the thumbnail corner expand pill are gone (gear stays). Hovering the thumbnail fades in a `bg-black/40` dim and a centered `Open` pill (`bg-black/60`, rounded-full, backdrop-blur); the existing inset click target still expands; idle shows nothing.

Fullscreen overlay starts below the window titlebar: height is measured at expand time (`[data-titlebar]`, then `header[class*="titlebar" i]`, then `[class*="titlebar" i]`; top-anchored, 20–80px; else 40px) and applied as `top` (left/right/bottom 0). While expanded, a mount-scoped `Contribute` (`HermesSdk.Contribute` + `TITLEBAR_AREAS.right`, id `computer-viewer:collapse`) puts a ghost Minimize2 collapse button in Hermes's titlebar. Missing Contribute/TITLEBAR_AREAS falls back to the floating collapse pill at `top: 48px`. Titlebar contribution replaces that pill; auto-fade bar, Escape, `data-overlay-surface`, and reparenting/no-reconnect are unchanged. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 9

Pane header shows the endpoint name only; VNC `desktopName` (when known) is a `Tip` on that name instead of a ` · ` suffix. Connected `phaseLine` is just `"Connected"`. `desktopname` event handling/state unchanged.

Fresh-layout pane data now tries `dock: { pane: 'cronjobs', pos: 'top' }` with `height: '260px'`, and still sends `placement: 'right', width: '320px'` as fallback. No runtime reposition. Pane body dropped `flex-1` so the thumbnail + status size to content; the pane root scrolls only when shorter than that. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 10

Titlebar collapse control no longer falls through to `icons.X`. Icon is lucide `Minimize2` or `Shrink`, else a 16px inward-diagonal SVG (`stroke='currentColor'`); never a text glyph. Contribute gets `order: 999` so it sorts to the far right of `TITLEBAR_AREAS.right`. Child is exactly a ghost icon button (`aria-label: Collapse computer view`) wrapped in `Tip` (`Collapse`). Overlay `top` is the smallest qualifying titlebar rect (`top <= 2`, height 20–60) using `rect.bottom`, else 40; re-measured on expand. Thumbnail "Open" pill uses `Maximize2` or `Expand`, else the matching outward-diagonal SVG. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 11

`cropPanel` is now explicit opt-in (default off): `blankEndpoint` sets `cropPanel: false`; `normalizeEndpoint` uses `raw.cropPanel === true` so stored endpoints missing the field resolve to no crop. Runtime gate is `cropPanel !== true`; editor switch is checked only on `=== true`, with hint that VM-side panel hide is preferred (live crop clipped bottom dock icons). README collapsed-thumbnail section documents the new default. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 12

Removed titlebar `Contribute`/`TITLEBAR_AREAS` collapse injection (helper, feature detection, and the `top: 48px` fallback pill). Expanded overlay now has a persistent top-right collapse pill (`top: 12px; right: 16px`, Minimize2/Shrink/inward SVG, `aria-label: Collapse computer view`, Tip `Collapse`, `bg-black/50` rounded-full, does not auto-fade). Auto-fade bar stays; its container uses extra right padding so it does not collide with the pill at narrow widths. Overlay titlebar-height `top`, Escape, `data-overlay-surface`, and reparenting/no-reconnect are unchanged. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 13

Expanded overlay's top-right collapse pill rendered but clicks did nothing. Dropped the SDK `Tip` wrapper (plain `button` with `title: 'Collapse'`, same aria-label / round-10 icon). Bound collapse natively with a button ref + layout-effect `pointerup` and `click` listeners (`stopPropagation` / `preventDefault` / `setExpanded(false)`), cleaned up on unmount, and kept the React `onClick`. Pill container stops `pointerdown` bubbling and uses inline `zIndex: 40` and `pointerEvents: 'auto'`. Pill is its own component so overlay chrome-fade re-renders on mousemove do not replace the node. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 14

Endpoint editor is one simple form (Name default "My computer", Computer address, Password, Connect) with live paste-anything detection and a collapsed Advanced section. `draft.address` persists; `normalizeEndpoint` synthesizes it from the mode URL on old records. Detection maps `ws(s)://` → websocket, noVNC `vnc.html` / `:port/` pages → iframe, other `http(s)://` → session-json, API-key shape → session bearer + **Find my computers** (no vendor names), `host`/`host:port` → probe (`ws(s)://host:port/websockify` then `http://host:port/vnc.html`, existing subprotocol retry). Connect disabled on unrecognized input. New `username` goes to RFB `credentials` / `sendCredentials`. Private `ws://` hosts now include `.local`, RFC1918, and link-local so the Mac recipe works. README leads with the address field; `build/connect-mac.sh` installs user-level websockify and a login LaunchAgent. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 15

Pane header is a computer switcher (`DropdownMenu`): every saved endpoint as `StatusDot` + name, live status only on the active row (inactive stay muted — no probing). Clicking a row writes `globalEndpointId` via `persistSettings` and `connect()`s that endpoint; per-bot overrides still win. Menu footer: ＋ Add computer / Manage computers…. Switching or disconnecting a connected websocket captures `rfb.toDataURL()` into an in-memory map (cap 8, never persisted); selected-but-not-connected shows that frame dimmed with a "last seen" overlay. Add flow prepends a Cloud | Local `SegmentedControl` (skipped when editing). Local adds Mac/Windows/Linux setup one-liners from `RAW_REPO_URL` plus the round-14 address form. EmptyState CTA is "Add a computer". Engine, detection, discovery, overlay unchanged. `node --check` pass; static imports still `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

## Fix round 16

Cross-OS setup scripts + README (no `plugin.js` changes). Shared design: idempotent, progress echoes, print `ws://<hostname>:6080/websockify` at the end (Mac hostname from `scutil --get LocalHostName` + `.local`), pin `websockify==0.13.0` where we control pip, bind VNC to localhost, expose only the websocket port, LAN/Tailscale only.

- **`build/connect-mac.sh` (rewrite).** Dedicated venv at `~/.hermes-cv/venv` with absolute `ProgramArguments` in `~/Library/LaunchAgents/com.computer-viewer.websockify.plist` — launchd has a bare PATH, so `pip --user` is invisible (AHEMOH/macstudio-llm pattern). `RunAtLoad` + `KeepAlive`, `ThrottleInterval` 10, logs to `~/.hermes-cv/websockify.log`, `bootout`/`bootstrap gui/$UID` with `unload`/`load` fallback. Does **not** enable Screen Sharing or set the VNC password (kickstart needs sudo and drops live sessions); prints the System Settings → Sharing → (i) → “VNC viewers may control screen with password” steps and the DES 8-char limit. Best-effort `sw_vers` compare against CVE-2026-65400 patched builds (Sonoma 14.8.9 / Sequoia 15.7.9 / Tahoe 26.6.1); generic warning if the mapping is unsure. Detects whether :5900 is listening.
- **`build/connect-linux.sh` (new).** Branches on `$XDG_SESSION_TYPE`: X11 → `x11vnc` + systemd user units (`-localhost -forever -shared -noxdamage -rfbauth ~/.hermes-cv/vncpwd -rfbport 5900`) and `computer-viewer-websockify.service` (`Restart=always`, `WantedBy=default.target`); wlroots-Wayland → `wayvnc` on 127.0.0.1 with RSA-AES + `relax_encryption` (noVNC security-type 262 caveat; less battle-tested); GNOME/KDE Wayland exits non-zero with “log into an Xorg session”. Packages via apt/dnf/pacman (`x11vnc`/`wayvnc` + `websockify`, `novnc` optional). Notes `loginctl enable-linger`.
- **`build/connect-windows.ps1` (new).** Self-elevates (`Start-Process powershell -Verb RunAs`). TightVNC 2.8.88 64-bit MSI from official tightvnc.com with `ADDLOCAL=Server SERVER_REGISTER_AS_SERVICE=1 SERVER_ALLOW_SAS=1 SET_USEVNCAUTHENTICATION=1 VALUE_OF_PASSWORD=<pw8>` (MSI password props historically unreliable — TightVNC bug #1392 — so the password is always printed; registry fallback may be needed). Loopback-only via `HKLM\SOFTWARE\TightVNC\Server` `AllowLoopback=1` `LoopbackOnly=1`, then `Restart-Service tvnserver`. `winget install -e --id Python.Python.3.12 --scope machine --silent` if needed, `pip install websockify==0.13.0`. Scheduled task: SYSTEM, `-AtStartup`, `-RunLevel Highest`, `RestartCount 3` / `RestartInterval 1min`, **`-ExecutionTimeLimit ([TimeSpan]::Zero)`** so Task Scheduler does not kill it at the 72h default. Firewall: TCP 6080, Private profile.
- **README.** Top-of-file **Connect any computer** (Cloud vs Local + one-paste `curl`/`irm` from `RAW_REPO_URL` master) and **Security** (no internet exposure, CVE-2026-65400, 8-char DES, `ws://` unencrypted / `wss://` needs certs). Existing recipes kept and expanded with Windows/Linux.

Validate: `bash -n build/connect-mac.sh && bash -n build/connect-linux.sh` pass. `connect-windows.ps1` cannot be lint-checked on this Mac (no `pwsh` syntax gate in the workspace). `node --check build/plugin.js` still passes; plugin.js untouched.

## Fix round 17

Live test of `build/connect-windows.ps1` on a real Windows 11 box (Windows PowerShell 5.1) failed to parse: BOM-less `.ps1` is read as the system ANSI codepage (Windows-1252), so UTF-8 em-dashes (`—`, bytes `E2 80 94`) decoded as `â€"` — the embedded double-quote corrupted string parsing and cascaded into "Unexpected token" errors. A UTF-8 BOM unblocked file-run in that test, but it is not a reliable fix for `irm <url> | iex` (piped execution). Canonical fix: make the setup scripts **pure ASCII** so they parse under any codepage.

- `build/connect-windows.ps1`: replaced every byte > 0x7F (`—`/`–` → `-`, `→` → `->`, and any smart quotes / ellipsis) in comments and `Write-Host` strings only. Logic, commands, and structure unchanged. Live test had already proven TightVNC + websockify + plugin VNC auth end-to-end once the file parsed.
- `build/connect-mac.sh` and `build/connect-linux.sh`: same ASCII scrub for consistency / locale safety; logic unchanged.
- `build/README.md`: setup-script sections and fenced command/code blocks ASCII-cleaned; Windows recipe notes the script is ASCII-only so `irm ... | iex` works on Windows PowerShell 5.1.

Validate: `bash -n build/connect-mac.sh && bash -n build/connect-linux.sh` pass. `LC_ALL=C grep -nP "[^\x00-\x7F]"` on the three connect scripts returns nothing. `node --check build/plugin.js` still passes; plugin.js untouched.

## Fix round 18

Black screen on a **real physically headless** Windows 11 Home box, live over SSH: `user@<windows-host>`, build **10.0.26200.8973** (25H2-era). TightVNC 2.8.88 + websockify 0.13.0 were already up (loopback `:5900`, `0.0.0.0:6080`, VNC DES auth `REDACTED` succeeded). Session 0 (OpenSSH) always reports `VirtualScreen=1024x768`; the console is session 1 (`explorer` / `dwm` running). `Screen.AllScreens` in session 0 is `WinDisc` at 1024x768 with `BitsPerPixel=0`.

**usbmmidd_v2 (Amyuni) on 26200: signature ACCEPTED.** `deviceinstaller64.exe install usbmmidd.inf usbmmidd` printed "Drivers installed successfully." then `enableidd 1` exit 0. PnP `USB Mobile Monitor Virtual Display` at `ROOT\DISPLAY\0001`. Did **not** enable test-signing and did **not** import certificates. `enableidd` is not persistent; scheduled task `ComputerViewerVirtualDisplay` (SYSTEM, AtStartup, `enableidd 1`) registered. Calling `enableidd 1` twice created two 1024x768 virtual monitors (2048x768 desktop); one `enableidd 0` plus `ChangeDisplaySettingsEx` on `\\.\DISPLAY21` made a single **1920x1080** primary (working area 1920x1032 -- taskbar present). Parsec VDA and DisplayFusion were already on the machine; they were not required for the fix.

**TightVNC still black after the virtual display was the desktop.** RFB 3.8 over `ws://<windows-ip>:6080/websockify`, DES auth OK, ServerInit **1920x1080**, one raw rect 1920x1080 = 8,294,400 bytes, **min=max=0, allZero=true**. `UseD3D=0` / `UseMirrorDriver=0` / `GrabTransparentWindows=1` did not change that (Win11 DXGI/IDD capture; TightVNC bugs #1486 / #1574).

**UltraVNC 1.8.2.4 hook/poll fixed the pixels.** Stopped `tvnserver` (Manual). Zip from `https://uvnc.eu/download/1800/UltraVNC_1824.zip`, `winvnc.exe -install`, service `uvnc_service`. Ini must live in `%ProgramData%\UltraVNC\ultravnc.ini` (1.8 moved it off Program Files). `passwd=` is the TightVNC 8-byte obfuscated blob as 16 hex chars **plus two checksum hex chars** (`0F1D551CB815719000`); 16 hex chars alone yields nTypes=0 "This server does not have a valid password enabled." Capture: `PollFullScreen=1 EnableHook=1 EnableDriver=0 LoopbackOnly=1`. Second RFB proof: ServerInit **1920x1080**, name `thomas (... ) - service mode`, raw 8,294,400 bytes, **uniqueByteValues=256, nonzeroBytes=8,232,248, allZero=false**, first pixels `bca078ff...` (real wallpaper, not black).

`build/connect-windows.ps1`: after the existing TightVNC + websockify setup, detect headless (1024x768 / WinDisc / existing USB Mobile Monitor), install usbmmidd idempotently (do not `enableidd` again if already attached), persist the startup task, then switch capture to UltraVNC on `:5900`. Download or signature failure is non-fatal and prints the **HDMI/DisplayPort dummy-plug (~$8)** fallback. Machines with a real monitor keep TightVNC. Script remains pure ASCII.

Validate: `LC_ALL=C grep -nP "[^\x00-\x7F]" build/connect-windows.ps1` returns nothing. `node --check build/plugin.js` still passes; plugin.js untouched.
