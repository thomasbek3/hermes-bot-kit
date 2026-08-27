# Bubble Mode for Hermes Desktop

iMessage-style chat bubbles — **only in Bot Mode**. Your Sessions view stays
exactly as it is.

Your messages render as light-gray bubbles on the right, the agent's as
darker-gray bubbles on the left (Grok-Bot-style palette). Cards, code blocks,
tool runs, approvals, and thinking sections keep their normal chrome — only
plain conversation text becomes bubbles.

```
┌────────────────────────────────────────────┐
│                      ╭─────────────────╮   │
│                      │ hey, status?    │   │  ← you (light gray)
│                      ╰─────────────────╯   │
│  ╭──────────────────────────╮              │
│  │ All green. Backups ran,  │              │  ← your bot (dark gray)
│  │ nothing needs you.       │              │
│  ╰──────────────────────────╯              │
│  [ tool run: check_backups ✓ ]             │  ← tool rows stay stock
└────────────────────────────────────────────┘
```

## Install (one command — agents can run this unattended)

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bubble-mode/main/install.sh | bash
```

Then in Hermes Desktop: **⌘⇧P → Reload plugins** (or restart the app). Done —
every Bot Mode chat gets bubbles, including bots you add later. The script is
idempotent, needs no sudo, prompts for nothing, verifies what it downloaded,
and backs up any existing copy before overwriting.

Manual install (equivalent):

```
mkdir -p ~/.hermes/desktop-plugins/bubble-mode
cp plugin.js ~/.hermes/desktop-plugins/bubble-mode/plugin.js
```

The folder must be named `bubble-mode` (it must match the plugin id).

Toggle any time: **⌘⇧P → Bubble Mode: toggle** (persists across restarts).

## Highlights

- **Bot Mode only.** Detection reconstructs "a Bot Mode chat owns the
  screen" from public SDK signals and DOM stamps — Sessions chats, group
  rooms, and the Bots home screen are never styled.
- **Everything works, only looks change.** Pure CSS plus one body-class
  toggle. No core patches, no React wrapping, no network calls, read-only
  SDK use. Streaming, editing, reactions, cards — all untouched.
- **Fleet-proof.** It skins the Bot Mode surface, not individual agents, so
  every current and future bot gets the look with zero per-agent setup.
- **Fails safe.** If a Hermes update renames the hooks it latches onto,
  bubbles silently stop applying and chats render stock. Nothing breaks.

> **Known issues & design notes:** [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).
> Full DOM/SDK research behind the detection logic: [docs/BUILD-NOTES.md](docs/BUILD-NOTES.md).

## Compatibility & upstream state

- **Built and verified against Hermes Desktop v0.20.5 (macOS), 2026-08.**
  Also verified on a build carrying the pending upstream pane fixes
  ([hermes-agent#95956](https://github.com/NousResearch/hermes-agent/pull/95956),
  [hermes-agent#95352](https://github.com/NousResearch/hermes-agent/pull/95352))
  — the plugin does not depend on either; stock and patched builds behave the
  same.
- Upstream has open PRs for an **app-wide** bubble layout
  ([#71961](https://github.com/NousResearch/hermes-agent/pull/71961),
  [#41402](https://github.com/NousResearch/hermes-agent/pull/41402)), both
  stalled. They're all-or-nothing: bubbles everywhere or nowhere. This plugin
  exists because Bot Mode should feel like texting while work sessions keep
  the full-width transcript. If one of those PRs merges, the two coexist.
- The hooks this plugin reads (`data-slot` message attributes, the
  `hermes-bots:pane` id, chat-surface stamps) are stable in v0.20.x but not a
  public API. [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) documents the
  failure mode (silent no-op) and the re-tune path;
  [docs/BUILD-NOTES.md](docs/BUILD-NOTES.md) maps every hook to its location
  in the Hermes source so future maintenance is a find-and-replace, not a
  rediscovery.

## Colors

Tuned for the dark theme, sampled from Grok Bot:

| Surface | Color |
|---|---|
| Your bubble (right) | `#4a4a4e`, ink `#f2f2f3` |
| Agent bubble (left) | `#2b2b2e`, ink `#e8e8ea` |
| Radius | `18px`, `4px` tail on the inner corner |

Want different colors? They live in one obvious `CSS` block at the top of
`plugin.js` — edit the hex values and reload plugins.

## Repository layout

```
plugin.js            the entire plugin (single ESM file, CSS + detection)
install.sh           one-command installer (curl-pipe friendly, idempotent)
docs/SPEC.md         the original build spec
docs/BUILD-NOTES.md  DOM/SDK research: every selector, why, and where it
                     lives in the Hermes source
docs/KNOWN-ISSUES.md design decisions, environment notes, update risk
CHANGELOG.md         version history
```

Plugin id: `bubble-mode` (folder name must match).

## How it detects Bot Mode

A disk plugin can't import the bundled hermes-bots plugin's internal state,
so Bubble Mode reconstructs the same question from public signals:
`host.paneVisibility('hermes-bots:pane')`, the Bots home / group-chat tab
state, and the chat-surface DOM stamps (`data-composer-target`,
`data-session-anchor`), skipping hidden keep-alive panes. The full derivation
— including the signals that looked tempting and were rejected — is in
[docs/BUILD-NOTES.md](docs/BUILD-NOTES.md).

## License

MIT
