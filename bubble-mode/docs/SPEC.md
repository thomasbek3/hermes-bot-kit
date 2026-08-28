Build a Hermes Desktop plugin: **bubble-mode** — iMessage-style chat bubbles, applied ONLY to Bot Mode chats, never to regular Sessions.

Output to ~/Documents/hermes-bubble-skin-spec/build/: plugin.js (single ESM; imports ONLY @hermes/plugin-sdk, react, react/jsx-runtime; no JSX — jsx()/jsxs(); no other deps), README.md, BUILD-NOTES.md (every SDK/DOM fact learned).

The installed desktop source for research: ~/.hermes/hermes-agent/apps/desktop/ (stock v0.20.5 + local patches). Proven plugin idioms: ~/.hermes/desktop-plugins/computer-viewer/plugin.js and the bundled Bot Mode plugin apps/desktop/src/plugins/hermes-bots/plugin.js (15k lines — see how it detects bot chats: $botChatFocused, $openBotChat, $botsPaneVisible, session ownership helpers).

DESIGN:
1. RESEARCH FIRST: find a reliable runtime signal for "the visible main-area chat is a Bot Mode bot chat" (hermes-bots owns this state; a disk plugin cannot import from it — find observable equivalents: host.state atoms, DOM markers on the chat surface/tabs, session id/title conventions like the canonical Bot Chat, data attributes on [data-composer-target] surfaces, etc). Document the chosen signal + fallbacks in BUILD-NOTES.
2. Styling: inject ONE <style> element (id-tagged, removed on plugin dispose). All rules scoped under a body class (e.g. body.hermes-bubble-mode). Toggle that class from the signal watcher. Style: user messages = right-aligned rounded bubbles (accent blue, white text); assistant messages = left-aligned gray bubbles; max-width ~72%; padding/radius per iMessage feel (radius ~18px); keep tool-run rows, thought rows, timestamps, and cards UNSTYLED (bubbles are for plain text messages only — do not wrap cards/tool chrome). Use the app's CSS variables for colors where available (respect dark/light).
3. Determine the DOM selectors for user vs assistant message rows in the transcript (inspect renderer source: apps/desktop/src/components/assistant-ui/ and app/session/) — record them in BUILD-NOTES; prefer stable data-* attrs/classes over structural selectors.
4. Settings via ctx.storage: enabled (default true). Palette entry "Bubble Mode: toggle" (PALETTE_AREA).
5. Must not interfere with Sessions view, cards (::card), the computer-viewer pane, or streaming updates. Zero behavior changes — CSS + a class toggle only.
6. node --check must pass. No core patches, no files outside build/.
