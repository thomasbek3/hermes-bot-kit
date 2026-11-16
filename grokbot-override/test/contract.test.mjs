// T10: the private-internals contract (core/contract.js): every entry has a
// probe, required misses fail, optional ones are 'absent', events are
// informational, and the notice names what is missing.

import assert from 'node:assert/strict'
import test from 'node:test'

import { BOT_MODE_STORAGE_KEYS, CONTRACT, contractNotice, createEventLog, probeContract } from '../src/core/contract.js'
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
