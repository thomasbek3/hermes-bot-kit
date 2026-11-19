// The bot's computer: the top-right Close (collapse) icon leaves the viewer
// through the workspace tab's own close (the function host.openWorkspace
// handed back), in every state: waking, an install card, a Hermes with no
// screen. The built plugin.js under Hermes's loader (one boot per file).

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, byLabel, reactErrors, SCOUT } from './loader-surfaces.mjs'
import { tick } from './fixtures/screen-cold-open.mjs'

const skip = !READY && 'dev dependencies not installed'
const lease = { holder: 'agent', epoch: 1, since: 0 }

test('Close leaves the viewer through the tab’s own close, in each state', { skip }, async t => {
  let mode = 'asleep'
  const base = { supported: true, installed: true, running: false, display: ':20', geometry: '1920x1200', profile_key: 'pk-scout', lease }
  const booted = await bootFull(t, {
    primitives: false,
    answers: {
      'display.status': () => {
        if (mode === 'no-screen') throw new Error('unknown method: display.status')
        if (mode === 'not-installed') return { ...base, installed: false, missing: ['xvfb'] }
        return base
      },
      // Held forever: the viewer stays in its waking state.
      'display.start': () => new Promise(() => undefined)
    }
  })
  const { workspaces, mount, internals, errors, calls } = booted
  const tabId = () => [...workspaces.keys()].find(id => String(id).startsWith('grokbot-override-screen-'))

  async function openAndClose(label, ready) {
    internals.openBotScreen(SCOUT)
    const id = await waitFor(tabId, `${label}: the screen tab`)
    const el = mount(workspaces.get(id).render)
    await waitFor(() => ready(el), `${label}: its state`)
    const close = byLabel(el, 'Close')
    assert.ok(close, `${label}: the Close icon`)
    assert.equal(close.getAttribute('title'), 'Close')
    assert.equal(close.closest('.gbo-screen-corner')?.lastElementChild, close, `${label}: Close at the far right of the corner`)
    close.click()
    await waitFor(() => !tabId(), `${label}: the tab closed`)
  }

  await openAndClose('waking', el => el.textContent.includes('Waking the computer…'))
  mode = 'not-installed'
  // The tab's own bookkeeping was cleared: opening again makes a new tab.
  await openAndClose('install card', el => el.textContent.includes('The screen is not installed'))
  mode = 'no-screen'
  await openAndClose('no screen', el => el.textContent.includes('No screen on this Hermes'))
  await tick(40)
  assert.equal(calls.filter(c => c.method === 'display.thumbnail').length, 0, 'the viewer never asks for a thumbnail')
  assert.deepEqual(reactErrors(errors), [])
})
