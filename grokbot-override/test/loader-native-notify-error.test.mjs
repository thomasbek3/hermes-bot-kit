// Review C-R2-03 (T7): an earlier failed turn does not veto a later
// successful background reply that has no user row of its own (a
// process_complete follow-up); a turn that itself fails still never
// notifies. Built plugin.js under Hermes's loader, stub ctx.os.notify; one
// plugin per file.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const tick = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))

test('native notifications: an old error does not silence a later background reply', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const sent = []
  const { panes, workspaces, mount, emit } = await bootPlugin(t, { ctxExtras: { os: { notify: n => sent.push(n) } } })
  let focused = false
  document.hasFocus = () => focused
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Security')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => chatEl.textContent.includes('hello security'), 'the transcript')
  await tick()
  assert.equal(sent.length, 0)

  // A turn that fails: no notification.
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { status: 'error', error: 'old failure', text: 'old failure' } })
  await waitFor(() => chatEl.querySelector('.gbo-turn-error'), 'the failed-turn card')
  await tick()
  assert.equal(sent.length, 0, 'a failed turn never notifies')

  // A background follow-up with no user row, successful: one notification.
  emit({ type: 'message.start', session_id: 'rt-security', payload: { display_kind: 'process_complete' } })
  emit({ type: 'message.delta', session_id: 'rt-security', payload: { text: 'successful ' } })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: 'successful follow-up' } })
  await waitFor(() => chatEl.textContent.includes('successful follow-up'), 'the follow-up reply')
  await waitFor(() => sent.length === 1, 'the successful background reply notifies')
  assert.equal(sent[0].body, 'Replied.')
  assert.ok(chatEl.querySelector('.gbo-turn-error'), 'the old error stays visible')

  // And a later failure of its own still stays quiet.
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.delta', session_id: 'rt-security', payload: { text: 'partial' } })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { status: 'error', error: 'new failure', text: 'partial' } })
  await tick(200)
  assert.equal(sent.length, 1, 'the new failed turn does not notify')

  // Review C-R3-04: a background turn that STARTS while Hermes is focused and
  // finishes after it lost focus still notifies, despite the old errors.
  focused = true
  emit({ type: 'message.start', session_id: 'rt-security', payload: { display_kind: 'process_complete' } })
  await tick()
  focused = false
  emit({ type: 'message.delta', session_id: 'rt-security', payload: { text: 'finished ' } })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: 'finished in the background' } })
  await waitFor(() => chatEl.textContent.includes('finished in the background'), 'the reply')
  await waitFor(() => sent.length === 2, 'a turn started while focused notifies when it ends unfocused')
})
