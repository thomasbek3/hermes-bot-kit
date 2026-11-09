// Pass 6 C: View → Reload (a full renderer reload): a fresh window, fresh
// module state, plugin storage kept, and Hermes's layout restoring its
// 'workspace' session view. The override claims the main pane for the bot
// its roster has selected; with nothing selected it shows "Pick a bot", never
// Hermes's chat.

import assert from 'node:assert/strict'
import test from 'node:test'

import { mainPaneModel } from './claim-host.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const MAIN = 'plugin-workspace:grokbot-override'

test('loader: a full renderer reload lands on the override’s screen, selection in sync', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const model = mainPaneModel('workspace')
  const { panes, workspaces, mount, calls, reload, errors } = await bootPlugin(t, { tweak: model.tweak, storage: { selected: 'home-server::scholar', chatOpen: false } })
  assert.equal(model.state.pane, MAIN)
  let rosterEl = mount(panes.find(p => p.id === 'roster').render)
  let mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'Scholar’s chat')
  await waitFor(() => rosterEl.querySelector('button.gbo-row.is-selected')?.textContent.includes('Scholar'), 'selected in the roster')

  // The renderer reloads: the old instance goes, Hermes's layout comes back
  // on its own session view, a fresh instance registers.
  await reload()
  model.front('workspace')
  await waitFor(() => model.state.pane === MAIN, 'claimed after the reload')
  rosterEl = mount(panes.find(p => p.id === 'roster').render)
  mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'the same bot again')
  await waitFor(() => rosterEl.querySelector('button.gbo-row.is-selected')?.textContent.includes('Scholar'), 'still in sync')
  assert.equal(calls.filter(c => c.method === 'openSession').length, 0, 'never Hermes’s chat view')
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
