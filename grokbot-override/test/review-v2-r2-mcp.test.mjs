// Review override-v2-r2 M3 (src/ui/ProfileConfig.tsx McpSetup): closing the
// config panel while the first key write is pending starts no further key
// write and no server test. Synthetic keys only; one boot per file.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, buttonWithText, dialogEl, SCOUT } from './loader-surfaces.mjs'

const skip = !READY && 'dev dependencies not installed'

function deferred() {
  let resolve
  const promise = new Promise(res => {
    resolve = res
  })
  return { promise, resolve }
}
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

function typeInto(input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('v2-r2 M3: closing the config panel during key setup sends no further key and no server test', { skip }, async t => {
  const gate = deferred()
  const { panes, mount, calls, internals } = await bootFull(t, {
    primitives: false,
    answers: {
      'mcp.servers.set_api_key': params => (params.env_var === 'A_KEY' ? gate.promise : { ok: true }),
      'mcp.servers.test': () => ({ ok: true })
    }
  })
  mount(panes.find(p => p.id === 'roster').render)
  internals.openDialog({ kind: 'config', bot: SCOUT, initial: { loaded: true, provider: '', model: '', soul: '', skills: [], toolsets: [], mcp: [{ name: 'keyed', enabled: false, fromCatalog: true, requires: ['A_KEY', 'B_KEY'] }] } })
  const dialog = await waitFor(() => dialogEl(false), 'the config dialog')
  buttonWithText(dialog, 'Set up').click()
  const inputs = await waitFor(() => {
    const list = [...dialog.querySelectorAll('input[type="password"]')]
    return list.length === 2 ? list : null
  }, 'the key fields')
  typeInto(inputs[0], 'synthetic-a')
  typeInto(inputs[1], 'synthetic-b')
  buttonWithText(dialog, 'Save and test').click()
  await waitFor(() => calls.some(c => c.method === 'mcp.servers.set_api_key'), 'the first key write')
  internals.openDialog(null)
  await waitFor(() => !dialogEl(false), 'the panel closed')
  gate.resolve({ ok: true })
  await tick(60)
  const keys = calls.filter(c => c.method === 'mcp.servers.set_api_key').map(c => c.params.env_var)
  assert.deepEqual(keys, ['A_KEY'], 'no key is written after the panel closed')
  assert.equal(calls.filter(c => c.method === 'mcp.servers.test').length, 0, 'no server test after the panel closed')
})
