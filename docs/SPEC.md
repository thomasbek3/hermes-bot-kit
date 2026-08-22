# SPEC — `computer-viewer`: Live Desktop Viewer plugin for Hermes Desktop

**Status:** Resolved spec, ready to build. All research done; API names below are verified against the live Hermes docs, real published plugins, the noVNC 1.7.0 source, and the Korgo Bot implementation. Do not re-litigate decisions marked **DECIDED** — build them as written. Sections marked **VERIFY AT RUNTIME** are the only genuinely unknown points; each has a prescribed fallback.

**Goal:** Add the "little computer box" experience from Grok Bot / Korgo Bot to Hermes Desktop as a proper plugin: a small live desktop thumbnail docked on the right that, when clicked, expands into a full interactive remote computer view.

---

## 1. Deliverables

| File | Description |
|---|---|
| `plugin.js` | Complete working plugin. Single ESM file, no build step. |
| `README.md` | Install steps, endpoint configuration guide (all 4 backend recipes in §8), controls reference, limitations (§12). |

Install location: `$HERMES_HOME/desktop-plugins/computer-viewer/plugin.js` (i.e. `~/.hermes/desktop-plugins/computer-viewer/plugin.js`). Plugin `id` **must** be `computer-viewer` (must match folder name).

---

## 2. Hard platform constraints (violating any of these = plugin won't load)

These come from the official Desktop Plugin SDK docs (`https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk`) and are confirmed by real plugins in `github.com/tonbistudio/hermes-desktop-plugins`:

1. **Single plain ESM `.js` file.** No bundler, no TypeScript, no multi-file relative imports.
2. **Exactly three static import specifiers resolve:** `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`. Any other static import fails at load.
3. **JSX syntax does not parse.** Use `jsx()` / `jsxs()` from `react/jsx-runtime` for all elements.
4. **No lifecycle hooks.** Default-export a `HermesPlugin` object `{ id, name, defaultEnabled, register(ctx) }`. Every `ctx.register(...)` returns a disposer; disabling the plugin in Settings → Plugins disposes all contributions. Any side-band resources (RFB connections, observers, timers, portals) must be torn down by disposers you return / effect cleanups — assume the plugin can be disabled at any moment.
5. **Hot reload is automatic** on file save (fallback: ⌘K → "Reload desktop plugins"). Design all module-level state to be safely re-creatable.
6. Plugins run **unsandboxed in the renderer with full app authority**; `fetch()` to arbitrary external hosts is proven to work (Markets plugin), and external iframes are proven to work (TradingView embed in Markets plugin).
7. Validation gate: `node --check plugin.js` must pass (this is what the ecosystem's `desktop-plugin-maker` skill uses).

Canonical registration shape (verbatim pattern from published plugins):

```javascript
import { host, useValue, PANES_AREA, STATUSBAR_AREAS, PALETTE_AREA, KEYBINDS_AREA,
         Button, Input, Select, Switch, Tooltip, Badge, EmptyState, ErrorState,
         Loader, StatusDot, Dialog, ScrollArea, Separator, icons, cn } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState, useCallback } from 'react'

export default {
  id: 'computer-viewer',
  name: 'Computer',
  defaultEnabled: true,
  register(ctx) {
    ctx.registerMany([
      { id: 'pane', area: PANES_AREA, title: 'Computer',
        data: { placement: 'right', width: '320px' },
        render: () => jsx(ComputerPane, { ctx }) },
      { id: 'status', area: STATUSBAR_AREAS.right, order: 120,
        render: () => jsx(ComputerStatusItem, { ctx }) },
      { id: 'palette-toggle', area: PALETTE_AREA,
        data: { id: 'computer-viewer.toggle', label: 'Computer: Toggle Pane',
                keywords: ['computer', 'desktop', 'vnc', 'screen'], run: () => togglePane() } },
      { id: 'palette-reconnect', area: PALETTE_AREA,
        data: { id: 'computer-viewer.reconnect', label: 'Computer: Reconnect',
                keywords: ['computer', 'reconnect', 'vnc'], run: () => engine.reconnect() } },
      { id: 'kb-expand', area: KEYBINDS_AREA,
        data: { id: 'computer-viewer.expand', label: 'Expand computer view',
                category: 'Computer', defaults: ['mod+shift+d'], run: () => toggleExpanded() } },
    ])
  }
}
```

Exact SDK surface available (use these, don't invent others): UI kit `Button, Input, Textarea, Select*, Switch, Checkbox, SegmentedControl, Tabs*, Dialog*, ConfirmDialog, DropdownMenu*, Popover*, Tooltip*, Badge, Kbd, SearchField, ScrollArea, Separator, Skeleton, Loader, EmptyState, ErrorState, CopyButton, StatusDot, Codicon` + `icons.*` (lucide), `cn`, `haptic`, `profileColor/profileColorSoft`. State: nanostores `atom, computed, useValue` and `host.state.*` atoms. OS bridge: `ctx.os.notify / openExternal / revealPath / writeClipboard`. Storage: `ctx.storage.get(key, default) / set(key, value) / remove(key)` — synchronous, JSON, plugin-scoped.

Styling: Tailwind-style classes with **theme CSS variables**, e.g. `text-(--ui-text-secondary)`; known vars: `--ui-text-secondary`, `--ui-text-tertiary`, `--ui-text-quaternary`, `--ui-stroke-secondary`, `--ui-accent`. Never hardcode colors; the pane must look native in every Hermes theme.

---

## 3. Architecture — DECIDED

Two viewer modes, one connection engine, one pane:

```
┌─ plugin.js ─────────────────────────────────────────────────────┐
│  SettingsStore (ctx.storage; global + per-bot endpoint configs) │
│  ConnectionEngine (mode A: noVNC RFB over WebSocket)            │
│  ┌──────────────────────────────────────────────┐               │
│  │ ComputerPane (PANES_AREA, right, 320px)      │               │
│  │  ├─ Header: status dot · endpoint name · ⚙   │               │
│  │  ├─ Thumbnail slot (click → expand)          │               │
│  │  └─ Controls row                             │               │
│  └──────────────────────────────────────────────┘               │
│  Portal overlay (document.body): hosts the ONE live surface —   │
│    absolutely positioned over the thumbnail slot when collapsed,│
│    inset-0 fullscreen when expanded (Korgo pattern, §5)         │
│  StatusBar item · Palette commands · Keybind                    │
└─────────────────────────────────────────────────────────────────┘
```

**Mode A — `websocket` (primary):** native noVNC `RFB` embedding, dynamically imported from CDN. Full programmatic control (scale, viewOnly, credentials, clipboard, Ctrl+Alt+Del). This is the Korgo Bot approach.

**Mode B — `iframe` (fallback / zero-dependency):** an `<iframe>` pointed at a backend-hosted noVNC page (e.g. `http://127.0.0.1:6080/vnc.html` — this is literally how Grok Bot's own computer box works: an Electron webview on the box's noVNC page). No CDN dependency, no RFB API; controls are limited to reload + expand. External iframes are proven to work in Hermes plugins.

The user picks the mode per endpoint in settings. Default `websocket`.

### 3.1 Loading noVNC — DECIDED, with prescribed fallback

**Primary:** dynamic import of the single-file ESM bundle, pinned:

```javascript
const NOVNC_URL = 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0/+esm'
let RFB = null
async function loadRFB() {
  if (RFB) return RFB
  const mod = await import(/* webpackIgnore: true */ NOVNC_URL)
  RFB = mod.default
  return RFB
}
```

Facts you must respect (verified by HTTP probe):
- `@novnc/novnc@1.7.0` is pure ESM (`"exports": "./core/rfb.js"`); the `/+esm` jsdelivr build is a single minified ESM file with `default` export = the RFB class. **Pin 1.7.0+**: versions 1.5–1.6 ship CommonJS-only `lib/` and cannot be imported in a browser at all; many old tutorials referencing `lib/rfb.js` now 404.
- The static-import allowlist (§2 item 2) applies to bare specifiers; **dynamic `import()` of an https URL is unverified in the Hermes renderer** (CSP could block it). → **VERIFY AT RUNTIME**: wrap `loadRFB()` in try/catch. On failure, set engine state to `error` with code `cdn-blocked` and a message that says exactly: noVNC could not be loaded from the CDN (likely CSP); switch this endpoint to **iframe mode** or check network. Mode B must remain fully usable in this scenario — that's why it exists.
- Alternate CDN fallback before giving up: try `https://esm.sh/@novnc/novnc@1.7.0` if jsdelivr's import throws. Two attempts total, then `cdn-blocked`.

### 3.2 The RFB API you're building against (noVNC 1.7.0, from `docs/API.md` — verified)

```javascript
const rfb = new RFB(targetEl, wsUrl, { shared: true, credentials: { password } })
// Writable props: viewOnly, scaleViewport, resizeSession, clipViewport, dragViewport,
//                 focusOnClick, qualityLevel (0-9), compressionLevel (0-9), background
// Events (payload on e.detail): 'connect', 'disconnect' {clean}, 'credentialsrequired' {types},
//   'securityfailure' {status, reason}, 'desktopname' {name}, 'clipboard' {text}, 'bell',
//   'capabilities', 'serververification' (→ rfb.approveServer())
// Methods: disconnect(), sendCredentials({password}), sendKey(keysym, code, down?),
//   sendCtrlAltDel(), clipboardPasteFrom(text), focus({preventScroll:true}), blur(),
//   toDataURL(), toBlob(cb), machineShutdown/Reboot/Reset() [needs capabilities.power]
```

- `targetEl` is a **container div**; noVNC injects its own screen div + canvas inside it. Never style the canvas via CSS child selectors — control geometry via the container + `scaleViewport`.
- **There is no built-in reconnect.** A dead RFB object is garbage; every (re)connect constructs a fresh one.

---

## 4. Settings — DECIDED

### 4.1 Data model (all via `ctx.storage`, synchronous JSON)

```javascript
// key: 'endpoints' → Endpoint[]
Endpoint = {
  id: string,              // crypto.randomUUID()
  name: string,            // display name, e.g. "Local box", "Orgo VPS"
  mode: 'websocket' | 'iframe' | 'session-json',
  wsUrl: string,           // websocket mode: ws(s)://host:port/path  e.g. ws://localhost:6080/websockify
  iframeUrl: string,       // iframe mode: http(s) URL of a hosted noVNC page, e.g. http://127.0.0.1:6080/vnc.html
  sessionUrl: string,      // session-json mode: https URL returning {websocketUrl, password} (§4.3)
  sessionBearer: string,   // optional bearer token for sessionUrl
  password: string,        // VNC password (websocket mode; optional)
  viewOnlyDefault: boolean,      // default false
  scaleMode: 'fit' | 'native',   // default 'fit' → scaleViewport=true; 'native' → clip+scroll
  autoConnect: boolean,          // default true: connect when pane becomes visible
  qualityLevel: number,          // default 7 (Korgo's value)
  compressionLevel: number,      // default 2
}
// key: 'globalEndpointId' → string | null      (the default endpoint)
// key: 'perBotEndpoint'  → Record<profileName, endpointId>   (per-bot override)
// key: 'ui' → { lastExpanded: boolean }        (do NOT persist connection state)
```

**Per-bot resolution:** active bot = `useValue(host.state.focusedSessionProfile) ?? useValue(host.state.profile)`. Effective endpoint = `perBotEndpoint[profileName] ?? globalEndpointId`. When the focused profile changes **and** it resolves to a *different* endpoint, the engine disconnects and reconnects to the new one (subscribe to the atom; there is no "onBotChanged" event — atom subscription is the documented pattern). If it resolves to the same endpoint, do nothing.

### 4.2 Settings UI

There is **no settings contribution point** in the SDK (Settings → Plugins is only the enable toggle — confirmed gap in the docs). Build settings **inside the pane**: a gear icon in the pane header opens a `Dialog` with:
- Endpoint list (add / edit / delete / set-as-global-default), using SDK `Input`, `Select`, `Switch`, `SegmentedControl` (for mode), `ConfirmDialog` for delete.
- Per-bot override: a `Select` of endpoints, bound to the currently focused bot, with a "use global default" option.
- Password field: `Input` with `type: 'password'`. Show a permanent one-line caveat: *"Stored locally in plugin storage (plain text). Prefer token-in-URL or session endpoints for anything sensitive."* — `ctx.storage` has no secret facility; do not pretend otherwise, do not roll crypto. (README must repeat this limitation.)
- Mixed-content preflight warning (non-blocking) shown next to `wsUrl` when the value starts with `ws://` and the host is not localhost/127.0.0.1/a `100.64.0.0/10` or `*.ts.net` address: *"Insecure ws:// to a public host will likely be blocked. Use wss://."* (Korgo enforces exactly this split: `wss://` public, plain `ws://` only for verified-private Tailscale hosts.)

### 4.3 `session-json` mode (rotating endpoints, Orgo/Modal-style) — in scope, small

Some backends don't have a stable URL: you `GET` an API and receive an ephemeral session. Korgo does this against Orgo: fetch `https://www.orgo.ai/api/computers/{id}` with `Authorization: Bearer <key>`, then build `wss://www.orgo.ai/desktops/{instanceId}/ws/websockify?token=<password>` and *also* pass the same password as RFB credentials.

Genericized for us: `sessionUrl` returns JSON; the engine reads `websocketUrl` (required) and `password` (optional) from the response and then behaves exactly like websocket mode. **The session must be re-fetched on every (re)connect — never cache the URL** (tokens rotate; a cached URL is the #1 cause of mystery reconnect failures). `fetch()` from plugins is proven to work. Non-2xx or missing `websocketUrl` → error state `session-failed` with the HTTP status in the detail.

---

## 5. The pane and the expand interaction — DECIDED (Korgo portal pattern)

**One RFB connection serves both the thumbnail and the fullscreen view.** Never reconnect on expand/collapse. Implementation (this is exactly how Korgo does it, and it's the right call):

1. The pane renders a **placeholder slot div** (the thumbnail box) — not the live canvas.
2. The live surface (the div you hand to `new RFB(...)`) lives in a **portal**: `createPortal(surface, document.body)` with `position: fixed`.
3. **Collapsed:** measure the slot with `getBoundingClientRect()` + a `ResizeObserver` (and re-measure on scroll/viewport changes — subscribe to `host.state.viewport`), and absolutely position the portal over the slot.
4. **Expanded:** the same portal switches to `inset: 0` with a high z-index (Korgo uses `z-[100]`), dark backdrop, `Escape` to collapse. Set a `data-overlay-surface` attribute on the fullscreen root so global app keyboard handlers can yield (Korgo's convention; harmless if Hermes ignores it).
5. `react` is an allowed import; `createPortal` however lives in `react-dom`, which is **not** importable. → **VERIFY AT RUNTIME**: check whether `@hermes/plugin-sdk` re-exports `createPortal` or a portal component. **If not available**: don't portal — instead render the surface directly inside the pane for collapsed mode, and for expanded mode move the *same DOM node* (`overlayRoot.appendChild(surfaceEl)`) into a plain `document.body`-appended fixed div managed imperatively in an effect. Moving a DOM node does not kill a canvas or the RFB session; this is a fully adequate substitute. Do not reconnect on expand under either implementation.

**Thumbnail behavior:**
- Interactive-on-click-through is OFF in collapsed mode: thumbnail is always rendered with pointer-events disabled and a click handler on the slot that expands. (A 300px-wide live desktop is unusable for input; clicks expanding is the Grok Bot behavior the user wants.)
- Aspect: read the true framebuffer size from the injected canvas's `width`/`height` **attributes** (authoritative), watched with a `MutationObserver` (`attributeFilter: ['width','height']`) so remote resolution changes re-fit the box. Set the thumbnail box's `aspectRatio` from it. Letterbox with the pane background; `clipViewport` stays `false` (Korgo tried clipping and reverted — "arrived decapitated").
- `scaleViewport = true` in both collapsed and expanded 'fit' mode; `resizeSession = false` (don't fight the remote resolution from a thumbnail-sized container — only offer `resizeSession` as an expanded-mode toggle later if trivial; not required for v1).

**Expanded controls bar** (top of overlay, auto-fade after 2s idle, reappear on mouse move):
- View-only `Switch` (live-updates `rfb.viewOnly`; initial from endpoint's `viewOnlyDefault`)
- Scale `SegmentedControl`: Fit / Native (native → `scaleViewport=false`, container scrolls)
- Paste button: `navigator.clipboard.readText()` → `rfb.clipboardPasteFrom(text)`
- Ctrl+Alt+Del button (`rfb.sendCtrlAltDel()`), behind a `Tooltip`
- Screenshot button: `rfb.toBlob(...)` → write PNG to clipboard if possible, else `ctx.os.notify` with a data-URL fallback saved via download; keep simple — clipboard-only is acceptable for v1
- Reconnect button, Disconnect button, Collapse (Escape) button
- Remote `clipboard` event → `ctx.os.writeClipboard(text)` (remote→local sync, Korgo parity)
- On pointer-down anywhere on the surface in interactive mode: `rfb.focus({ preventScroll: true })`

**Pane (collapsed) chrome:**
- Header row: `StatusDot` (state-colored) + endpoint name + desktop name (from `desktopname` event) + gear (settings dialog) + expand icon.
- Below thumbnail: connection state line using `text-(--ui-text-tertiary)`; on `error`, an `ErrorState` with the human message from §7 and a Reconnect `Button`; on unconfigured, an `EmptyState`: "No computer endpoint configured" + "Add endpoint" button opening settings.
- **Iframe mode:** the slot hosts the iframe directly (no portal needed for collapsed; expanded reuses the same overlay with a second iframe is WRONG — instead move the same iframe node exactly like the surface div, to preserve the session). Controls reduce to: Reload, Open in browser (`ctx.os.openExternal(iframeUrl)`), Expand/Collapse.

**Statusbar item** (`STATUSBAR_AREAS.right`, order 120): `StatusDot` + "Computer" label; click toggles the pane via `host.paneVisibility('computer-viewer:pane')` atom if it's writable, otherwise `host.navigate` is irrelevant here — **VERIFY AT RUNTIME**: the docs expose `host.paneVisibility(paneId)` as an atom getter; if it's read-only, the statusbar click instead expands/collapses the overlay and the label shows state only. Don't burn time here; statusbar is sugar.

---

## 6. Connection engine — DECIDED

A single module-level engine object (survives React re-renders; hot-reload recreates it — that's fine since hot reload disposes contributions). State machine:

```
unconfigured → idle → resolving → loading-novnc → connecting → connected
                                      ↘ error(code) ← disconnected
```

```javascript
const engine = {
  state: atom({ phase: 'idle', code: null, detail: null, desktopName: null, fbW: 0, fbH: 0 }),
  rfb: null,
  generation: 0,
  async connect(endpoint) { /* see rules */ },
  disconnect() { ... },
  reconnect() { ... },
}
```

Rules (each one earns its place — these are the bugs Korgo already fixed):

1. **Generation guard.** `const gen = ++engine.generation` at the top of every `connect()`/`disconnect()`; every `await`-resumption and every event handler checks `gen === engine.generation` before touching state. This prevents a slow old connection clobbering a new one on rapid endpoint switches / bot switches / unmounts.
2. **Fresh target.** Before `new RFB(...)`: `targetEl.replaceChildren()`.
3. **Resolve then connect.** `resolving` = for `session-json` mode, fetch the session now (never cached); for websocket mode, a no-op. Then `loading-novnc` (`loadRFB()`, §3.1), then construct.
4. **Event wiring:**
   - `connect` → phase `connected`; read canvas attrs for fbW/fbH; attach MutationObserver.
   - `credentialsrequired` → if a password is known, `rfb.sendCredentials({ password })` automatically (Korgo's pattern); if not, phase `error`/`password-required` and the settings dialog highlights the password field.
   - `securityfailure` → phase `error`/`vnc-auth-failed`, detail = `e.detail.reason`.
   - `desktopname` → store name.
   - `clipboard` → `ctx.os.writeClipboard(e.detail.text)`.
   - `disconnect` → `detail.clean ? 'disconnected' : (auto-reconnect path)`.
5. **Auto-reconnect — DECIDED (deliberate departure from Korgo, which only offers a manual button):** on **unclean** disconnect while the pane is visible: exponential backoff `1s, 2s, 4s, 8s, 15s` (5 attempts), each attempt a *full* `connect()` (re-fetches session in session-json mode — rotating tokens make this mandatory; idle proxies like nginx's 60s default read-timeout make unclean drops routine). After 5 failures → phase `error`/`unreachable` with a manual Reconnect button. Clean disconnects (user-initiated, server shutdown) never auto-retry. A successful `connect` event resets the backoff. Timer must be cancelled by generation bump.
6. **Visibility-driven lifecycle:** `autoConnect && pane visible && phase in {idle, disconnected}` → connect (mirror Korgo's `useEffect`). Pane hidden/plugin disabled → `disconnect()` + clear timers/observers. Never hold a connection for an invisible pane.
7. **Auth failure shapes — handle all three distinctly** (they present differently):
   - websockify token rejected → socket closes mid-handshake → unclean `disconnect`, **no** `securityfailure`. After backoff exhaustion in session-json mode, error detail should hint "token may have expired/been rejected".
   - wrong VNC password → `securityfailure`.
   - password required but absent → `credentialsrequired` unanswered → `password-required`.

---

## 7. Error states — exact copy

| code | Message (title / body) |
|---|---|
| `unconfigured` | "No computer endpoint" / "Add a VNC endpoint to see a live desktop here." |
| `cdn-blocked` | "Couldn't load the viewer" / "noVNC couldn't be fetched from the CDN (network or CSP). Switch this endpoint to iframe mode, or check your connection." |
| `mixed-content` | "Blocked insecure connection" / "ws:// to a public host is blocked. Use wss:// (TLS) or a localhost/Tailscale address." (Detect *before* attempting: `wsUrl` starts `ws://` + non-private host.) |
| `password-required` | "Password required" / "This server asked for a VNC password. Add it in endpoint settings." |
| `vnc-auth-failed` | "Authentication failed" / detail from `securityfailure.reason`. |
| `session-failed` | "Session request failed" / "GET {sessionUrl} → HTTP {status}." |
| `unreachable` | "Can't reach the computer" / "Gave up after 5 attempts. Check that the endpoint is up ({wsUrl})." |

All errors render as `ErrorState` in the pane with a Reconnect button and a gear shortcut. Never a blank box; never a raw stack trace.

---

## 8. Backend recipes (must appear in README, verbatim-usable)

1. **Local VNC + websockify:** `websockify 6080 localhost:5900` → endpoint `ws://localhost:6080/websockify`, password = VNC password. (`/websockify` is noVNC's conventional default path.)
2. **Grok-Bot-style local Docker box:** containers like grokbot-shim's expose a full noVNC page at `http://127.0.0.1:6080/vnc.html` — either use **iframe mode** with that URL (identical to Grok Bot's own webview approach), or websocket mode against the same origin's `/websockify`.
3. **Remote VPS:** must be `wss://` behind nginx/caddy TLS (`wss://host/websockify`). Self-signed certs fail *silently* at the websocket layer — user must trust the cert by visiting the https origin once. Include an nginx `proxy_read_timeout`/upgrade snippet in the README.
4. **Rotating APIs (Orgo etc.):** session-json mode; document the expected response shape `{ "websocketUrl": "wss://...", "password": "..." }` and note that the same rotating password often doubles as the websockify `?token=`.

---

## 9. Non-goals (v1)

- No multiple simultaneous connections (one active endpoint at a time; switching bots switches the connection).
- No `resizeSession` control, no clipboard *file* transfer, no audio, no session recording.
- No secret-grade credential storage (documented limitation instead).
- No backend/agent-plugin component — desktop-only plugin, no `plugin.yaml`.

---

## 10. Acceptance criteria

Build is done when all of these pass:

1. `node --check plugin.js` passes; file has zero static imports beyond the three allowed specifiers.
2. Dropped into `~/.hermes/desktop-plugins/computer-viewer/plugin.js`, the plugin appears in Settings → Plugins, and a "Computer" pane appears docked right; disabling the plugin removes pane + statusbar item + palette entries cleanly (no console errors), re-enabling restores them.
3. Against a local test target (`x11vnc` or a Docker desktop image + `websockify 6080 localhost:5900`): pane shows a live thumbnail within ~2s of becoming visible; clicking it expands to fullscreen **without reconnecting** (verify: no second websocket in devtools network tab); Escape collapses; mouse + keyboard work in expanded interactive mode; view-only toggle stops input immediately.
4. Kill websockify while connected → pane shows reconnecting states with backoff, then `unreachable` with a working Reconnect button; restart websockify + click Reconnect → live again.
5. Wrong password → `vnc-auth-failed` (not a spinner, not `unreachable`). Empty password against a password-requiring server → `password-required`.
6. Iframe mode against `http://127.0.0.1:6080/vnc.html` (any noVNC-serving container) renders, reloads, expands/collapses without losing the iframe session.
7. Settings persist across app restart and hot reload; per-bot override: with two bots mapped to two endpoints, tabbing between their chats switches the connection (watch the status line).
8. Simulated CSP failure (temporarily point `NOVNC_URL` at a garbage URL): pane shows `cdn-blocked`, not an unhandled rejection; iframe-mode endpoints still work.
9. Every Hermes theme: pane chrome uses theme variables — no hardcoded hex visible in chrome (letterbox black behind the canvas is exempt).

---

## 11. Reference material (in this folder)

`references/korgo/` — fetched sources from `github.com/nickvasilescu/korgo-bot`, **for study only, do not copy code**:
- `index.tsx` — the complete 670-line viewer pane (portal pattern, generation guard, MutationObserver geometry, panel-bar crop, event wiring). This is the primary implementation reference.
- `orgo-desktop.ts` — rotating-session fetch + URL construction (session-json mode reference).
- `novnc.d.ts` — hand-rolled RFB typings (handy as an API crib sheet).
- `rail.tsx` — resizable rail shell (not needed; Hermes panes handle sizing).
- `desktop-package.json` — confirms `"@novnc/novnc": "1.7.0"`.

Docs to consult if stuck: Hermes SDK `https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk` · noVNC API `https://github.com/novnc/noVNC/blob/master/docs/API.md` · example plugins `https://github.com/tonbistudio/hermes-desktop-plugins` (especially `placement-playground` for contribution mechanics).

---

## 12. Known limitations to state in the README

- Passwords in `ctx.storage` are plain text on disk (`hermes.plugin.computer-viewer.*`).
- CDN dependency in websocket mode (offline Hermes = iframe mode only, or vendor the `+esm` file — vendoring requires serving it somehow since relative imports don't resolve; out of scope v1).
- `ws://` to non-private hosts may be blocked by the renderer (mixed content); use `wss://`.
- Keyboard capture: in expanded interactive mode the remote desktop receives most keys; Escape is reserved for collapse (send Escape to the remote via view-only toggle off + on-screen note, or accept the tradeoff — accept for v1, document it).
- One connection at a time; thumbnails of *multiple* bots' computers simultaneously is a future version.
