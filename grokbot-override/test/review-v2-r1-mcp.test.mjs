// Review override-v2-r1 #5 (src/ui/ProfileConfig.tsx McpSetup): MCP keys are
// never kept after a failed setup, never resent invisibly, never echoed in an
// error; and the sweep's same-class instance: an MCP sign-in whose panel was
// closed is cancelled (stock mcp-setup.tsx oauthEpoch), not left running.
// The built plugin.js under Hermes's loader, real clicks and typing.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, buttonWithText, CONFIG, dialogEl, reactErrors, SCOUT } from './loader-surfaces.mjs'

function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

test('v2-r1 #5 a failed MCP key setup keeps no key: the retry shows empty fields and transmits nothing old; errors never echo a key; a closed sign-in is cancelled', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let failB = true
  let oauth = null
  const { panes, mount, calls, errors, internals } = await bootFull(t, {
    primitives: false,
    tweak: sdk => {
      sdk.host.completeMcpOAuth = options => {
        oauth = options
        return new Promise(() => undefined) // the browser sign-in never finishes
      }
    },
    answers: {
      'mcp.servers.add': () => ({ ok: true }),
      'mcp.servers.set_api_key': params => {
        if (params.env_var === 'B_KEY' && failB) throw new Error(`invalid value for B_KEY: ${params.value}`)
        return { ok: true }
      },
      'mcp.servers.test': () => ({ ok: true })
    }
  })
  mount(panes.find(p => p.id === 'roster').render)
  const config = {
    ...CONFIG,
    mcp: [
      { name: 'keyed', enabled: false, fromCatalog: true, requires: ['A_KEY', 'B_KEY'] },
      { name: 'signin', enabled: false, fromCatalog: true, auth: 'oauth' }
    ]
  }
  internals.openDialog({ kind: 'config', bot: SCOUT, initial: config })
  const dialog = await waitFor(() => dialogEl(false), 'the config dialog')
  const setUp = () => [...dialog.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Set up')[0]
  const keyCalls = () => calls.filter(c => c.method === 'mcp.servers.set_api_key')

  setUp().click()
  const inputs = await waitFor(() => {
    const list = [...dialog.querySelectorAll('input[type="password"]')]
    return list.length === 2 ? list : null
  }, 'the key fields')
  typeInto(inputs[0], 'secret-a-123')
  typeInto(inputs[1], 'secret-b-456')
  buttonWithText(dialog, 'Save and test').click()
  await waitFor(() => dialog.querySelector('.gbo-card-error'), 'the failure')
  assert.equal(keyCalls().length, 2)
  assert.ok(!dialog.textContent.includes('secret-b-456') && !dialog.textContent.includes('secret-a-123'), 'the error never echoes a key value')

  // Retry: the fields are empty, and saving without re-entering sends nothing old.
  failB = false
  setUp().click()
  const again = await waitFor(() => {
    const list = [...dialog.querySelectorAll('input[type="password"]')]
    return list.length === 2 ? list : null
  }, 'the key fields again')
  assert.deepEqual(again.map(i => i.value), ['', ''], 'the retry shows empty fields')
  buttonWithText(dialog, 'Save and test').click()
  await tick(60)
  assert.equal(keyCalls().length, 2, 'no key from the failed attempt is transmitted again')
  assert.ok(!keyCalls().slice(2).some(c => /secret-/.test(String(c.params.value))))

  // A sign-in left running when the panel closes is cancelled (stock oauthEpoch).
  const signIn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign in')
  assert.ok(signIn, 'the OAuth server offers Sign in')
  signIn.click()
  await waitFor(() => oauth, 'the sign-in started')
  assert.equal(oauth.cancelled(), false, 'running while the panel is open')
  internals.openDialog(null)
  await waitFor(() => !dialogEl(false), 'the dialog to close')
  await tick()
  assert.equal(oauth.cancelled(), true, 'closing the panel cancels the sign-in')
  assert.deepEqual(reactErrors(errors), [])
})
