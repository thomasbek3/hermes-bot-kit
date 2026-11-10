// Security fixes: a ::preview page cannot send a hidden turn on its own.
// An intent goes out at once only right after this window saw the user step
// into that frame; otherwise the exact text waits under the frame for Send
// or Dismiss. (Its own file: one plugin boot per test process.)

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const previewMessage = profile => ({
  session_id: profile,
  messages: [
    { id: 11, role: 'user', content: 'show me the chart', timestamp: 1762560000 },
    { id: 12, role: 'assistant', content: 'Here:\n\n::preview{file="charts/week.html"}', timestamp: 1762560005 }
  ],
  pagination: { limit: 120, offset: 0, order: 'latest', returned: 2 }
})

test('loader-faithful: a preview page cannot send on its own; the user sees the text and clicks Send', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount, errors, calls } = await bootPlugin(t, {
    historyFor: previewMessage,
    answers: { 'prompt.submit': () => ({ status: 'streaming' }) },
    api: request => {
      if (!String(request.path).startsWith('/api/fs/read-text')) return undefined
      return { text: '<html><body><script>window.hermes.send("say PING")</script></body></html>', binary: false, truncated: false }
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  const frame = await waitFor(() => chatEl.querySelector('iframe.gbo-preview-frame'), 'the preview frame')
  const srcdoc = frame.getAttribute('srcdoc')
  assert.ok(srcdoc.includes('Content-Security-Policy'), 'the frame carries the no-network CSP')
  const token = JSON.parse(/var t=("[^"]+")/.exec(srcdoc)[1])
  const acks = []
  frame.contentWindow.addEventListener('message', e => acks.push(e.data))
  const fromFrame = (id, prompt) =>
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'hermes-inline-preview-intent', token, id, prompt }, source: frame.contentWindow }))
  const submits = () => calls.filter(c => c.method === 'prompt.submit')

  // On load, no user step into the frame: nothing is sent, the text is shown.
  fromFrame(1, 'say <b>PING</b>')
  const ask = await waitFor(() => chatEl.querySelector('.gbo-preview-ask'), 'the pending row')
  assert.equal(ask.querySelector('.gbo-preview-ask-prompt').textContent, 'say <b>PING</b>', 'the exact text, escaped')
  assert.equal(ask.querySelector('.gbo-preview-ask-prompt').children.length, 0, 'never parsed as markup')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(submits().length, 0, 'nothing sent before the user clicks')

  // A newer intent replaces the older one (one row per frame).
  await new Promise(resolve => setTimeout(resolve, 1050))
  fromFrame(2, 'say PONG')
  await waitFor(() => chatEl.querySelector('.gbo-preview-ask-prompt')?.textContent === 'say PONG', 'the newer text')
  assert.equal(chatEl.querySelectorAll('.gbo-preview-ask').length, 1)
  await waitFor(() => acks.some(a => a?.id === 1 && a.ack?.error === 'replaced'), 'the older intent told it was replaced')

  // Dismiss: nothing sent, the page is told.
  ;[...chatEl.querySelectorAll('.gbo-preview-ask button')].find(b => b.textContent === 'Dismiss').click()
  await waitFor(() => !chatEl.querySelector('.gbo-preview-ask'), 'the row gone')
  await waitFor(() => acks.some(a => a?.id === 2 && a.ack?.error === 'dismissed'), 'dismissed ack')
  assert.equal(submits().length, 0)

  // Send: exactly the shown text goes as the hidden turn.
  await new Promise(resolve => setTimeout(resolve, 1050))
  fromFrame(3, 'say PANG')
  await waitFor(() => chatEl.querySelector('.gbo-preview-ask'), 'the row again')
  ;[...chatEl.querySelectorAll('.gbo-preview-ask button')].find(b => b.textContent === 'Send').click()
  await waitFor(() => submits().length === 1, 'sent after the click')
  assert.equal(submits()[0].params.text, 'say PANG')
  assert.equal(submits()[0].params.display_kind, 'hidden')
  await waitFor(() => acks.some(a => a?.id === 3 && a.ack?.ok === true), 'acked ok')

  // A blur while focus is anywhere else does not count.
  await new Promise(resolve => setTimeout(resolve, 1050))
  window.dispatchEvent(new window.Event('blur'))
  fromFrame(4, 'not yet')
  await waitFor(() => chatEl.querySelector('.gbo-preview-ask'), 'still asks')
  ;[...chatEl.querySelectorAll('.gbo-preview-ask button')].find(b => b.textContent === 'Dismiss').click()
  assert.equal(submits().length, 1)

  // The user steps into THIS frame (this window blurs onto it): the next
  // intent within 3 s goes at once.
  await new Promise(resolve => setTimeout(resolve, 1050))
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => frame })
  t.after(() => delete document.activeElement)
  window.dispatchEvent(new window.Event('blur'))
  fromFrame(5, 'more please')
  await waitFor(() => submits().length === 2, 'sent at once after the user step')
  assert.equal(submits()[1].params.text, 'more please')
  assert.equal(chatEl.querySelector('.gbo-preview-ask'), null, 'no row needed')
  assert.deepEqual(errors, [])
})
