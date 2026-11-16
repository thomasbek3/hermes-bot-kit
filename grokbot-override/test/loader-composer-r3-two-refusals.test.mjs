// Review C-R3-01 (T8): two sends pending at once, A → B → A, then both are
// refused (4009) in the same tick. Neither text is lost: both come back to
// Security's composer, and no stale failed bubble offers a second route.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { openSecurity, rpcError, tick } from './composer-r3-helpers.mjs'

test('two refusals landing together after A → B → A: both texts come back', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const pending = []
  const { chatEl, open, send, calls } = await openSecurity(t, { 'prompt.submit': () => new Promise((resolve, reject) => pending.push({ resolve, reject })) })
  await send('preserve this refused draft')
  await waitFor(() => pending.length === 1, 'the first submit is in flight')
  await waitFor(() => chatEl.querySelector('textarea')?.value === '', 'emptied')
  await send('preserve the second refused draft')
  await waitFor(() => pending.length === 2, 'the second submit is in flight')
  await open('Scholar')
  await open('Security')
  pending[0].reject(rpcError(4009, 'session busy'))
  pending[1].reject(rpcError(4009, 'session busy'))
  await tick(200)
  const value = chatEl.querySelector('textarea').value
  assert.ok(value.includes('preserve this refused draft'), `the first text is back: ${JSON.stringify(value)}`)
  assert.ok(value.includes('preserve the second refused draft'), 'the second text is back')
  assert.match(chatEl.textContent, /back in the composer/)
  for (const text of ['preserve this refused draft', 'preserve the second refused draft']) {
    assert.equal([...chatEl.querySelectorAll('.bubble')].filter(b => b.textContent.includes(text)).length, 0, `one way to resend ${text}: the composer`)
  }
  assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 2)
})
