// Email draft card in the running plugin (ui/EmailDraft.tsx): an older gateway without plugin RPC: the same card through /email-drafts on slash.exec.
// One boot per file (test/email-drafts-fixture.mjs). Nothing is sent anywhere.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { button, fakePlugin, openScholar } from './email-drafts-fixture.mjs'

const skip = !READY && 'dev dependencies not installed'

test('loader: an older gateway without plugin RPC: the same card through /email-drafts on slash.exec', { skip }, async t => {
  const plugin = fakePlugin({ legacy: true })
  const { booted, card } = await openScholar(t, plugin)
  button(card, 'Send').click()
  await waitFor(() => card.dataset.status === 'sent', 'sent')
  const slash = booted.calls.filter(c => c.method === 'slash.exec')
  assert.ok(slash.length >= 2)
  assert.equal(slash[0].via, 'home-server::scholar')
  assert.equal(slash[0].params.session_id, 'rt-scholar')
  assert.match(slash.at(-1).params.command, /^\/email-drafts api send \{"id":"ed_0123456789abcdef","rev":1\}$/)
  assert.equal(plugin.ops.filter(o => o.op === 'send').length, 1)
})
