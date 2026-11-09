// Pass 6 C: a cold app start with Hermes's last session tab persisted, a
// session tab Hermes restores after the plugin registered, and the exit from
// the first-run provider screen ("I'll choose a provider later" lifts the
// overlay, store/onboarding.ts dismissFirstRunOnboarding, and the main zone
// shows its 'workspace' pane): the main pane is the override's every time,
// showing the bot the roster has selected.

import assert from 'node:assert/strict'
import test from 'node:test'

import { mainPaneModel } from './claim-host.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const MAIN = 'plugin-workspace:grokbot-override'

test('loader: cold start over a restored stock session tab, a late restore and the onboarding exit all end on the override', { skip: !READY && 'dev dependencies not installed' }, async t => {
  // Hermes boots with Scholar's stock session tab fronted; the override
  // remembers Security.
  const model = mainPaneModel('session-tile:k-root')
  const { panes, workspaces, mount, calls, errors } = await bootPlugin(t, { tweak: model.tweak, storage: { selected: 'local::security', chatOpen: false } })
  assert.equal(model.state.pane, MAIN, 'cold start: the override took the main pane')
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'the remembered bot’s chat')
  await waitFor(() => rosterEl.querySelector('button.gbo-row.is-selected')?.textContent.includes('Security'), 'the roster selection matches')
  assert.ok(mainEl.querySelector('.gbo-head-pill').textContent.includes('Security'), 'the header shows the same bot')

  // Hermes restores its last session tab after plugins registered.
  model.restoreSession('k-root')
  await waitFor(() => model.state.pane === MAIN, 'a late restore is claimed back')

  // The first-run provider screen, then "I'll choose a provider later": the
  // overlay lifts over the layout's own 'workspace' pane.
  model.front('workspace')
  await waitFor(() => model.state.pane === MAIN, 'the onboarding exit is claimed back')
  assert.ok(mainEl.textContent.includes('hello security'), 'same chat, still mounted')

  assert.equal(calls.filter(c => c.method === 'openSession').length, 0)
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
