# Known issues & design notes

Everything non-obvious we hit while building and testing on real machines.
None of these break chats — the plugin's failure mode is always "the SMS look
simply doesn't apply".

## By design

- **Only the canonical Bot Chat is styled (since 1.2.0).** The gate is the
  selected tab titled "Bot Chat" — the desktop's per-bot main conversation,
  the same title Hermes core gates on in `tools/bot_mode_probe.py`. Long-form
  side tabs, new drafts, Sessions view, and group chats all render stock,
  even inside Bot Mode.
- **Work rows are hidden by default (since 1.1.0).** Thinking disclosures,
  reasoning text, activity rows, tool blocks, and per-reply timer chips are
  `display: none` in Bot Chat. Approvals are never hidden, and the typing
  indicator shows the bot is busy. "Bubble Mode: toggle work rows" restores
  everything (persisted).
- **Cards, code blocks, and images keep their stock chrome.** Only plain
  conversation text becomes a bubble. When a reply mixes text and cards, the
  text paragraphs get bubbles (with small gaps) and the cards render
  untouched. The split triggers on any `pre`, `table`, mermaid block, or
  image — not just known card slots (1.0.1).
- **Background-process notification rows are hidden in quiet mode (2.1.0).**
  Agent-to-agent chips ("Message from X" / "Replied to X") are conversation
  and always stay. "toggle work rows" restores the process rows.
- **The live composer is exempt from all bubble styling (2.0.1)** — any
  element containing a textarea/contenteditable/input renders stock.
- **The edit composer is tinted too.** Editing one of your sent messages
  reuses the same bubble surface, so the editor shows your bubble color.
  Cosmetic, accepted.

## Environment-specific

- **Colors are tuned for the dark theme.** User bubble `#4a4a4e`, assistant
  `#2b2b2e` (Grok-Bot palette). On a light theme they'll look heavy — edit
  the hex values in the `CSS` block at the top of `plugin.js`.
- **A brand-new bot draft may bubble a beat late.** Detection reads the
  pane/tab state; a tab whose chat surface hasn't painted yet is caught on
  the next frame by the DOM observer. You may see one unstyled frame.

## Upstream bug: tab caption scramble (worked around in 1.4.0)

Stock Hermes Desktop: when the per-profile `hermes … serve` process backing
an open Bot Chat restarts (crash, kill, heavy load), the desktop re-binds
the tab as a plain session tab and the "Bot Chat" caption is replaced by a
message-derived label. The session itself is untouched — its DB title stays
`Bot Chat` (user provenance) — only the visible caption is wrong.

- **Plugin impact (fixed):** the label gate would turn the styling off.
  Since 1.4.0 the plugin remembers tab ids it has seen correctly labeled
  (persisted, capped at 64), so styling survives the scramble.
- **Cosmetic remainder (upstream):** the caption itself stays wrong until
  you close the tab, quit the app (so the layout saves clean), relaunch, and
  click the bot — the canonical open path hard-codes the caption. A proper
  fix belongs upstream: the re-bind path should re-check the session's root
  title the way `createCanonicalChat` does.

## Update risk (the honest part)

The plugin latches onto Hermes Desktop's rendering hooks (`data-slot`
message attributes, `data-streamdown` markers, the `hermes-bots:pane` id,
chat-surface stamps, session-tile tab labels). These are stable in v0.20.x
but not a public API. If a future Hermes update renames them:

- **Failure mode:** bubbles silently stop applying; chats render stock.
  Nothing crashes, no messages are lost.
- **Fix:** re-check the selectors against the new app
  (see [BUILD-NOTES.md](BUILD-NOTES.md) for where each one lives in the
  source) and update the `CSS` block / detection constants.

## Upstream context

Hermes has open PRs for an **app-wide** bubble layout
([hermes-agent#71961](https://github.com/NousResearch/hermes-agent/pull/71961),
[hermes-agent#41402](https://github.com/NousResearch/hermes-agent/pull/41402))
— both stalled without a maintainer decision as of 2026-08. If one merges,
that becomes an all-or-nothing setting; this plugin remains the
Bot-Chat-only option and the two can coexist (worst case you'd turn one off).
