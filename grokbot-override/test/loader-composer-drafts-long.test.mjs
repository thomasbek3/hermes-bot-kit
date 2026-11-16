// Review C-R1-01 (T8): a draft that crosses 4,096 characters is kept whole
// across a bot switch (built plugin.js under Hermes's loader). One plugin per
// file: react-dom binds to the first window it sees.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('composer: a draft past 4 KB survives switching bots and coming back', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount } = await bootPlugin(t)
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
  const long = 'x'.repeat(4096)
  type(await box(), long)
  type(await box(), `${long}y`)
  await waitFor(() => chatEl.querySelector('textarea').value.length === 4097, 'typed past 4 KB')
  ;(await row('Scholar')).click()
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'scholar transcript')
  ;(await row('Security')).click()
  await waitFor(() => chatEl.textContent.includes('hello security'), 'back to security')
  await waitFor(() => chatEl.querySelector('textarea')?.value === `${long}y`, 'the whole 4,097-character draft is back')
})
