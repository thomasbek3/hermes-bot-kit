// T3 (audit 20): route, don't block, Hermes's session views. During the
// start-up restore the override claims the main pane as before
// (loader-claim-cold / -reload). After it, a session the user opens through
// Hermes (search, a notification, a cron run, ⌘N, an artifact link) is not
// undone: a roster bot's Bot Chat opens in the override, anything else stays
// in Hermes's own view until the user comes back to the override.

import assert from 'node:assert/strict'
import test from 'node:test'

import { botForSession } from '../src/core/roster.js'
import { mainPaneModel } from './claim-host.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const MAIN = 'plugin-workspace:grokbot-override'
// Past the 300 ms a pane change waits before it is claimed after start-up.
const settle = () => new Promise(resolve => setTimeout(resolve, 450))

test('botForSession: registry id, lineage tip, the open chat’s newer canonical, else null', () => {
  const a = { name: 'a', route: { connectionId: 'c', mode: 'remote', profile: 'a' }, canonical_session: { id: 'a-root', resolved_id: 'a-tip' } }
  const b = { name: 'b', route: { connectionId: 'c', mode: 'remote', profile: 'b' }, canonical_session: { id: 'b-root' } }
  assert.equal(botForSession([a, b], 'a-root'), a)
  assert.equal(botForSession([a, b], 'a-tip'), a)
  assert.equal(botForSession([a, b], 'b-root'), b)
  assert.equal(botForSession([a, b], 'other'), null)
  assert.equal(botForSession([a, b], ''), null)
  assert.equal(botForSession([a, b], 'b-new', { bot: { ...b }, canonical: { id: 'b-new' } }), b, 'the open chat moved past the roster’s row')
})

test('loader: after start-up, a non-bot session stays in Hermes and a Bot Chat opens in the override', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const model = mainPaneModel('workspace')
  const { panes, workspaces, mount, calls, errors, internals } = await bootPlugin(t, { tweak: model.tweak, smoke: true, storage: { selected: 'local::security', chatOpen: false } })
  assert.equal(model.state.pane, MAIN, 'cold start: claimed')
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'the remembered bot’s chat')

  // Still the start-up restore: a non-bot session is claimed back.
  model.restoreSession('restored-other')
  await waitFor(() => model.state.pane === MAIN, 'the start-up restore is claimed back')

  // The user's first input ends the start-up restore.
  document.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))

  // Session search / a notification opens a session that is no bot's chat.
  const reveals = () => model.state.reveals.filter(id => id === MAIN).length
  const before = reveals()
  model.restoreSession('s-other')
  await settle()
  assert.equal(model.state.pane, 'session-tile:s-other', 'Hermes’s view stays on screen')
  assert.equal(reveals(), before, 'no revealPane(MAIN)')
  assert.equal(internals.app.selectedKey.get(), 'local::security', 'the selection is untouched')

  // ⌘N: a new draft in Hermes's view stays too.
  model.newDraft()
  await settle()
  assert.equal(model.state.pane, 'workspace', 'the new draft stays')
  assert.equal(reveals(), before)

  // A Bot Chat (Scholar's canonical, opened from a notification) opens in the override.
  model.restoreSession('k-root')
  await waitFor(() => model.state.pane === MAIN, 'the override is fronted')
  assert.equal(internals.app.selectedKey.get(), 'home-server::scholar', 'that bot is selected')
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'Scholar’s chat')
  await waitFor(() => rosterEl.querySelector('button.gbo-row.is-selected')?.textContent.includes('Scholar'), 'the roster follows')

  // Its compression-lineage tip routes the same way.
  model.restoreSession('s-other-2')
  await settle()
  assert.equal(model.state.pane, 'session-tile:s-other-2')
  model.restoreSession('s-root')
  await waitFor(() => model.state.pane === MAIN, 'Security’s Bot Chat routes back')
  assert.equal(internals.app.selectedKey.get(), 'local::security')

  // Back on the override, Hermes's 'workspace' pane fronting by itself (no
  // session focus change, e.g. the onboarding exit) is claimed again.
  model.front('workspace')
  await waitFor(() => model.state.pane === MAIN, 'claimed again')

  assert.equal(calls.filter(c => c.method === 'openSession').length, 0, 'the override never opens Hermes’s chat')
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
