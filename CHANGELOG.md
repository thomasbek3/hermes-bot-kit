# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — 2026-08-24

First public release.

### Desktop plugin (`plugin.js`)

- Dockable "Computer" pane: live remote-desktop thumbnail on the right,
  click-to-expand fullscreen; one connection serves both sizes (no
  reconnect on expand).
- Multi-endpoint switcher with per-bot bindings; inactive machines keep a
  last-frame snapshot.
- Address field auto-detects: websocket URLs, noVNC pages, Orgo session
  APIs, or bare `host:port`.
- Optional HD overlay (H.264 over WebSocket) with automatic VNC fallback.
- View-only mode, quality/compression tuning, clipboard sync, reconnect
  backoff with session re-fetch for rotating endpoints.

### Host setup

- One-paste bridge installers for macOS, Windows, and Linux
  (`connect-*`): VNC bound to loopback + websockify on 6080.
- Headless Windows support: virtual display driver + UltraVNC capture.
- Optional HD agent installers for macOS (VideoToolbox), Windows
  (NVENC/x264), Linux (VAAPI/x264) on port 6090.

### Agent plugin (`agent-plugin/orgo-computer`)

- `orgo_computer_bash`: run shell commands on the pinned computer.
- `orgo_computer_run`: delegate bounded GUI/browser tasks to Orgo's
  hosted computer-use agent.
- Per-profile computer pinning via `/computer`.

[0.1.0]: https://github.com/thomasbek3/hermes-computer-viewer/releases/tag/v0.1.0
