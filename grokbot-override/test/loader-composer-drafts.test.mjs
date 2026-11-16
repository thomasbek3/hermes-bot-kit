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

test('draft texts: per owner, empty clears, capped at 20 owners, any length kept whole', () => {
  const d = createDraftTexts()
  d.set('a', 'hello')
  d.set('b', 'other')
  assert.equal(d.get('a'), 'hello')
  assert.equal(d.get('b'), 'other')
  assert.equal(d.get('c'), '')
  d.set('a', '   ')
  assert.equal(d.get('a'), '', 'whitespace only is no draft')
  d.set('a', 'x'.repeat(4096))
  d.set('a', 'x'.repeat(4097))
  assert.equal(d.get('a').length, 4097, 'crossing 4 KB never drops the draft (C-R1-01)')
  d.set('a', 'y'.repeat(100_000))
  assert.equal(d.get('a').length, 100_000)
  for (let i = 0; i < 25; i += 1) d.set(`k${i}`, `t${i}`)
  assert.equal(d.size(), 20)
  assert.equal(d.get('k0'), '', 'the oldest owner goes first')
  assert.equal(d.get('k24'), 't24')
  d.clear('k24')
  assert.equal(d.get('k24'), '')
  d.set('', 'no owner')
  assert.equal(d.get(''), '')
})

test('draft texts: a refused send goes to a live empty composer, else to the store for the next one, never over a newer draft', () => {
  const d = createDraftTexts()
  // No composer on screen: stored, with a pending record for the next mount.
  assert.equal(d.restore('a', 'refused', { clientId: 'local:1', note: 'Not sent' }), true)
  assert.equal(d.get('a'), 'refused')
  assert.equal(d.take('a', 'something else'), null, 'only when the composer shows that text')
  d.restore('a', 'x')
  assert.equal(d.get('a'), 'refused', 'never over a newer draft')
  d.set('a', '')
  assert.equal(d.restore('a', 'again', { clientId: 'local:2', note: 'n' }), true)
  assert.deepEqual(d.take('a', 'again'), { text: 'again', clientId: 'local:2', note: 'n' })
  assert.equal(d.take('a', 'again'), null, 'consumed')
  // A live composer that is empty takes it; the store is left to its own write.
  d.set('b', '')
  const got = []
  const off = d.subscribe('b', (text, info) => (got.push([text, info.clientId]), true))
  assert.equal(d.restore('b', 'live one', { clientId: 'local:3' }), true)
  assert.deepEqual(got, [['live one', 'local:3']])
  assert.equal(d.take('b', 'live one'), null, 'no pending record when a live composer took it')
  off()
  // A live composer that refuses (it holds files) leaves nothing behind.
  const off2 = d.subscribe('c', () => false)
  assert.equal(d.restore('c', 'refused', {}), false)
  assert.equal(d.get('c'), '')
  off2()
  // Typing something else drops the pending record.
  d.restore('e', 'pending text', { clientId: 'local:4' })
  d.set('e', 'typed over')
  assert.equal(d.take('e', 'pending text'), null)
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
