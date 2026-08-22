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
