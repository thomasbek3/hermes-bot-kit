// Shared steps for the round-3 draft regressions (C-R3-01..03): the built
// plugin under Hermes's loader, typed like a user. Not a test file.

import { bootPlugin, waitFor } from './loader-boot.mjs'

export function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
export const rpcError = (code, message) => Object.assign(new Error(message), { code })
export const tick = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))

/** Boot, open Security; returns helpers to drive the roster and composer. */
export async function openSecurity(t, answers) {
  const booted = await bootPlugin(t, { answers })
  const { panes, workspaces, mount } = booted
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
  const open = async name => {
    ;(await row(name)).click()
    await waitFor(() => chatEl.textContent.includes(`hello ${name.toLowerCase()}`), `${name} transcript`)
    await tick(50)
  }
  const send = async value => {
    type(await box(), value)
    await waitFor(() => chatEl.querySelector('textarea').value === value, `typed ${value}`)
    ;(await box()).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  return { ...booted, chatEl, box, open, send }
}
