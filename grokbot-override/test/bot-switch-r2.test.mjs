// Review tighter-b r2 #2 (T9), loader-faithful: while a remembered chat is
// checked its composer cannot send (as during any open), so no send can be
// taken and then lost by a bot switch; once the check is done, a send goes
// to the checked Bot Chat.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const deferred = () => {
  let resolve
  const promise = new Promise(res => (resolve = res))
  return { promise, resolve }
}

test('loader: Send is held off while a remembered chat is checked, a switch loses nothing, and the checked chat gets the send', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let gate = null
  const answers = {
    'session.list': async (_params, profile) => {
      if (gate && profile === 'security') await gate.promise
      return { sessions: profile === 'security' ? [{ id: 's-root', title: 'Bot Chat', message_count: 4 }] : [{ id: 'k-root', resolved_id: 'k-tip', title: 'Bot Chat', message_count: 4 }] }
    },
    'prompt.submit': () => ({ status: 'streaming' })
  }
  const { workspaces, mount, errors, internals, calls } = await bootPlugin(t, { smoke: true, answers, storage: { selected: 'local::security' } })
  const { app, selectBot } = internals
  const row = name => app.roster.get().rows.find(r => r.name === name)
  const mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'Security’s chat')
  selectBot(row('scholar'))
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'Scholar’s chat')

  // Back to Security with its registry check held.
  gate = deferred()
  selectBot(row('security'))
  await waitFor(() => mainEl.textContent.includes('hello security'), 'the remembered transcript')
  assert.equal(app.chat.get().checking, true)
  const input = () => mainEl.querySelector('textarea')
  const sendButton = () => mainEl.querySelector('button.is-send')
  assert.ok(input().disabled, 'the composer waits for the check, as on any open')
  assert.ok(sendButton().disabled, 'Send cannot be pressed')
  input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  // Switching away mid-check, then back, after the check could finish.
  selectBot(row('scholar'))
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'Scholar again')
  gate.resolve()
  gate = null
  selectBot(row('security'))
  await waitFor(() => app.chat.get()?.checking === false && app.chat.get().phase === 'ready', 'Security checked')
  assert.ok(!calls.some(c => c.method === 'prompt.submit'), 'nothing was sent, nothing parked')

  await waitFor(() => input() && !input().disabled, 'the composer is enabled')
  type(input(), 'after the check')
  await waitFor(() => !sendButton().disabled, 'Send enabled')
  sendButton().click()
  await waitFor(() => calls.some(c => c.method === 'prompt.submit'), 'the send')
  const submit = calls.find(c => c.method === 'prompt.submit')
  assert.equal(submit.params.text, 'after the check')
  assert.equal(submit.params.session_id, 'rt-security', 'on the checked Bot Chat’s runtime')
  assert.equal(app.chat.get().storedId, 's-root')
  await waitFor(() => mainEl.textContent.includes('after the check'), 'the bubble')
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
