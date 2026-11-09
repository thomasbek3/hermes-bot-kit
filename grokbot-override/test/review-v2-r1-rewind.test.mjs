// Review override-v2-r1 #3 in the UI: "Rewind to here" on a canonical
// gateway runs session.rewind on the selected row, never the legacy slash
// route; a refused rewind leaves the composer alone; a confirmed one brings the
// message back without overwriting what the user had typed. The built
// plugin.js under Hermes's loader (test/hermes-loader.mjs), real clicks.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

test('v2-r1 #3 Rewind to here: canonical rewind, prefill only after a confirmed rewind, an existing draft is kept', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let refuse = true
  const { panes, workspaces, mount, errors, calls } = await bootPlugin(t, {
    answers: {
      'session.rewind': params => {
        if (refuse) throw Object.assign(new Error('revision conflict'), { code: 4001, data: { reason: 'revision_conflict' } })
        return { status: 'rewound', rewound_count: 4, target_message: { id: params.target_message_id, content: 'hello security' } }
      }
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Security')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => chatEl.textContent.includes('hello security'), 'transcript')
  const box = await waitFor(() => {
    const el = chatEl.querySelector('textarea')
    return el && !el.disabled ? el : null
  }, 'an enabled composer')
  await tick()
  type(box, 'my draft')
  const rewind = () => chatEl.querySelector('button[aria-label="Rewind to here"]')

  ;(await waitFor(rewind, 'the Rewind action')).click()
  await waitFor(() => calls.some(c => c.method === 'session.rewind'), 'session.rewind sent')
  await waitFor(() => chatEl.textContent.includes('revision conflict'), 'the refusal is shown')
  await tick()
  assert.equal(box.value, 'my draft', 'a refused rewind puts nothing in the composer')
  const rewound = calls.find(c => c.method === 'session.rewind')
  assert.equal(rewound.via, 'local::security')
  assert.equal(rewound.params.target_message_id, 11, 'the selected durable row is the target')
  assert.ok(!calls.some(c => c.method === 'slash.exec' || c.method === 'command.dispatch'), 'never the legacy slash route on a canonical gateway')

  refuse = false
  ;(await waitFor(rewind, 'the Rewind action again')).click()
  await waitFor(() => box.value.includes('hello security'), 'the rewound message comes back')
  assert.equal(box.value, 'my draft\n\nhello security', 'the draft is kept, the message goes below it')
  assert.ok(chatEl.textContent.includes('Your draft was kept'))
  assert.ok(!calls.some(c => c.method === 'prompt.submit'), 'rewinding never sends')
  assert.deepEqual(errors, [])
})
