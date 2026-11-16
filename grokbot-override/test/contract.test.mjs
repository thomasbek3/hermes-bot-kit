// T10: the private-internals contract (core/contract.js): every entry has a
// probe, required misses fail, optional ones are 'absent', events are
// informational, and the notice names what is missing.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { BOT_MODE_STORAGE_KEYS, CONTRACT, CONTRACT_EVENT_PREFIXES, CONTRACT_EVENTS, contractNotice, createEventLog, probeContract } from '../src/core/contract.js'
import { CHROME_ANCHORS } from '../src/core/stock.js'

const doc = present => ({ querySelector: sel => (present.includes(sel) ? {} : null) })
const storage = keys => ({ getItem: k => (keys.includes(k) ? '{}' : null) })
const cache = hit => ({ getQueryCache: () => ({ findAll: ({ queryKey }) => (hit && queryKey.join('/') === 'hermes-bots/roster' ? [{}] : []) }) })
const fullDom = ['[data-tree-tab]', '[data-tree-group]', CHROME_ANCHORS.topHeader, CHROME_ANCHORS.titlebarCluster, CHROME_ANCHORS.statusbar, CHROME_ANCHORS.seam]

test('contract: ids are unique, every entry says where it is used, and every chrome anchor is listed', () => {
  const ids = CONTRACT.map(e => e.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const e of CONTRACT) assert.ok(e.used && e.target && typeof e.required === 'boolean', e.id)
  const targets = CONTRACT.map(e => e.target)
  for (const anchor of Object.values(CHROME_ANCHORS)) assert.ok(targets.includes(anchor), anchor)
  for (const key of Object.values(BOT_MODE_STORAGE_KEYS)) assert.ok(targets.includes(key), key)
  assert.ok(targets.includes('["hermes-bots","roster"]'))
})

test('contract probe: all present is ok; a missing required anchor or bridge fails; optional ones are absent', () => {
  const events = createEventLog()
  events.note('message.complete')
  events.note('not.in.the.contract')
  const ok = probeContract({ document: doc(fullDom), queryClient: cache(true), localStorage: storage([BOT_MODE_STORAGE_KEYS.botMeta]), bridge: { api() {}, readFileDataUrl() {} }, events })
  assert.equal(ok.ok, true, JSON.stringify(ok.missing))
  const status = (r, id) => r.entries.find(e => e.id === id).status
  assert.equal(status(ok, 'dom.sash-overlap'), 'ok')
  assert.equal(status(ok, 'storage.bot-meta'), 'ok')
  assert.equal(status(ok, 'storage.group-chats'), 'absent', 'optional data not written yet')
  assert.equal(status(ok, 'bridge.getMachineProfile'), 'absent')
  assert.equal(status(ok, 'event.message.complete'), 'seen')
  assert.equal(status(ok, 'event.approval.request'), 'unseen')
  assert.equal(contractNotice(ok), null, 'no notice when everything required is there')

  const broken = probeContract({ document: doc(fullDom.filter(s => s !== CHROME_ANCHORS.titlebarCluster && s !== CHROME_ANCHORS.statusbar)), queryClient: null, localStorage: storage([]), bridge: null, events })
  assert.equal(broken.ok, false)
  assert.deepEqual(broken.missing.sort(), ['bridge.api', 'dom.titlebar-cluster'])
  assert.equal(status(broken, 'dom.statusbar'), 'absent', 'a hidden status bar is not a failure')
  assert.equal(status(broken, 'query.bot-mode-roster'), 'absent', 'the roster falls back to its own read')
  const notice = contractNotice(broken)
  assert.equal(notice.kind, 'info')
  assert.match(notice.message, /bridge\.api/)
  assert.match(notice.message, /dom\.titlebar-cluster/)
})

test('contract probe: never throws; an unqueryable document is unprobed, not missing', () => {
  const throwing = { querySelector: () => { throw new Error('bad selector') } }
  const r = probeContract({ document: throwing, bridge: { api() {} } })
  assert.equal(r.entries.find(e => e.id === 'dom.tree-tab').status, 'missing')
  const none = probeContract({})
  assert.equal(none.entries.find(e => e.id === 'dom.tree-tab').status, 'unprobed')
  assert.equal(none.entries.find(e => e.id === 'event.message.start').status, 'unprobed')
})

// Review C-R1-05: the contract covers every event name and DOM attribute the
// source actually relies on. Scans the source, so a new dependency that is
// not added to the contract fails here.

const SRC = new URL('../src/', import.meta.url)
const sources = () =>
  ['core', 'ui'].flatMap(dir => readdirSync(new URL(`${dir}/`, SRC)).filter(f => /\.(js|ts|tsx)$/.test(f) && f !== 'contract.js').map(f => ({ file: `${dir}/${f}`, text: readFileSync(new URL(`${dir}/${f}`, SRC), 'utf8') })))

function eventInventory() {
  const exact = new Set()
  const prefixes = new Set()
  for (const { file, text } of sources()) {
    for (const m of text.matchAll(/(?<![.\w]|typeof )(?:event\?\.)?type\s*[!=]==\s*'([a-z_]+(?:\.[a-z_]+)*)'/g)) exact.add(m[1])
    for (const m of text.matchAll(/onDisplayEvent\('([^']+)'/g)) exact.add(m[1])
    for (const m of text.matchAll(/_EVENTS = new Set\(\[([^\]]+)\]/g)) for (const n of m[1].matchAll(/'([^']+)'/g)) exact.add(n[1])
    for (const m of text.matchAll(/(?<![.\w])type\.startsWith\('([^'/]+)'\)/g)) prefixes.add(m[1])
    if (file === 'core/reducer.js') for (const m of text.matchAll(/case '([a-z_]+(?:\.[a-z_]+)+)'/g)) exact.add(m[1])
  }
  return { exact, prefixes }
}

test('contract coverage: every gateway event name the source acts on is listed', () => {
  const { exact, prefixes } = eventInventory()
  for (const name of ['gateway.ready', 'session.replay_gap', 'display.lease', 'display.status', 'display.install.log', 'display.install.done', 'message.complete']) assert.ok(exact.has(name), `the scan finds ${name}`)
  const listed = new Set(CONTRACT_EVENTS)
  const missing = [...exact].filter(name => !listed.has(name))
  assert.deepEqual(missing, [], `events used but not in the contract: ${missing.join(', ')}`)
  for (const prefix of prefixes) {
    assert.ok(CONTRACT_EVENT_PREFIXES.includes(prefix) || CONTRACT_EVENTS.some(n => n.startsWith(prefix)), `event prefix ${prefix} is covered`)
  }
})

test('contract coverage: every Hermes DOM attribute stock.js and app.ts rely on has a probe', () => {
  const attrs = new Set()
  for (const file of ['core/stock.js', 'ui/app.ts']) {
    const text = readFileSync(new URL(file, SRC), 'utf8')
    for (const m of text.matchAll(/\[(data-[a-z-]+)/g)) attrs.add(m[1])
    for (const m of text.matchAll(/(?:get|has)Attribute\??\.?\(?'(data-[a-z-]+)'/g)) attrs.add(m[1])
  }
  for (const own of [...attrs]) if (own.startsWith('data-gbo-')) attrs.delete(own)
  assert.ok(attrs.has('data-panel-page-header'), 'the scan finds the page header attribute')
  const targets = CONTRACT.filter(e => e.kind === 'selector').map(e => e.target).join(' ')
  const missing = [...attrs].filter(attr => !targets.includes(attr))
  assert.deepEqual(missing, [], `DOM attributes without a probe: ${missing.join(', ')}`)
})

test('contract: the reconnect and display events are counted when they arrive; room frames by prefix', () => {
  const events = createEventLog()
  for (const type of ['gateway.ready', 'session.replay_gap', 'display.lease', 'display.status', 'display.install.log', 'display.install.done', 'room.message']) events.note(type)
  const r = probeContract({ events })
  for (const name of ['gateway.ready', 'session.replay_gap', 'display.lease', 'display.status', 'display.install.log', 'display.install.done']) {
    assert.equal(r.entries.find(e => e.id === `event.${name}`)?.status, 'seen', name)
  }
  assert.equal(r.entries.find(e => e.id === 'event.room.*').status, 'seen')
  assert.equal(r.entries.find(e => e.id === 'event.group*').status, 'unseen')
  assert.equal(r.entries.find(e => e.id === 'dom.panel-page-header').status, 'unprobed')
})
