// Email draft card in the running plugin (ui/EmailDraft.tsx): edit then send sends what the card shows; Sent · time, read-only; a double click sends once.
// One boot per file (test/email-drafts-fixture.mjs). Nothing is sent anywhere.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { button, fakePlugin, ID, openScholar, typeInto } from './email-drafts-fixture.mjs'

const skip = !READY && 'dev dependencies not installed'

test('loader: edit then send sends what the card shows; Sent · time, read-only; a double click sends once', { skip }, async t => {
  const plugin = fakePlugin()
  const { booted, card } = await openScholar(t, plugin)
  typeInto(card.querySelector('input[aria-label="Cc"]'), 'lee@example.org')
  typeInto(card.querySelector('textarea.gbo-ed-body'), 'Hi Sam,\n\nEdited by hand.')
  const send = button(card, 'Send')
  send.click()
  send.click()
  await waitFor(() => card.dataset.status === 'sent', 'sent')
  const sends = plugin.ops.filter(o => o.op === 'send')
  assert.equal(sends.length, 1, 'one send for two clicks')
  assert.deepEqual(sends[0], { op: 'send', id: ID, rev: 1, to: ['sam@example.com'], cc: ['lee@example.org'], subject: 'Re: pricing', body: 'Hi Sam,\n\nEdited by hand.' })
  assert.match(card.querySelector('.gbo-ed-state').textContent, /^Sent · \d{1,2}:\d{2}/)
  assert.equal(card.querySelector('textarea'), null, 'read-only after sending')
  assert.equal(card.querySelector('input'), null)
  assert.equal(button(card, 'Send'), undefined)
  assert.equal(button(card, 'Discard'), undefined)
  assert.equal(card.querySelector('.gbo-ed-body').textContent, 'Hi Sam,\n\nEdited by hand.')
  assert.ok(booted.calls.filter(c => c.method === 'plugin.email-drafts.api').every(c => c.via === 'home-server::scholar'))
})
