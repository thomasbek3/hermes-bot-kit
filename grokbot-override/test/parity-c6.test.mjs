// PARITY C6 / C28: every send carries a submission id, as stock does
// (apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts:1084-1112),
// and an uncertain send that carried it can be retried under the same id,
// which the canonical gateway answers with the original admission
// (gateway/session_controls.py:823-834). A legacy gateway that refuses the key
// before admitting anything gets one identityless send (submit.ts:1166-1186);
// that send keeps the never-twice rule (no retry while uncertain).

import assert from 'node:assert/strict'
import test from 'node:test'

import { isAdmittedConflict, isIdentityRefusal } from '../src/core/delivery.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const submits = gw => gw.calls.filter(c => c.method === 'prompt.submit')
const rpc = (code, message, data) => Object.assign(new Error(message), { code, data })
const LEGACY_REFUSAL = () => rpc(4000, 'invalid params for prompt.submit: submission_id: Extra inputs are not permitted')

test('C6 identity refusals and admitted conflicts are recognised from the structured error', () => {
  assert.equal(isIdentityRefusal(LEGACY_REFUSAL()), true)
  assert.equal(isIdentityRefusal(rpc(4094, 'submission ids unsupported')), true)
  assert.equal(isIdentityRefusal(rpc(4000, 'invalid params for prompt.submit: text')), false)
  assert.equal(isIdentityRefusal(new Error('timeout')), false)
  assert.equal(isAdmittedConflict(rpc(4001, 'admission_conflict', { reason: 'admission_conflict', field: 'request_id' })), true)
  assert.equal(isAdmittedConflict(rpc(4001, 'admission_conflict', { reason: 'admission_conflict', field: 'text' })), false)
})

test('C6 a legacy gateway: the id is refused before admission, one identityless send follows', async () => {
  const gw = gateway({ 'prompt.submit': params => (params.submission_id ? (() => { throw LEGACY_REFUSAL() })() : { status: 'streaming' }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('hello')
  assert.equal(result.ok, true)
  const [first, second] = submits(gw)
  assert.ok(first.params.submission_id)
  assert.equal(second.params.submission_id, undefined)
  assert.equal(second.params.text, 'hello')
  assert.equal(submits(gw).length, 2)
})

test('C6 canonical: an uncertain send that carried its id offers Retry; the retry re-sends the exact params under the same id', async () => {
  let n = 0
  const gw = gateway({
    'prompt.submit': params => {
      n += 1
      if (n === 1) throw new Error('request timed out after 30s: prompt.submit')
      // The owner had admitted and finished it: the dedupe receipt.
      return { status: 'terminal', submission_id: params.submission_id, session_id: params.session_id }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('did it run?')
  assert.equal(result.delivery, 'unknown')
  const bubble = chat.get().chat.items.find(i => i.id === result.clientId)
  assert.equal(bubble.idempotent, true, 'Retry is offered: it carried its identity')
  const retried = await chat.retry(result.clientId)
  assert.equal(retried.ok, true)
  const [a, b] = submits(gw)
  assert.deepEqual(b.params, a.params, 'byte-identical params, same submission_id')
  const after = chat.get().chat.items.find(i => i.id === result.clientId)
  assert.equal(after?.failed, undefined)
  assert.equal(after?.receipt, 'terminal')
  assert.equal(chat.get().chat.busy, false, 'a dedupe starts no turn')
})

test('C6 canonical: an admission_conflict on the retry is the original (delivered, no new turn)', async () => {
  let n = 0
  const gw = gateway({
    'prompt.submit': () => {
      n += 1
      if (n === 1) throw new Error('WebSocket closed')
      throw rpc(4001, 'admission_conflict', { reason: 'admission_conflict', field: 'request_id' })
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('x')
  const retried = await chat.retry(result.clientId)
  assert.equal(retried.ok, true)
  assert.equal(chat.get().chat.items.find(i => i.id === result.clientId)?.receipt, 'terminal')
})

test('C6 canonical: `queued` on an idle chat is the start of the turn, not "queued after the current reply"', async () => {
  const gw = gateway({ 'prompt.submit': params => ({ status: 'queued', submission_id: params.submission_id }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await chat.sendDraft('go')
  assert.equal(chat.get().chat.busy, true)
  const bubble = chat.get().chat.items.findLast(i => i.kind === 'user')
  assert.equal(bubble.receipt, undefined)
})

test('C6 canonical `unknown` receipt: admitted then lost by its owner, it will not run (no busy, no retry)', async () => {
  const gw = gateway({ 'prompt.submit': params => ({ status: 'unknown', submission_id: params.submission_id }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('lost')
  assert.equal(result.ok, true)
  assert.equal(chat.get().chat.busy, false)
  assert.equal(chat.get().chat.items.find(i => i.id === result.clientId)?.receipt, 'unknown')
  assert.equal((await chat.retry(result.clientId)).ok, false)
  assert.equal(submits(gw).length, 1)
})

test('C6 an identityless uncertain send (legacy) is never retried', async () => {
  const gw = gateway({
    'prompt.submit': params => {
      if (params.submission_id) throw LEGACY_REFUSAL()
      throw new Error('request timed out')
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('once only')
  assert.equal(result.delivery, 'unknown')
  assert.equal(chat.get().chat.items.find(i => i.id === result.clientId).idempotent, undefined)
  assert.equal((await chat.retry(result.clientId)).ok, false)
  assert.equal(submits(gw).filter(c => !c.params.submission_id).length, 1)
})

test('C6 a definite refusal retried by the user reuses its id (nothing was admitted under it)', async () => {
  let n = 0
  const gw = gateway({
    'prompt.submit': () => {
      n += 1
      if (n === 1) throw rpc(4009, 'session busy')
      return { status: 'streaming' }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('again')
  assert.equal(result.delivery, 'not-sent')
  await chat.retry(result.clientId)
  await settle()
  const [a, b] = submits(gw)
  assert.equal(a.params.submission_id, b.params.submission_id)
})
