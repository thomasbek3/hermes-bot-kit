// T8: the composer keeps the typed text per bot across switches (built
// plugin.js under Hermes's loader, typed like a user), and a send clears it.
// Plus the pure draft store (core/drafts.js createDraftTexts).

import assert from 'node:assert/strict'
import test from 'node:test'

import { createDraftTexts } from '../src/core/drafts.js'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('draft texts: per owner, empty clears, capped at 20 owners and 4 KB', () => {
  const d = createDraftTexts()
  d.set('a', 'hello')
  d.set('b', 'other')
  assert.equal(d.get('a'), 'hello')
  assert.equal(d.get('b'), 'other')
  assert.equal(d.get('c'), '')
  d.set('a', '   ')
  assert.equal(d.get('a'), '', 'whitespace only is no draft')
  d.set('a', 'x'.repeat(4097))
  assert.equal(d.get('a'), '', 'over 4 KB is not remembered')
  d.set('a', 'x'.repeat(4096))
  assert.equal(d.get('a').length, 4096)
  for (let i = 0; i < 25; i += 1) d.set(`k${i}`, `t${i}`)
  assert.equal(d.size(), 20)
  assert.equal(d.get('k0'), '', 'the oldest owner goes first')
  assert.equal(d.get('k24'), 't24')
  d.clear('k24')
  assert.equal(d.get('k24'), '')
  d.set('', 'no owner')
  assert.equal(d.get(''), '')
})

test('composer: a draft survives switching bots and coming back; a send clears it', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount, calls } = await bootPlugin(t, { answers: { 'prompt.submit': () => ({ status: 'streaming' }) } })
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
  type(await box(), 'half-written note for security')
  await waitFor(() => chatEl.querySelector('textarea').value === 'half-written note for security', 'typed')

  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'scholar transcript')
  assert.equal((await box()).value, '', 'the other bot starts with its own (empty) draft')
  type(await box(), 'scholar draft')

  ;(await row('Security')).click()
  await waitFor(() => chatEl.textContent.includes('hello security'), 'back to security')
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'half-written note for security', 'the security draft is back')

  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'scholar draft', 'the scholar draft is back')

  // Send: the composer empties and the draft is gone for good.
  ;(await row('Security')).click()
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'half-written note for security', 'security again')
  const el = await box()
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => calls.some(c => c.method === 'prompt.submit'), 'sent')
  await waitFor(() => chatEl.querySelector('textarea')?.value === '', 'the composer empties')
  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.querySelector('textarea')?.value === 'scholar draft', 'scholar keeps its draft')
  ;(await row('Security')).click()
  await waitFor(() => chatEl.textContent.includes('hello security'), 'security once more')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(chatEl.querySelector('textarea').value, '', 'no draft after the send')
})
