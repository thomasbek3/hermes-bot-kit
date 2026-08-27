# Bubble Mode — SDK / DOM research notes

Research source: `~/.hermes/hermes-agent/apps/desktop/` (stock v0.20.5 + local patches).
Plugin idioms: `~/.hermes/desktop-plugins/computer-viewer/plugin.js`, bundled `src/plugins/hermes-bots/plugin.js`.

This plugin cannot import hermes-bots module state. Every signal below is something a disk plugin can observe through `@hermes/plugin-sdk` or the live DOM.

---

## 1. Why hermes-bots' own atoms are unreachable

`src/plugins/hermes-bots/plugin.js` keeps Bot Mode's "who owns the center" story in **module-local nanostores**:

| Atom | Meaning |
|---|---|
| `$botsPaneVisible` | Mirrors `host.paneVisibility('hermes-bots:pane')`. Set in `register()`. |
| `$openBotChat` | `{ key, openedRegistryId, openedSessionId }` after a roster click lands. |
| `$botChatFocused` | `Boolean(focusedStoredSessionId)` — a session owns the main workspace. |
| `$botsHomeFronted` | Bots home tab (`plugin-workspace:hermes-bots:home`) is the visible main surface. |
| `$groupChatWorkspace` | Active group-chat room name, or null. |

`botChatOwnsWorkspace()` (plugin.js ~13977) is:

```
$botsPaneVisible
  && !$groupChatWorkspace
  && !botsHomeVisible()            // host.paneVisibility('plugin-workspace:hermes-bots:home')
  && Boolean($openBotChat || sessionOwnsWorkspace())
```

`sessionOwnsWorkspace()` prefers `host.state.focusedStoredSessionId.get()`, then `host.state.activeSessionId.get()`, then `$botChatFocused`.

A disk plugin **cannot import those atoms**. The equivalent observables are listed next.

---

## 2. Chosen runtime signal: "visible main-area chat is a Bot Mode bot chat"

### Primary (SDK)

1. **`host.paneVisibility('hermes-bots:pane').get() === true`**
   - Contribution id is `<pluginId>:<localId>` → `hermes-bots:pane`.
   - `host.paneVisibility` (sdk/index.ts ~1165): true only while the pane is in the layout tree, not dismissed/hidden, its zone un-minimized, **and holding its zone's active tab slot**.
   - The Bots roster docks **center-stacked into the Sessions zone** (`dock: { pane: 'sessions', pos: 'center', enforce: true }`). So this atom is exactly "the user is on the Bots tab, not the Sessions tab".
   - Feature-detect: `typeof host.paneVisibility === 'function'`.

2. **`host.paneVisibility('plugin-workspace:hermes-bots:home').get() !== true`**
   - `host.openWorkspace(id)` prefixes `plugin-workspace:` (sdk/index.ts ~1087).
   - Bots home id is `hermes-bots:home` → pane id `plugin-workspace:hermes-bots:home`.
   - While home is fronted, the canonical Bot Chat can remain mounted as a hidden sibling (`data-pane-hidden`). Home is not a transcript.

3. **Group-chat workspaces are not Bot Chat transcripts.**
   - Opened as `host.openWorkspace('hermes-bots:group:' + slugify(group))`.
   - Pane ids: `plugin-workspace:hermes-bots:group:<slug>`.
   - Group UI is a custom log (no `data-slot="aui_*-message-root"`). Detected via `[data-tree-tab^="plugin-workspace:hermes-bots:group:"][aria-selected="true"]`.
   - Bubbles stay off on group rooms (no matching message rows anyway).

4. **Visible chat surface is a session tile, not the Sessions primary workspace.**
   - `ChatView` stamps `data-chat-surface`, `data-composer-target`, `data-session-anchor` (app/chat/index.tsx ~607–611).
   - Primary Sessions workspace: `data-composer-target="main"` and `data-session-anchor="workspace"`.
   - Session tiles: `data-composer-target="tile:<storedSessionId>"` and `data-session-anchor="session-tile:<storedSessionId>"` (session-tile.tsx ~181; ChatView `isPrimary` branch).
   - Canonical Bot Chats are opened with `host.openSession(..., { intent: 'tab', workspaceMode: 'bots', workspaceOwnerKey, tabTitle: 'Bot Chat' })` (`openStoredBotChat`). That creates a **bots-scoped session tile**.

### Why a focused session + Bots pane is not enough

`sessionOwnsWorkspace()` is true for **any** focused stored session, including a leftover Sessions chat. hermes-bots still treats that as "a session owns the center" so it will not passively open Bots home.

The Sessions **primary pane itself** is registered with `workspaceMode: 'sessions'` (`app/contrib/controller.tsx` ~178–180 and `syncWorkspaceTitle`). `contributesToWorkspace()` (`workspace-scope.ts`) **filters it out** while hermes-bots has published `host.setWorkspaceScope('bots', ...)`.

Consequences:

- In Bot Mode the visible transcript cannot be the Sessions primary (`data-composer-target="main"`).
- Visible `session-tile:*` tabs in that workspace are bots-scoped tiles (sessions-mode tiles are filtered the same way).
- Therefore: **Bots pane active ∧ home not fronted ∧ a visible `tile:` / `session-tile:` chat surface ⇒ Bot Mode bot chat.**

`$workspaceMode` is **not** on `host.state`. hermes-bots writes it via `host.setWorkspaceScope`; there is no plugin-readable atom for the current mode. Pane visibility + tile surfaces are the public equivalent.

### Fallbacks (in order)

1. SDK `paneVisibility` missing → DOM `[data-tree-tab="hermes-bots:pane"][aria-selected="true"]` (tree-group.tsx stamps `data-tree-tab={paneId}`).
2. No `tile:` surface yet but an active tab is `session-tile:*` while the Bots pane is active → treat as bot chat (covers a tab whose ChatView has not painted `data-chat-surface` this frame).
3. Tab label conventions (secondary): exact `"Bot Chat"`, `"Agent Inbox"` (`CANONICAL_CHAT_TITLE` / `BOT_MODE_SWEEP_TITLES`), or prefix `"Group: "` (member-session titles). Used as documentation / extra confidence, not as the only gate — a brand-new bot draft may still say "New session".
4. **Never** key off `host.state.focusedSessionProfile` or `host.state.profile`. Default is a valid bot; Sessions chats also have profiles.
5. **Never** RPC `session.list` / `listPersistedSessions` to read hidden flags. Spec is CSS + class toggle only; no behavior, no network.

### Signals that look tempting and were rejected

| Candidate | Why not |
|---|---|
| `host.state.focusedStoredSessionId` alone | True for Sessions chats. |
| Session title `"Bot Chat"` in ChatHeader | Canonical chats are **hidden** from `$sessions`. ChatHeader resolves title via `$sessions.find(...)` and falls back to `NEW_SESSION_TITLE`. |
| `host.state.workspaceMode` | Does not exist. |
| Importing hermes-bots atoms | Disk plugins cannot. |
| `data-composer-target="main"` | That's the Sessions primary. Bot chats are tiles. |

### Keep-alive / hidden panes

Inactive tabs stay mounted with `visibility: hidden` and `data-pane-hidden` (`pane-visibility.ts` `PANE_HIDDEN_ATTR`). Their layout box matches the visible tab, so querySelector without this filter answers the wrong surface. All DOM reads skip `el.closest('[data-pane-hidden]')`.

---

## 3. Message-row DOM (assistant-ui)

Inspected `src/components/assistant-ui/thread/`.

### User

| Attr | Where |
|---|---|
| `data-role="user"` | Message root |
| `data-slot="aui_user-message-root"` | Same root (`StickyHumanMessageContainer` and process/agent-notice variants) |
| `data-message-id` | On the sticky root |
| `.composer-human-message` | Inner bubble (`USER_BUBBLE_BASE_CLASS`) — **this is the surface we restyle** |
| `data-slot="aui_user-bubble-actions"` | Action bar wrapping the bubble |
| `data-slot="aui_user-message-text"` | Rendered prompt text |
| `data-slot="aui_user-inline-code"` / `aui_user-fence` | Inline / fenced user markdown |

Process-notification and inter-agent delivery rows also have `data-role="user"` + `aui_user-message-root` but **do not** use `.composer-human-message`. Styling the inner bubble class leaves those notices alone.

Edit composer: `data-slot="aui_edit-composer-root"` reuses `USER_BUBBLE_BASE_CLASS`. Restyling `.composer-human-message` also tints the edit surface in Bot Mode (same bubble). Acceptable.

### Assistant

| Attr | Where |
|---|---|
| `data-role="assistant"` | `MessagePrimitive.Root` |
| `data-slot="aui_assistant-message-root"` | Same |
| `data-slot="aui_assistant-message-content"` | Text + parts column |
| `.aui-md` | Streamdown markdown container (`MARKDOWN_CONTAINER_CLASS_NAME`) — **plain-text bubble target** |
| `data-slot="aui_message-streaming-marker"` | Sibling of content; `data-message-streaming="true"` while running. Do not touch. |

`.aui-md` is a **direct child** of `aui_assistant-message-content` (via `TimelineMarkdownText` fragment: timestamp sibling + `MarkdownText`). Tool rows, thinking, status, and footers are **siblings**, not children, so a child combinator (`> .aui-md`) cannot wrap them.

### Left unstyled on purpose

| Slot / attr | What |
|---|---|
| `[data-slot="tool-block"]` | Tool-run rows (`ToolFallback`, delegate card) |
| `[data-slot="tool-approval-inline"]` / `tool-approval-fallback` / `tool-approval-actions` | Approvals |
| `[data-slot="aui_thinking-disclosure"]` | Thought header (`data-conversation-scaffold`) |
| `[data-slot="aui_reasoning-text"]` | Thought body (`.aui-md` nested **inside** the disclosure, so `> .aui-md` misses it) |
| `[data-slot="timeline-timestamp"]` | Per-part timestamps |
| `[data-slot="aui_turn-duration"]` / `aui_msg-actions` / `aui_msg-reactions` | Footer chrome |
| `[data-slot="aui_turn-activity"]` / `aui_response-loading` / `aui_background-resume` | Status rows |
| `[data-slot="code-card"]` | Fenced code |
| `[data-slot="aui_artifact-card"]` | Artifact / `::card`-class promotions (`detectArtifact` → `ArtifactCard`) |
| `[data-slot="aui_embed-card"]` | URL embeds |
| `[data-slot="aui_changed-files"]` | Settled changed-files card (sibling of content) |
| `[data-slot="aui_generated-image"]` | Image-generate result |
| `[data-slot="aui_markdown-alert"]` | GFM alerts |
| `[data-slot="clarify-inline"]` / `mcp-setup-inline` | Widget chrome |
| `[data-slot="aui_system-message-root"]` | System rows |
| `[data-slot="aui_agent-message-note"]` / `aui_agent-delivery-notice` / `aui_agent-reply-notice` | Inter-agent notices |
| `[data-streamdown="code-block"]` | Streamdown fence wrapper around `code-card` |

When `.aui-md` **contains** any of those card slots, the outer bubble is disabled (`:has(...)`) and only non-card **direct children** (paragraphs, lists, headings) get the gray bubble. Cards keep their own chrome.

---

## 4. Chat surface / composer stamps

From `app/chat/index.tsx` and `composer/focus.ts`:

- `[data-chat-surface]` — every ChatView.
- `[data-composer-target]` — `'main'` \| `'edit'` \| `'tile:<id>'`.
- `[data-session-anchor]` — `'workspace'` \| `'session-tile:<id>'`.
- `[data-chat-unfocused]` — present when the surface is not the focused stored session. Still a Bot Mode chat if it's a visible tile; we style all visible bot tiles.
- `[data-composer-surface-id]` — unique mount id; unused.

---

## 5. CSS variables (theme-aware)

| Token | Use |
|---|---|
| `--dt-primary` / `--theme-primary` | User bubble fill (accent blue; default `#0053fd`) |
| `--dt-primary-foreground` | User bubble ink (`#fcfcfc`) |
| `--ui-accent-secondary` | Alias of `--theme-primary` |
| `--ui-chat-bubble-background` | Assistant gray bubble (already the designed chat-bubble mix; follows light/dark) |
| `--ui-bg-tertiary` | Fallback fill |
| `--ui-text-primary` / `--dt-foreground` | Assistant ink |
| `--dt-user-bubble` | **Stock user bubble**. We override it rather than reuse it — stock uses this for the human glass card; iMessage wants accent on the human and gray on the agent. |

`.dark` / theme retint already re-seed these on `:root`. Unlayered injected `<style>` beats Tailwind `@layer utilities`, so `bg-(--dt-user-bubble)` / `rounded-xl` lose without `!important`.

Bubble geometry: radius 18px, iMessage tail 4px on the inner corner, padding `0.5rem 0.875rem`, `max-width: 72%`, `width: fit-content`.

---

## 6. Plugin SDK contract (disk plugin)

From `src/contrib/plugin.ts` + `hello-runtime/plugin.runtime.js` + computer-viewer:

- Default-export `{ id, name, description, defaultEnabled, register(ctx) }`.
- `ctx.storage.get(key, fallback)` / `.set(key, value)` / `.remove(key)` — **synchronous**, namespaced `hermes.plugin.<id>.`. hermes-bots still `Promise.resolve`s reads; we do the same defensively.
- `ctx.register({ id, area, data })` — contribution id becomes `bubble-mode:<id>`.
- `PALETTE_AREA === 'palette'`. Payload: `{ id, label, keywords, run, detail?, detailVariant?, keepOpen? }` (`app/command-palette/contrib.ts`).
- `ctx.onDispose(fn)` — required for the style node, body class, atom listeners, MutationObserver. Feature-detect.
- Imports allowed by this task: `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`. This plugin needs no React tree, so it imports only the SDK.
- `host.state.*` atoms: `.get()` / `.listen()` / `.subscribe()`. Used: `focusedStoredSessionId`, fallback `activeSessionId`.
- `host.paneVisibility(id)` returns a memoized `ReadableAtom<boolean>`.
- No `host.setWorkspaceScope` writes — read-only observer.

Palette row: label **exactly** `Bubble Mode: toggle`, `keepOpen: true`, `detail` on/off.

Setting: `ctx.storage` key `enabled`, default `true`.

---

## 7. Non-interference

| Surface | Why we don't touch it |
|---|---|
| Sessions view | Bots pane visibility is false → body class off. CSS never matches. |
| Sessions primary ChatView | `workspaceMode: 'sessions'` pane is filtered out in Bot Mode; selector also skips `data-composer-target="main"`. |
| `::card` / artifact / code cards | Excluded by slot + `:has()` split. |
| computer-viewer pane | No `aui_*` message slots. Class toggle does not register panes or bind keys. |
| Streaming | CSS only. MutationObserver `attributeFilter` ignores class/text; `childList` is rAF-coalesced and the class is toggled only on boolean change. No wrappers, no React, no layout JS on token flush. |
| Sticky human clamp | We do not change `position`, `--human-msg-full`, or clamp classes. |

---

## 8. Canonical Bot Chat identity (context)

- Title **exactly** `"Bot Chat"` (`CANONICAL_CHAT_TITLE`). Unique per profile via gateway `UNIQUE(title)`.
- Always `hidden: true` on create; hide-sweep also matches `"Agent Inbox"` and `"Group: "` prefix.
- Open path: `host.openSession(id, { intent: 'tab', workspaceMode: 'bots', workspaceOwnerKey: 'bot:<route>', tabTitle: 'Bot Chat' })`.
- New-agent mint uses `intent: 'main'` **and** `workspaceMode: 'bots'` — `setSessionTileWorkspaceScope` still stamps the tile; the Sessions primary pane is not shown in bots workspace.

---

## 9. Watcher wiring (mirrors hermes-bots register())

hermes-bots listens to:

- `host.paneVisibility('hermes-bots:pane')`
- `host.paneVisibility(BOTS_HOME_PANE_ID)`
- `host.state.focusedStoredSessionId || host.state.activeSessionId`

This plugin listens to the same three, plus a document MutationObserver on `data-pane-hidden`, `aria-selected`, `data-tree-tab`, `data-chat-surface`, `data-composer-target`, `data-session-anchor` so tab-fronting that does not move focus still flips the class.

Style element id: `hermes-bubble-mode-style`. Body class: `hermes-bubble-mode`. Both removed on `ctx.onDispose`.
