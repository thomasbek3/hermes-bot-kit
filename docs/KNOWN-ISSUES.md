# Known issues & design notes

Everything non-obvious we hit while building and testing on real machines.
None of these break chats — the plugin's failure mode is always "bubbles
simply don't apply".

## By design

- **Group chats stay unstyled.** Bot Mode group rooms use a custom log view
  with none of the normal message markup, so bubbles are deliberately off
  there. Nothing to fix.
- **Cards, code blocks, tool runs, approvals, and thinking sections keep
  their stock chrome.** Only plain conversation text becomes a bubble. When a
  reply mixes text and a card, the text paragraphs get bubbles and the card
  renders untouched.
- **The edit composer is tinted too.** Editing one of your sent messages
  reuses the same bubble surface, so the editor shows your bubble color.
  Cosmetic, accepted.

## Environment-specific

- **Colors are tuned for the dark theme.** User bubble `#4a4a4e`, assistant
  `#2b2b2e` (Grok-Bot palette). On a light theme they'll look heavy — edit
  the two hex values in the `CSS` block at the top of `plugin.js`.
- **A brand-new bot draft may bubble a beat late.** Detection reads the
  pane/tab state; a tab whose chat surface hasn't painted yet is caught on
  the next frame by the DOM observer. You may see one unstyled frame.

## Update risk (the honest part)

The plugin latches onto Hermes Desktop's rendering hooks (`data-slot`
message attributes, the `hermes-bots:pane` id, chat-surface stamps). These
are stable in v0.20.x but not a public API. If a future Hermes update renames
them:

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
Bot-Mode-only option and the two can coexist (worst case you'd turn one off).
