# Changelog

## 1.5.0 — 2026-08-31

- Agent-writable assignments file at `<hermesHome>/bot-sections.json`
  (`sections` + `assign`). Polled every 5s via `readFileText`; applied
  only when the raw text changes so palette/UI moves are not fought.
  Missing file is silent; malformed JSON warns once per distinct
  content. `"Unassigned"` clears a bot's override. The file never
  deletes sections.


## 1.4.5 — 2026-08-29

- Editor polish round: the smiley button sits below the input (1.4.4), and
  tapping it now opens a full scrollable emoji palette (120 emojis,
  iMessage-style grid) instead of a single short row.


## 1.4.3 — 2026-08-29

- Rename / New section editor redone: no Save button — Enter saves, and so
  does clicking anywhere outside (autosave; Escape cancels). The emoji strip
  is hidden behind an iMessage-style smiley button at the end of the input.


## 1.4.2 — 2026-08-29

- Menu slimmed: Collapse/Expand removed — left-click on the header already
  does it; the menu is Rename…, New section…, and Delete section.
- Screenshots added to the README (annotated roster + the right-click menu).


## 1.4.1 — 2026-08-29

- Collapse is instant (the 250ms double-click disambiguation delay is gone;
  double-click rename retired — right-click → Rename… is the path).
- Caret is a proper chevron (bigger, straight, rotates cleanly), replacing
  the CSS border-triangle that rendered slightly diagonal.


## 1.4.0 — 2026-08-29

- **Cold-start ready for everyone.** The `SECTIONS` config block is now a
  one-time seed: on first launch it imports into storage, which becomes the
  single source of truth — so every section (including ones from config)
  can be renamed and deleted, and plugin updates never clobber your layout.
  The shipped default config is empty: a fresh install shows one
  "Unassigned (n)" section wrapping all bots — right-click it → New
  section… to start organizing.
- **Bots auto-discovered from the roster** for the palette: "Bot Sections:
  cycle <bot>" commands now exist for every bot visible in your roster, not
  just ones already mapped — so new sections can be populated immediately.


## 1.3.3 — 2026-08-29

- Delete section works visibly: the deleted section's header element was
  left orphaned in the roster (the sync loop never visits removed
  sections); headers not in the current ladder are now swept out.

## 1.3.2 — 2026-08-29

- Menu hover/clicks for real this time: the app's dismiss-layer locks the
  whole page with body pointer-events:none and exempts only its own portal.
  Our menu now exempts itself the same way (and unlocks the page while
  open), so items highlight and respond.

## 1.3.1 — 2026-08-29

- Menu items respond again: the app menu's invisible dismiss-layer (its
  full-screen click-catcher) was floating above our menu, eating hover and
  clicks. The whole rival portal is now hidden and our menu re-asserts
  itself as the top hit-test layer.

## 1.3.0 — 2026-08-29

- **New section…** in the header right-click menu: name it inline (emoji
  strip under the input), it appears immediately and stays visible while
  empty so you can cycle bots into it. Custom sections persist per install
  and get a **Delete section** menu item (bots fall back to Unassigned).
- **Emoji picker moved where it belongs:** no more always-visible strip at
  the top of the menu — it now appears under the input when you click
  Rename… or New section…, Notion-style: tap an emoji to prepend it, Enter
  saves name + emoji together.


## 1.2.4 — 2026-08-29

- Menu restyled from the app's own context-menu recipe (same tokens:
  --ui-bg-elevated color-mix surface, --ui-stroke-secondary border,
  --ui-control-active-background hover, item metrics, icons on
  Rename/Collapse) — tracks the app theme.
- Section headers light up on hover (the app's own hover tokens) and show a
  native-style tooltip chip: "<name> · N bots · right-click for options".

## 1.2.3 — 2026-08-29

- The app's context menu is opened by a boot-time window-capture listener a
  plugin cannot run before; when the section menu opens on a header, the
  app menu is now hidden the moment it mounts (narrowly identified, never
  touched anywhere else).

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
