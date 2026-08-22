# Computer — live desktop viewer for Hermes Desktop

A Hermes Desktop plugin that docks a live remote-desktop thumbnail on the right. Click the thumbnail to expand a full interactive view. One connection serves both sizes; expand/collapse does not reconnect.

Plugin id: `computer-viewer` (folder name must match).

## Install

Copy this file to Hermes's desktop-plugin directory. The folder name **must** be `computer-viewer`.

```bash
# macOS / Linux (default profile)
mkdir -p ~/.hermes/desktop-plugins/computer-viewer
cp plugin.js ~/.hermes/desktop-plugins/computer-viewer/plugin.js
cp connect-mac.sh ~/.hermes/desktop-plugins/computer-viewer/connect-mac.sh
chmod +x ~/.hermes/desktop-plugins/computer-viewer/connect-mac.sh
```

Named Hermes profile:

```bash
mkdir -p ~/.hermes/profiles/<name>/desktop-plugins/computer-viewer
cp plugin.js ~/.hermes/profiles/<name>/desktop-plugins/computer-viewer/plugin.js
cp connect-mac.sh ~/.hermes/profiles/<name>/desktop-plugins/computer-viewer/connect-mac.sh
chmod +x ~/.hermes/profiles/<name>/desktop-plugins/computer-viewer/connect-mac.sh
```

Windows (typical):

```text
%LOCALAPPDATA%\hermes\desktop-plugins\computer-viewer\plugin.js
```

Then:

1. Hermes Desktop hot-loads disk plugins within a few seconds. If it does not appear, open the command palette (⌘K / Ctrl+K) and run **Reload desktop plugins**.
2. Enable it in **Settings → Plugins**. The inventory name is **Computer**.
3. A **Computer** pane docks on the right (320px). The status bar shows a Computer chip on the right.

Disable the plugin from Settings → Plugins to tear down the pane, status-bar item, palette commands, keybind, and any live RFB / iframe session.

## First-run setup

The pane starts empty until you add a computer:

1. Click the gear in the pane header (or **Add endpoint**).
2. Paste into **Computer address**. The field accepts any of the shapes below — you do not pick a mode.
3. Optional password. **Connect**.
4. **Default** marks the global computer. Optionally pick a per-bot override at the top of the dialog (bound to the focused chat's profile).

| You paste | What happens |
|---|---|
| `wss://host/websockify` (or `ws://` on a private host) | Treated as a VNC address. |
| `http://127.0.0.1:6080/vnc.html` (a noVNC page) | Embedded as a web viewer. |
| `https://api.example/computers/id` | Fetches the connection from that API. |
| An API key (`sk-…` / `sk_…`, or a similar bare key) | **Find my computers**, then pick one. |
| `host:port` or a hostname (`macbook.local:6080`) | Probes WebSocket `/websockify`, then `http://host:port/vnc.html`. |

Power fields (explicit mode, raw URLs, username, scale, quality, …) live under **Advanced**.

Passwords are stored locally in plugin storage **in plain text** (`hermes.plugin.computer-viewer.*`). Prefer a token in the WebSocket URL or a session endpoint for anything sensitive. There is no secret-grade credential store.

## Backend recipes

### 1. Local VNC + websockify

Bridge a local VNC server (for example `:5900`) through websockify:

```bash
websockify 6080 localhost:5900
```

Paste `ws://localhost:6080/websockify` into **Computer address**, plus your VNC password.

`/websockify` is noVNC's conventional default path.

### 2. Use a spare Mac as your computer

1. **Enable Screen Sharing** (manual): System Settings → General → Sharing → Screen Sharing.
2. **Run `connect-mac.sh`** (one paste in Terminal — no sudo). From this folder, or after install:

   ```bash
   bash connect-mac.sh
   ```

   The script installs `websockify` via `python3 -m pip install --user websockify` (falling back to `pipx` or `brew` if present), writes a LaunchAgent at `~/Library/LaunchAgents/com.computer-viewer.websockify.plist` that runs `websockify 6080 localhost:5900` at login, loads it, and prints an address like `ws://<hostname>.local:6080/websockify`. Tailscale names work too (`ws://<tailscale-name>:6080/websockify`).
3. In the plugin: paste that address, then under **Advanced** fill **Username** (your Mac login) and **Password**.

`ws://` is allowed only for private-network hosts (this Mac, LAN, `.local`, Tailscale `100.64.0.0/10` / `*.ts.net`). Public hosts need `wss://`.

Retina Macs report a large framebuffer. Keep **Fit** scale (the default) so the view shrinks into the pane; **Native** will scroll.

### 3. Grok-Bot-style local Docker box

Containers like grokbot-shim expose a full noVNC page at `http://127.0.0.1:6080/vnc.html`.

Paste `http://127.0.0.1:6080/vnc.html` to embed that page (Reload / Open in browser). Or paste `ws://127.0.0.1:6080/websockify` for scale, view-only, clipboard, and Ctrl+Alt+Del.

### 4. Remote VPS

Public hosts **must** be `wss://` behind TLS (nginx, Caddy, …). Example endpoint: `wss://host/websockify`.

Self-signed certificates fail *silently* at the websocket layer. Visit the `https://` origin once in a browser (or the desktop webview) and trust the cert, then reconnect.

Plain `ws://` to a non-private host is blocked before connect (mixed content). `ws://` is allowed only for `localhost`, `127.0.0.1`, RFC1918 / link-local IPs, `*.local`, Tailscale `100.64.0.0/10`, and `*.ts.net`.

nginx snippet (websocket upgrade + a long read timeout; idle proxies like nginx's 60s default make unclean drops routine):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name desktop.example.com;

    # ssl_certificate     /path/to/fullchain.pem;
    # ssl_certificate_key /path/to/privkey.pem;

    location /websockify {
        proxy_pass http://127.0.0.1:6080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:6080;
        proxy_set_header Host $host;
    }
}
```

Caddy equivalent:

```caddy
desktop.example.com {
    reverse_proxy 127.0.0.1:6080
}
```

### 5. Rotating APIs (Orgo, Modal, …)

Paste the session API URL into **Computer address** when the desktop URL is minted per session instead of being stable. (Advanced: Session JSON.)

`GET` `sessionUrl` (optional `Authorization: Bearer <sessionBearer>`) must return JSON of this shape:

```json
{
  "websocketUrl": "wss://www.example.com/desktops/abc/ws/websockify?token=…",
  "password": "…"
}
```

`websocketUrl` is required unless the body is an Orgo computer document (`fly_instance_id` / `instance_id` instead — see below); `password` is optional. The engine then behaves exactly like WebSocket mode.

The session is **re-fetched on every (re)connect** — never cached. Rotating tokens make a cached URL the #1 cause of mystery reconnect failures. The same rotating password often doubles as the websockify `?token=` query parameter; sending it both in the URL and as RFB credentials is the usual pattern.

Non-2xx responses or a body without a usable `websocketUrl` (and without an Orgo instance id) surface as **Session request failed** (`GET {sessionUrl} → HTTP {status}.`).

#### Orgo

Paste your API key into **Computer address**, click **Find my computers**, pick a workspace/computer, then **Connect**. The plugin fills the session URL as `https://www.orgo.ai/api/computers/<computer-id>` (and names the computer after the pick if it was still "My computer", "Local box", "Untitled", or empty). Discovery origin defaults to `https://www.orgo.ai`; override it with **Session URL** under Advanced.

If discovery can't reach the API from the app, paste the session URL by hand (Computer address or Advanced):

- **Session URL:** `https://www.orgo.ai/api/computers/<computer-id>`
- **Bearer:** API key (from orgo.ai settings) — or paste the key into Computer address.

The official computer document has no `websocketUrl`; Session JSON mode constructs it.

Live `GET /api/computers/{id}` returns `{ id, status, fly_instance_id, hostname, connection_url, vnc_password }` (Orgo's docs still say `instance_id`). The plugin accepts the first non-empty of `instance_id` / `instanceId` / `fly_instance_id` / `flyInstanceId` (must match `/^[a-zA-Z0-9-]+$/`), and if those are missing it uses the last path segment of `connection_url`. It builds:

```text
wss://{host}/desktops/{instance_id}/ws/websockify?token={password}
```

`{host}` is the hostname of `connection_url`, else the body's `hostname`, else the Session URL host (never hardcoded). `password` is `vnc_password` falling back to `password`; if still empty, the plugin GETs `{origin}/api/computers/{id}/vnc-password` and reads `password` / `vnc_password` (that extra call is non-fatal). If there is still no password, `?token=` is omitted. The same password is also the RFB credential. It rotates on every computer restart, which is why the session is re-fetched on each connect.

Workspace discovery follows the live list shape `{ projects: [{ desktops: [...] }] }` (docs still say `workspaces` / `computers`). If the list embeds no computers and the Session URL contains a UUID, the plugin also tries `GET /api/computers/{uuid}` — the id in an Orgo dashboard `/workspaces/{uuid}` URL is sometimes a desktop id, not a project id.

If `status` is a non-running lifecycle value (`stopped`, `stopping`, `creating`, `starting`, `restarting`, `deleting`, `error`), the pane shows **Session request failed** with `Computer status: {status}. Start it in Orgo first.`

Official Orgo docs say API keys are meant to be server-side. If the API rejects browser-origin requests, paste the constructed `wss://` URL directly plus the current VNC password (valid until the computer restarts).

## Viewer modes

The address field picks a mode for you. These names only appear under **Advanced**.

| Mode | How it connects | When to use |
|---|---|---|
| **WebSocket** (default) | Dynamically loads noVNC 1.7.0 (`RFB`) from jsDelivr, then `esm.sh` if that import throws. | Full controls: scale, view-only, clipboard, Ctrl+Alt+Del, screenshot. |
| **Iframe** | `<iframe>` pointed at a hosted noVNC page. No CDN. | CSP blocks the noVNC module, you're offline, or you already have `vnc.html`. |
| **Session JSON** | `GET` a session document, then WebSocket/RFB as above. | Rotating desktops (paste the API URL or an API key). |

If noVNC cannot be loaded from the CDN (network or CSP), the pane shows **Couldn't load the viewer** and tells you to switch the endpoint to iframe mode (Advanced, or paste a `vnc.html` URL). Iframe endpoints keep working in that situation.

## Controls

### Pane (collapsed)

| Control | Action |
|---|---|
| Thumbnail | Always view-only. Click to expand. Pointer events are disabled on the live surface so a 320px desktop is not an input target. Optional top-panel crop is **off by default** (see below). |
| Status dot | Connection state (idle / connecting / connected / error). |
| Gear | Opens the settings dialog. |
| Expand (or ⌘⇧D / Ctrl+Shift+D) | Fullscreen overlay. Same RFB/iframe node — no reconnect. |
| Connect / Reconnect | Shown when idle, disconnected, or on error. |
| Reload / Open in browser | Iframe mode only. |

The collapsed thumbnail can crop a top panel strip (XFCE-style, `min(12%, 28px/fbH)`). **`cropPanel` defaults to off** — stored endpoints that omit the field do not crop. Turn it on per endpoint in settings if you want the thumbnail to hide a top panel; hiding the panel in the VM is the recommended approach, because crop can clip bottom dock icons. Fullscreen is never cropped.

### Expanded overlay

Mouse-move shows the bar; it auto-fades after 2s idle. Escape collapses (Escape is reserved for collapse and is **not** sent to the remote).

| Control | Action |
|---|---|
| View only | Live-updates `rfb.viewOnly`. |
| Fit / Native | Fit scales the framebuffer into the overlay. Native turns scaling off and lets the container scroll. |
| Paste | `navigator.clipboard.readText()` → `rfb.clipboardPasteFrom`. Remote clipboard events write back via `ctx.os.writeClipboard`. |
| Ctrl+Alt+Del | `rfb.sendCtrlAltDel()`. |
| Screenshot | `rfb.toBlob` → PNG on the clipboard when possible; otherwise a PNG download. |
| Reconnect | Full `connect()` (re-fetches session JSON). |
| Disconnect | Clean disconnect; does not auto-retry. |
| Collapse | Leave fullscreen. |

Iframe expanded controls are Reload, Open in browser, and Collapse.

### Command palette and keybind

| Command | Default |
|---|---|
| Computer: Toggle Pane | Palette. Toggles pane visibility when the host atom is writable; otherwise expands/collapses the overlay. |
| Computer: Reconnect | Palette. |
| Expand computer view | `mod+shift+d` (rebindable in Settings). |

### Per-bot endpoints

Effective endpoint = `perBotEndpoint[focusedProfile] ?? globalEndpointId`. Switching the focused chat to a profile that resolves to a **different** endpoint disconnects and reconnects. The same endpoint is left alone.

`autoConnect` (default on) connects when the pane becomes visible and disconnects when it is hidden or the plugin is disabled. Connection state is not persisted; `lastExpanded` is.

## Auto-reconnect

On an **unclean** RFB disconnect while the pane is visible, the engine retries with exponential backoff `1s, 2s, 4s, 8s, 15s` (5 attempts). Each attempt is a full `connect()` (session JSON is re-fetched). After 5 failures the pane shows **Can't reach the computer** with a Reconnect button. Clean disconnects (you clicked Disconnect, or a clean server shutdown) never auto-retry.

Auth failures are distinct and do **not** fall through to unreachable:

- wrong VNC password → **Authentication failed**
- server asked for a password and none is stored → **Password required** (settings dialog highlights the password field)
- session-json token rejected at the socket (unclean drop, no `securityfailure`) → backoff, then unreachable with a token-expired hint

## Compatibility

Old nginx/websockify backends that require the legacy `binary` WebSocket subprotocol are auto-negotiated: a handshake-phase failure retries once with the other variant and the working choice is remembered per endpoint.

## Limitations

- Passwords in `ctx.storage` are plain text on disk (`hermes.plugin.computer-viewer.*`).
- CDN dependency in websocket mode (offline Hermes = iframe mode only, or vendor the `+esm` file — vendoring requires serving it somehow since relative imports don't resolve; out of scope v1).
- `ws://` to non-private hosts may be blocked by the renderer (mixed content); use `wss://`.
- Keyboard capture: in expanded interactive mode the remote desktop receives most keys; Escape is reserved for collapse (send Escape to the remote via view-only toggle off + on-screen note, or accept the tradeoff — accepted for v1).
- One connection at a time; thumbnails of *multiple* bots' computers simultaneously is a future version.
- No `resizeSession` control, no clipboard *file* transfer, no audio, no session recording.
- Desktop-only plugin — no agent-side `plugin.yaml`.
