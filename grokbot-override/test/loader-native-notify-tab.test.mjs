// Review C-R2-02 (T7): an override chat open in a side tab (Share → Open
// another chat beside this one) sends native notifications too, while the
// main tab shows another bot: reply, approval and input needed. A bot open in
// both tabs notifies once per reply. Built plugin.js under Hermes's loader,
// stub ctx.os.notify; one plugin per file.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const tick = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))

test('native notifications: a side-tab chat notifies while the main tab shows another bot', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const sent = []
  const revealed = []
  const { panes, workspaces, mount, emit, sdk } = await bootPlugin(t, { ctxExtras: { os: { notify: n => sent.push(n) } } })
  const reveal = sdk.host.revealPane
  sdk.host.revealPane = id => (revealed.push(id), reveal(id))
  let focused = true
  document.hasFocus = () => focused
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = name => waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name)), `${name} row`)
  ;(await row('Security')).click()
  const mainEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'security in the main tab')

  // Security beside, then the main tab follows Scholar.
  mainEl.querySelector('button[aria-label="Share"]').click()
  ;(await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('Open another chat beside this one')), 'the Share menu')).click()
  const [sideId, side] = await waitFor(() => [...workspaces.entries()].find(([id]) => String(id).startsWith('grokbot-override-tab-')), 'the side tab')
  const sideEl = mount(side.render)
  await waitFor(() => sideEl.textContent.includes('hello security'), 'security in the side tab')
  ;(await row('Scholar')).click()
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'scholar in the main tab')
  await tick()
  assert.equal(sent.length, 0, 'opening chats notifies nothing')

  focused = false
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.delta', session_id: 'rt-security', payload: { text: 'extra reply' } })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: 'extra reply' } })
  await waitFor(() => sideEl.textContent.includes('extra reply'), 'the side tab shows the reply')
  await waitFor(() => sent.length === 1, 'one notification for the side-tab reply')
  assert.equal(sent[0].title, 'Security')
  assert.equal(sent[0].body, 'Replied.')

  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'approval.request', session_id: 'rt-security', payload: { request_id: 'ap-side', command: 'rm -rf /tmp/x', description: 'delete' } })
  await waitFor(() => sent.length === 2, 'the side-tab approval notifies')
  assert.equal(sent[1].body, 'Needs your approval.')

  emit({ type: 'clarify.request', session_id: 'rt-security', payload: { request_id: 'q-side', question: 'Which one?', choices: ['a', 'b'] } })
  await waitFor(() => sent.length === 3, 'the side-tab question notifies')
  assert.equal(sent[2].body, 'Has a question for you.')

  // Clicking it brings that side tab forward.
  sent[0].onActivate()
  assert.ok(revealed.includes(`plugin-workspace:${sideId}`), 'the side tab is revealed')

  // The same bot in both tabs: one notification per reply.
  emit({ type: 'approval.settled', session_id: 'rt-security', payload: { request_id: 'ap-side' } })
  emit({ type: 'clarify.settled', session_id: 'rt-security', payload: { request_id: 'q-side' } })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: 'closing the side turn' } })
  await waitFor(() => sent.length === 4, 'the side turn ends')
  focused = true
  ;(await row('Security')).click()
  await waitFor(() => mainEl.textContent.includes('hello security'), 'security in both tabs')
  await tick()
  focused = false
  const before = sent.length
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: 'shared reply' } })
  await waitFor(() => sideEl.textContent.includes('shared reply') && mainEl.textContent.includes('shared reply'), 'both tabs show it')
  await tick(150)
  assert.equal(sent.length - before, 1, 'one notification, not one per tab')
})
