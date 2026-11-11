// Loader-faithful: the built plugin.js draws the server avatar of a bot on
// another connection (Bot Mode only fetches the active source's). A remote
// row whose gateway reports has_avatar shows the picture its own route
// returns, fetched once however often the roster refreshes; a row whose
// fetch fails keeps its generated shape; a local bot is untouched (no fetch,
// same shape). Core rules: test/remote-avatars.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, LOCAL, READY, REMOTE, waitFor } from './loader-boot.mjs'
import { pngDataUrl } from './fixtures/avatar-png.mjs'

const PICTURE = pngDataUrl(512, 512)
const BROKEN = {
  ...REMOTE,
  name: 'courier',
  display_name: 'Courier',
  route: { connectionId: 'home-server', mode: 'remote', profile: 'courier', targetProfile: 'courier' },
  canonical_session: { id: 'c-root', preview: 'courier preview', last_active: 1762540000 }
}

test('loader-faithful: a remote bot with a server avatar shows it (fetched once); a failed fetch and a local bot keep their shapes', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const rows = [{ ...LOCAL, has_avatar: true }, { ...REMOTE, has_avatar: true }, { ...BROKEN, has_avatar: true }]
  const { panes, mount, errors, calls } = await bootPlugin(t, {
    rows,
    answers: {
      'profiles.get_asset': (params, profile) => {
        if (profile === 'courier') throw new Error('gateway offline')
        return { found: true, mime: 'image/png', data: PICTURE }
      }
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  await waitFor(() => row('Security') && row('Scholar') && row('Courier'), 'roster rows')

  const face = name => row(name)?.querySelector('.gbo-avatar')
  await waitFor(() => face('Scholar')?.querySelector('img'), 'the remote picture')
  const img = face('Scholar').querySelector('img')
  assert.equal(img.getAttribute('src'), PICTURE)
  assert.equal(face('Scholar').getAttribute('data-avatar'), 'server')
  assert.equal(face('Scholar').querySelector('svg'), null, 'the picture replaces the shape')

  // Let the roster refresh (ROSTER_TICK_MS) re-render the rows a few times.
  await new Promise(resolve => setTimeout(resolve, 3_500))
  const assets = calls.filter(c => c.method === 'profiles.get_asset')
  assert.deepEqual(assets.map(c => c.via).sort(), ['home-server::courier', 'home-server::scholar'], 'once per remote bot, on its own route')
  assert.deepEqual(assets.find(c => c.via === 'home-server::scholar').params, { name: 'scholar', asset: 'avatar' })

  assert.equal(face('Courier').querySelector('img'), null, 'a failed fetch keeps the shape')
  assert.ok(face('Courier').querySelector('svg[data-shape]'), 'generated shape')
  assert.equal(face('Security').querySelector('img'), null, 'the local bot is unchanged')
  assert.ok(face('Security').querySelector('svg[data-shape]'))
  assert.equal(calls.filter(c => c.method === 'profiles.get_asset' && (c.via === 'request' || c.via.startsWith('local::'))).length, 0, 'nothing asked for the local bot')
  assert.equal(calls.filter(c => c.method === 'profiles.list' && c.via !== 'request').length, 0, 'rows that report has_avatar need no list')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
