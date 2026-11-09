// Add to Slack: a card hidden in an earlier session stays hidden for that
// route key (plugin storage `slackCardHidden`), even though the profile has
// no Slack. Own file: the loader harness opens the chat workspace only on the
// first boot in a process.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootPanel, slackBackends } from './slack-fakes.mjs'

test('loader: a stored Hide keeps the Add to Slack card away', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const backend = slackBackends({ 'home-server::scholar': {} })
  const { panelNow, store } = await bootPanel(t, backend, { storage: { slackCardHidden: ['home-server::scholar'] } })
  await waitFor(() => backend.routes().includes('GET /api/messaging/platforms'), 'the platforms read')
  await new Promise(r => setTimeout(r, 50))
  assert.equal(Boolean(panelNow().querySelector('[aria-label="Suggested"]')), false)
  assert.deepEqual(store.get('slackCardHidden'), ['home-server::scholar'])
  assert.deepEqual(backend.stray, [])
})
