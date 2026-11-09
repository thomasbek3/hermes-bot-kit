// Hermes's HUD (`?win=hud`) is a second full renderer that loads every
// plugin and boots against whatever profile it was handed (live 2026-11-09:
// a HUD opened on a remote bot's chat booted against a non-existent local
// "planner"). The override must stay inert there even with its stored toggle
// ON: no roster pane, no chat tab, no roster / room polling on that gateway.
// One plugin per test file (loader-boot.mjs).

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY } from './loader-boot.mjs'

test('loader-faithful: in the HUD window the override registers its commands but stays off', { skip: !READY && 'dev dependencies not installed' }, async t => {
  t.after(() => {
    delete globalThis.location
  })
  const { panes, workspaces, calls } = await bootPlugin(t, {
    storage: { enabled: true },
    tweak: () => {
      window.history.replaceState(null, '', '/?win=hud')
      Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true, writable: true })
    }
  })
  assert.ok(panes.some(p => p.id === 'palette-toggle'), 'commands still register')
  assert.ok(!panes.some(p => p.id === 'roster'), 'no roster pane in the HUD')
  await new Promise(resolve => setTimeout(resolve, 3_300))
  assert.equal(workspaces.size, 0, 'no chat tab')
  assert.deepEqual(calls.filter(c => c.via || c.method === 'REST'), [], 'no gateway or REST traffic from the HUD copy')
  assert.equal(document.getElementById('grokbot-override-hide-stock'), null, 'stock Bot Mode is not hidden in the HUD')

  // The palette toggle there only records the choice for the main window.
  panes.find(p => p.id === 'palette-toggle').data.run()
  assert.ok(!panes.some(p => p.id === 'roster'), 'toggling in the HUD does not turn it on there')
})
