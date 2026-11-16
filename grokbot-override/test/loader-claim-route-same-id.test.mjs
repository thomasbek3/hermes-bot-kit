// Review tighter-b r1 #3 (T3): routing must not depend on the focused stored
// id changing. One plugin per test file (loader-boot.mjs).

import assert from 'node:assert/strict'
import test from 'node:test'

import { mainPaneModel } from './claim-host.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const MAIN = 'plugin-workspace:grokbot-override'
const settle = () => new Promise(resolve => setTimeout(resolve, 450))

// Review tighter-b r1 #3: Hermes keeps the focused stored id while a plugin
// tab covers the chat (store/session-focus.ts), so an open need not change it.
test('loader: ⌘N with nothing focused, and re-opening the same session, stay in Hermes; a closed tab still reopens', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const model = mainPaneModel('workspace')
  const { workspaces, mount, errors, internals } = await bootPlugin(t, { tweak: model.tweak, smoke: true, storage: { selected: 'local::security', chatOpen: false } })
  assert.equal(model.state.pane, MAIN)
  const mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'the chat')
  document.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))

  // First-use ⌘N: the focused id is null before and after.
  model.newDraft()
  await settle()
  assert.equal(model.state.pane, 'workspace', '⌘N’s new draft stays on screen')

  // Back to the override (its tab), then a native session, then back again.
  model.front(MAIN)
  model.restoreSession('s-other')
  await settle()
  assert.equal(model.state.pane, 'session-tile:s-other')
  model.front(MAIN)
  await settle()
  // Re-opening that same session tab: the focused id does not change.
  model.front('session-tile:s-other')
  await settle()
  assert.equal(model.state.pane, 'session-tile:s-other', 'the same session opened again stays')
  assert.equal(internals.app.selectedKey.get(), 'local::security')

  // The override's tab closed by the user is reopened.
  model.front(MAIN)
  await settle()
  const options = workspaces.get('grokbot-override')
  model.front('workspace')
  options.onClose()
  await waitFor(() => model.state.pane === MAIN, 'the closed tab reopens')
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
