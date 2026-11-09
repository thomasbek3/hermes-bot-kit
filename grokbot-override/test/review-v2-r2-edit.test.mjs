// Review override-v2-r2 sweep S3 (src/ui/BotDialogs.tsx EditProfileDialog):
// the description is re-read from a source-scoped bot's own backend when Edit
// profile opens; a read landing after the user typed never replaces the text
// (it would otherwise silently discard the edit). One boot per file.

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
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('v2-r2 S3: a late server read of the description never replaces what the user typed', { skip }, async t => {
  const gate = deferred()
  let hold = false
  const { panes, mount, calls, internals } = await bootFull(t, {
    primitives: false,
    answers: {
      'profiles.list': (params, profile) => (hold && profile === 'scout' ? gate.promise : { profiles: [] }),
      'cli.exec': () => ({ code: 0 })
    }
  })
  mount(panes.find(p => p.id === 'roster').render)
  hold = true
  internals.openDialog({ kind: 'edit', bot: { ...SCOUT, description: 'old roster text' } })
  const dialog = await waitFor(() => dialogEl(false), 'the edit dialog')
  const area = await waitFor(() => dialog.querySelector('textarea'), 'the description field')
  await waitFor(() => calls.some(c => c.method === 'profiles.list' && c.via === 'mini::scout'), 'the server read')
  typeInto(area, 'my new words')
  gate.resolve({ profiles: [{ name: 'scout', description: 'server text', ui_meta: { 'hermes-bots': {} } }] })
  await tick(60)
  assert.equal(dialog.querySelector('textarea').value, 'my new words', 'the typed description stays')
  hold = false
  buttonWithText(dialog, 'Save').click()
  const exec = await waitFor(() => calls.find(c => c.method === 'cli.exec'), 'the describe write')
  assert.ok(exec.params.argv.includes('my new words'))
})
