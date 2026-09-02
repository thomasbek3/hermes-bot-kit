# Changelog

## 1.0.1 — 2026-09-02

- Cached tasks now restore only when both the bot profile and canonical
  session ID match. A partially settled bot switch can no longer show one
  session's Tasks panel under another.
- The stable Scheduled Jobs ownership pane now keeps Task Dock mounted during
  transient transcript remounts, preventing disappear/reappear flashes.
- While enabled, Task Dock reversibly hides the stock widget after capture so
  the source and cloned panels never render as duplicates.
- Multiple stock task widgets collapse into one dock using the newest list.
- Completed lists auto-hide when counts are complete or every visible item is
  completed/cancelled.
- The dock close button hides all task UI while keeping source suppression
  active; **Task Dock: toggle** brings the single dock back.

## 1.0.0 — 2026-09-01

- First release. Captures the live **Tasks N/M** composer widget while it is
  on screen and re-renders a compact dock above the composer after the app
  clears the list on view unmount (bot switch). Snapshots are per-bot,
  throttled to about one write per second, and expire after 24 hours.
- Palette command **Task Dock: toggle**. Collapse/expand and enabled state
  persist in plugin storage.
- Bot Chat only. The app widget is mirrored, never adopted or mutated.
