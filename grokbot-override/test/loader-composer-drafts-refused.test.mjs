// Review C-R1-02 (T8): a send that Hermes definitely refuses (4009 session
// busy, nothing admitted) after the user already switched to another bot puts
// the text back in the first bot's draft. An `unknown` delivery is never
// restored. Built plugin.js under Hermes's loader; one plugin per file.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const rpcError = (code, message) => Object.assign(new Error(message), { code })

test('composer: a refused send after a bot switch comes back as that bot\'s draft', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const pending = []
  const { panes, workspaces, mount, calls } = await bootPlugin(t, {
    answers: { 'prompt.submit': () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = name => waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name)), `${name} row`)
  ;(await row('Security')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  const box = () => waitFor(() => {
    const el = chatEl.querySelector('textarea')
    return el && !el.disabled ? el : null
  }, 'an enabled composer')
  await waitFor(() => chatEl.textContent.includes('hello security'), 'security transcript')
  await new Promise(resolve => setTimeout(resolve, 50))
  type(await box(), 'preserve this refused draft')
  await waitFor(() => chatEl.querySelector('textarea').value === 'preserve this refused draft', 'typed')
  ;(await box()).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => pending.length === 1, 'the submit is in flight')
  await waitFor(() => chatEl.querySelector('textarea')?.value === '', 'the composer empties optimistically')

  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'scholar transcript')
  pending[0].reject(rpcError(4009, 'session busy'))
  await new Promise(resolve => setTimeout(resolve, 100))

  ;(await row('Security')).click()
  await waitFor(() => chatEl.textContent.includes('hello security'), 'back to security')
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'preserve this refused draft', 'the refused text is back in Security\'s composer')
  assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 1, 'never resent by itself')

  // An unknown delivery (no answer: it may have reached the bot) is never
  // put back, so it cannot invite a duplicate send.
  type(await box(), 'maybe delivered')
  await waitFor(() => chatEl.querySelector('textarea').value === 'maybe delivered', 'typed again')
  ;(await box()).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => pending.length === 2, 'the second submit is in flight')
  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'scholar again')
  pending[1].reject(new Error('socket closed'))
  await new Promise(resolve => setTimeout(resolve, 100))
  ;(await row('Security')).click()
  await waitFor(() => chatEl.textContent.includes('hello security'), 'security again')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(chatEl.querySelector('textarea').value, '', 'an unknown delivery is not restored')
})
