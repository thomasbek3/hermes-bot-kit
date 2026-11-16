// Review C-R2-01 (T8): send from Security, switch to Scholar and BACK to
// Security before Hermes answers, then Hermes definitely refuses the send
// (4009 session busy). The live Security composer gets the text back with the
// refusal note, the failed bubble is dropped only because the composer now
// holds it, and the next edit does not lose anything. Built plugin.js under
// Hermes's loader; one plugin per file.

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
const tick = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))

test('composer: A → B → A, then a refusal: the text comes back into the live composer', { skip: !READY && 'dev dependencies not installed' }, async t => {
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
  await tick(50)
  type(await box(), 'preserve this refused draft')
  await waitFor(() => chatEl.querySelector('textarea').value === 'preserve this refused draft', 'typed')
  ;(await box()).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => pending.length === 1, 'the submit is in flight')

  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'scholar transcript')
  ;(await row('Security')).click()
  await waitFor(() => chatEl.textContent.includes('hello security'), 'back to security before the answer')
  await tick(50)
  assert.equal(chatEl.querySelector('textarea').value, '', 'still empty while the send is pending')

  pending[0].reject(rpcError(4009, 'session busy'))
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'preserve this refused draft', 'the refused text is back in the live composer')
  assert.match(chatEl.textContent, /Your message is back in the composer/, 'the refusal note shows')
  // The composer is the recovery route: no second copy as a failed bubble.
  const bubbles = [...chatEl.querySelectorAll('.bubble')].filter(b => b.textContent.includes('preserve this refused draft'))
  assert.equal(bubbles.length, 0, 'the failed bubble is dropped once the composer holds the text')

  // The next edit builds on it; switching away and back keeps it.
  type(await box(), 'preserve this refused draft, edited')
  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'scholar again')
  ;(await row('Security')).click()
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'preserve this refused draft, edited', 'the edited draft survives')
  assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 1, 'never resent by itself')

  // A newer draft typed before the refusal is never overwritten; the failed
  // bubble then stays as the recovery route.
  type(await box(), 'second refused send')
  await waitFor(() => chatEl.querySelector('textarea').value === 'second refused send', 'typed the second')
  ;(await box()).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => pending.length === 2, 'the second submit is in flight')
  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'scholar a third time')
  ;(await row('Security')).click()
  await waitFor(() => chatEl.textContent.includes('hello security'), 'security a third time')
  await tick(50)
  type(await box(), 'newer text')
  await waitFor(() => chatEl.querySelector('textarea').value === 'newer text', 'typed newer text')
  pending[1].reject(rpcError(4009, 'session busy'))
  await tick(150)
  assert.equal(chatEl.querySelector('textarea').value, 'newer text', 'the newer draft is kept')
  assert.ok(chatEl.textContent.includes('second refused send'), 'the failed bubble stays as the way to retry it')
})
