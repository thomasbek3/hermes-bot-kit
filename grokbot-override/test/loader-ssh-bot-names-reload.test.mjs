// Loader-faithful: the name an SSH bot's own gateway reports arrives on the
// override's existing per-machine list (no request of its own), is kept in
// plugin storage per connection + profile, and survives "Reload desktop
// plugins" with the machine no longer answering. This desktop's bare
// `default` record (its own bot) never names the SSH machine's `default`.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'
import { LOCAL_DEFAULT, rowNames, SOURCES, SSH_DEFAULT } from './fixtures/ssh-bot-names.mjs'

test('loader-faithful: a gateway-read SSH name is cached and survives a plugin reload; the bare default record does not leak', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let release
  const gate = new Promise(resolve => (release = resolve))
  let up = true
  const { panes, mount, errors, calls, store, reload } = await bootPlugin(t, {
    rows: [LOCAL_DEFAULT, SSH_DEFAULT],
    sources: SOURCES,
    // Bot Mode's local snapshot: a title on the bare `default` (this desktop's bot).
    tweak: () => globalThis.localStorage.setItem('hermes.plugin.hermes-bots.bot-meta-v2', JSON.stringify({ default: { title: 'Desk' } })),
    answers: {
      'profiles.list': async () => {
        await gate
        if (!up) throw new Error('not connected')
        return { profiles: [{ name: 'default', display_name: 'Hermes', has_avatar: false, ui_meta: { 'hermes-bots': { title: 'Scout' } } }] }
      }
    }
  })
  let rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowNames(rosterEl).length === 2, 'both rows')
  // Before the machine answers: the local bot has its bare-record title; the
  // SSH bot does NOT borrow it.
  assert.deepEqual(rowNames(rosterEl).sort(), ['Desk', 'Hermes'])

  release()
  await waitFor(() => rowNames(rosterEl).includes('Scout'), 'the gateway-read name')
  assert.deepEqual(rowNames(rosterEl).sort(), ['Desk', 'Scout'])
  const lists = calls.filter(c => c.method === 'profiles.list' && c.via !== 'request')
  assert.deepEqual(lists.map(c => c.via), ['laptop::default'], 'one list for the machine, as before: no request of its own')
  assert.deepEqual(store.get('botMetaCache')?.['laptop::default']?.meta, { title: 'Scout' }, 'kept per connection + profile')

  // Reload desktop plugins with the machine gone: the cache names it at once.
  up = false
  await reload()
  rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowNames(rosterEl).length === 2, 'both rows after the reload')
  assert.deepEqual(rowNames(rosterEl).sort(), ['Desk', 'Scout'])
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
