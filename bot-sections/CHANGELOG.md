# Changelog

## 1.2.2 — 2026-08-29

- Right-click on headers truly wins now: the app opens its own menu on the
  right-button PRESS (mousedown), before contextmenu ever fires. The plugin
  intercepts the press itself (window capture, headers only) and swallows
  the follow-up contextmenu. Right-click anywhere else is untouched.

## 1.2.1 — 2026-08-29

- Right-click on a section header now reliably opens OUR menu: the app's
  global context menu was capturing the event first; the plugin now
  intercepts at window capture phase, scoped strictly to its own headers —
  right-click everywhere else is untouched.

## 1.2.0 — 2026-08-29

- Right-click a section header for a proper menu: an emoji picker
  (🏠 💼 📣 💰 ⚙️ 🧪 🚀 ✨ 🤖 📈 + remove), Rename with a real input field
  (Enter saves, Escape cancels, Save button), and Collapse/Expand.
  Double-click still jumps straight to rename. The 1.1.0 inline
  contenteditable rename fought the app's global keybinds (Enter never
  committed) and is replaced by the input.

## 1.1.1 — 2026-08-29

- Headers are actually clickable: 1.0.0 shipped them with
  `pointer-events: none`, which silently ate 1.1.0's collapse/rename
  clicks. Editable label gets a visible outline while renaming.

## 1.1.0 — 2026-08-29

- Click a section header to collapse/expand it (persisted per install;
  caret rotates).
- Double-click a header to rename it in place — emoji welcome
  ("🏠 Airbnb Operations"). Section IDs (config keys, cycle commands) stay
  stable; only the displayed label changes. Enter commits, Escape cancels.


## 1.0.0 — 2026-08-29

- First release. Named group headers in the Bot Mode roster (Apollo / OMH /
  HQ, plus automatic Unassigned), driven by a `SECTIONS` config block and
  per-bot palette cycle commands.
- Annotates React-owned bot rows (`data-bot-section` + CSS `order`); appends
  plugin-owned headers at the end of each bot-row list and positions them
  with `order`. Never re-parents React nodes.
- Scoped to `hermes-bots:pane`. Native gateway / group-chat / Hidden
  headings stay. Ordering is per gateway bucket when the roster is split.
- Fails safe: selector miss → stock roster.
