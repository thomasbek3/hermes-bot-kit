// PARITY C3: creating a Bot Chat follows stock createCanonicalChat
// (apps/desktop/src/plugins/hermes-bots/canonical-chat.ts:413-605) call for
// call: registry first, session.create hidden + follow_profile_config, eager
// session.title, adopt the winner on a title conflict, kickoff only for a new
// agent. Tests drive the shapes stock's own tests use
// (canonical-chat-creation.test.ts, canonical-chat-adopt-on-conflict.test.ts).

import assert from 'node:assert/strict'
import test from 'node:test'

import { createCanonicalChat, KICKOFF_TEXT } from '../src/core/create-chat.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway, pooledGateway } from './harness.mjs'

const NO_CHAT_BOT = { ...BOT, canonical_session: undefined }
const empty = () => ({ sessions: [] })
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const noWait = () => Promise.resolve()

test('C3 an existing Bot Chat is adopted, never re-created', async () => {
  const gw = gateway()
  const result = await createCanonicalChat(gw.deps.requestForBot, BOT, { wait: noWait })
  assert.equal(result.adopted, true)
  assert.deepEqual(gw.methods(), ['session.list'])
})

test('C3 a failed registry lookup never mints (fail closed)', async () => {
  const gw = gateway({
    'session.list': () => {
      throw new Error('backend restarting')
    }
  })
  await assert.rejects(createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait }), /registry/)
  assert.ok(!gw.methods().includes('session.create'))
})

test('C3 create: hidden, follows profile config, eager title, no kickoff on the click path', async () => {
  const gw = gateway({
    'session.list': empty,
    'session.create': () => ({ session_id: 'rt-new', stored_session_id: 'st-new' }),
    'session.title': () => ({ title: 'Bot Chat' })
  })
  const result = await createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait })
  assert.equal(result.created, true)
  assert.equal(result.row.id, 'st-new')
  const create = gw.calls.find(c => c.method === 'session.create')
  assert.deepEqual(create.params, { profile: 'scholar', title: 'Bot Chat', hidden: true, follow_profile_config: true })
  assert.deepEqual(create.options, { spawnPriority: 'foreground' })
  assert.deepEqual(gw.calls.find(c => c.method === 'session.title').params, { session_id: 'rt-new', title: 'Bot Chat' })
  assert.ok(!gw.methods().includes('prompt.submit'), 'no intro turn on an ordinary open')
})

test('C3 adopt-on-conflict: another writer took the title; its chat is used, ours is abandoned', async () => {
  let listed = 0
  const gw = gateway({
    'session.list': () => (listed++ === 0 ? { sessions: [] } : { sessions: [{ id: 'winner', title: 'Bot Chat' }] }),
    'session.create': () => ({ session_id: 'rt-stray', stored_session_id: 'st-stray' }),
    'session.title': () => {
      throw new Error('Title "Bot Chat" is already in use by session winner')
    }
  })
  const result = await createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait })
  assert.equal(result.adopted, true)
  assert.equal(result.row.id, 'winner')
  assert.ok(!gw.methods().includes('prompt.submit'), 'never prompts into the stray session')
})

test('C3 an older gateway without the eager title gets the compat kickoff; a new agent gets its intro', async () => {
  for (const [kickoff, titleFails] of [[false, true], [true, false]]) {
    const gw = gateway({
      'session.list': empty,
      'session.create': () => ({ session_id: 'rt', stored_session_id: 'st' }),
      'session.title': () => {
        if (titleFails) throw Object.assign(new Error('unknown method'), { code: -32601 })
        return {}
      }
    })
    await createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait, kickoff })
    const submit = gw.calls.find(c => c.method === 'prompt.submit')
    assert.deepEqual(submit.params, { session_id: 'rt', text: KICKOFF_TEXT })
  }
})

test('C3 a double click joins the creation in flight: one session.create', async () => {
  let release
  const gate = new Promise(resolve => (release = resolve))
  const gw = gateway({
    'session.list': empty,
    'session.create': async () => (await gate, { session_id: 'rt', stored_session_id: 'st' }),
    'session.title': () => ({})
  })
  const a = createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait })
  const b = createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait })
  release()
  assert.equal(await a, await b)
  assert.equal(gw.calls.filter(c => c.method === 'session.create').length, 1)
})

test('C3 controller: a roster click on a bot without a chat creates it under a route lease, then opens it', async () => {
  const gw = pooledGateway({
    handlers: {
      'session.list': empty,
      'session.create': () => ({ session_id: 'rt-new', stored_session_id: 'st-new' }),
      'session.title': () => ({}),
      REST: () => ({ messages: [] })
    }
  })
  const chat = createChatController(NO_CHAT_BOT, gw.deps, { createIfMissing: true })
  await chat.open()
  await settle()
  assert.equal(chat.get().phase, 'ready')
  assert.equal(chat.get().storedId, 'st-new')
  const order = gw.order
  assert.ok(order.indexOf('retain') < order.indexOf('session.create'), 'the lease is held before session.create')
  assert.ok(chat.get().runtimeId, 'attached')
  chat.dispose()
})

test('C3 controller: without a user click, a missing chat is "no-chat"; Start Bot Chat creates it', async () => {
  const gw = gateway({
    'session.list': empty,
    'session.create': () => ({ session_id: 'rt-new', stored_session_id: 'st-new' }),
    'session.title': () => ({}),
    REST: () => ({ messages: [] })
  })
  const chat = createChatController(NO_CHAT_BOT, gw.deps)
  await chat.open()
  assert.equal(chat.get().phase, 'no-chat')
  assert.ok(!gw.methods().includes('session.create'))
  await chat.create()
  assert.equal(chat.get().phase, 'ready')
  assert.equal(gw.calls.filter(c => c.method === 'session.create').length, 1)
  chat.dispose()
})
