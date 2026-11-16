// Review C-R1-04 (T10): the contract's startup probe is not lost when the
// override starts switched off. The first 8 s probe finds it off; switching
// it on later arms a new probe, which (on a Hermes build missing the required
// desktop bridge) shows the one quiet notice, once. Built plugin.js under
// Hermes's loader, the 8 s timers captured and run by hand.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const PROBE_MS = 8_000

test('contract notice: armed again when the override is switched on after the first probe ran', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const probes = []
  const timers = new Set()
  const { panes, mount, calls } = await bootPlugin(t, {
    storage: { enabled: false },
    ctxExtras: {
      setTimeout: (fn, ms) => {
        if (ms === PROBE_MS) {
          const entry = { fn, cancelled: false }
          probes.push(entry)
          return () => void (entry.cancelled = true)
        }
        const id = setTimeout(() => (timers.delete(id), fn()), ms)
        timers.add(id)
        return () => (timers.delete(id), clearTimeout(id))
      }
    }
  })
  t.after(() => timers.forEach(clearTimeout))
  const notices = () => calls.filter(c => c.method === 'notify' && /Hermes changed/.test(c.params?.title || ''))
  const fire = () => {
    const pending = probes.filter(p => !p.cancelled && !p.ran)
    for (const p of pending) {
      p.ran = true
      p.fn()
    }
    return pending.length
  }

  assert.equal(fire(), 1, 'the load-time probe')
  assert.equal(notices().length, 0, 'off: nothing probed, no notice')
  assert.equal(fire(), 0, 'no busy retry while the override is off')

  // Switch it on (the palette toggle) and put it on screen.
  panes.find(p => p.data?.id === 'grokbot-override.toggle').data.run()
  const rosterEl = mount(await waitFor(() => panes.find(p => p.id === 'roster')?.render, 'the roster pane'))
  await waitFor(() => rosterEl.querySelector('[data-gbo-root]') || document.querySelector('[data-gbo-root]'), 'the override on screen')
  // Hermes's chrome is there; only the required desktop bridge is missing.
  document.body.insertAdjacentHTML('beforeend', '<div data-titlebar-cluster="left"></div><div data-tree-group="side" data-window-top="true"><div data-panel-header=""><button data-tree-tab="grokbot-override:roster"></button></div></div>')
  window.hermesDesktop = {}
  assert.equal(fire(), 1, 'switching on armed a new probe')
  assert.equal(notices().length, 1, 'the missing bridge shows one quiet notice')
  assert.match(notices()[0].params.message, /\(bridge\.api\)/, 'names exactly the missing entry')
  assert.equal(notices()[0].params.kind, 'info')

  // Off and on again: no second probe, no second notice.
  panes.find(p => p.data?.id === 'grokbot-override.toggle').data.run()
  panes.find(p => p.data?.id === 'grokbot-override.toggle').data.run()
  fire()
  assert.equal(notices().length, 1, 'once per app session')
})
