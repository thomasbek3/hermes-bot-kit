// The roster's own sections (src/core/sections.js): the one-time copy of a
// Bot Sections layout, and each action on the stored state. The loader-level
// flows (menus, inline name field, confirm) are in loader-sections.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSections, ownSectionOf, rowKey } from '../src/core/roster.js'
import {
  addSection,
  assignBot,
  deleteSection,
  emptySections,
  loadSections,
  migrateLegacy,
  moveSection,
  renameSection,
  sectionIdFor,
  sectionsFrom,
  toggleSectionCollapsed
} from '../src/core/sections.js'

const legacyReader = data => (key, fallback) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback)

const LEGACY = {
  enabled: true,
  customSections: ['work', 'play', 'Unassigned', 'work', '', 7],
  sectionNames: { work: '💼 Work', play: '  ' },
  collapsedSections: ['play'],
  sectionOverrides: { Security: 'work', scholar: 'play', scout: 'Unassigned', nobody: 'gone', '': 'work' }
}

test('migration copies sections, names (emoji is just text), order, collapsed state and assignments', () => {
  const reads = []
  const read = (key, fallback) => {
    reads.push(key)
    return legacyReader(LEGACY)(key, fallback)
  }
  const { state, write } = loadSections({ stored: undefined, readLegacy: read, collapsedHere: [] })
  assert.equal(write, true, 'a first run stores the result once')
  assert.deepEqual(state, {
    version: 1,
    sections: [
      { id: 'work', name: '💼 Work', collapsed: false },
      { id: 'play', name: 'play', collapsed: true }
    ],
    // Keys lowercased like Bot Sections matched them; 'Unassigned' and
    // unknown targets mean the default grouping, so they are not copied.
    assign: { security: 'work', scholar: 'play' }
  })
  assert.deepEqual([...new Set(reads)].sort(), ['collapsedSections', 'customSections', 'sectionNames', 'sectionOverrides'], 'only reads')
})

test('migration also keeps the override\'s own collapsed list (it showed Bot Sections ids as names)', () => {
  const state = migrateLegacy(legacyReader({ customSections: ['work'] }), ['work'])
  assert.deepEqual(state.sections, [{ id: 'work', name: 'work', collapsed: true }])
})

test('already migrated: a valid stored state is used as is and nothing is copied or written', () => {
  const stored = { version: 1, sections: [{ id: 's-1', name: 'Mine', collapsed: false }], assign: { 'local::security': 's-1' } }
  let read = 0
  const { state, write } = loadSections({ stored, readLegacy: () => (read++, LEGACY.customSections) })
  assert.equal(write, false)
  assert.equal(read, 0, 'the old layout is not read again')
  assert.deepEqual(state, stored)
  // Deleting every section is still a valid state: no re-import.
  assert.equal(loadSections({ stored: emptySections(), readLegacy: legacyReader(LEGACY) }).write, false)
})

test('missing old data: an empty state, written once so the copy never runs again', () => {
  const { state, write } = loadSections({ stored: undefined, readLegacy: legacyReader({}) })
  assert.equal(write, true)
  assert.deepEqual(state, emptySections())
})

test('malformed old data is skipped, never fatal', () => {
  for (const data of [
    { customSections: 'work', sectionNames: 'x', collapsedSections: { a: 1 }, sectionOverrides: ['work'] },
    { customSections: [null, {}, ['a']], sectionNames: null, sectionOverrides: null },
    { customSections: ['ok'], sectionNames: { ok: 42 }, sectionOverrides: { bot: 42, other: { id: 'ok' } } }
  ]) {
    const state = migrateLegacy(legacyReader(data))
    assert.ok(Array.isArray(state.sections) && state.assign && typeof state.assign === 'object')
    for (const section of state.sections) assert.equal(typeof section.name, 'string')
  }
  assert.deepEqual(migrateLegacy(legacyReader({ customSections: ['ok'], sectionNames: { ok: 42 } })).sections, [{ id: 'ok', name: 'ok', collapsed: false }])
  const throwing = () => {
    throw new Error('storage gone')
  }
  assert.deepEqual(migrateLegacy(throwing), emptySections())
})

test('a malformed stored value is not a state: the copy runs instead', () => {
  for (const stored of [null, 'x', 3, [], { sections: [] }, { version: 2, sections: [] }]) {
    assert.equal(sectionsFrom(stored), null)
    assert.equal(loadSections({ stored, readLegacy: legacyReader(LEGACY) }).write, true)
  }
  // A valid version with junk inside is cleaned, not replaced.
  const cleaned = sectionsFrom({ version: 1, sections: [{ id: 'a' }, { id: 'a', name: 'dup' }, { name: 'no id' }, 'x'], assign: { b: 'a', c: 'gone', d: '', e: 5 } })
  assert.deepEqual(cleaned, { version: 1, sections: [{ id: 'a', name: 'a', collapsed: false }], assign: { b: 'a', d: '' } })
})

test('new, rename, move up / down, collapse and delete', () => {
  let state = emptySections()
  ;({ state } = addSection(state, '  🏠 Home  ', 'h'))
  ;({ state } = addSection(state, 'Money', 'm'))
  assert.deepEqual(state.sections.map(s => [s.id, s.name]), [['h', '🏠 Home'], ['m', 'Money']])
  assert.equal(addSection(state, '   ').state, state, 'an empty name adds nothing')

  assert.equal(renameSection(state, 'm', 'Cash').sections[1].name, 'Cash')
  assert.equal(renameSection(state, 'm', ' '), state, 'an empty rename changes nothing')
  assert.equal(renameSection(state, 'zz', 'x'), state)

  const up = moveSection(state, 'm', -1)
  assert.deepEqual(up.sections.map(s => s.id), ['m', 'h'])
  assert.deepEqual(moveSection(up, 'm', 1).sections.map(s => s.id), ['h', 'm'])
  assert.equal(moveSection(state, 'h', -1), state, 'the first cannot move up')
  assert.equal(moveSection(state, 'm', 1), state, 'the last cannot move down')

  const folded = toggleSectionCollapsed(state, 'h')
  assert.equal(folded.sections[0].collapsed, true)
  assert.equal(toggleSectionCollapsed(folded, 'h').sections[0].collapsed, false)

  state = assignBot(state, 'local::a', 'm')
  state = assignBot(state, 'local::b', 'h')
  state = { ...state, assign: { ...state.assign, legacy: 'm' } }
  const gone = deleteSection(state, 'm')
  assert.deepEqual(gone.sections.map(s => s.id), ['h'])
  assert.deepEqual(gone.assign, { 'local::b': 'h' }, 'its bots fall back to their default section')
})

test('move a bot: its exact key wins over a copied name key; Default is an explicit empty target', () => {
  let state = { version: 1, sections: [{ id: 'w', name: 'Work', collapsed: false }, { id: 'p', name: 'Play', collapsed: false }], assign: { security: 'w' } }
  assert.equal(sectionIdFor(state, 'local::security', ['security']), 'w', 'name keys from a Bot Sections layout')
  state = assignBot(state, 'local::security', 'p')
  assert.equal(sectionIdFor(state, 'local::security', ['security']), 'p')
  state = assignBot(state, 'local::security', '')
  assert.equal(sectionIdFor(state, 'local::security', ['security']), '', 'Default beats the copied name key')
  assert.equal(assignBot(state, 'local::x', 'nope').assign['local::x'], '', 'an unknown section is Default')
  assert.equal(assignBot(state, 'local::security', ''), state, 'no change, same state')
})

test('the roster lists own sections first (empty ones only with keepEmpty), hidden bots stay out', () => {
  const rows = [
    { name: 'security', connectionId: 'local', route: { connectionId: 'local', mode: 'local', profile: 'security', targetProfile: 'security' } },
    { name: 'quiet', connectionId: 'local', route: { connectionId: 'local', mode: 'local', profile: 'quiet', targetProfile: 'quiet' } },
    { name: 'scholar', remoteSource: true, connectionKind: 'ssh', connectionLabel: 'HOME', connectionId: 'home', route: { connectionId: 'home', mode: 'remote', profile: 'scholar', targetProfile: 'scholar' } }
  ]
  const meta = { quiet: { hidden: true } }
  const metaFor = bot => meta[bot.name] || {}
  const state = {
    version: 1,
    sections: [
      { id: 'e', name: 'Empty', collapsed: false },
      { id: 'w', name: 'Work', collapsed: true }
    ],
    assign: { [rowKey(rows[0])]: 'w', [rowKey(rows[1])]: 'w' }
  }
  assert.equal(ownSectionOf(rows[0], state, metaFor), 'w')
  const listed = buildSections(rows, { metaFor, sections: state })
  assert.deepEqual(listed.map(s => [s.name, s.bots.map(b => b.name), Boolean(s.own)]), [['Work', ['security'], true], ['HOME', ['scholar'], false]])
  assert.equal(listed[0].collapsed, true)
  const all = buildSections(rows, { metaFor, sections: state, keepEmpty: true })
  assert.deepEqual(all.map(s => s.name), ['Empty', 'Work', 'HOME'])
})
