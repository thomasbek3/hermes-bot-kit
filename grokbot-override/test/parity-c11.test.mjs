// PARITY C11: answering clarify / sudo / secret / vault prompts and
// connection cards from the override, on the gateway's own proxies (see
// src/core/prompts.js for the stock sources). Secrets travel only in the
// answering request.

import assert from 'node:assert/strict'
import test from 'node:test'

import { clarifyQuestions, inputRequestFrom, valueResult } from '../src/core/prompts.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const running = extra => () => ({ session_id: 'rt-1', running: true, ...extra })

test('C11 prompt shapes: batch and single clarify, value prompts, connection snapshot', () => {
  assert.deepEqual(clarifyQuestions({ questions: [{ qid: 'q1', question: 'A?', choices: ['x', ' '], multi_select: true }, { qid: '', question: 'skip me' }] }), [
    { qid: 'q1', question: 'A?', choices: ['x'], multiSelect: true }
  ])
  assert.deepEqual(clarifyQuestions({ prompt_id: 'p', question: 'B?' }), [{ qid: 'p', question: 'B?', choices: null, multiSelect: false }])
  assert.equal(inputRequestFrom('vault.save_login', { origin: 'https://a', site: 'A' }, 'v1').kind, 'vault-login')
  assert.equal(inputRequestFrom('secret', { env_var: 'GH', prompt: 'token' }, 's1').envVar, 'GH')
  assert.equal(inputRequestFrom('connection', { op_id: 'op', seq: 2, targets: [{ name: 'github' }] }).opId, 'op')
  assert.equal(inputRequestFrom('terminal.read', {}, 'x'), null, 'desktop bridges are not user prompts')
  assert.deepEqual(valueResult('vault-login', { identifier: 'me', password: 'pw' }), { value: JSON.stringify({ identifier: 'me', password: 'pw' }) })
  assert.deepEqual(valueResult('vault-login', { identifier: '', password: '' }), { value: '' })
  assert.deepEqual(valueResult('sudo', 'pw'), { value: 'pw' })
})

test('C11 clarify: one clarify.lock per question, sequentially, null for skipped; the card clears', async () => {
  const gw = gateway({
    'session.resume': running({
      open_requests: [{ id: 'c9', method: 'clarify', params: { questions: [{ qid: 'a', question: 'Env?', choices: ['prod', 'dev'] }, { qid: 'b', question: 'Why?' }] } }]
    }),
    'clarify.lock': params => ({ status: 'ok', remaining: params.question_id === 'a' ? ['b'] : [] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.get().chat.waiting.kind, 'clarify')
  const result = await chat.answerPrompt({ a: 'prod' })
  assert.equal(result.ok, true)
  assert.deepEqual(
    gw.calls.filter(c => c.method === 'clarify.lock').map(c => c.params),
    [
      { request_id: 'c9', question_id: 'a', answer: 'prod' },
      { request_id: 'c9', question_id: 'b', answer: null }
    ]
  )
  assert.equal(chat.get().chat.waiting, null)
  chat.dispose()
})

test('C11 clarify that already ended answers `expired`: the card goes, nothing else is sent', async () => {
  const gw = gateway({
    'session.resume': running({ open_requests: [{ id: 'c1', method: 'clarify', params: { questions: [{ qid: 'a', question: 'A?' }, { qid: 'b', question: 'B?' }] } }] }),
    'clarify.lock': () => ({ status: 'expired' })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.answerPrompt({ a: '1', b: '2' })
  assert.equal(result.status, 'expired')
  assert.equal(gw.calls.filter(c => c.method === 'clarify.lock').length, 1)
  chat.dispose()
})

test('C11 sudo / secret / vault answer through request.answer {id, result:{value}}; the value is in that call only', async () => {
  for (const [method, params, answer, value] of [
    ['sudo', { command: 'apt install jq' }, 'hunter2', 'hunter2'],
    ['secret', { env_var: 'GH_TOKEN', prompt: 'token' }, 'ghp_SECRET', 'ghp_SECRET'],
    ['vault.unlock_prompt', { backend: 'bitwarden', display_name: 'Bitwarden' }, 'master', 'master'],
    ['vault.code', { site: 'github.com' }, '123456', '123456'],
    ['vault.save_login', { origin: 'https://a', site: 'A' }, { identifier: 'me', password: 'pw' }, JSON.stringify({ identifier: 'me', password: 'pw' })]
  ]) {
    const gw = gateway({
      'session.resume': running({ open_requests: [{ id: 'r1', method, params }] }),
      'request.answer': () => ({ status: 'ok' })
    })
    const chat = createChatController(BOT, gw.deps)
    await chat.open()
    await chat.answerPrompt(answer)
    const call = gw.calls.find(c => c.method === 'request.answer')
    assert.deepEqual(call.params, { id: 'r1', result: { value } }, method)
    assert.equal(chat.get().chat.waiting, null)
    const elsewhere = JSON.stringify({ state: chat.get(), other: gw.calls.filter(c => c !== call) })
    assert.ok(!elsewhere.includes(value), `${method}: the value is never kept`)
    chat.dispose()
  }
})

test('C11 a gateway without request.answer: inline error with the Bot Mode link, the card stays', async () => {
  const gw = gateway({ 'session.resume': running({ open_requests: [{ id: 'r1', method: 'secret', params: { env_var: 'X', prompt: 'x' } }] }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.answerPrompt('value')
  assert.equal(result.unsupported, true)
  assert.equal(chat.get().chat.waiting.unsupported, true)
  assert.ok(!JSON.stringify(chat.get()).includes('"value"'))
  chat.dispose()
})

test('C11 connection card: snapshot, live update, connection.respond with the session owner, settlement clears', async () => {
  const gw = gateway({
    'session.resume': running({ pending_connection: { op_id: 'op1', seq: 1, deadline_at: 0, timeout_seconds: 60, targets: [{ name: 'github', state: 'pending' }] } }),
    'connection.respond': () => ({ status: 'ok', settled: false })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.get().chat.waiting.kind, 'connection')
  await chat.respondConnection({ targets: [{ name: 'github', status: 'skipped' }] })
  assert.deepEqual(gw.calls.find(c => c.method === 'connection.respond').params, {
    op_id: 'op1',
    owner: { session_id: 'rt-1', type: 'session' },
    result: { targets: [{ name: 'github', status: 'skipped' }] }
  })
  gw.emit({ type: 'connection.update', session_id: 'rt-1', payload: { op_id: 'op1', seq: 2, owner: { type: 'session', session_id: 'rt-1' }, targets: [{ name: 'github', state: 'skipped' }] } })
  assert.equal(chat.get().chat.waiting.targets[0].state, 'skipped')
  gw.emit({ type: 'connection.update', session_id: 'rt-1', payload: { op_id: 'op1', seq: 1, owner: { type: 'session' }, targets: [] } })
  assert.equal(chat.get().chat.waiting.targets.length, 1, 'an older frame moves nothing')
  gw.emit({ type: 'connection.update', session_id: 'rt-1', payload: { op_id: 'op1', seq: 3, settled: true, owner: { type: 'session' }, targets: [] } })
  assert.equal(chat.get().chat.waiting, null)
  chat.dispose()
})

test('C11 request.cancel withdraws only the matching prompt', async () => {
  const gw = gateway({ 'session.resume': running({ open_requests: [{ id: 'r2', method: 'sudo', params: { command: 'x' } }] }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'request.cancel', session_id: 'rt-1', payload: { id: 'older' } })
  assert.equal(chat.get().chat.waiting.id, 'r2')
  gw.emit({ type: 'request.cancel', session_id: 'rt-1', payload: { id: 'r2' } })
  assert.equal(chat.get().chat.waiting, null)
  chat.dispose()
})

test('C11 a legacy server request mid-turn (never delivered to plugins) is found: the watchdog sees `waiting` and reads the snapshot', async () => {
  let resumes = 0
  const gw = gateway({
    'session.resume': () => {
      resumes += 1
      return resumes === 1
        ? { session_id: 'rt-1', running: true }
        : { session_id: 'rt-1', running: true, open_requests: [{ id: 'r5', method: 'sudo', params: { command: 'make install' } }] }
    },
    'session.active_list': () => ({ sessions: [{ id: 'rt-1', status: 'waiting' }] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.get().chat.waiting, null)
  await chat.reconcile()
  await settle()
  assert.equal(chat.get().chat.waiting?.kind, 'sudo')
  assert.equal(chat.get().chat.waiting?.text, 'make install')
  chat.dispose()
})
