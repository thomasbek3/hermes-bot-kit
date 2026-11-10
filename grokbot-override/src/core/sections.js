// The roster's own sections: named groups the user makes, renames, orders,
// collapses and moves bots into. Display only: kept in the override's own
// plugin storage (key `sections`), never in Bot Mode's metadata or on a
// gateway.
//
//   { version: 1, sections: [{ id, name, collapsed }], assign: { botKey: id } }
//
// `assign` keys are a bot's exact roster key (roster.js rowKey) for moves
// made here, or a lowercased bot name / display name / handle for layouts
// copied from the retired Bot Sections plugin (which keyed bots that way). A
// row's exact key wins over its name keys; an exact key set to '' means
// "Default": the bot goes back to the grouping it has without a section of
// its own (Bot Mode's section name, else its connection).
//
// Migration: on the first run without a valid `sections` value, the Bot
// Sections layout (its plugin storage `customSections`, `sectionNames`,
// `collapsedSections`, `sectionOverrides`) is copied in once. The old keys are
// only read, never written or removed, so going back to Bot Sections still
// finds the layout it had. Once `sections` holds a valid value nothing is
// copied again.

export const SECTIONS_KEY = 'sections'
export const LEGACY_SECTIONS_PLUGIN = 'bot-sections'
export const SECTIONS_VERSION = 1

// Bot Sections' catch-all bucket; it is the "Default" grouping here.
const LEGACY_UNASSIGNED = 'Unassigned'

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = value => (typeof value === 'string' ? value.trim() : '')

export function emptySections() {
  return { version: SECTIONS_VERSION, sections: [], assign: {} }
}

/** A stored value read back and cleaned, or null when it is not a sections
 *  state at all (missing, another shape): then the migration runs. */
export function sectionsFrom(value) {
  if (!isPlainObject(value) || value.version !== SECTIONS_VERSION) return null
  const sections = []
  const ids = new Set()
  for (const entry of Array.isArray(value.sections) ? value.sections : []) {
    const id = text(entry?.id)
    if (!id || ids.has(id)) continue
    ids.add(id)
    sections.push({ id, name: text(entry?.name) || id, collapsed: entry?.collapsed === true })
  }
  const assign = {}
  if (isPlainObject(value.assign)) {
    for (const [key, target] of Object.entries(value.assign)) {
      if (!key || typeof target !== 'string') continue
      if (target === '' || ids.has(target)) assign[key] = target
    }
  }
  return { version: SECTIONS_VERSION, sections, assign }
}

/** The Bot Sections layout as a sections state. `read(key, fallback)` reads
 *  that plugin's storage; `collapsedHere` is the override's own collapsed
 *  list from before (it showed Bot Sections' ids as section names). Anything
 *  malformed is skipped, never fatal. */
export function migrateLegacy(read, collapsedHere = []) {
  const safe = (key, fallback) => {
    try {
      const value = read(key, fallback)
      return value === undefined || value === null ? fallback : value
    } catch {
      return fallback
    }
  }
  const custom = safe('customSections', [])
  const names = safe('sectionNames', {})
  const collapsed = safe('collapsedSections', [])
  const overrides = safe('sectionOverrides', {})
  const folded = new Set([
    ...(Array.isArray(collapsed) ? collapsed : []),
    ...(Array.isArray(collapsedHere) ? collapsedHere : [])
  ].map(text))
  const state = emptySections()
  const ids = new Set()
  for (const raw of Array.isArray(custom) ? custom : []) {
    const id = text(raw)
    if (!id || id === LEGACY_UNASSIGNED || ids.has(id)) continue
    ids.add(id)
    const label = isPlainObject(names) ? text(names[id]) : ''
    state.sections.push({ id, name: label || id, collapsed: folded.has(id) })
  }
  if (isPlainObject(overrides)) {
    for (const [rawKey, rawTarget] of Object.entries(overrides)) {
      const key = text(rawKey).toLowerCase()
      const target = text(rawTarget)
      if (key && ids.has(target)) state.assign[key] = target
    }
  }
  return state
}

/** The state to use on start, and whether it must be written (a first run:
 *  the migration result is stored once, even when there was nothing to copy,
 *  so it never runs again). */
export function loadSections({ stored, readLegacy, collapsedHere }) {
  const current = sectionsFrom(stored)
  if (current) return { state: current, write: false }
  return { state: migrateLegacy(readLegacy, collapsedHere), write: true }
}

let idCounter = 0
/** A new section id, unique in `state`. */
export function newSectionId(state, now = Date.now()) {
  const taken = new Set((state?.sections || []).map(section => section.id))
  for (;;) {
    idCounter += 1
    const id = `s-${now.toString(36)}-${idCounter.toString(36)}`
    if (!taken.has(id)) return id
  }
}

/** New section at the end. An empty name changes nothing (id: ''). */
export function addSection(state, name, id = newSectionId(state)) {
  const label = text(name)
  if (!label) return { state, id: '' }
  return { state: { ...state, sections: [...state.sections, { id, name: label, collapsed: false }] }, id }
}

/** Rename; an empty or unchanged name changes nothing. */
export function renameSection(state, id, name) {
  const label = text(name)
  const section = state.sections.find(entry => entry.id === id)
  if (!label || !section || section.name === label) return state
  return { ...state, sections: state.sections.map(entry => (entry.id === id ? { ...entry, name: label } : entry)) }
}

/** Delete a section; its bots go back to their default grouping. */
export function deleteSection(state, id) {
  if (!state.sections.some(entry => entry.id === id)) return state
  const assign = {}
  for (const [key, target] of Object.entries(state.assign)) if (target !== id) assign[key] = target
  return { ...state, sections: state.sections.filter(entry => entry.id !== id), assign }
}

/** Move a section one place up (-1) or down (+1); at an end, nothing. */
export function moveSection(state, id, delta) {
  const from = state.sections.findIndex(entry => entry.id === id)
  const to = from + (delta < 0 ? -1 : 1)
  if (from < 0 || to < 0 || to >= state.sections.length) return state
  const sections = [...state.sections]
  ;[sections[from], sections[to]] = [sections[to], sections[from]]
  return { ...state, sections }
}

export function toggleSectionCollapsed(state, id) {
  if (!state.sections.some(entry => entry.id === id)) return state
  return { ...state, sections: state.sections.map(entry => (entry.id === id ? { ...entry, collapsed: !entry.collapsed } : entry)) }
}

/** Put the bot with exact key `key` in section `id` ('' = Default). */
export function assignBot(state, key, id) {
  if (!key) return state
  const target = id && state.sections.some(entry => entry.id === id) ? id : ''
  if (own(state.assign, key) && state.assign[key] === target) return state
  return { ...state, assign: { ...state.assign, [key]: target } }
}

/** The section id a bot is in ('' = Default): its exact key first, then
 *  the name keys a copied Bot Sections layout uses. */
export function sectionIdFor(state, exactKey, nameKeys = []) {
  if (!state || !state.sections.length) return ''
  const known = id => (id && state.sections.some(entry => entry.id === id) ? id : '')
  if (exactKey && own(state.assign, exactKey)) return known(state.assign[exactKey])
  for (const raw of nameKeys) {
    const key = text(raw).toLowerCase()
    if (key && own(state.assign, key)) return known(state.assign[key])
  }
  return ''
}
