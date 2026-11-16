// Review C-R3-02 (T8): a refused send that carried an attachment, refused
// while another bot is selected: its text comes back to Security's composer
// with a note to attach the file again (files are never kept across a switch).

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { openSecurity, rpcError, tick, type } from './composer-r3-helpers.mjs'

test('a refused send with an attachment, A → B → refusal → A: the text and a reattach note come back', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const pending = []
  const { chatEl, box, open, calls } = await openSecurity(t, {
    'file.attach': () => ({ ok: true, ref_text: '@file:review-file.txt' }),
    'prompt.submit': () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  })
  type(await box(), 'preserve this refused draft')
  const input = chatEl.querySelector('input[type="file"]')
  Object.defineProperty(input, 'files', { value: [new window.File(['hello'], 'review-file.txt', { type: 'text/plain' })], configurable: true })
  input.dispatchEvent(new window.Event('change', { bubbles: true }))
  await waitFor(() => chatEl.textContent.includes('review-file.txt'), 'the file is attached')
  ;(await box()).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => pending.length === 1, 'the submit is in flight')
  await open('Scholar')
  pending[0].reject(rpcError(4009, 'session busy'))
  await tick(200)
  await open('Security')
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'preserve this refused draft', 'the text is back')
  assert.match(chatEl.textContent, /[Aa]ttach the files? again/, 'a note says to attach the file again')
  assert.equal([...chatEl.querySelectorAll('.bubble')].filter(b => b.textContent.includes('preserve this refused draft')).length, 0, 'one way to resend it: the composer')
  assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 1)
})
