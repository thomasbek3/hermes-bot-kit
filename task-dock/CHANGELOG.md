# Changelog

## 1.0.0 — 2026-09-01

- First release. Captures the live **Tasks N/M** composer widget while it is
  on screen and re-renders a compact dock above the composer after the app
  clears the list on view unmount (bot switch). Snapshots are per-bot,
  throttled to about one write per second, and expire after 24 hours.
- Palette command **Task Dock: toggle**. Collapse/expand and enabled state
  persist in plugin storage.
- Bot Chat only. The app widget is mirrored, never adopted or mutated.
