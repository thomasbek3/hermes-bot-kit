# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed

- Viewer auto-connects when the bot starts using its computer: a fresh
  orgo-computer tool row during a live turn wakes the pane (releases a manual
  Disconnect hold too), so you watch the bot work without clicking Connect —
  Grok Bot behavior. History renders never trigger it; throttled to one wake
  per 30s.

- Pane docking: the Computer pane now docks ON TOP of Bot Mode's Cronjobs
  pane instead of beside the workspace. Cronjobs re-enforces its own dock on
  every app launch (stock Hermes behavior), which used to split the two into
  separate columns and revert any manual arrangement; both enforcements now
  converge to one right column (Computer above Cronjobs) on every launch.

### Added

- `orgo-term`: one-shot root shell on an Orgo computer over the official
  WebSocket PTY. Free (no AI credits). Set `ORGO_COMPUTER_ID` + `ORGO_API_KEY`.
- `orgo-hands`: screenshot / click / type / key over Orgo REST (no AI credits).
- Agent plugin hands: `orgo_computer_screenshot`, `orgo_computer_click`,
  `orgo_computer_type`, `orgo_computer_key`. Hosted `orgo_computer_run` is
  off unless plugin config `hosted_run: true`.

### Docs

- README: bash and hands are free; hosted `orgo_computer_run` is opt-in.
  Measured Chrome timing. Chrome-on-Orgo launch flags (`DISPLAY=:99`).
- `docs/KNOWN-ISSUES.md`: Orgo Chrome/DISPLAY=:99 and inbound-SSH-blocked.

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

[0.1.0]: https://github.com/thomasbek3/hermes-bot-kit/releases/tag/v0.1.0
