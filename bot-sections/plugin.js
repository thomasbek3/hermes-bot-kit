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
  // One-time seed, imported into storage on first launch. Ship empty: a
  // fresh install shows a single "Unassigned" section wrapping every bot —
  // right-click it -> "New section…" to start organizing, then move bots
  // with the palette ("Bot Sections: cycle <bot>"). Pre-fill this block if
  // you prefer declaring a starting layout in code.
  order: [],
  bots: {}
}

let customSections = []
const discoveredBots = new Set()
let discoveredDirty = false

// First-run seed: the SECTIONS config block is a one-time template. On the
// first launch it is imported into storage (custom sections + overrides);
// from then on storage is the single source of truth, so users can rename
// and delete every section — and kit updates shipping a neutral config
// never touch an existing layout.
const seedState = { customs: false, overrides: false, flag: undefined }

function trySeedFromConfig() {
  if (!seedState.customs || !seedState.overrides || seedState.flag === undefined) return
  if (seedState.flag) return
  seedState.flag = true
  let changed = false
  for (const name of SECTIONS.order) {
    const n = String(name || '').trim()
    if (n && n !== UNASSIGNED && !customSections.includes(n)) {
      customSections.push(n)
      changed = true
    }
  }
  const next = { ...overrides }
  for (const [k, v] of Object.entries(SECTIONS.bots)) {
    const key = String(k || '').trim().toLowerCase()
    if (key && !(key in next)) {
      next[key] = v
      changed = true
    }
  }
  if (changed) {
    overrides = next
    writeOverrides()
    persistCustomSections()
  }
  try {
    pluginCtx?.storage?.set?.('configSeeded', true)
  } catch {
    /* holds for this window */
  }
  scheduleSync()
  registerCycleCommands()
}

function readSeedFlag(ctx) {
  try {
    const value = ctx.storage?.get?.('configSeeded', false)
    const absorb = v => {
      seedState.flag = v === true
      trySeedFromConfig()
    }
    if (value && typeof value.then === 'function') value.then(absorb).catch(() => { seedState.flag = false; trySeedFromConfig() })
    else absorb(value)
  } catch {
    seedState.flag = false
    trySeedFromConfig()
  }
}

function sectionLadder() {
  const seen = new Set()
  const ladder = []
  for (const name of [...SECTIONS.order, ...customSections]) {
    const n = String(name || '').trim()
    if (!n || n === UNASSIGNED || seen.has(n)) continue
    seen.add(n)
    ladder.push(n)
  }
  ladder.push(UNASSIGNED)
  return ladder
}

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
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

.hermes-bot-section-menu {
  position: fixed;
  z-index: 2147483000;
  pointer-events: auto;
  min-width: 13rem;
  padding: 0.25rem;
  border-radius: 0.5rem;
  border: 1px solid var(--ui-stroke-secondary, rgba(255, 255, 255, 0.1));
  background: color-mix(in srgb, var(--ui-bg-elevated, #1b1e24) 96%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.3);
  font-size: var(--conversation-text-font-size, 0.8125rem);
  line-height: 1.25;
  color: var(--ui-text-primary, #e8e8ea);
}

.hermes-bot-section-menu-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.25rem 0.5rem;
  min-height: 1.75rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--ui-text-primary, #e8e8ea);
  text-align: left;
  cursor: default;
  font: inherit;
  font-size: 0.75rem;
}

.hermes-bot-section-menu-item svg {
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
  color: var(--ui-text-tertiary, #8a8a90);
}

.hermes-bot-section-menu-item:hover {
  background: var(--ui-control-active-background, rgba(255, 255, 255, 0.08));
}

.hermes-bot-section-menu-emojis {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  padding: 0.125rem;
  margin: 0 0 0.125rem;
}

.hermes-bot-section-menu-emojis button {
  border: none;
  background: transparent;
  font-size: 0.875rem;
  line-height: 1;
  padding: 0.3125rem 0.34rem;
  border-radius: 0.375rem;
  cursor: default;
}

.hermes-bot-section-menu-emojis button:hover {
  background: var(--ui-control-active-background, rgba(255, 255, 255, 0.08));
}

body.hermes-bot-sections [${HEADER_ATTR}]:hover {
  background: var(--chrome-action-hover, rgba(255, 255, 255, 0.06));
  color: var(--ui-text-secondary, #c9c9ce);
}

.hermes-bot-section-tip {
  position: fixed;
  z-index: 2147483001;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  border: 1px solid var(--ui-stroke-secondary, rgba(255, 255, 255, 0.1));
  background: var(--ui-bg-elevated, #26282e);
  color: var(--ui-text-secondary, #d0d0d4);
  font-size: 0.6875rem;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.hermes-bot-section-menu-editrow {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin: 0.25rem 0;
}

.hermes-bot-section-menu-smiley {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--ui-text-tertiary, rgba(255, 255, 255, 0.45));
  cursor: default;
}

.hermes-bot-section-menu-smiley svg {
  width: 1.05rem;
  height: 1.05rem;
}

.hermes-bot-section-menu-smiley:hover {
  background: var(--ui-control-active-background, rgba(255, 255, 255, 0.08));
  color: var(--ui-text-secondary, #d0d0d4);
}

.hermes-bot-section-menu input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 0.3125rem 0.5rem;
  border-radius: 0.375rem;
  border: 1px solid var(--ui-stroke-secondary, rgba(255, 255, 255, 0.12));
  background: var(--ui-surface-sunken, rgba(0, 0, 0, 0.3));
  color: var(--ui-text-primary, #f0f0f2);
  font: inherit;
  font-size: 0.75rem;
  outline: none;
}

body.hermes-bot-sections [${HEADER_ATTR}] .hermes-bot-section-label[contenteditable] {
  user-select: text;
  cursor: text;
  outline: 1px solid var(--ui-stroke-tertiary, rgba(255, 255, 255, 0.2));
  border-radius: 0.25rem;
  padding: 0 0.25rem;
  text-transform: none;
}

body.hermes-bot-sections [${HEADER_ATTR}][hidden] {
  display: none !important;
}

body.hermes-bot-sections [data-bot-section][data-bot-section-collapsed="1"] {
  display: none !important;
}

body.hermes-bot-sections [data-hermes-bot-section-header][data-collapsed="1"] .hermes-bot-section-caret {
  transform: rotate(-90deg);
}

body.hermes-bot-sections .hermes-bot-section-caret {
  transition: transform 0.12s ease;
}

body.hermes-bot-sections .hermes-bot-section-caret {
  display: inline-flex;
  width: 0.875rem;
  height: 0.875rem;
  opacity: 0.9;
  flex-shrink: 0;
}

body.hermes-bot-sections .hermes-bot-section-caret svg {
  width: 100%;
  height: 100%;
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
  return sectionLadder().includes(name)
}

function sectionBaseOrder(sectionId) {
  const ladder = sectionLadder()
  const i = ladder.indexOf(sectionId)
  if (i < 0) return ladder.length * ORDER_STEP
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

// Display names: rename any section (emoji welcome — "🏠 Airbnb Operations").
// Section IDS stay stable (config keys, cycle commands); only the label
// shown on the header changes. Persisted per install.
let sectionNames = {}
let collapsedSections = new Set()

function persistCollapsed() {
  try {
    pluginCtx?.storage?.set?.('collapsedSections', Array.from(collapsedSections))
  } catch {
    /* holds for this window */
  }
}

function readCollapsed(ctx) {
  try {
    const value = ctx.storage?.get?.('collapsedSections', [])
    const absorb = list => {
      if (Array.isArray(list)) collapsedSections = new Set(list.map(String))
      scheduleSync()
    }
    if (value && typeof value.then === 'function') value.then(absorb).catch(() => undefined)
    else absorb(value)
  } catch {
    /* ignore */
  }
}

function persistCustomSections() {
  try {
    pluginCtx?.storage?.set?.('customSections', customSections)
  } catch {
    /* holds for this window */
  }
}

function readCustomSections(ctx) {
  try {
    const value = ctx.storage?.get?.('customSections', [])
    const absorb = list => {
      if (Array.isArray(list)) customSections = list.map(String).filter(Boolean)
      seedState.customs = true
      trySeedFromConfig()
      scheduleSync()
      registerCycleCommands()
    }
    if (value && typeof value.then === 'function') value.then(absorb).catch(() => undefined)
    else absorb(value)
  } catch {
    /* ignore */
  }
}

function toggleCollapsed(section) {
  if (collapsedSections.has(section)) collapsedSections.delete(section)
  else collapsedSections.add(section)
  persistCollapsed()
  scheduleSync()
}

function displaySectionName(section) {
  const v = sectionNames[section]
  return typeof v === 'string' && v.trim() ? v.trim() : section
}

function persistSectionNames() {
  try {
    pluginCtx?.storage?.set?.('sectionNames', sectionNames)
  } catch {
    /* storage unavailable — holds for this window */
  }
}

function readSectionNames(ctx) {
  try {
    const value = ctx.storage?.get?.('sectionNames', {})
    const absorb = obj => {
      if (obj && typeof obj === 'object') sectionNames = { ...obj }
      scheduleSync()
    }
    if (value && typeof value.then === 'function') value.then(absorb).catch(() => undefined)
    else absorb(value)
  } catch {
    /* ignore */
  }
}

const MENU_EMOJIS = ['🏠', '💼', '📣', '💰', '⚙️', '🧪', '🚀', '✨', '🤖', '📈']
let openMenuEl = null
let menuAutosave = null

function closeMenu() {
  if (menuAutosave) {
    const f = menuAutosave
    menuAutosave = null
    f()
  }
  if (openMenuEl) {
    if (openMenuEl._restoreBodyPE !== undefined && document.body.style.pointerEvents === '') {
      // leave the page unlocked — the rival layer is hidden and cannot
      // restore itself; re-locking would freeze the whole app
    }
    openMenuEl.remove()
    openMenuEl = null
    document.removeEventListener('pointerdown', onMenuOutside, true)
    document.removeEventListener('keydown', onMenuKey, true)
  }
}

function onMenuOutside(e) {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu()
}

function onMenuKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeMenu()
  }
}

function setEmoji(section, emoji) {
  const current = displaySectionName(section)
  const bare = current.replace(/^[^\p{L}\p{N}]+\s*/u, '')
  const next = emoji ? `${emoji} ${bare}` : bare
  if (next && next !== section) sectionNames[section] = next
  else delete sectionNames[section]
  persistSectionNames()
  scheduleSync()
}

function headerFromEvent(e) {
  return e.target && typeof e.target.closest === 'function' ? e.target.closest(`[${HEADER_ATTR}]`) : null
}

// The app opens its own context menu on right-button MOUSEDOWN, before the
// contextmenu event ever fires — so we intercept the press itself, scoped
// strictly to our headers. contextmenu is still swallowed as a backstop.
function onGlobalRightPress(e) {
  if (e.button !== 2) return
  const header = headerFromEvent(e)
  if (!header) return
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
  openSectionMenu(header.getAttribute(HEADER_ATTR), e.clientX, e.clientY, false)
}

function onGlobalContextMenu(e) {
  const header = headerFromEvent(e)
  const insideOurMenu = openMenuEl && e.target && openMenuEl.contains(e.target)
  if (!header && !insideOurMenu) return
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
}

function openSectionMenu(section, x, y, renameNow) {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'hermes-bot-section-menu'

  const mkItem = (svg, text) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'hermes-bot-section-menu-item'
    b.innerHTML = `${svg}<span>${text}</span>`
    menu.appendChild(b)
    return b
  }

  const renameItem = mkItem(
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M11.1 2.6a1.4 1.4 0 0 1 2 2L5.4 12.3l-2.7.7.7-2.7 7.7-7.7z"/></svg>',
    'Rename…'
  )
  const newItem = mkItem(
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 3v10M3 8h10"/></svg>',
    'New section…'
  )
  let deleteItem = null
  if (customSections.includes(section)) {
    deleteItem = mkItem(
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.2a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8.2"/></svg>',
      'Delete section'
    )
    deleteItem.addEventListener('click', () => {
      customSections = customSections.filter(n => n !== section)
      persistCustomSections()
      // bots pointing at the deleted section fall back to Unassigned
      let changed = false
      const next = { ...overrides }
      for (const [k, v] of Object.entries(next)) {
        if (v === section) {
          next[k] = UNASSIGNED
          changed = true
        }
      }
      if (changed) {
        overrides = next
        writeOverrides()
      }
      delete sectionNames[section]
      persistSectionNames()
      collapsedSections.delete(section)
      persistCollapsed()
      scheduleSync()
      closeMenu()
    })
  }

  // Shared editor: input + emoji strip beneath it (Notion-style: pick an
  // emoji to prepend, then Enter/Save commits name+emoji together).
  const openEditor = mode => {
    renameItem.hidden = true
    newItem.hidden = true
    if (deleteItem) deleteItem.hidden = true

    const input = document.createElement('input')
    input.type = 'text'
    if (mode === 'rename') {
      input.value = displaySectionName(section)
      input.placeholder = section
    } else {
      input.value = ''
      input.placeholder = 'New section name'
    }

    const row = document.createElement('div')
    row.className = 'hermes-bot-section-menu-editrow'

    const smiley = document.createElement('button')
    smiley.type = 'button'
    smiley.className = 'hermes-bot-section-menu-smiley'
    smiley.title = 'Add an emoji'
    smiley.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M5.4 9.4a3.4 3.4 0 0 0 5.2 0"/><circle cx="6" cy="6.6" r="0.55" fill="currentColor" stroke="none"/><circle cx="10" cy="6.6" r="0.55" fill="currentColor" stroke="none"/></svg>'

    const strip = document.createElement('div')
    strip.className = 'hermes-bot-section-menu-emojis'
    strip.hidden = true
    smiley.addEventListener('click', () => {
      strip.hidden = !strip.hidden
      input.focus()
    })
    const setLeading = em => {
      const bare = input.value.replace(/^[^\p{L}\p{N}]+\s*/u, '')
      input.value = em ? `${em} ${bare}` : bare
      input.focus()
    }
    for (const em of MENU_EMOJIS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = em
      b.addEventListener('click', () => setLeading(em))
      strip.appendChild(b)
    }
    const clearB = document.createElement('button')
    clearB.type = 'button'
    clearB.textContent = '✕'
    clearB.title = 'Remove emoji'
    clearB.addEventListener('click', () => setLeading(''))
    strip.appendChild(clearB)

    const save = () => {
      const next = input.value.trim()
      if (mode === 'rename') {
        if (next && next !== section) sectionNames[section] = next
        else if (!next || next === section) delete sectionNames[section]
        persistSectionNames()
      } else {
        if (next && !sectionLadder().includes(next)) {
          customSections = [...customSections, next]
          persistCustomSections()
          registerCycleCommands()
        }
      }
      scheduleSync()
    }
    // autosave: Enter commits, clicking anywhere outside commits too;
    // only Escape cancels.
    menuAutosave = save
    input.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Enter') closeMenu()
      if (e.key === 'Escape') {
        menuAutosave = null
        closeMenu()
      }
    })

    row.appendChild(input)
    row.appendChild(smiley)
    menu.appendChild(row)
    menu.appendChild(strip)
    input.focus()
    if (mode === 'rename') input.select()
  }

  renameItem.addEventListener('click', () => openEditor('rename'))
  newItem.addEventListener('click', () => openEditor('new'))

  document.body.appendChild(menu)
  menu.style.pointerEvents = 'auto'
  // Radix-style dismiss layers set body { pointer-events: none } and exempt
  // only their own portal. If the (hidden) rival layer left the page locked,
  // unlock it for the lifetime of our menu and restore afterwards.
  if (document.body.style.pointerEvents === 'none') {
    menu._restoreBodyPE = 'none'
    document.body.style.pointerEvents = ''
  }
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
  openMenuEl = menu
  // The app's own context menu opens from a boot-time window-capture
  // listener we cannot pre-empt; hide it the moment it mounts (narrowly
  // identified, never touched anywhere else).
  const hideRival = () => {
    if (openMenuEl !== menu) return
    const divs = document.querySelectorAll('div')
    for (const d of divs) {
      if (d === menu || menu.contains(d) || d.contains(menu)) continue
      const text = d.textContent || ''
      if (text.length > 300) continue
      if (!text.includes('Update Hermes') || !text.includes('Toggle tabs')) continue
      // Hide the app menu's whole body-level portal, not just the visible
      // box: its invisible dismiss-layer otherwise floats above our menu
      // and eats every hover/click (same z, later in DOM wins hit-testing).
      let node = d
      while (node.parentElement && node.parentElement !== document.body) {
        node = node.parentElement
      }
      const target = node.parentElement === document.body && node !== menu && !node.contains(menu) ? node : d
      if (target.style.display !== 'none') target.style.display = 'none'
      if (target !== d && d.style.display !== 'none') d.style.display = 'none'
    }
    // Re-assert our menu as the last body child so same-z hit-testing
    // favors it over any layer mounted after we opened.
    if (menu.parentNode === document.body && document.body.lastElementChild !== menu) {
      document.body.appendChild(menu)
    }
  }
  for (const t of [0, 40, 120, 260, 450]) setTimeout(hideRival, t)
  document.addEventListener('pointerdown', onMenuOutside, true)
  document.addEventListener('keydown', onMenuKey, true)
  if (renameNow) openEditor('rename')
}

function beginRename(label, section) {
  if (label.isContentEditable) return
  label.contentEditable = 'plaintext-only'
  const prev = label.textContent
  label.focus()
  try {
    const range = document.createRange()
    range.selectNodeContents(label)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {}
  const finish = commit => {
    label.contentEditable = 'false'
    label.removeEventListener('keydown', onKey)
    label.removeEventListener('blur', onBlur)
    const next = (label.textContent || '').trim()
    if (commit && next && next !== section) {
      sectionNames[section] = next
      persistSectionNames()
    } else if (commit && (!next || next === section)) {
      delete sectionNames[section]
      persistSectionNames()
    }
    label.textContent = displaySectionName(section)
  }
  const onKey = e => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      label.textContent = prev
      finish(false)
    }
  }
  const onBlur = () => finish(true)
  label.addEventListener('keydown', onKey)
  label.addEventListener('blur', onBlur)
}

function createHeader(section) {
  const el = document.createElement('div')
  el.setAttribute(HEADER_ATTR, section)
  el.setAttribute('aria-hidden', 'true')
  const caret = document.createElement('span')
  caret.className = 'hermes-bot-section-caret'
  caret.setAttribute('aria-hidden', 'true')
  caret.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.25L8 9.75l3.5-3.5"/></svg>'
  const label = document.createElement('span')
  label.className = 'hermes-bot-section-label'
  label.textContent = displaySectionName(section)
  label.title = 'Double-click to rename (emoji welcome)'

  el.style.cursor = 'pointer'
  el.addEventListener('mouseenter', () => {
    if (el._tipTimer) clearTimeout(el._tipTimer)
    el._tipTimer = setTimeout(() => {
      if (openMenuEl) return
      const tip = document.createElement('div')
      tip.className = 'hermes-bot-section-tip'
      const n = (el.querySelector('[data-hermes-bot-section-count]') || {}).textContent || '0'
      tip.textContent = `${displaySectionName(section)} · ${n} bots · right-click for options`
      document.body.appendChild(tip)
      const r = el.getBoundingClientRect()
      tip.style.left = `${r.left + 8}px`
      tip.style.top = `${Math.max(4, r.top - tip.getBoundingClientRect().height - 6)}px`
      el._tipEl = tip
    }, 450)
  })
  el.addEventListener('mouseleave', () => {
    if (el._tipTimer) clearTimeout(el._tipTimer)
    el._tipTimer = 0
    if (el._tipEl) {
      el._tipEl.remove()
      el._tipEl = null
    }
  })
  el.addEventListener('click', e => {
    e.preventDefault()
    e.stopPropagation()
    toggleCollapsed(section)
  })
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
  // Remove headers for sections that no longer exist (deleted customs) —
  // the ladder loop below never visits them, so they'd linger forever.
  const valid = new Set(sectionLadder())
  for (const h of list.querySelectorAll(`:scope > [${HEADER_ATTR}]`)) {
    if (!valid.has(h.getAttribute(HEADER_ATTR))) {
      try {
        h.remove()
      } catch {
        /* already gone */
      }
    }
  }
  for (const section of sectionLadder()) {
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
    const labelEl = header.querySelector('.hermes-bot-section-label')
    if (labelEl && !labelEl.isContentEditable) {
      const want = displaySectionName(section)
      if (labelEl.textContent !== want) labelEl.textContent = want
    }
    const count = counts[section] || 0
    const countEl = header.querySelector('[data-hermes-bot-section-count]')
    const countText = String(count)
    if (countEl && countEl.textContent !== countText) countEl.textContent = countText
    const hide = count === 0 && !customSections.includes(section)
    if (header.hidden !== hide) header.hidden = hide
    setAttr(header, 'data-collapsed', collapsedSections.has(section) ? '1' : '0')
  }
}

function clearAnnotations() {
  if (typeof document === 'undefined') return
  const rows = document.querySelectorAll(`[${ROW_SECTION_ATTR}]`)
  for (const el of rows) {
    el.removeAttribute(ROW_SECTION_ATTR)
    el.removeAttribute('data-bot-section-collapsed')
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
    for (const section of sectionLadder()) counts[section] = 0
    for (const row of listRows) {
      const section = sectionForRow(row)
      for (const id of rowIdentities(row)) {
        if (!discoveredBots.has(id)) {
          discoveredBots.add(id)
          discoveredDirty = true
        }
        break
      }
      const item = listItem(row, list)
      setAttr(item, ROW_SECTION_ATTR, section)
      setAttr(item, 'data-bot-section-collapsed', collapsedSections.has(section) ? '1' : '0')
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
  if (discoveredDirty) {
    discoveredDirty = false
    registerCycleCommands()
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
  seedState.overrides = true
  setTimeout(trySeedFromConfig, 0)
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
  const ladder = sectionLadder()
  const current = sectionForKey(key)
  const i = ladder.indexOf(current)
  const next = ladder[(i < 0 ? 0 : i + 1) % ladder.length]
  overrides = { ...overrides, [key]: next }
  writeOverrides()
  scheduleSync()
}

function knownBots() {
  const bots = new Set(Object.keys(SECTIONS.bots))
  for (const key of Object.keys(overrides)) bots.add(key)
  for (const key of discoveredBots) bots.add(key)
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
  closeMenu()
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
    readSectionNames(ctx)
    readCollapsed(ctx)
    readCustomSections(ctx)
    readSeedFlag(ctx)
    readOverrides(ctx)
    injectStyle()

    watchPane(BOTS_PANE_ID, scheduleSync)
    window.addEventListener('pointerdown', onGlobalRightPress, true)
    window.addEventListener('mousedown', onGlobalRightPress, true)
    window.addEventListener('contextmenu', onGlobalContextMenu, true)
    unbinders.push(() => {
      window.removeEventListener('pointerdown', onGlobalRightPress, true)
      window.removeEventListener('mousedown', onGlobalRightPress, true)
      window.removeEventListener('contextmenu', onGlobalContextMenu, true)
    })
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
