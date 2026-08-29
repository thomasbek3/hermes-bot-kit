# Changelog

## 2.1.0 — 2026-08-29

- Quiet chat also hides background-process notification rows ("Background
  process proc_… exited"). Agent-to-agent chips ("Message from X" /
  "Replied to X") stay visible. "toggle work rows" restores everything.

## 2.0.1 — 2026-08-29

- Never bubble the live composer (the 0.20.6 redesign moved it into the
  message structure; the user-bubble rule was shrinking the input bar).

## 2.0.0 — 2026-08-28

- Hermes Desktop 0.20.6 support (Bot Mode redesign): new detection path —
  the canonical chat now renders in the main workspace, gated via the
  public "Scheduled Jobs (routines) tile seated" signal (hermes-bots seats
  it only while a real bot chat owns the workspace, never for group chats)
  plus a visible transcript check. The 0.20.5 tab-strip path is kept, so
  one plugin works on both versions.

## 1.5.0 — 2026-08-28

- Quiet chat also hides the per-reply timer chips ("3s", "7s") in Bot Chat.
  "Bubble Mode: toggle work rows" brings them back along with the rest.

## 1.4.2 — 2026-08-28

- Stray pre-reply mini-bubble fully fixed (containers whose children are all
  empty are treated as empty).
- Typing indicator resized to Grok-Bot proportions: smaller pill, tighter
  6px dots.

## 1.4.1 — 2026-08-28

- Typing indicator: the empty just-created reply container no longer renders
  as a stray mini-bubble next to the "..." dots.

## 1.4.0 — 2026-08-28

- Sticky canonical detection: tab ids once seen labeled "Bot Chat" keep the
  SMS styling even when a serve-process restart re-binds the tab and
  scrambles its caption (the recurring "bubbles randomly turned off" bug).
  Remembered per install, capped at 64 tabs.

## 1.3.0 — 2026-08-28

- Typing indicator: while the bot is thinking or working, the loading row
  renders as an iMessage-style "..." bubble with three pulsing dots
  (Bot Chat only, pure CSS on the stock aui_response-loading slot).

## 1.2.0 — 2026-08-28

- Bubbles + quiet chat now apply ONLY to the canonical "Bot Chat" tab (the
  bot's main conversation) — matching the texting-style plugin's gate.
  Long-form side sessions and new drafts in Bot Mode render stock.

## 1.1.0 — 2026-08-28

- Quiet chat: in Bot Mode, thinking disclosures, reasoning text, activity
  rows, and tool blocks are hidden by default (approvals and the typing
  indicator always stay visible). New palette command "Bubble Mode: toggle
  work rows" brings them back; the choice persists.

## 1.0.1 — 2026-08-28

- Mixed text+code replies: split mode now also triggers on bare `pre`,
  `table`, mermaid blocks, and image wrappers (previously an unrecognized
  code-block variant could leave the whole reply in one giant bubble).
- Split mode: text chunks get 3px vertical gaps so consecutive paragraphs
  read as separate bubbles instead of fusing into a slab; `hr` and wrappers
  containing `pre`/`table` are never bubbled.

## 1.0.0 — 2026-08-27

- Initial release.
- iMessage-style bubbles scoped to Bot Mode chats only; Sessions untouched.
- Grok-Bot gray palette: user `#4a4a4e` (right), assistant `#2b2b2e` (left),
  18px radius with a 4px tail.
- Cards, code blocks, tool runs, approvals, and thinking sections keep stock
  chrome via slot exclusions and a `:has()` split.
- Command-palette toggle ("Bubble Mode: toggle"), persisted per install.
- Pure CSS + body-class toggle; no core patches, no network, read-only SDK use.
- Built and verified against Hermes Desktop v0.20.5 (macOS).
