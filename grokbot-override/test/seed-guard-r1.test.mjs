// Review tighter-b r1 #1, #2, #4: a seeded chat (T9) is only a picture until
// open() has checked the registry and read the history. Nothing is attached,
// sent or written before that; a replaced Bot Chat gets the writes, never the
// remembered one; a send cannot be overtaken by the first history read; and
// the remembered earlier pages survive the background read.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatController, HISTORY_PAGE } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(res => (resolve = res))
  return { promise, resolve }
}
const row = (id, role, content) => ({ id, role, content, timestamp: 1762560000 + id })
const SEED_ROWS = [row(1, 'user', 'hi'), row(2, 'assistant', 'hello')]
const seed = (rows = SEED_ROWS, extra = {}) => ({ storedId: 'tip', canonical: { id: 'root', resolved_id: 'tip' }, rows, hasMore: false, ...extra })

test('r1 #1 a send before the registry answers waits, and lands on the replacement Bot Chat', async () => {
  const registry = deferred()
  const gw = gateway({
    'session.list': () => registry.promise,
    'session.resume': params => ({ session_id: `rt-${params.session_id}`, running: false, messages: [] }),
    REST: params => ({ session_id: params.sessionId, messages: SEED_ROWS })
  })
  const chat = createChatController(BOT, gw.deps, { seed: seed() })
  assert.equal(chat.get().phase, 'ready', 'the remembered transcript paints at once')
  const opening = chat.open()
  const sending = chat.sendDraft('new prompt')
  await flush()
  await flush()
  assert.deepEqual(
    gw.calls.filter(c => c.method !== 'session.list').map(c => c.method),
    [],
    'no attach, read or submit before the registry answered'
  )

  registry.resolve({ sessions: [{ id: 'replacement', title: 'Bot Chat', message_count: 2 }] })
  await opening
  await sending
  const state = chat.get()
  assert.equal(state.storedId, 'replacement')
  assert.equal(state.runtimeId, 'rt-replacement')
  const resumes = gw.calls.filter(c => c.method === 'session.resume').map(c => c.params.session_id)
  assert.deepEqual([...new Set(resumes)], ['replacement'], 'only the validated chat is attached')
  const submits = gw.calls.filter(c => c.method === 'prompt.submit')
  assert.equal(submits.length, 1)
  assert.equal(submits[0].params.session_id, 'rt-replacement', 'the send went to the validated runtime')
  assert.ok(!gw.calls.some(c => c.method === 'REST' && c.params.sessionId === 'tip'), 'the obsolete chat was never read')
})

test('r1 #2 a send and a streaming reply are never overtaken by the first history read', async () => {
  const history = deferred()
  let reads = 0
  const gw = gateway({
    REST: () => (++reads === 1 ? history.promise : { session_id: 'tip', messages: SEED_ROWS })
  })
  const chat = createChatController(BOT, gw.deps, { seed: seed() })
  const opening = chat.open()
  const sending = chat.sendDraft('new prompt')
  await flush()
  await flush()
  assert.ok(!gw.calls.some(c => c.method === 'prompt.submit'), 'held until the history read is in')

  history.resolve({ session_id: 'tip', messages: SEED_ROWS })
  await opening
  await sending
  assert.ok(gw.calls.some(c => c.method === 'prompt.submit'), 'then sent')
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: 'new streaming reply' } })
  await flush()
  const state = chat.get()
  assert.equal(state.chat.busy, true, 'the turn is still running')
  const texts = state.chat.items.map(i => i.text)
  assert.ok(texts.includes('new prompt'), 'the sent bubble stays')
  assert.ok(texts.some(t => String(t || '').includes('new streaming reply')), 'the streaming reply stays')
})

test('r1 #4 the background read keeps the remembered earlier pages', async () => {
  const rows = Array.from({ length: 2 * HISTORY_PAGE }, (_, i) => row(i + 1, i % 2 ? 'assistant' : 'user', `m${i + 1}`))
  const latest = rows.slice(HISTORY_PAGE)
  const gw = gateway({ REST: () => ({ session_id: 'tip', messages: latest }) })
  const chat = createChatController(BOT, gw.deps, { seed: seed(rows, { hasMore: true }) })
  assert.equal(chat.get().rows.length, 2 * HISTORY_PAGE)
  await chat.open()
  const state = chat.get()
  assert.equal(state.rows.length, 2 * HISTORY_PAGE, 'earlier pages kept')
  assert.equal(state.loadedCount, 2 * HISTORY_PAGE)
  assert.equal(state.hasMore, true, 'pagination state kept')
  assert.equal(state.chat.items.filter(i => i.text === 'm1').length, 1, 'the oldest message still shows, once')
})

test('r1 #1 a seeded chat that is disposed before open() never hangs its waiting actions', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps, { seed: seed() })
  const refreshing = chat.refresh()
  chat.dispose()
  await refreshing
  assert.ok(!gw.calls.some(c => c.method === 'session.resume'))
})
