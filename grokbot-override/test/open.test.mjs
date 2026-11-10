// Milestone 2: open a bot's canonical Bot Chat and load its history.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatController } from '../src/core/session.js'
import { BOT, gateway } from './harness.mjs'

test('open resolves the registry, reads the tail by REST, then attaches without creating', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps)
  await chat.open()

  const state = chat.get()
  assert.equal(state.phase, 'ready')
  assert.equal(state.canonical.id, 'root')
  assert.equal(state.storedId, 'tip', 'the lineage tip is what opens')
  assert.equal(state.runtimeId, 'rt-1')
  assert.deepEqual(state.chat.items.map(i => [i.kind, i.text]), [['user', 'hi'], ['assistant', 'hello']])

  assert.deepEqual(gw.methods(), ['session.list', 'REST', 'session.resume'])
  const rest = gw.calls[1].params
  assert.deepEqual(rest, { sessionId: 'tip', limit: 120, offset: 0 })
  const resume = gw.calls[2].params
  assert.deepEqual(resume, { session_id: 'tip', profile: 'scholar', omit_messages: true, source: 'desktop' })
  assert.ok(!gw.methods().includes('session.create'))
})

test('attachOnOpen:false is a pure read (registry + REST only)', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps, { attachOnOpen: false })
  await chat.open()
  assert.equal(chat.get().phase, 'ready')
  assert.deepEqual(gw.methods(), ['session.list', 'REST'])
})

test('a bot that never had a Bot Chat ends in no-chat; nothing is created', async () => {
  const gw = gateway({ 'session.list': () => ({ sessions: [{ id: 'side', title: 'Side chat' }] }) })
  const chat = createChatController({ ...BOT, canonical_session: null }, gw.deps)
  await chat.open()
  assert.equal(chat.get().phase, 'no-chat')
  assert.deepEqual(gw.methods(), ['session.list'])
})

test('a registry failure is an error to retry, never no-chat', async () => {
  const gw = gateway({
    'session.list': () => {
      throw new Error('socket closed')
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.get().phase, 'error')
  assert.match(chat.get().error, /Could not check scholar's Bot Chat registry/)
})

test('when REST is unavailable the resume snapshot supplies the history', async () => {
  const gw = gateway({
    REST: () => {
      throw new Error('no transcript reader')
    },
    'session.resume': params => ({
      session_id: 'rt-9',
      messages: params.omit_messages ? [] : [{ role: 'user', text: 'yo' }, { role: 'assistant', text: 'sup' }]
    })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.get().phase, 'ready')
  assert.equal(gw.calls.find(c => c.method === 'session.resume').params.omit_messages, false)
  assert.deepEqual(chat.get().chat.items.map(i => i.text), ['yo', 'sup'])
})

test('a running turn and a pending approval on the snapshot are restored', async () => {
  const gw = gateway({
    'session.resume': () => ({
      session_id: 'rt-2',
      running: true,
      inflight: { streaming: true, assistant: 'Half an ans' },
      pending_approval: { command: 'rm -rf ./build', description: 'Clean the build directory', request_id: 'req-approval-1', choices: ['once', 'session', 'deny'] }
    })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const { chat: c } = chat.get()
  assert.equal(c.busy, true)
  const kinds = c.items.map(i => i.kind)
  assert.deepEqual(kinds, ['user', 'assistant', 'assistant', 'approval'])
  assert.equal(c.items[2].text, 'Half an ans')
  assert.equal(c.items[3].requestId, 'req-approval-1')
})

test('Show earlier pages backwards with offset and prepends', async () => {
  let page = 0
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: `${page}-${i}`, role: i % 2 ? 'assistant' : 'user', content: `m${page}-${i}` }))
  const gw = gateway({
    REST: params => {
      page = params.offset ? 2 : 1
      return { messages: rows(page === 1 ? 120 : 5) }
    }
  })
  const chat = createChatController(BOT, gw.deps, { attachOnOpen: false })
  await chat.open()
  assert.equal(chat.get().hasMore, true)
  await chat.loadEarlier()
  const restCalls = gw.calls.filter(c => c.method === 'REST')
  assert.equal(restCalls[1].params.offset, 120)
  assert.equal(chat.get().hasMore, false)
  assert.equal(chat.get().chat.items.length, 125)
  assert.equal(chat.get().chat.items[0].text, 'm2-0')
})

test('idle refresh re-reads the tail and keeps pending approval cards', async () => {
  let n = 0
  const gw = gateway({ REST: () => ({ messages: [{ id: 1, role: 'user', content: `v${(n += 1)}` }] }) })
  const chat = createChatController(BOT, gw.deps, { attachOnOpen: false })
  await chat.open()
  assert.equal(chat.get().chat.items[0].text, 'v1')
  await gw.runTimers()
  assert.equal(chat.get().chat.items[0].text, 'v2')
})

test('dispose unsubscribes from the event tap', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps)
  assert.equal(gw.listenerCount(), 1)
  chat.dispose()
  assert.equal(gw.listenerCount(), 0)
})
