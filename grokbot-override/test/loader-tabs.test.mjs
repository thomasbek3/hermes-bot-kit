// PARITY C26: two Bot Chats side by side, loader-faithful.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

test('loader-faithful: a second chat tab opens beside the main one and keeps its bot while the main tab switches', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount, errors, calls } = await bootPlugin(t)
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  ;(await waitFor(() => row('Security'), 'rows')).click()
  const mainEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'main tab')).render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'main transcript')

  // Share (the header's one pill) holds "Open another chat beside this one".
  mainEl.querySelector('button[aria-label="Share"]').click()
  ;(await waitFor(() => [...mainEl.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('Open another chat beside this one')), 'the Share menu')).click()
  const [tabId, tab] = await waitFor(() => [...workspaces.entries()].find(([id]) => id.startsWith('grokbot-override-tab-')), 'the extra tab')
  assert.deepEqual(tab.dock, { pane: 'plugin-workspace:grokbot-override', pos: 'right' }, 'docked beside the main chat')
  const tabEl = mount(tab.render)
  await waitFor(() => tabEl.textContent.includes('hello security'), 'tab transcript')
  assert.ok(!tabEl.querySelector('.gbo-panel'), 'the extra tab is the chat only')

  row('Scholar').click()
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'main switched')
  assert.ok(tabEl.textContent.includes('hello security'), 'the side tab keeps its bot')
  assert.equal(calls.filter(c => c.method === 'session.resume' && c.via === 'local::security').length, 2, 'each tab attached its own chat controller')

  tab.onClose()
  assert.ok(tabId)
  assert.deepEqual(errors, [])
})
