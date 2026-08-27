# Bubble Mode for Hermes Desktop

iMessage-style chat bubbles — **only in Bot Mode**. Your Sessions view stays exactly as it is.

Your messages render as light-gray bubbles on the right, the agent's as darker-gray bubbles on the left (Grok-Bot-style palette). Cards, code blocks, tool runs, approvals, and thinking sections keep their normal chrome — only plain conversation text becomes bubbles.

## Why a plugin?

Upstream has open PRs for an app-wide bubble layout (see [hermes-agent#71961](https://github.com/NousResearch/hermes-agent/pull/71961)), but they are all-or-nothing: bubbles everywhere or nowhere. This plugin scopes the look to Bot Mode chats, so working sessions keep the full-width transcript while bot chats feel like texting.

It is CSS plus a body-class toggle. No core patching, no React tree wrapping, no network calls, read-only use of the plugin SDK.

## Install

1. Copy `plugin.js` into your Hermes home:

   ```
   mkdir -p ~/.hermes/desktop-plugins/bubble-mode
   cp plugin.js ~/.hermes/desktop-plugins/bubble-mode/plugin.js
   ```

2. In Hermes Desktop: Command Palette (⌘⇧P) → **Reload plugins** (or restart the app).
3. Open any Bot Mode chat. Bubbles on. Switch to Sessions — unchanged.

Toggle any time: ⌘⇧P → **Bubble Mode: toggle** (persists across restarts).

## How it detects Bot Mode

A disk plugin can't import the bundled hermes-bots plugin's internal state, so Bubble Mode reconstructs "a Bot Mode chat owns the screen" from public signals: `host.paneVisibility('hermes-bots:pane')`, the Bots home / group-chat tab state, and the chat-surface DOM stamps (`data-composer-target`, `data-session-anchor`), skipping hidden keep-alive panes. Full research notes in [docs-BUILD-NOTES.md](docs-BUILD-NOTES.md).

## Compatibility

- Built and verified against Hermes Desktop **v0.20.x** (macOS).
- Colors are tuned for the dark theme (user `#4a4a4e`, assistant `#2b2b2e`). Light-theme users: edit the two hex values in the `CSS` block at the top of `plugin.js`.
- If a future Hermes update renames the DOM hooks, the plugin fails safe: bubbles simply don't apply and chats render stock. Nothing breaks.

## License

MIT
