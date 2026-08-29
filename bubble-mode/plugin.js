/**
 * Bubble Mode — iMessage-style chat bubbles for Hermes Desktop Bot Mode.
 *
 * CSS + a body-class toggle only. Never patches core, never wraps React
 * trees, never touches Sessions view. A disk plugin cannot import hermes-bots
 * atoms ($botChatFocused / $openBotChat / $botsPaneVisible); this file
 * reconstructs the same question from host.state, host.paneVisibility, and
 * DOM markers. See BUILD-NOTES.md.
 */

import { PALETTE_AREA, host } from '@hermes/plugin-sdk'

const PLUGIN_ID = 'bubble-mode'
const STYLE_ID = 'hermes-bubble-mode-style'
const BODY_CLASS = 'hermes-bubble-mode'
const QUIET_CLASS = 'hermes-bubble-quiet'
const STORAGE_KEY = 'enabled'
const SHOW_WORK_KEY = 'showWork'

const BOTS_PANE_ID = 'hermes-bots:pane'
const ROUTINES_PANE_ID = 'hermes-bots:routines'
const BOTS_HOME_PANE_ID = 'plugin-workspace:hermes-bots:home'
const BOTS_GROUP_TAB_PREFIX = 'plugin-workspace:hermes-bots:group:'
const SESSION_TILE_TAB_PREFIX = 'session-tile:'
const PANE_HIDDEN_ATTR = 'data-pane-hidden'

const CSS = /* css */ `
body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_user-message-root"]:not(:has(textarea, [contenteditable="true"], input)) {
  align-items: flex-end;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_user-message-root"] .composer-human-message:not(:has(textarea, [contenteditable="true"], input)) {
  width: fit-content;
  max-width: 72%;
  margin-left: auto;
  padding: 0.5rem 0.875rem;
  border: none;
  border-radius: 18px 18px 4px 18px;
  background: #4a4a4e;
  color: #f2f2f3;
  box-shadow: none;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_user-message-root"] .composer-human-message [data-slot="aui_user-message-text"],
body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_user-message-root"] .composer-human-message [data-slot="aui_user-inline-text"] {
  color: inherit;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_user-message-root"] .composer-human-message [data-slot="aui_user-inline-code"] {
  background: color-mix(in srgb, #fff 18%, transparent);
  color: inherit;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_user-message-root"] .composer-human-message button,
body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_user-message-root"] .composer-human-message svg {
  color: #f2f2f3;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_assistant-message-content"] > .aui-md {
  box-sizing: border-box;
  width: fit-content;
  max-width: 72%;
  padding: 0.5rem 0.875rem;
  border-radius: 18px 18px 18px 4px;
  background: #2b2b2e;
  color: #e8e8ea;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_assistant-message-content"] > .aui-md:has(
  [data-slot="code-card"],
  [data-slot="aui_artifact-card"],
  [data-slot="aui_embed-card"],
  [data-slot="aui_changed-files"],
  [data-slot="aui_generated-image"],
  [data-slot="aui_markdown-alert"],
  [data-streamdown="code-block"],
  [data-streamdown="mermaid-block"],
  [data-streamdown="image-wrapper"],
  pre,
  table
) {
  width: 100%;
  max-width: 72%;
  padding: 0;
  background: transparent;
  border-radius: 0;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_assistant-message-content"] > .aui-md:has(
  [data-slot="code-card"],
  [data-slot="aui_artifact-card"],
  [data-slot="aui_embed-card"],
  [data-slot="aui_changed-files"],
  [data-slot="aui_generated-image"],
  [data-slot="aui_markdown-alert"],
  [data-streamdown="code-block"],
  [data-streamdown="mermaid-block"],
  [data-streamdown="image-wrapper"],
  pre,
  table
) > :not([data-slot="code-card"]):not([data-slot="aui_artifact-card"]):not([data-slot="aui_embed-card"]):not([data-slot="aui_changed-files"]):not([data-slot="aui_generated-image"]):not([data-slot="aui_markdown-alert"]):not([data-streamdown="code-block"]):not([data-streamdown="mermaid-block"]):not([data-streamdown="image-wrapper"]):not([data-streamdown="horizontal-rule"]):not(pre):not(table):not(hr):not(:has(pre, table)) {
  box-sizing: border-box;
  width: fit-content;
  max-width: 100%;
  padding: 0.5rem 0.875rem;
  border-radius: 18px 18px 18px 4px;
  background: #2b2b2e;
  margin-top: 3px;
  margin-bottom: 3px;
}

/* Quiet chat: hide the agent's working noise in Bot Mode. Approvals always
   stay visible; the response-loading indicator still shows activity. Toggle
   with "Bubble Mode: toggle work rows". */
body.hermes-bubble-quiet [data-chat-surface] [data-slot="aui_thinking-disclosure"],
body.hermes-bubble-quiet [data-chat-surface] [data-slot="aui_reasoning-text"],
body.hermes-bubble-quiet [data-chat-surface] [data-slot="aui_turn-activity"],
body.hermes-bubble-quiet [data-chat-surface] [data-slot="aui_turn-duration"] {
  display: none;
}

body.hermes-bubble-quiet [data-chat-surface] [data-slot="tool-block"]:not(:has([data-slot="tool-approval-fallback"])) {
  display: none;
}

/* Never paint a bubble around a reply that has no content yet (the empty
   message container that appears next to the typing indicator). */
body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_assistant-message-content"] > .aui-md:empty,
body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_assistant-message-content"] > .aui-md:not(:has(*)),
body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_assistant-message-content"] > .aui-md:not(:has(:not(:empty))) {
  background: transparent;
  padding: 0;
  box-shadow: none;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_assistant-message-content"] > .aui-md:not(:has(:not(:empty))) > * {
  background: transparent;
  padding: 0;
}

/* Typing indicator: while the bot is thinking/working, the stock loading
   row becomes an iMessage-style "..." bubble (three pulsing dots). */
body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_response-loading"] {
  box-sizing: border-box;
  width: fit-content;
  padding: 0.7rem 0.8rem;
  border-radius: 16px;
  background: #2b2b2e;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_response-loading"] > * {
  display: none;
}

body.hermes-bubble-mode [data-chat-surface] [data-slot="aui_response-loading"]::after {
  content: '';
  display: block;
  width: 6px;
  height: 6px;
  margin-right: 20px;
  border-radius: 50%;
  background: #6b6b70;
  box-shadow: 10px 0 0 #6b6b70, 20px 0 0 #6b6b70;
  animation: hermes-bubble-typing 1.2s infinite ease-in-out;
}

@keyframes hermes-bubble-typing {
  0%, 90%, 100% { background: #b9b9bf; box-shadow: 10px 0 0 #6b6b70, 20px 0 0 #6b6b70; }
  30% { background: #6b6b70; box-shadow: 10px 0 0 #b9b9bf, 20px 0 0 #6b6b70; }
  60% { background: #6b6b70; box-shadow: 10px 0 0 #6b6b70, 20px 0 0 #b9b9bf; }
}
`

let pluginCtx = null
let enabled = true
let showWork = false
let applied = false
let raf = 0
let observer = null
const unbinders = []

function inHiddenPane(el) {
  return Boolean(el && typeof el.closest === 'function' && el.closest(`[${PANE_HIDDEN_ATTR}]`))
}

function paneStoreGet(paneId) {
  if (typeof host.paneVisibility !== 'function') return undefined
  try {
    const store = host.paneVisibility(paneId)
    if (store && typeof store.get === 'function') return Boolean(store.get())
  } catch {
    /* older / test hosts */
  }
  return undefined
}

function tabSelected(paneId) {
  if (typeof document === 'undefined') return false
  const tab = document.querySelector(`[data-tree-tab="${cssAttr(paneId)}"]`)
  return Boolean(tab && tab.getAttribute('aria-selected') === 'true' && !inHiddenPane(tab))
}

function cssAttr(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_:-]/g, ch => `\\${ch}`)
}

function botsPaneActive() {
  const fromSdk = paneStoreGet(BOTS_PANE_ID)
  if (fromSdk !== undefined) return fromSdk
  return tabSelected(BOTS_PANE_ID)
}

function botsHomeFronted() {
  const fromSdk = paneStoreGet(BOTS_HOME_PANE_ID)
  if (fromSdk !== undefined) return fromSdk
  return tabSelected(BOTS_HOME_PANE_ID)
}

function groupChatFronted() {
  if (typeof document === 'undefined') return false
  const tabs = document.querySelectorAll(`[data-tree-tab^="${BOTS_GROUP_TAB_PREFIX}"]`)
  for (const tab of tabs) {
    if (tab.getAttribute('aria-selected') === 'true' && !inHiddenPane(tab)) return true
  }
  return false
}

function visibleBotChatSurface() {
  if (typeof document === 'undefined') return false
  const surfaces = document.querySelectorAll('[data-chat-surface]')
  for (const el of surfaces) {
    if (inHiddenPane(el)) continue
    const target = el.getAttribute('data-composer-target') || ''
    const anchor = el.getAttribute('data-session-anchor') || ''
    if (target === 'main' || anchor === 'workspace') continue
    if (target.startsWith('tile:') || anchor.startsWith('session-tile:')) return true
  }
  return false
}

const knownBotChatTabs = new Set()

function rememberBotChatTab(id) {
  if (knownBotChatTabs.has(id)) return
  knownBotChatTabs.add(id)
  try {
    pluginCtx?.storage?.set?.('knownBotChatTabs', Array.from(knownBotChatTabs).slice(-64))
  } catch {
    /* storage unavailable — holds for this window */
  }
}

function readKnownBotChatTabs(ctx) {
  try {
    const value = ctx.storage?.get?.('knownBotChatTabs', [])
    const absorb = list => {
      if (Array.isArray(list)) for (const id of list) knownBotChatTabs.add(String(id))
      scheduleSync()
    }
    if (value && typeof value.then === 'function') value.then(absorb).catch(() => undefined)
    else absorb(value)
  } catch {
    /* ignore */
  }
}

function canonicalBotChatTabSelected() {
  if (typeof document === 'undefined') return false
  const tabs = document.querySelectorAll('[data-tree-tab][aria-selected="true"]')
  for (const tab of tabs) {
    if (inHiddenPane(tab)) continue
    const id = tab.getAttribute('data-tree-tab') || ''
    if (!id.startsWith(SESSION_TILE_TAB_PREFIX)) continue
    // Only the canonical per-bot conversation (tab titled "Bot Chat", the
    // desktop's createCanonicalChat title, matching the agent-side gate in
    // tools/bot_mode_probe.py). Other Bot Mode tabs (long-form side
    // sessions, new drafts) stay stock. A serve-process restart under an
    // open canonical tab can scramble the caption (re-bound plain tab), so
    // any tab id once seen labeled "Bot Chat" keeps its styling even when
    // the caption is wrong — persisted across app restarts.
    const label = (tab.getAttribute('aria-label') || tab.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
    if (label === 'bot chat') {
      rememberBotChatTab(id)
      return true
    }
    if (knownBotChatTabs.has(id)) return true
  }
  return false
}

/**
 * Observable equivalent of hermes-bots botChatOwnsWorkspace():
 *   $botsPaneVisible && !botsHomeVisible && !$groupChatWorkspace
 *   && a Bot-Mode chat surface (session-tile) is the visible main transcript.
 *
 * The Sessions primary pane is registered with workspaceMode:'sessions', so it
 * is filtered out of the tree while Bot Mode has published setWorkspaceScope
 * ('bots'). Visible session-tile panes in that scope are therefore Bot Mode
 * chats, never regular Sessions.
 */
/** >=0.20.6 one-chat-per-agent Bot Mode: the canonical chat renders in the
 *  MAIN workspace surface (no session-tile tabs anymore). hermes-bots seats
 *  its Scheduled Jobs (routines) tile only while a real bot chat owns the
 *  workspace and never for group chats, so that pane's visibility is the
 *  public botChatOwnsWorkspace() bit. The message-slot check keeps the Bots
 *  home / empty-draft splash (same surface, no transcript) unstyled. */
function workspaceBotChatVisible() {
  if (paneStoreGet(ROUTINES_PANE_ID) !== true) return false
  if (typeof document === 'undefined') return false
  const surfaces = document.querySelectorAll('[data-chat-surface]')
  for (const el of surfaces) {
    if (inHiddenPane(el)) continue
    const target = el.getAttribute('data-composer-target') || ''
    const anchor = el.getAttribute('data-session-anchor') || ''
    if (target !== 'main' && anchor !== 'workspace') continue
    if (
      el.querySelector(
        '[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-content"], [data-slot="aui_response-loading"]'
      )
    )
      return true
  }
  return false
}

function botModeChatVisible() {
  if (!botsPaneActive()) return false
  if (botsHomeFronted()) return false
  if (groupChatFronted()) return false
  // v0.20.5 tab-strip path first, then the >=0.20.6 workspace path.
  if (canonicalBotChatTabSelected()) return true
  return workspaceBotChatVisible()
}

function setBodyClass(on) {
  if (typeof document === 'undefined' || !document.body) return
  if (on) document.body.classList.add(BODY_CLASS)
  else document.body.classList.remove(BODY_CLASS)
  const quiet = Boolean(on && !showWork)
  if (quiet) document.body.classList.add(QUIET_CLASS)
  else document.body.classList.remove(QUIET_CLASS)
  applied = on
}

function sync() {
  const next = Boolean(enabled && botModeChatVisible())
  const quietNext = Boolean(next && !showWork)
  if (
    next === applied &&
    document.body &&
    document.body.classList.contains(BODY_CLASS) === next &&
    document.body.classList.contains(QUIET_CLASS) === quietNext
  ) return
  setBodyClass(next)
}

function scheduleSync() {
  if (typeof requestAnimationFrame !== 'function') {
    sync()
    return
  }
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    sync()
  })
}

function readEnabled(ctx) {
  try {
    const value = ctx.storage?.get?.(STORAGE_KEY, true)
    if (value && typeof value.then === 'function') {
      value
        .then(resolved => {
          enabled = resolved !== false
          scheduleSync()
        })
        .catch(() => undefined)
      return true
    }
    return value !== false
  } catch {
    return true
  }
}

function readShowWork(ctx) {
  try {
    const value = ctx.storage?.get?.(SHOW_WORK_KEY, false)
    if (value && typeof value.then === 'function') {
      value
        .then(resolved => {
          showWork = resolved === true
          scheduleSync()
        })
        .catch(() => undefined)
      return false
    }
    return value === true
  } catch {
    return false
  }
}

function toggleShowWork() {
  showWork = !showWork
  try {
    pluginCtx?.storage?.set?.(SHOW_WORK_KEY, showWork)
  } catch {
    /* storage unavailable — holds for this window */
  }
  scheduleSync()
}

function writeEnabled(value) {
  enabled = Boolean(value)
  try {
    pluginCtx?.storage?.set?.(STORAGE_KEY, enabled)
  } catch {
    /* storage unavailable — holds for this window */
  }
  scheduleSync()
}

function toggleEnabled() {
  writeEnabled(!enabled)
}

function injectStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  ;(document.head || document.documentElement).appendChild(el)
}

function removeStyle() {
  if (typeof document === 'undefined') return
  document.getElementById(STYLE_ID)?.remove()
}

function watchStore(store, fn) {
  if (!store || typeof store.listen !== 'function') return
  unbinders.push(store.listen(fn))
}

function watchPane(paneId, fn) {
  if (typeof host.paneVisibility !== 'function') return
  try {
    watchStore(host.paneVisibility(paneId), fn)
  } catch {
    /* ignore */
  }
}

function startDomObserver() {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return
  observer = new MutationObserver(scheduleSync)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      PANE_HIDDEN_ATTR,
      'aria-selected',
      'data-tree-tab',
      'data-chat-surface',
      'data-composer-target',
      'data-session-anchor'
    ]
  })
}

function dispose() {
  if (raf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(raf)
    raf = 0
  }
  while (unbinders.length) {
    const stop = unbinders.pop()
    try {
      stop?.()
    } catch {
      /* already unbound */
    }
  }
  try {
    observer?.disconnect()
  } catch {
    /* ignore */
  }
  observer = null
  setBodyClass(false)
  removeStyle()
}

export default {
  id: PLUGIN_ID,
  name: 'Bubble Mode',
  defaultEnabled: true,
  description: 'iMessage-style chat bubbles on Bot Mode chats only. Sessions stay unchanged.',
  register(ctx) {
    pluginCtx = ctx
    enabled = readEnabled(ctx)
    showWork = readShowWork(ctx)
    readKnownBotChatTabs(ctx)
    injectStyle()

    watchPane(BOTS_PANE_ID, scheduleSync)
    watchPane(BOTS_HOME_PANE_ID, scheduleSync)
    watchPane(ROUTINES_PANE_ID, scheduleSync)
    watchStore(host.state?.focusedStoredSessionId || host.state?.activeSessionId, scheduleSync)

    startDomObserver()
    scheduleSync()

    ctx.register({
      id: 'palette-toggle',
      area: PALETTE_AREA,
      data: {
        id: `${PLUGIN_ID}.toggle`,
        label: 'Bubble Mode: toggle',
        keywords: ['bubble', 'imessage', 'chat', 'bots', 'skin', 'style', 'bubbles'],
        detail: () => (enabled ? 'on' : 'off'),
        detailVariant: 'state',
        keepOpen: true,
        run: () => toggleEnabled()
      }
    })

    ctx.register({
      id: 'palette-toggle-work',
      area: PALETTE_AREA,
      data: {
        id: `${PLUGIN_ID}.toggleWork`,
        label: 'Bubble Mode: toggle work rows',
        keywords: ['bubble', 'thinking', 'thoughts', 'tools', 'work', 'quiet', 'noise'],
        detail: () => (showWork ? 'shown' : 'hidden'),
        detailVariant: 'state',
        keepOpen: true,
        run: () => toggleShowWork()
      }
    })

    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
  }
}
