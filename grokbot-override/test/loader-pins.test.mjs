// Pinned bots under the loader replica (built plugin.js, jsdom, clicks): the
// row menu pins a bot by its exact route key into the override's own plugin
// storage, the big avatar replaces its row, a click on it opens the same chat
// a row click opens, the palette unpins it, and a stored pin survives a fresh
// boot (a pin for a bot that is gone stays stored but is not drawn). No
// gateway write happens.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, byLabel, menuItem, openMenu, reactErrors, rowButton } from './loader-surfaces.mjs'

const WRITES = /^(prompt\.submit|session\.create|profiles\.(create|configure|set_asset))/
const pinButton = (rosterEl, name) => [...rosterEl.querySelectorAll('.gbo-pins button.gbo-pin')].find(b => b.textContent.includes(name)) || null

test('loader: pin from the row menu, open from the pin, unpin from the palette', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount, errors, calls, store, internals } = await bootFull(t, { primitives: true })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowButton(rosterEl, 'Scholar') && rowButton(rosterEl, 'Security'), 'roster rows')

  const menu = await openMenu(byLabel(rosterEl, 'Actions for Scholar'), true)
  menuItem(menu, 'Pin to top').click()
  await waitFor(() => pinButton(rosterEl, 'Scholar'), 'the pinned avatar')
  assert.deepEqual(store.get('pinnedBots'), ['home-server::scholar'], 'stored by exact route key in the override\'s storage')
  assert.equal(rowButton(rosterEl, 'Scholar'), null, 'not listed twice')

  pinButton(rosterEl, 'Scholar').click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat workspace')).render)
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'Scholar\'s transcript')
  assert.equal(internals.app.selectedKey.get(), 'home-server::scholar', 'the same selection a row click makes')
  assert.equal(pinButton(rosterEl, 'Scholar').getAttribute('aria-current'), 'true')

  const unpin = panes.find(p => p.id === 'palette-unpin-top')
  assert.ok(panes.find(p => p.id === 'palette-pin-top'), 'pin palette command')
  unpin.data.run()
  await waitFor(() => !rosterEl.querySelector('.gbo-pins') && rowButton(rosterEl, 'Scholar'), 'back in its section')
  assert.deepEqual(store.get('pinnedBots'), [])

  assert.deepEqual(reactErrors(errors), [])
  assert.deepEqual(calls.filter(c => WRITES.test(String(c.method))).map(c => c.method), [], 'no gateway write')
})

test('loader: stored pins come back on boot; a pin for a missing bot is kept but not drawn', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, mount, store } = await bootFull(t, { primitives: true, storage: { pinnedBots: ['local::gone', 'local::security'] } })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => pinButton(rosterEl, 'Security'), 'the stored pin')
  assert.equal(rosterEl.querySelectorAll('.gbo-pins button.gbo-pin').length, 1)
  assert.equal(rowButton(rosterEl, 'Security'), null)
  assert.deepEqual(store.get('pinnedBots'), ['local::gone', 'local::security'])
})
