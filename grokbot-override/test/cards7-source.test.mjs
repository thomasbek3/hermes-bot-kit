// Cards 7, part 1: our chats are desktop sessions. Stock Desktop sends
// `source: 'desktop'` on session.create (use-session-actions/
// session-create-request.ts) and session.resume (resume-owner.ts); without it
// the gateway builds the agent for the terminal UI (tui_gateway/
// agent_factory.py _resolve_session_source) and the bot is told markdown,
// MEDIA: and widgets do not render. A gateway whose closed contract refuses
// the key (the session authority's create takes no 'desktop' source) gets the
// call once more without it, as for inline_images before.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createCanonicalChat, CREATE_SOURCE } from '../src/core/create-chat.js'
import { withoutRefusedParams } from '../src/core/outcomes.js'
import { createChatController, RESUME_KEYS, SESSION_SOURCE } from '../src/core/session.js'
import { BOT, gateway } from './harness.mjs'

const NO_CHAT_BOT = { ...BOT, canonical_session: undefined }
const noWait = () => Promise.resolve()
const invalidParams = fields => Object.assign(new Error('invalid_params'), { code: 4001, data: { reason: 'invalid_params', fields } })

test('create and resume both name the desktop surface', async () => {
  assert.equal(CREATE_SOURCE, 'desktop')
  assert.equal(SESSION_SOURCE, 'desktop')
  assert.ok(RESUME_KEYS.includes('source'))
  const gw = gateway({
    'session.list': () => ({ sessions: [] }),
    'session.create': () => ({ session_id: 'rt-new', stored_session_id: 'st-new' }),
    'session.title': () => ({ title: 'Bot Chat' })
  })
  await createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait })
  assert.equal(gw.calls.find(c => c.method === 'session.create').params.source, 'desktop')

  const gw2 = gateway()
  const chat = createChatController(BOT, gw2.deps)
  await chat.open()
  assert.equal(gw2.calls.find(c => c.method === 'session.resume').params.source, 'desktop')
  chat.dispose()
})

test('a create refusal naming source is resent once without it; the chat is created', async () => {
  const gw = gateway({
    'session.list': () => ({ sessions: [] }),
    'session.create': params => {
      if ('source' in params) throw invalidParams(['source'])
      return { session_id: 'rt-new', stored_session_id: 'st-new' }
    },
    'session.title': () => ({ title: 'Bot Chat' })
  })
  const result = await createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait })
  assert.equal(result.created, true)
  assert.equal(result.row.id, 'st-new')
  const creates = gw.calls.filter(c => c.method === 'session.create')
  assert.equal(creates.length, 2)
  assert.deepEqual(creates[1].params, { profile: 'scholar', title: 'Bot Chat', hidden: true, follow_profile_config: true })
  assert.deepEqual(creates[1].options, { spawnPriority: 'foreground' })
})

test('a create refusal that names nothing we sent, or another error, is not retried', async () => {
  for (const failure of [invalidParams(['request_id']), invalidParams(['profile']), Object.assign(new Error('boom'), { code: 5000 })]) {
    const gw = gateway({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => {
        throw failure
      }
    })
    await assert.rejects(createCanonicalChat(gw.deps.requestForBot, NO_CHAT_BOT, { wait: noWait }))
    assert.equal(gw.calls.filter(c => c.method === 'session.create').length, 1)
  }
})

test('a resume refusal naming source drops it for good; the chat attaches', async () => {
  let resumes = 0
  const gw = gateway({
    'session.resume': params => {
      resumes += 1
      if ('source' in params) throw invalidParams(['source'])
      return { session_id: 'rt-1', message_count: 3, messages: [], running: false }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.get().runtimeId, 'rt-1')
  assert.equal(resumes, 2)
  const last = gw.calls.filter(c => c.method === 'session.resume').at(-1).params
  assert.ok(!('source' in last))
  chat.dispose()
})

test('withoutRefusedParams: top-level keys only, kept keys never dropped', () => {
  const params = { profile: 'p', source: 'desktop', cols: 96 }
  assert.deepEqual(withoutRefusedParams(invalidParams(['source', 'cols.x']), params, ['profile']), { profile: 'p' })
  assert.equal(withoutRefusedParams(invalidParams(['profile']), params, ['profile']), null)
  assert.equal(withoutRefusedParams(Object.assign(new Error('x'), { code: 4001, data: { reason: 'not_found' } }), params), null)
  // wrapped by routing.js asError (cause chain)
  const wrapped = Object.assign(new Error('Gateway request session.create failed'), { cause: invalidParams(['source']) })
  assert.deepEqual(withoutRefusedParams(wrapped, params), { profile: 'p', cols: 96 })
})
