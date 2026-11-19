// The profile panel's Computer card under Hermes's loader (the built
// plugin.js; one boot per file): a still left in plugin storage by an
// earlier viewing shows while the screen is awake and never while it is
// asleep, and the card itself sends nothing to the gateway: no thumbnail,
// no start, no stream, whether the panel is shown, hidden or the screen is
// stopped.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, byLabel, reactErrors, rowButton } from './loader-surfaces.mjs'

const skip = !READY && 'dev dependencies not installed'
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
const STILL = 'data:image/jpeg;base64,' + 'Q'.repeat(600)

test('Computer card: Awake with the stored still, Asleep with the sleeping face, and no gateway call of its own', { skip }, async t => {
  let running = true
  const booted = await bootFull(t, {
    primitives: false,
    // An earlier session's still for this bot (keyed <connectionId>::<profile>),
    // and another connection's bot of the same name that must not leak in.
    storage: { 'screen-thumbs': { 'local::security': { url: STILL, at: 1 }, 'other::security': { url: 'data:image/jpeg;base64,' + 'Z'.repeat(600), at: 2 } } },
    answers: {
      'display.status': () => ({ supported: true, installed: true, running, profile_key: 'pk-security', lease: { holder: 'agent', epoch: 1, since: 0 } }),
      'display.thumbnail': () => {
        throw new Error('the card must never ask for a thumbnail')
      }
    }
  })
  const { calls, errors, panes, workspaces, mount, internals } = booted
  const sent = method => calls.filter(c => c.method === method).length

  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowButton(rosterEl, 'Security'), 'the roster')
  rowButton(rosterEl, 'Security').click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat workspace')).render)
  await waitFor(() => chatEl.querySelector('.gbo-panel') || byLabel(chatEl, 'Show profile'), 'the chat header')
  if (!chatEl.querySelector('.gbo-panel')) byLabel(chatEl, 'Show profile').click()

  const card = await waitFor(() => chatEl.querySelector('.gbo-computer-card[data-state="awake"]'), 'the awake card')
  assert.equal(card.querySelector('.panel-row__title').textContent, 'Bot’s computer')
  assert.equal(card.querySelector('.panel-row__sub').textContent, 'Awake')
  const img = card.querySelector('.computer-thumb img')
  assert.ok(img, 'the stored still is the thumbnail')
  assert.equal(img.getAttribute('src'), STILL, 'this bot’s own still, not the other connection’s')

  // The panel stays up a while: nothing polls.
  const before = calls.length
  await tick(150)
  assert.equal(sent('display.thumbnail'), 0, 'no thumbnail request while shown')
  assert.deepEqual(calls.slice(before).map(c => c.method).filter(m => String(m).startsWith('display.')), [], 'no display.* request while the panel just sits there')

  // Asleep now (the next status read): the sleeping face, never the stale still.
  running = false
  internals.app.screen.set({ key: 'local::security', status: { supported: true, installed: true, running: false } })
  const asleep = await waitFor(() => chatEl.querySelector('.gbo-computer-card[data-state="asleep"]'), 'the asleep card')
  assert.equal(asleep.querySelector('.panel-row__sub').textContent, 'Asleep')
  assert.ok(!asleep.querySelector('img'), 'no still for a sleeping screen')
  assert.ok(asleep.querySelector('.computer-thumb__face') && asleep.querySelector('.computer-thumb__z1'), 'the sleeping face with its z')

  // Hidden panel: still nothing of its own.
  byLabel(chatEl, 'Close profile').click()
  await waitFor(() => !chatEl.querySelector('.gbo-computer-card'), 'the panel hidden')
  await tick(120)
  for (const method of ['display.thumbnail', 'display.start', 'display.observe', 'display.lease.acquire']) assert.equal(sent(method), 0, `${method}: never sent by the card`)
  assert.deepEqual(reactErrors(errors), [])
})
