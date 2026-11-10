// The work-rows setting under the loader replica: the override's own palette
// command "Grokbot Override: show work rows" toggles Thought and tool rows in
// the open chat and stores the choice in its own plugin storage; on the first
// run the retired Bubble Mode's "toggle work rows" preference is copied once
// and its storage is left as it was.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, reactErrors, rowButton } from './loader-surfaces.mjs'

const LEGACY_KEY = 'hermes.plugin.bubble-mode.showWork'
const toolRow = el => [...el.querySelectorAll('button, summary, div')].some(node => /\b\d+ tools?\b/.test(node.textContent || '') && node.children.length < 6)

async function openChat(booted, name) {
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowButton(rosterEl, name), `${name} row`)
  rowButton(rosterEl, name).click()
  const ws = await waitFor(() => booted.workspaces.get('grokbot-override'), 'the chat workspace')
  const chatEl = booted.mount(ws.render)
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'the transcript')
  return chatEl
}

test('loader: "Grokbot Override: show work rows" toggles the rows and is stored; hidden by default', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const booted = await bootFull(t)
  const { panes, store, errors } = booted
  const command = panes.find(p => p.id === 'palette-show-work')
  assert.ok(command, 'the palette command is registered')
  assert.equal(command.data.label, 'Grokbot Override: show work rows')
  assert.equal(command.data.detail(), 'off', 'hidden by default')
  assert.equal(store.get('showWork'), false, 'the first run stores the default once')
  const chatEl = await openChat(booted, 'Scholar')
  assert.equal(toolRow(chatEl), false, 'no tool row while hidden')

  command.data.run()
  assert.equal(command.data.detail(), 'on')
  assert.equal(store.get('showWork'), true)
  await waitFor(() => toolRow(chatEl), 'the tool row shows')

  command.data.run()
  assert.equal(store.get('showWork'), false)
  await waitFor(() => !toolRow(chatEl), 'hidden again')
  assert.deepEqual(reactErrors(errors), [])
})

test('loader: Bubble Mode\'s old preference is copied once and left as it was', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, store, reload } = await bootFull(t, { tweak: () => localStorage.setItem(LEGACY_KEY, 'true') })
  assert.equal(store.get('showWork'), true, 'copied on the first run')
  assert.equal(panes.find(p => p.id === 'palette-show-work').data.detail(), 'on')
  panes.find(p => p.id === 'palette-show-work').data.run()
  assert.equal(store.get('showWork'), false)
  await reload()
  assert.equal(panes.find(p => p.id === 'palette-show-work').data.detail(), 'off', 'the override\'s own value wins; not copied again')
  assert.equal(localStorage.getItem(LEGACY_KEY), 'true', 'Bubble Mode\'s storage is untouched')
})
