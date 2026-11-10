// Email draft card in the running plugin (ui/EmailDraft.tsx): discard.
// One boot per file (test/email-drafts-fixture.mjs). Nothing is sent anywhere.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { button, fakePlugin, openScholar } from './email-drafts-fixture.mjs'

const skip = !READY && 'dev dependencies not installed'

test('loader: discard', { skip }, async t => {
  const plugin = fakePlugin()
  const { card } = await openScholar(t, plugin)
  button(card, 'Discard').click()
  await waitFor(() => card.dataset.status === 'discarded' && card.querySelector('.gbo-ed-state')?.textContent === 'Discarded', 'discarded')
  assert.equal(plugin.ops.filter(o => o.op === 'send').length, 0)
  assert.equal(button(card, 'Send'), undefined)
})
