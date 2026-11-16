// Review C-R3-03 (T8): a free-text answer to a clarify card that Hermes did
// not accept (clarify.lock -32601) comes back to Security's composer with its
// note, whether the failure lands while Security is shown again (A → B → A)
// or while another bot is shown (A → B → failure → A).

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { openSecurity, rpcError, tick } from './composer-r3-helpers.mjs'

test('a failed free-text answer comes back to the composer across a switch', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const pending = []
  const { chatEl, emit, open, send, calls } = await openSecurity(t, { 'clarify.lock': () => new Promise((resolve, reject) => pending.push({ resolve, reject })) })
  emit({ type: 'clarify.request', session_id: 'rt-security', payload: { request_id: 'q1', question: 'Which branch?', choices: ['main', 'dev'] } })
  await waitFor(() => chatEl.textContent.includes('Which branch?'), 'the clarify card')

  // A → B → A, then the failure.
  await send('a carefully composed free-text answer')
  await waitFor(() => pending.length === 1, 'the answer is in flight')
  await open('Scholar')
  await open('Security')
  pending[0].reject(rpcError(-32601, 'Method not found'))
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'a carefully composed free-text answer', 'the answer is back in the composer')
  assert.match(chatEl.textContent, /Your answer was not sent/)

  // A → B → failure → A.
  await waitFor(() => chatEl.textContent.includes('Which branch?'), 'the card is still open')
  await send('a second answer')
  await waitFor(() => pending.length === 2, 'the second answer is in flight')
  await open('Scholar')
  pending[1].reject(rpcError(-32601, 'Method not found'))
  await tick(200)
  await open('Security')
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'a second answer', 'the second answer is back')
  assert.match(chatEl.textContent, /Your answer was not sent/)
  assert.equal(calls.filter(c => c.method === 'clarify.lock').length, 2)
})
