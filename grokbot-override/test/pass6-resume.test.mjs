// Pass 6 B: a brand-new bot's Bot Chat showed "Live updates are paused
// (invalid_params)". Shapes from the live repro (bot `welcome`, 2026-11-09):
//  - state.db sessions row: id = chat_id = 'local-b0fb…', source 'local',
//    created_source 'desktop', title 'Bot Chat', hidden 1 (the first turn ran
//    through the gateway's local platform, session key
//    agent:welcome:local:dm:local-b0fb…);
//  - that chat is owned by the gateway's session authority, whose dispatcher
//    (gateway/session_controls.py:327) checks session.resume against
//    CanonicalResumeParams (tui_gateway/contracts/canonical_sessions.py:58)
//    and refuses any other key before the handler runs:
//    {code: 4001, message: 'invalid_params', data: {reason: 'invalid_params', fields: [...]}}.
// The override sent `inline_images`, a key only the TUI sidecar's
// SessionResumeParams has.

import assert from 'node:assert/strict'
import test from 'node:test'

import { correctedResumeParams, createChatController, RECONNECTING_NOTICE_MS, RESUME_KEYS } from '../src/core/session.js'
import { gateway } from './harness.mjs'

const STORED = 'local-b0fb0c2c366f20b65b5136035eecf194e4dd2350e29ee286e67a3b6f23168a13'
const WELCOME = {
  name: 'welcome',
  display_name: 'WELCOME BOT',
  connectionId: 'local',
  connectionKind: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: 'welcome', targetProfile: 'welcome' },
  canonical_session: { id: STORED, title: 'Bot Chat', source: 'local' }
}

// CanonicalResumeParams' closed key set (ProfileParams.profile included).
const CANONICAL_RESUME_KEYS = new Set(['profile', 'session_id', 'title', 'latest', 'workspace', 'source', 'editor', 'api_key', 'defer_history', 'omit_messages', 'cols', 'display_projection'])

function invalidParams(fields) {
  return Object.assign(new Error('invalid_params'), { code: 4001, data: { reason: 'invalid_params', fields } })
}

/** session.resume as the session authority answers it. */
function canonicalResume(keys = CANONICAL_RESUME_KEYS) {
  return params => {
    const unknown = Object.keys(params).filter(key => !keys.has(key))
    if (unknown.length) throw invalidParams(unknown)
    if (params.session_id !== STORED) throw Object.assign(new Error('not_found'), { code: 4001, data: { reason: 'not_found' } })
    return { session_id: 'rt-welcome', running: false, message_count: 2, messages: [] }
  }
}

function newBotGateway(resume = canonicalResume()) {
  return gateway({
    'session.list': () => ({ sessions: [{ id: STORED, title: 'Bot Chat', source: 'local', message_count: 2 }] }),
    'session.resume': resume,
    REST: () => ({
      session_id: STORED,
      messages: [
        { id: 1, role: 'user', content: 'Hey, tell me about yourself!', timestamp: 1794249786 },
        { id: 2, role: 'assistant', content: "I'm WELCOME BOT, the welcome agent.", timestamp: 1794249788 }
      ]
    })
  })
}

test('a new bot’s Bot Chat attaches live on the first session.resume (the authority’s contract)', async () => {
  const gw = newBotGateway()
  const chat = createChatController(WELCOME, gw.deps)
  await chat.open()
  const state = chat.get()
  assert.equal(state.phase, 'ready')
  assert.equal(state.storedId, STORED)
  assert.equal(state.runtimeId, 'rt-welcome', 'attached')
  assert.equal(state.attachError, null)
  assert.equal(state.reconnecting, false)
  const resumes = gw.calls.filter(c => c.method === 'session.resume')
  assert.equal(resumes.length, 1, 'one resume, no retry needed')
  assert.deepEqual(resumes[0].params, { session_id: STORED, profile: 'welcome', omit_messages: true, source: 'desktop' })
  for (const key of Object.keys(resumes[0].params)) assert.ok(CANONICAL_RESUME_KEYS.has(key), `${key} is in CanonicalResumeParams`)
  assert.ok(!gw.methods().includes('session.create'), 'no new chat')
})

test('every resume key the override sends is one both Hermes resume contracts accept', () => {
  for (const key of RESUME_KEYS) assert.ok(CANONICAL_RESUME_KEYS.has(key), key)
  assert.ok(!RESUME_KEYS.includes('inline_images'))
})

test('a refusal naming a key is corrected once (the key dropped for good); the chat attaches', async () => {
  // An owner whose contract lacks omit_messages: refused, corrected, attached.
  const keys = new Set([...CANONICAL_RESUME_KEYS].filter(key => key !== 'omit_messages'))
  const gw = newBotGateway(canonicalResume(keys))
  const chat = createChatController(WELCOME, gw.deps)
  await chat.open()
  assert.equal(chat.get().runtimeId, 'rt-welcome')
  const resumes = gw.calls.filter(c => c.method === 'session.resume').map(c => c.params)
  assert.equal(resumes.length, 2)
  assert.deepEqual(resumes[1], { session_id: STORED, profile: 'welcome', source: 'desktop' })
  assert.equal(chat.get().attachError, null)
})

test('a not-found under the lineage tip retries once with the registry id', () => {
  const error = Object.assign(new Error('not_found'), { code: 4001, data: { reason: 'not_found' } })
  const params = { session_id: 'tip', profile: 'welcome', omit_messages: true }
  assert.deepEqual(correctedResumeParams(error, params, { id: 'root', resolved_id: 'tip' }), { ...params, session_id: 'root' })
  assert.equal(correctedResumeParams(error, params, { id: 'tip' }), null, 'no other id: nothing to correct')
  assert.equal(correctedResumeParams(invalidParams(['session_id']), params, {}), null, 'never drops the id')
  assert.equal(correctedResumeParams(invalidParams(['profile']), params, {}), null, 'never drops the profile')
  assert.equal(correctedResumeParams(Object.assign(new Error('boom'), { code: 5000 }), params, { id: 'root' }), null)
})

test('an uncorrectable refusal: silent, history kept, "Reconnecting…" only after 10 s, retried in the background', async () => {
  const timers = []
  const gw = newBotGateway(() => {
    throw invalidParams(['some_key_we_never_sent'])
  })
  gw.deps.setTimer = (fn, ms) => {
    const timer = { fn, ms, cancelled: false }
    timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }
  const chat = createChatController(WELCOME, gw.deps)
  await chat.open()
  const state = chat.get()
  assert.equal(state.phase, 'ready', 'the history is on screen')
  assert.equal(state.chat.items.length, 2)
  assert.equal(state.runtimeId, '')
  assert.equal(state.reconnecting, false, 'nothing shown yet')
  assert.equal(gw.calls.filter(c => c.method === 'session.resume').length, 1, 'no retry when the refusal names nothing we sent')
  const notice = timers.find(t => t.ms === RECONNECTING_NOTICE_MS && !t.cancelled)
  assert.ok(notice, 'a 10 s notice timer')
  assert.ok(timers.some(t => t.ms === 1_000 && !t.cancelled), 'a background re-attach')
  assert.ok(timers.some(t => t.ms === 15_000 && !t.cancelled), 'the polling refresh')
  await notice.fn()
  assert.equal(chat.get().reconnecting, true)
  chat.dispose()
})

test('the notice timer is dropped when the attach succeeds before 10 s', async () => {
  const timers = []
  let fail = true
  const gw = newBotGateway(params => {
    if (fail) throw Object.assign(new Error('socket closed'), {})
    return canonicalResume()(params)
  })
  gw.deps.setTimer = (fn, ms) => {
    const timer = { fn, ms, cancelled: false }
    timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }
  const chat = createChatController(WELCOME, gw.deps)
  await chat.open()
  fail = false
  await timers.find(t => t.ms === 1_000).fn()
  assert.equal(chat.get().runtimeId, 'rt-welcome')
  assert.ok(timers.find(t => t.ms === RECONNECTING_NOTICE_MS).cancelled)
  assert.equal(chat.get().reconnecting, false)
  chat.dispose()
})
