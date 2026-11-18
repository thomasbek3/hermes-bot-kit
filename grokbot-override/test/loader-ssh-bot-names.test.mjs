// Loader-faithful: a bot on an SSH connection that is not the live gateway
// (connect-on-demand, no name on its row) shows the name its own gateway
// last reported, from the override's plugin storage, at start and with the
// machine not answering; this desktop's own `default` without a title still
// shows "Hermes". Core rules: test/gateway-meta.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'
import { LOCAL_DEFAULT, rowNames, SOURCES, SSH_DEFAULT } from './fixtures/ssh-bot-names.mjs'

test('loader-faithful: laptop::default with no row name and a cached gateway title shows it; local default stays Hermes', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, mount, errors, calls } = await bootPlugin(t, {
    rows: [LOCAL_DEFAULT, SSH_DEFAULT],
    sources: SOURCES,
    storage: { botMetaCache: { 'laptop::default': { meta: { title: 'Scout' }, display_name: '', description: '', at: 1 } } },
    answers: {
      // The SSH machine does not answer: only the cache can name its bot.
      'profiles.list': (_params, profile) => {
        throw new Error(`${profile}: not connected`)
      }
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowNames(rosterEl).length === 2, 'both rows')
  assert.deepEqual(rowNames(rosterEl).sort(), ['Hermes', 'Scout'])
  const scout = [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scout'))
  assert.ok(scout.textContent.includes('remote preview'), 'Scout is the SSH row')
  assert.ok(calls.some(c => c.method === 'profiles.list' && c.via === 'laptop::default'), 'the existing per-machine list was tried')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
