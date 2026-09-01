/**
 * Task Dock — persist the Bot Chat "Tasks N/M" list across bot switches.
 *
 * The app widget is live-only (streaming todo events, no store after unmount).
 * This plugin copies the visible widget into plugin storage and renders its
 * own panel above the composer. Never moves or mutates the app widget.
 * Fails safe: selector miss → no dock. Imports: `@hermes/plugin-sdk` only.
 */

import { PALETTE_AREA, host } from '@hermes/plugin-sdk'

const PLUGIN_ID = 'task-dock'
const STYLE_ID = 'hermes-task-dock-style'
const BODY_CLASS = 'hermes-task-dock'
const DOCK_ATTR = 'data-hermes-task-dock'

const STORAGE_ENABLED = 'enabled'
const STORAGE_COLLAPSED = 'collapsed'
const STORAGE_SNAPSHOTS = 'snapshots'

const BOTS_PANE_ID = 'hermes-bots:pane'
const ROUTINES_PANE_ID = 'hermes-bots:routines'
const BOTS_HOME_PANE_ID = 'plugin-workspace:hermes-bots:home'
const BOTS_GROUP_TAB_PREFIX = 'plugin-workspace:hermes-bots:group:'
const SESSION_TILE_TAB_PREFIX = 'session-tile:'
const PANE_HIDDEN_ATTR = 'data-pane-hidden'

const TASKS_HEADER_RE = /Tasks\s+(\d+)\s*\/\s*(\d+)/
const CAPTURE_MS = 1000
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000
const ITEM_TEXT_MAX = 300
const STATUS_CLASS_MAX = 240
const STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'unknown'])

const CSS = /* css */ `
body:not(.hermes-task-dock) [${DOCK_ATTR}] {
  display: none !important;
}

[${DOCK_ATTR}] {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-height: 12rem;
  margin: 0 0.5rem;
  pointer-events: auto;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-stroke-secondary, rgba(127, 127, 127, 0.4)) 70%, transparent);
  border-bottom: none;
  border-radius: 1rem 1rem 0 0;
  background: var(--composer-fill, var(--ui-bg-elevated, color-mix(in srgb, var(--dt-card, #1b1e24) 88%, transparent)));
  color: var(--ui-text-primary, inherit);
  font-size: var(--conversation-text-font-size, 0.75rem);
  line-height: 1.25;
  backdrop-filter: blur(12px);
}

[${DOCK_ATTR}][data-stale='1'] {
  opacity: 0.55;
}

.hermes-task-dock-header {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0.35rem 0.5rem;
  border: none;
  background: transparent;
  color: var(--ui-text-secondary, #c9c9ce);
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.hermes-task-dock-header:hover {
  color: var(--ui-text-primary, inherit);
  background: var(--chrome-action-hover, rgba(127, 127, 127, 0.08));
}

.hermes-task-dock-caret {
  display: inline-flex;
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
  opacity: 0.9;
  transition: transform 0.12s ease;
}

.hermes-task-dock-caret svg {
  width: 100%;
  height: 100%;
}

[${DOCK_ATTR}][data-collapsed='1'] .hermes-task-dock-caret {
  transform: rotate(-90deg);
}

.hermes-task-dock-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.hermes-task-dock-spacer {
  flex: 1;
  min-width: 0.25rem;
}

.hermes-task-dock-updated {
  flex-shrink: 0;
  font-size: 0.625rem;
  font-weight: 400;
  color: var(--ui-text-quaternary, #8a8a90);
  white-space: nowrap;
}

[${DOCK_ATTR}]:not([data-stale='1']) .hermes-task-dock-updated {
  display: none;
}

.hermes-task-dock-list {
  min-height: 0;
  max-height: 9.5rem;
  overflow-y: auto;
  padding: 0 0.25rem 0.35rem;
}

[${DOCK_ATTR}][data-collapsed='1'] .hermes-task-dock-list {
  display: none;
}

.hermes-task-dock-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  min-height: 1.35rem;
  padding: 0.15rem 0.4rem;
  color: var(--ui-text-primary, inherit);
}

.hermes-task-dock-item[data-status='completed'],
.hermes-task-dock-item[data-status='cancelled'] {
  color: var(--ui-text-tertiary, #8a8a90);
}

.hermes-task-dock-item[data-status='cancelled'] {
  opacity: 0.7;
}

.hermes-task-dock-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0.7rem;
  height: 0.7rem;
  margin-top: 0.2rem;
  flex-shrink: 0;
  color: var(--ui-text-quaternary, #8a8a90);
}

.hermes-task-dock-glyph svg {
  width: 100%;
  height: 100%;
}

.hermes-task-dock-item[data-status='pending'] .hermes-task-dock-glyph {
  box-sizing: border-box;
  border-radius: 50%;
  border: 1px dashed color-mix(in srgb, var(--ui-text-quaternary, #8a8a90) 85%, transparent);
}

.hermes-task-dock-item[data-status='completed'] .hermes-task-dock-glyph {
  color: #10b981;
}

.hermes-task-dock-item[data-status='in_progress'] .hermes-task-dock-glyph {
  color: var(--ui-text-secondary, #c9c9ce);
}

.hermes-task-dock-pulse {
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 50%;
  background: currentColor;
  animation: hermes-task-dock-pulse 1.2s ease-in-out infinite;
}

.hermes-task-dock-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.73rem;
  line-height: 1.2;
}

@media (prefers-reduced-motion: reduce) {
  .hermes-task-dock-pulse {
    animation: none;
    opacity: 0.85;
  }

  .hermes-task-dock-caret {
    transition: none;
  }
}

@keyframes hermes-task-dock-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
`

const CARET_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.25L8 9.75l3.5-3.5"/></svg>'
const CHECK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>'
const CANCEL_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 5.5l5 5"/></svg>'

let pluginCtx = null
let enabled = true
let collapsed = false
let snapshots = {}
let applied = false
let raf = 0
let observer = null
let tickTimer = 0
let persistTimer = 0
let persistDirty = false
let lastPersistAt = 0
let lastRenderKey = ''
let dockEl = null
let labelEl = null
let updatedEl = null
let listEl = null
const unbinders = []
const knownBotChatTabs = new Set()

function inHiddenPane(el) {
  return Boolean(el && typeof el.closest === 'function' && el.closest(`[${PANE_HIDDEN_ATTR}]`))
}

function ownDock(el) {
  return Boolean(el && typeof el.closest === 'function' && el.closest(`[${DOCK_ATTR}]`))
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

function cssAttr(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_:-]/g, ch => `\\${ch}`)
}

function tabSelected(paneId) {
  if (typeof document === 'undefined') return false
  const tab = document.querySelector(`[data-tree-tab="${cssAttr(paneId)}"]`)
  return Boolean(tab && tab.getAttribute('aria-selected') === 'true' && !inHiddenPane(tab))
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

function rememberBotChatTab(id) {
  if (knownBotChatTabs.has(id)) return
  knownBotChatTabs.add(id)
  try {
    pluginCtx?.storage?.set?.('knownBotChatTabs', Array.from(knownBotChatTabs).slice(-64))
  } catch {
    /* holds for this window */
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
  if (canonicalBotChatTabSelected()) return true
  return workspaceBotChatVisible()
}

function visibleChatSurface() {
  if (typeof document === 'undefined') return null
  const surfaces = document.querySelectorAll('[data-chat-surface]')
  let main = null
  for (const el of surfaces) {
    if (inHiddenPane(el)) continue
    const target = el.getAttribute('data-composer-target') || ''
    const anchor = el.getAttribute('data-session-anchor') || ''
    if (target.startsWith('tile:') || anchor.startsWith('session-tile:')) return el
    if (target === 'main' || anchor === 'workspace') main = main || el
  }
  return main
}

function readProfileName() {
  try {
    const focused = host.state.focusedSessionProfile && host.state.focusedSessionProfile.get()
    if (focused) return focused
  } catch {
    /* older SDK */
  }
  try {
    return host.state.profile.get() || 'default'
  } catch {
    return 'default'
  }
}

function currentBotKey() {
  const key = String(readProfileName() || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
  return key || 'default'
}

function sessionIdFrom(surface) {
  if (surface) {
    const target = surface.getAttribute('data-composer-target') || ''
    if (target.startsWith('tile:')) return target.slice(5)
    const anchor = surface.getAttribute('data-session-anchor') || ''
    if (anchor.startsWith('session-tile:')) return anchor.slice('session-tile:'.length)
  }
  try {
    const focused = host.state.focusedStoredSessionId && host.state.focusedStoredSessionId.get()
    if (focused) return String(focused)
  } catch {
    /* ignore */
  }
  try {
    const active = host.state.activeSessionId && host.state.activeSessionId.get()
    if (active) return String(active)
  } catch {
    /* ignore */
  }
  return ''
}

function normText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function classNameOf(el) {
  if (!el) return ''
  const c = el.className
  const s = typeof c === 'string' ? c : (c && c.baseVal) || ''
  return String(s)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STATUS_CLASS_MAX)
}

function findTasksHeader(root) {
  if (!root) return null
  const stack = root.querySelector('[data-slot="composer-status-stack"]')
  const dock = root.querySelector('[data-slot="composer-dock"]')
  const scope =
    stack && !inHiddenPane(stack) ? stack : dock && !inHiddenPane(dock) ? dock : root
  const passes = [scope.querySelectorAll('button'), scope.querySelectorAll('span')]
  for (const nodes of passes) {
    for (const el of nodes) {
      if (ownDock(el) || inHiddenPane(el)) continue
      const text = normText(el.textContent)
      if (text.length > 64) continue
      if (TASKS_HEADER_RE.test(text)) return el
    }
  }
  return null
}

function tasksSection(header) {
  const btn = (header && header.closest && header.closest('button')) || header
  if (!btn) return null
  const headerRow = btn.parentElement
  if (!headerRow) return btn
  return headerRow.parentElement || headerRow
}

function sectionBody(section, headerBtn) {
  if (!section) return null
  for (const child of Array.from(section.children)) {
    if (child.contains(headerBtn)) continue
    return child
  }
  return null
}

function hasDashedBorder(el) {
  if (!el || el.nodeType !== 1) return false
  const nodes = [el]
  try {
    const kids = el.querySelectorAll('span, i, svg')
    for (let i = 0; i < kids.length && i < 8; i++) nodes.push(kids[i])
  } catch {
    /* ignore */
  }
  for (const n of nodes) {
    let style
    try {
      style = getComputedStyle(n)
    } catch {
      continue
    }
    if (!style) continue
    const bs = `${style.borderStyle} ${style.borderTopStyle} ${style.borderLeftStyle} ${style.borderRightStyle}`
    if (/\bdashed\b/.test(bs)) return true
  }
  return false
}

function rgbOf(el) {
  if (!el) return null
  try {
    const c = getComputedStyle(el).color
    const m = String(c).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    if (!m) return null
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
  } catch {
    return null
  }
}

function classifyStatus(row) {
  if (!row) return 'unknown'
  try {
    if (row.querySelector('[role="status"]')) return 'in_progress'
  } catch {
    /* ignore */
  }
  if (hasDashedBorder(row)) return 'pending'
  let icon = null
  try {
    icon = row.querySelector('i, svg')
  } catch {
    icon = null
  }
  if (!icon) return 'unknown'
  const rgb = rgbOf(icon) || rgbOf(row)
  if (rgb && rgb.g > rgb.r + 20 && rgb.g > rgb.b + 10) return 'completed'
  try {
    const op = Number(getComputedStyle(icon).opacity)
    if (Number.isFinite(op) && op < 0.55) return 'cancelled'
  } catch {
    /* ignore */
  }
  if (rgb) {
    const max = Math.max(rgb.r, rgb.g, rgb.b)
    const min = Math.min(rgb.r, rgb.g, rgb.b)
    if (max - min < 25) return 'cancelled'
  }
  return 'completed'
}

function hasStatusAffordance(row) {
  if (!row) return false
  try {
    if (row.querySelector('[role="status"]')) return true
    if (row.querySelector('i, svg')) return true
  } catch {
    return false
  }
  return hasDashedBorder(row)
}

function itemText(row) {
  const raw = normText(row && row.textContent)
    .replace(/^[\u2800-\u28FF●○◦•]+/, '')
    .trim()
  return raw.slice(0, ITEM_TEXT_MAX)
}

function parseItem(row, headerBtn) {
  if (!row || row.nodeType !== 1) return null
  if (headerBtn && row.contains(headerBtn)) return null
  const text = itemText(row)
  if (!text || TASKS_HEADER_RE.test(text)) return null
  if (text.length > ITEM_TEXT_MAX) return null
  if (!hasStatusAffordance(row)) return null
  const leading = row.firstElementChild
  return {
    text,
    status: classifyStatus(row),
    statusClass: classNameOf(leading)
  }
}

function captureItems(section, headerBtn) {
  const body = sectionBody(section, headerBtn)
  if (!body) return []
  const rows = body.children.length ? Array.from(body.children) : Array.from(body.querySelectorAll(':scope > *'))
  const items = []
  for (const row of rows) {
    const item = parseItem(row, headerBtn)
    if (item) items.push(item)
  }
  return items
}

function parseCounts(header) {
  const text = normText(header && header.textContent)
  const m = text.match(TASKS_HEADER_RE)
  if (!m) return null
  return { done: Number(m[1]), total: Number(m[2]) }
}

function captureLive(surface, bot, sessionId) {
  const header = findTasksHeader(surface)
  if (!header) return null
  const counts = parseCounts(header)
  if (!counts) return null
  if (counts.total <= 0 && counts.done <= 0) return null
  const btn = (header.closest && header.closest('button')) || header
  const section = tasksSection(header)
  let items = captureItems(section, btn)
  const prev = snapshots[bot]
  // Collapsed app widget unmounts its rows. Keep the last rows we actually
  // saw when the N/M counts have not moved.
  if (
    !items.length &&
    prev &&
    Array.isArray(prev.items) &&
    prev.items.length &&
    prev.done === counts.done &&
    prev.total === counts.total
  ) {
    items = prev.items
  }
  return {
    bot,
    sessionId: sessionId || '',
    done: counts.done,
    total: counts.total,
    items,
    capturedAt: Date.now()
  }
}

function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null
  const text = String(it.text || '').trim()
  if (!text) return null
  const status = STATUSES.has(it.status) ? it.status : 'unknown'
  return {
    text: text.slice(0, ITEM_TEXT_MAX),
    status,
    statusClass: String(it.statusClass || '').slice(0, STATUS_CLASS_MAX)
  }
}

function normalizeSnapshot(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const capturedAt = Number(v.capturedAt)
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return null
  const items = Array.isArray(v.items) ? v.items.map(normalizeItem).filter(Boolean) : []
  return {
    bot: String(v.bot || ''),
    sessionId: String(v.sessionId || ''),
    done: Number(v.done) || 0,
    total: Number(v.total) || 0,
    items,
    capturedAt
  }
}

function pruneSnapshots() {
  const cutoff = Date.now() - SNAPSHOT_TTL_MS
  let changed = false
  const next = {}
  for (const [key, value] of Object.entries(snapshots)) {
    const snap = normalizeSnapshot(value)
    if (!snap || snap.capturedAt <= cutoff) {
      changed = true
      continue
    }
    next[key] = snap
  }
  if (changed) snapshots = next
  return changed
}

function usableSnapshot(snap) {
  if (!snap) return null
  const normalized = normalizeSnapshot(snap)
  if (!normalized) return null
  if (Date.now() - normalized.capturedAt > SNAPSHOT_TTL_MS) return null
  if (normalized.total <= 0 && normalized.items.length === 0) return null
  return normalized
}

function persistSnapshotsNow() {
  pruneSnapshots()
  persistDirty = false
  lastPersistAt = Date.now()
  try {
    pluginCtx?.storage?.set?.(STORAGE_SNAPSHOTS, snapshots)
  } catch {
    /* holds for this window */
  }
}

function schedulePersist() {
  persistDirty = true
  const wait = Math.max(0, CAPTURE_MS - (Date.now() - lastPersistAt))
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = 0
    if (persistDirty) persistSnapshotsNow()
  }, wait)
}

function acceptLive(snap) {
  if (!snap || !snap.bot) return
  snapshots[snap.bot] = snap
  schedulePersist()
}

function absorbSnapshots(value) {
  const next = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, raw] of Object.entries(value)) {
      const snap = normalizeSnapshot(raw)
      if (!snap) continue
      next[String(key).toLowerCase()] = snap
    }
  }
  snapshots = next
  pruneSnapshots()
  scheduleSync()
}

function readSnapshots(ctx) {
  try {
    const value = ctx.storage?.get?.(STORAGE_SNAPSHOTS, {})
    if (value && typeof value.then === 'function') {
      value.then(absorbSnapshots).catch(() => undefined)
      return
    }
    absorbSnapshots(value)
  } catch {
    /* ignore */
  }
}

function relativeTime(ts) {
  const delta = Math.max(0, Date.now() - Number(ts || 0))
  const sec = Math.round(delta / 1000)
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}

function glyphNode(status) {
  const el = document.createElement('span')
  el.className = 'hermes-task-dock-glyph'
  el.setAttribute('aria-hidden', 'true')
  if (status === 'completed') el.innerHTML = CHECK_SVG
  else if (status === 'cancelled') el.innerHTML = CANCEL_SVG
  else if (status === 'in_progress') {
    const pulse = document.createElement('span')
    pulse.className = 'hermes-task-dock-pulse'
    el.appendChild(pulse)
  }
  return el
}

function fillList(items) {
  if (!listEl) return
  listEl.textContent = ''
  for (const item of items) {
    const row = document.createElement('div')
    row.className = 'hermes-task-dock-item'
    row.setAttribute('data-status', item.status || 'unknown')
    const text = document.createElement('span')
    text.className = 'hermes-task-dock-text'
    text.textContent = item.text
    text.title = item.text
    row.append(glyphNode(item.status), text)
    listEl.appendChild(row)
  }
}

function buildDock() {
  const root = document.createElement('div')
  root.id = 'hermes-task-dock'
  root.setAttribute(DOCK_ATTR, '')
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', 'Task Dock')

  const header = document.createElement('button')
  header.type = 'button'
  header.className = 'hermes-task-dock-header'

  const caret = document.createElement('span')
  caret.className = 'hermes-task-dock-caret'
  caret.setAttribute('aria-hidden', 'true')
  caret.innerHTML = CARET_SVG

  labelEl = document.createElement('span')
  labelEl.className = 'hermes-task-dock-label'

  const spacer = document.createElement('span')
  spacer.className = 'hermes-task-dock-spacer'

  updatedEl = document.createElement('span')
  updatedEl.className = 'hermes-task-dock-updated'

  header.append(caret, labelEl, spacer, updatedEl)
  header.addEventListener('click', () => {
    collapsed = !collapsed
    try {
      pluginCtx?.storage?.set?.(STORAGE_COLLAPSED, collapsed)
    } catch {
      /* holds for this window */
    }
    lastRenderKey = ''
    scheduleSync()
  })

  listEl = document.createElement('div')
  listEl.className = 'hermes-task-dock-list'

  root.append(header, listEl)
  dockEl = root
  return root
}

function detachDock() {
  lastRenderKey = ''
  if (dockEl && dockEl.parentNode) {
    try {
      dockEl.remove()
    } catch {
      /* already gone */
    }
  }
}

function findDockHost(surface) {
  if (!surface) return null
  const named = surface.querySelector('[data-slot="composer-dock"]')
  if (named && !inHiddenPane(named) && !ownDock(named)) return named
  const composer = surface.querySelector('[data-slot="composer-root"]')
  const parent = composer && composer.parentElement
  if (parent && !inHiddenPane(parent) && !ownDock(parent)) return parent
  return null
}

function ensureDock(surface) {
  const hostEl = findDockHost(surface)
  if (!hostEl) return false
  if (!dockEl) buildDock()
  const composer =
    hostEl.querySelector(':scope > [data-slot="composer-root"]') || hostEl.querySelector('[data-slot="composer-root"]')
  const misplaced =
    dockEl.parentNode !== hostEl ||
    (composer && composer.parentNode === hostEl && dockEl.nextElementSibling !== composer)
  if (misplaced) {
    if (composer && composer.parentNode === hostEl) hostEl.insertBefore(dockEl, composer)
    else hostEl.appendChild(dockEl)
  }
  return true
}

function viewKey(view, stale) {
  return JSON.stringify({
    bot: view.bot,
    sessionId: view.sessionId,
    done: view.done,
    total: view.total,
    items: view.items.map(it => [it.text, it.status]),
    stale,
    collapsed,
    ageBucket: stale ? Math.floor(view.capturedAt / 15000) : 0
  })
}

function renderDock(surface, view, stale) {
  if (!ensureDock(surface)) {
    detachDock()
    return
  }
  const key = viewKey(view, stale)
  if (key === lastRenderKey) return
  lastRenderKey = key

  const total = view.total || view.items.length
  const done = view.done
  const header = dockEl.querySelector('.hermes-task-dock-header')
  dockEl.setAttribute('data-stale', stale ? '1' : '0')
  dockEl.setAttribute('data-collapsed', collapsed ? '1' : '0')
  if (header) header.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  if (labelEl) labelEl.textContent = `Tasks ${done}/${total}`
  if (updatedEl) {
    updatedEl.textContent = stale ? `last updated ${relativeTime(view.capturedAt)}` : ''
  }
  fillList(view.items)
}

function setBodyClass(on) {
  if (typeof document === 'undefined' || !document.body) return
  if (on) document.body.classList.add(BODY_CLASS)
  else document.body.classList.remove(BODY_CLASS)
  applied = on
}

function sync() {
  try {
    const active = Boolean(enabled && botModeChatVisible())
    if (active) {
      if (!applied) setBodyClass(true)
      else if (document.body && !document.body.classList.contains(BODY_CLASS)) setBodyClass(true)
    } else {
      if (applied || (document.body && document.body.classList.contains(BODY_CLASS))) setBodyClass(false)
      detachDock()
      return
    }

    const surface = visibleChatSurface()
    const bot = currentBotKey()
    const sessionId = sessionIdFrom(surface)
    const live = surface ? captureLive(surface, bot, sessionId) : null
    if (live) acceptLive(live)
    if (pruneSnapshots()) schedulePersist()

    const stored = usableSnapshot(snapshots[bot])
    const view = live || stored
    const stale = !live && Boolean(view)
    if (!view || !surface) {
      detachDock()
      return
    }
    renderDock(surface, view, stale)
  } catch {
    /* fail safe — no dock */
  }
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

function mutationInsideDock(node) {
  if (!dockEl || !node) return false
  if (node === dockEl) return true
  const el = node.nodeType === 1 ? node : node.parentElement
  return Boolean(el && (el === dockEl || dockEl.contains(el)))
}

function readEnabled(ctx) {
  try {
    const value = ctx.storage?.get?.(STORAGE_ENABLED, true)
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

function readCollapsed(ctx) {
  try {
    const value = ctx.storage?.get?.(STORAGE_COLLAPSED, false)
    const absorb = v => {
      collapsed = v === true
      lastRenderKey = ''
      scheduleSync()
    }
    if (value && typeof value.then === 'function') value.then(absorb).catch(() => undefined)
    else absorb(value)
  } catch {
    /* ignore */
  }
}

function writeEnabled(value) {
  enabled = Boolean(value)
  try {
    pluginCtx?.storage?.set?.(STORAGE_ENABLED, enabled)
  } catch {
    /* holds for this window */
  }
  lastRenderKey = ''
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
  observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (mutationInsideDock(m.target)) continue
      scheduleSync()
      return
    }
  })
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
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

function startTick() {
  if (tickTimer) return
  tickTimer = setInterval(scheduleSync, CAPTURE_MS)
}

function stopTick() {
  if (!tickTimer) return
  try {
    clearInterval(tickTimer)
  } catch {
    /* ignore */
  }
  tickTimer = 0
}

function dispose() {
  stopTick()
  if (persistTimer) {
    try {
      clearTimeout(persistTimer)
    } catch {
      /* ignore */
    }
    persistTimer = 0
  }
  if (persistDirty) persistSnapshotsNow()
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
  detachDock()
  dockEl = null
  labelEl = null
  updatedEl = null
  listEl = null
  setBodyClass(false)
  removeStyle()
}

export default {
  id: PLUGIN_ID,
  name: 'Task Dock',
  defaultEnabled: true,
  description: 'Keeps the Tasks list visible in Bot Chats after the app clears it on bot switch.',
  register(ctx) {
    pluginCtx = ctx
    enabled = readEnabled(ctx)
    readCollapsed(ctx)
    readSnapshots(ctx)
    readKnownBotChatTabs(ctx)
    injectStyle()

    watchPane(BOTS_PANE_ID, scheduleSync)
    watchPane(BOTS_HOME_PANE_ID, scheduleSync)
    watchPane(ROUTINES_PANE_ID, scheduleSync)
    watchStore(host.state?.focusedStoredSessionId || host.state?.activeSessionId, scheduleSync)
    watchStore(host.state?.focusedSessionProfile, scheduleSync)
    watchStore(host.state?.profile, scheduleSync)

    startDomObserver()
    startTick()
    scheduleSync()

    ctx.register({
      id: 'palette-toggle',
      area: PALETTE_AREA,
      data: {
        id: `${PLUGIN_ID}.toggle`,
        label: 'Task Dock: toggle',
        keywords: ['task', 'todo', 'dock', 'tasks', 'bots', 'checklist'],
        detail: () => (enabled ? 'on' : 'off'),
        detailVariant: 'state',
        keepOpen: true,
        run: () => toggleEnabled()
      }
    })

    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
  }
}
