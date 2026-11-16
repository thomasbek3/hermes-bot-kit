// Review tighter-b r2 #1, #2: a remembered transcript (T9) is trusted only
// after the newest open() confirmed and loaded its Bot Chat. A failed or
// empty registry check, or an open overtaken by another, never lets a write
// through to the remembered chat; and a send made while it is checked is
// refused at once (never parked behind the check), so a bot switch or a
// closed tab cannot swallow it: the composer gets it back.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const SEED_ROWS = [
  { id: 1, role: 'user', content: 'hi', timestamp: 1762560001 },
  { id: 2, role: 'assistant', content: 'hello', timestamp: 1762560002 }
]
const seed = () => ({ storedId: 'tip', canonical: { id: 'root', resolved_id: 'tip' }, rows: SEED_ROWS, hasMore: false })
const WRITES = ['session.resume', 'prompt.submit', 'image.attach_bytes', 'file.attach', 'session.rewind', 'message.react', 'slash.exec']
const writes = gw => gw.calls.filter(c => WRITES.includes(c.method) || c.method === 'REST')

for (const [label, answer] of [
  ['a rejected registry', registry => registry.reject(new Error('registry offline'))],
  ['an empty registry for a chat known before', registry => registry.resolve({ sessions: [] })]
]) {
  test(`r2 #1 ${label}: the send made while checking is not sent, and nothing reaches the remembered chat after`, async () => {
    const registry = deferred()
    const gw = gateway({ 'session.list': () => registry.promise })
    const chat = createChatController(BOT, gw.deps, { seed: seed() })
    const opening = chat.open()
    const sending = chat.sendDraft('must validate before sending')
    answer(registry)
    await opening
    const result = await sending
    assert.equal(result.ok, false)
    assert.equal(result.delivery, 'not-sent', 'a definite not-sent: the composer restores the draft')
    const state = chat.get()
    assert.equal(state.phase, 'error')
    assert.equal(state.storedId, '', 'the remembered stored id is forgotten')
    assert.equal(state.checking, false)
    // Even a later direct call cannot address the remembered chat.
    const later = await chat.sendDraft('still not')
    assert.equal(later.ok, false)
    await flush()
    assert.deepEqual(writes(gw), [], 'no resume, read or submit at all')
  })
}

test('r2 #1 overlapping opens: only the newest, confirmed open lets writes through', async () => {
  const first = deferred()
  const second = deferred()
  let lists = 0
  const gw = gateway({
    'session.list': () => (++lists === 1 ? first.promise : second.promise),
    'session.resume': params => ({ session_id: `rt-${params.session_id}`, running: false, messages: [] }),
    REST: params => ({ session_id: params.sessionId, messages: SEED_ROWS })
  })
  const chat = createChatController(BOT, gw.deps, { seed: seed() })
  const a = chat.open()
  const b = chat.open()
  assert.equal((await chat.sendDraft('early')).ok, false)
  first.resolve({ sessions: [{ id: 'root', resolved_id: 'tip', title: 'Bot Chat' }] })
  await a
  assert.equal(chat.get().checking, true, 'a superseded open does not end the check')
  assert.equal((await chat.sendDraft('still early')).ok, false)
  assert.deepEqual(writes(gw), [], 'nothing written while the newest open is out')

  second.resolve({ sessions: [{ id: 'replacement', title: 'Bot Chat' }] })
  await b
  assert.equal(chat.get().checking, false)
  assert.ok((await chat.sendDraft('now')).ok)
  const state = chat.get()
  assert.equal(state.storedId, 'replacement')
  assert.equal(state.runtimeId, 'rt-replacement')
  assert.deepEqual([...new Set(gw.calls.filter(c => c.method === 'session.resume').map(c => c.params.session_id))], ['replacement'])
  assert.deepEqual(gw.calls.filter(c => c.method === 'prompt.submit').map(c => c.params.session_id), ['rt-replacement'])
})

test('r2 #1 a failed check can be retried: the next open confirms and then sends', async () => {
  let fail = true
  const gw = gateway({
    'session.list': () => {
      if (fail) throw new Error('registry offline')
      return { sessions: [{ id: 'root', resolved_id: 'tip', title: 'Bot Chat' }] }
    }
  })
  const chat = createChatController(BOT, gw.deps, { seed: seed() })
  await chat.open()
  assert.equal(chat.get().phase, 'error')
  fail = false
  await chat.open()
  assert.equal(chat.get().phase, 'ready')
  assert.equal(chat.get().storedId, 'tip')
  assert.ok((await chat.sendDraft('after retry')).ok)
})

test('r2 #2 a send while checking is answered at once, so a switch right after cannot lose it', async () => {
  const registry = deferred()
  const gw = gateway({ 'session.list': () => registry.promise })
  const chat = createChatController(BOT, gw.deps, { seed: seed() })
  void chat.open()
  let settled = null
  chat.sendDraft('typed then switched').then(result => (settled = result))
  await flush()
  assert.ok(settled, 'the send is answered before the check ends (nothing parked)')
  assert.equal(settled.delivery, 'not-sent')
  // The user switches bots: the chat retires (idle) and is disposed.
  assert.equal(chat.retire(), false)
  registry.resolve({ sessions: [{ id: 'root', resolved_id: 'tip', title: 'Bot Chat' }] })
  await flush()
  await flush()
  assert.deepEqual(writes(gw), [], 'nothing runs late on the closed chat')
})
