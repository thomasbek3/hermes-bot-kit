// Loader-faithful regression for the live failure of the first remote-avatar
// build: Hermes Desktop reports an SSH machine that is not the live gateway as
// a `connect-on-demand` source (sourceReachable false once annotated), and its
// rows carry no has_avatar. Every SSH bot was skipped as "unreachable", so none
// showed its picture. The override must list that machine once and fetch the
// picture through the bot's own route, and draw it. Core rules:
// test/remote-avatars.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, LOCAL, READY, REMOTE, waitFor } from './loader-boot.mjs'
import { pngDataUrl } from './fixtures/avatar-png.mjs'

const PICTURE = pngDataUrl(512, 512)

test('loader-faithful: an SSH bot on a connect-on-demand source (no has_avatar on its row) shows its server avatar', { skip: !READY && 'dev dependencies not installed' }, async t => {
  // The live condition: host.agents reports the SSH machine as connect-on-demand
  // and its rows say nothing about has_avatar; the override must still list
  // that machine once and fetch the picture through the bot's own route.
  const sources = [
    { connectionId: 'local', label: 'This Mac', reachable: true },
    { connectionId: 'home-server', label: 'HOME-SERVER', reachable: true, error: 'connect-on-demand' }
  ]
  const { panes, mount, errors, calls } = await bootPlugin(t, {
    rows: [LOCAL, REMOTE],
    sources,
    answers: {
      'profiles.list': () => ({ profiles: [{ name: 'default', has_avatar: false }, { name: 'scholar', has_avatar: true }] }),
      'profiles.get_asset': () => ({ found: true, mime: 'image/png', data: PICTURE })
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const face = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))?.querySelector('.gbo-avatar')
  await waitFor(() => face('Scholar')?.querySelector('img'), 'the SSH bot picture')
  assert.equal(face('Scholar').querySelector('img').getAttribute('src'), PICTURE)
  assert.ok(!face('Scholar').closest('button').className.includes('is-dim'), 'the on-demand row is not dimmed')
  assert.deepEqual(calls.filter(c => c.method === 'profiles.list').map(c => [c.via, c.params]), [['home-server::scholar', { include_sessions: false }]], 'one list for the machine')
  assert.deepEqual(calls.filter(c => c.method === 'profiles.get_asset').map(c => [c.via, c.params]), [['home-server::scholar', { name: 'scholar', asset: 'avatar' }]], 'one fetch, on the bot\'s own route')
  assert.ok(face('Security').querySelector('svg[data-shape]'), 'the local bot keeps its shape')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
