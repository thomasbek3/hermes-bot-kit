// Email draft card in the running plugin (ui/EmailDraft.tsx): a failure shows the error and Retry; Retry sends.
// One boot per file (test/email-drafts-fixture.mjs). Nothing is sent anywhere.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { button, fakePlugin, openScholar } from './email-drafts-fixture.mjs'

const skip = !READY && 'dev dependencies not installed'

test('loader: a failure shows the error and Retry; Retry sends', { skip }, async t => {
  const plugin = fakePlugin({ failFirstSend: true })
  const { card } = await openScholar(t, plugin)
  button(card, 'Send').click()
  await waitFor(() => card.dataset.status === 'failed', 'failed')
  assert.match(card.querySelector('.gbo-ed-state').textContent, /^Not sent: Gmail is not signed in/)
  const retry = await waitFor(() => button(card, 'Retry'), 'Retry')
  retry.click()
  await waitFor(() => card.dataset.status === 'sent', 'sent on retry')
  assert.equal(plugin.ops.filter(o => o.op === 'send').length, 2)
})
