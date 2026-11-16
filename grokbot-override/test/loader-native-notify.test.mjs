// T7 under Hermes's loader (the built plugin.js): with a stub `ctx.os.notify`
// and the window not focused, a reply in the open override chat makes one
// native notification per turn, a [SILENT] reply none, an approval one with a
// generic body; while focused nothing fires. Clicking it opens that bot.
// Needs a live check in Hermes Desktop too (the real OS door).

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

test('native notifications: one per finished turn while Hermes is in the background; none for silence or while focused', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const sent = []
  const { panes, workspaces, mount, emit } = await bootPlugin(t, { ctxExtras: { os: { notify: n => sent.push(n) } } })
  let focused = true
  document.hasFocus = () => focused
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Security')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => chatEl.textContent.includes('hello security'), 'the transcript')
  await tick()
  assert.equal(sent.length, 0, 'opening a chat notifies nothing')

  // Focused: a finished turn makes no native notification.
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: 'focused reply' } })
  await waitFor(() => chatEl.textContent.includes('focused reply'), 'the focused reply')
  await tick()
  assert.equal(sent.length, 0, 'nothing while focused')

  // Away: one per turn, generic body, the bot's name as the title.
  focused = false
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.delta', session_id: 'rt-security', payload: { text: 'private ' } })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: 'private details here' } })
  await waitFor(() => sent.length === 1, 'one notification for the turn')
  await tick(80)
  assert.equal(sent.length, 1, 'exactly one for the turn')
  assert.equal(sent[0].title, 'Security')
  assert.equal(sent[0].body, 'Replied.')
  assert.ok(!JSON.stringify(sent[0]).includes('private'), 'never the reply text')
  assert.equal(typeof sent[0].onActivate, 'function')

  // A [SILENT] turn: none.
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: '[SILENT]' } })
  await tick(120)
  assert.equal(sent.length, 1, 'no notification for a silent reply')

  // An approval: one, generic.
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'approval.request', session_id: 'rt-security', payload: { request_id: 'ap1', command: 'rm -rf /tmp/private', description: 'delete files' } })
  await waitFor(() => sent.length === 2, 'the approval notification')
  assert.equal(sent[1].body, 'Needs your approval.')
  assert.ok(!JSON.stringify(sent[1]).includes('private'))

  // Clicking it opens the bot (no throw, the workspace stays).
  sent[0].onActivate()
  assert.ok(workspaces.get('grokbot-override'))
})
