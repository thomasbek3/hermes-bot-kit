/**
 * Bot Sections — named group headers in the Hermes Desktop Bot Mode roster.
 *
 * Never re-parents React-owned DOM. Annotates roster rows with dataset + CSS
 * order, and appends plugin-owned header nodes at the END of each bot-row
 * list (visual position via `order`). Fails safe: selector miss → stock
 * roster. Imports: `@hermes/plugin-sdk` only.
 */

import { PALETTE_AREA, host } from '@hermes/plugin-sdk'

const PLUGIN_ID = 'bot-sections'
const STYLE_ID = 'hermes-bot-sections-style'
const BODY_CLASS = 'hermes-bot-sections'
const STORAGE_ENABLED = 'enabled'
const STORAGE_OVERRIDES = 'sectionOverrides'

const BOTS_PANE_ID = 'hermes-bots:pane'
const PANE_HIDDEN_ATTR = 'data-pane-hidden'
const HEADER_ATTR = 'data-hermes-bot-section-header'
const LIST_ATTR = 'data-hermes-bot-section-list'
const PIN_ATTR = 'data-hermes-bot-section-pin'
const ROW_SECTION_ATTR = 'data-bot-section'

const UNASSIGNED = 'Unassigned'
const ORDER_STEP = 10
const HIDDEN_ORDER = 10000

const SECTIONS = {
  order: ['Apollo', 'OMH', 'HQ'],
  bots: {
    pricing: 'Apollo',
    pooly: 'Apollo',
    knowledgey: 'Apollo',
    listy: 'Apollo',
    insurey: 'Apollo',
    inquiry: 'Apollo',
    onboardy: 'Apollo',
    rainmaker: 'Apollo',
    galen: 'OMH',
    health: 'OMH',
    sentinel: 'OMH',
    jarvis: 'HQ',
    alfred: 'HQ',
    muse: 'HQ',
    orchestrator: 'HQ',
    meta: 'HQ',
    bouncer: 'HQ',
    techy: 'HQ'
  }
}

const SECTION_LADDER = [...SECTIONS.order, UNASSIGNED]

const CSS = /* css */ `
body.hermes-bot-sections [${LIST_ATTR}] {
  display: flex;
  flex-direction: column;
}

body.hermes-bot-sections [${HEADER_ATTR}] {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.25rem;
  padding: 0.375rem 0.5rem;
  border-radius: 0.375rem;
  box-sizing: border-box;
  text-align: left;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ui-text-quaternary);
  pointer-events: none;
  user-select: none;
  flex-shrink: 0;
}

body.hermes-bot-sections [${HEADER_ATTR}][hidden] {
  display: none !important;
}

body.hermes-bot-sections .hermes-bot-section-caret {
  width: 0;
  height: 0;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  border-left: 5px solid currentColor;
  transform: rotate(90deg);
  opacity: 0.85;
  flex-shrink: 0;
}

body.hermes-bot-sections .hermes-bot-section-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body.hermes-bot-sections .hermes-bot-section-spacer {
  min-width: 0;
  flex: 1;
}

body.hermes-bot-sections .hermes-bot-section-count {
  flex-shrink: 0;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-quaternary);
}
`

let pluginCtx = null
let enabled = true
let overrides = {}
let applied = false
let raf = 0
let observer = null
const unbinders = []
const registeredBots = new Set()

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

function knownSection(name) {
  return name === UNASSIGNED || SECTIONS.order.includes(name)
}

function sectionBaseOrder(sectionId) {
  if (sectionId === UNASSIGNED) return (SECTIONS.order.length + 1) * ORDER_STEP
  const i = SECTIONS.order.indexOf(sectionId)
  if (i < 0) return (SECTIONS.order.length + 1) * ORDER_STEP
  return (i + 1) * ORDER_STEP
}

function sectionForKey(rawKey) {
  const key = String(rawKey || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
  if (!key) return UNASSIGNED
  if (Object.prototype.hasOwnProperty.call(overrides, key)) {
    const mapped = String(overrides[key] || '').trim() || UNASSIGNED
    return knownSection(mapped) ? mapped : UNASSIGNED
  }
  if (SECTIONS.bots[key]) return SECTIONS.bots[key]
  return UNASSIGNED
}

function rowIdentities(btn) {
  const ids = []
  const push = value => {
    const key = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '')
    if (key && !ids.includes(key)) ids.push(key)
  }
  const label = (btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
  const parts = label.split('·').map(part => part.trim())
  for (const part of parts) {
    if (part.charAt(0) === '@' && part.length > 1) {
      push(part.slice(1))
      break
    }
  }
  const span = btn.querySelector('span.font-medium')
  push(span && span.textContent)
  if (parts[0] && parts[0].charAt(0) !== '@') push(parts[0])
  if (ids[0] === 'hermes') push('default')
  return ids
}

function sectionForRow(btn) {
  const ids = rowIdentities(btn)
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return sectionForKey(id)
  }
  for (const id of ids) {
    if (SECTIONS.bots[id]) return SECTIONS.bots[id]
  }
  return UNASSIGNED
}

function isBotRow(el) {
  if (!el || el.nodeType !== 1) return false
  if (el.hasAttribute(HEADER_ATTR) || el.closest?.(`[${HEADER_ATTR}]`)) return false
  const slot = el.getAttribute('data-slot')
  const trigger = el.hasAttribute('data-hermes-context-menu-trigger')
  if (slot !== 'row-button' && !trigger) return false
  const label = el.getAttribute('aria-label') || ''
  return /·\s*@[A-Za-z0-9]/.test(label)
}

function findBotsPaneRoots() {
  if (typeof document === 'undefined') return []
  const roots = []
  const spans = document.querySelectorAll('span')
  for (const span of spans) {
    if (inHiddenPane(span)) continue
    if ((span.textContent || '').trim() !== 'Bots') continue
    const cls = span.className || ''
    if (!/tracking-wider/.test(cls) || !/uppercase/.test(cls)) continue
    let el = span.parentElement
    let root = null
    for (let i = 0; i < 6 && el; i++) {
      const c = el.classList
      if (c && c.contains('flex') && c.contains('h-full') && c.contains('flex-col')) {
        root = el
        break
      }
      el = el.parentElement
    }
    if (!root) root = span.parentElement && span.parentElement.parentElement
    if (root && !inHiddenPane(root) && !roots.includes(root)) roots.push(root)
  }
  return roots
}

function listItem(row, list) {
  let el = row
  while (el && el.parentElement && el.parentElement !== list) el = el.parentElement
  return el && el.parentElement === list ? el : row
}

function isHiddenSection(el) {
  if (!el || el.nodeType !== 1) return false
  if (el.hasAttribute(HEADER_ATTR)) return false
  if (isBotRow(el)) return false
  if (el.getAttribute('data-slot') === 'row-button') return false
  if (el.hasAttribute('data-hermes-context-menu-trigger')) return false
  const text = (el.textContent || '').replace(/\s+/g, ' ')
  if (!/\bHidden\b/.test(text)) return false
  return Boolean(el.querySelector('[data-slot="row-button"], [data-hermes-context-menu-trigger]'))
}

function setAttr(el, name, value) {
  if (!el) return
  if (el.getAttribute(name) === value) return
  el.setAttribute(name, value)
}

function setOrder(el, n) {
  const next = String(n)
  if (el.style.order !== next) el.style.order = next
}

function createHeader(section) {
  const el = document.createElement('div')
  el.setAttribute(HEADER_ATTR, section)
  el.setAttribute('aria-hidden', 'true')
  const caret = document.createElement('span')
  caret.className = 'hermes-bot-section-caret'
  caret.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'hermes-bot-section-label'
  label.textContent = section
  const spacer = document.createElement('span')
  spacer.className = 'hermes-bot-section-spacer'
  const count = document.createElement('span')
  count.className = 'hermes-bot-section-count'
  count.setAttribute('data-hermes-bot-section-count', '')
  count.textContent = '0'
  el.append(caret, label, spacer, count)
  return el
}

function syncHeaders(list, counts) {
  for (const section of SECTION_LADDER) {
    const sel = `:scope > [${HEADER_ATTR}="${cssAttr(section)}"]`
    let header = null
    try {
      header = list.querySelector(sel)
    } catch {
      header = null
    }
    if (!header) {
      header = createHeader(section)
    }
    if (header.parentNode !== list) list.appendChild(header)
    setOrder(header, sectionBaseOrder(section) - 1)
    const count = counts[section] || 0
    const countEl = header.querySelector('[data-hermes-bot-section-count]')
    const countText = String(count)
    if (countEl && countEl.textContent !== countText) countEl.textContent = countText
    const hide = count === 0
    if (header.hidden !== hide) header.hidden = hide
  }
}

function clearAnnotations() {
  if (typeof document === 'undefined') return
  const rows = document.querySelectorAll(`[${ROW_SECTION_ATTR}]`)
  for (const el of rows) {
    el.removeAttribute(ROW_SECTION_ATTR)
    el.style.removeProperty('order')
  }
  const lists = document.querySelectorAll(`[${LIST_ATTR}]`)
  for (const el of lists) {
    el.removeAttribute(LIST_ATTR)
  }
  const pins = document.querySelectorAll(`[${PIN_ATTR}]`)
  for (const el of pins) {
    el.removeAttribute(PIN_ATTR)
    el.style.removeProperty('order')
  }
  const headers = document.querySelectorAll(`[${HEADER_ATTR}]`)
  for (const el of headers) {
    try {
      el.remove()
    } catch {
      /* already gone */
    }
  }
}

function applySections() {
  if (typeof document === 'undefined') return
  const roots = findBotsPaneRoots()
  if (!roots.length) {
    clearAnnotations()
    return
  }
  const rows = []
  for (const root of roots) {
    const buttons = root.querySelectorAll('[data-slot="row-button"], [data-hermes-context-menu-trigger]')
    for (const btn of buttons) {
      if (inHiddenPane(btn)) continue
      if (!isBotRow(btn)) continue
      rows.push(btn)
    }
  }
  if (!rows.length) {
    clearAnnotations()
    return
  }

  const buckets = new Map()
  for (const row of rows) {
    const list = row.parentElement
    if (!list) continue
    let bucket = buckets.get(list)
    if (!bucket) {
      bucket = []
      buckets.set(list, bucket)
    }
    bucket.push(row)
  }

  const liveLists = new Set(buckets.keys())

  for (const [list, listRows] of buckets) {
    setAttr(list, LIST_ATTR, '')
    const counts = Object.create(null)
    for (const section of SECTION_LADDER) counts[section] = 0
    for (const row of listRows) {
      const section = sectionForRow(row)
      const item = listItem(row, list)
      setAttr(item, ROW_SECTION_ATTR, section)
      setOrder(item, sectionBaseOrder(section))
      counts[section] = (counts[section] || 0) + 1
    }
    for (const child of Array.from(list.children)) {
      if (isHiddenSection(child)) {
        setAttr(child, PIN_ATTR, 'hidden')
        setOrder(child, HIDDEN_ORDER)
      }
    }
    syncHeaders(list, counts)
  }

  const staleHeaders = document.querySelectorAll(`[${HEADER_ATTR}]`)
  for (const header of staleHeaders) {
    if (!liveLists.has(header.parentNode)) {
      try {
        header.remove()
      } catch {
        /* ignore */
      }
    }
  }
  const staleLists = document.querySelectorAll(`[${LIST_ATTR}]`)
  for (const list of staleLists) {
    if (!liveLists.has(list)) list.removeAttribute(LIST_ATTR)
  }
}

function setBodyClass(on) {
  if (typeof document === 'undefined' || !document.body) return
  if (on) document.body.classList.add(BODY_CLASS)
  else document.body.classList.remove(BODY_CLASS)
  applied = on
}

function sync() {
  try {
    const next = Boolean(enabled && botsPaneActive())
    if (next) {
      if (!applied) setBodyClass(true)
      else if (document.body && !document.body.classList.contains(BODY_CLASS)) setBodyClass(true)
      applySections()
      return
    }
    if (applied || (document.body && document.body.classList.contains(BODY_CLASS))) setBodyClass(false)
    clearAnnotations()
  } catch {
    /* fail safe — leave the roster stock */
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

function absorbOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const next = {}
  for (const [key, section] of Object.entries(value)) {
    const bot = String(key || '')
      .trim()
      .toLowerCase()
    if (!bot) continue
    next[bot] = String(section || '').trim() || UNASSIGNED
  }
  overrides = next
  registerCycleCommands()
  scheduleSync()
}

function readOverrides(ctx) {
  try {
    const value = ctx.storage?.get?.(STORAGE_OVERRIDES, {})
    if (value && typeof value.then === 'function') {
      value.then(absorbOverrides).catch(() => undefined)
      return
    }
    absorbOverrides(value)
  } catch {
    /* ignore */
  }
}

function writeEnabled(value) {
  enabled = Boolean(value)
  try {
    pluginCtx?.storage?.set?.(STORAGE_ENABLED, enabled)
  } catch {
    /* storage unavailable — holds for this window */
  }
  scheduleSync()
}

function writeOverrides() {
  try {
    pluginCtx?.storage?.set?.(STORAGE_OVERRIDES, { ...overrides })
  } catch {
    /* storage unavailable — holds for this window */
  }
}

function toggleEnabled() {
  writeEnabled(!enabled)
}

function cycleBot(bot) {
  const key = String(bot || '')
    .trim()
    .toLowerCase()
  if (!key) return
  const current = sectionForKey(key)
  const i = SECTION_LADDER.indexOf(current)
  const next = SECTION_LADDER[(i < 0 ? 0 : i + 1) % SECTION_LADDER.length]
  overrides = { ...overrides, [key]: next }
  writeOverrides()
  scheduleSync()
}

function knownBots() {
  const bots = new Set(Object.keys(SECTIONS.bots))
  for (const key of Object.keys(overrides)) bots.add(key)
  return bots
}

function registerCycleCommands() {
  if (!pluginCtx || typeof pluginCtx.register !== 'function') return
  for (const bot of knownBots()) {
    if (registeredBots.has(bot)) continue
    registeredBots.add(bot)
    const key = bot
    pluginCtx.register({
      id: `palette-cycle-${key}`,
      area: PALETTE_AREA,
      data: {
        id: `${PLUGIN_ID}.cycle.${key}`,
        label: `Bot Sections: cycle ${key}`,
        keywords: ['bot', 'section', 'roster', 'group', 'unassigned', key],
        detail: () => sectionForKey(key),
        detailVariant: 'state',
        keepOpen: true,
        run: () => cycleBot(key)
      }
    })
  }
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
    attributeFilter: [PANE_HIDDEN_ATTR, 'aria-selected', 'aria-label', 'data-tree-tab', 'class']
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
  clearAnnotations()
  removeStyle()
}

export default {
  id: PLUGIN_ID,
  name: 'Bot Sections',
  defaultEnabled: true,
  description: 'Named group headers in the Bot Mode roster. Sessions stay unchanged.',
  register(ctx) {
    pluginCtx = ctx
    enabled = readEnabled(ctx)
    readOverrides(ctx)
    injectStyle()

    watchPane(BOTS_PANE_ID, scheduleSync)
    startDomObserver()
    scheduleSync()

    ctx.register({
      id: 'palette-toggle',
      area: PALETTE_AREA,
      data: {
        id: `${PLUGIN_ID}.toggle`,
        label: 'Bot Sections: toggle',
        keywords: ['bot', 'section', 'roster', 'group', 'unassigned', 'headers'],
        detail: () => (enabled ? 'on' : 'off'),
        detailVariant: 'state',
        keepOpen: true,
        run: () => toggleEnabled()
      }
    })

    registerCycleCommands()

    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
  }
}
