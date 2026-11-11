// The failed-turn card in the built plugin.js under Hermes's loader
// (test/hermes-loader.mjs), real clicks: the card replaces the red error and
// the grey boundary line, Details holds the raw text, Try again runs the
// supported /retry once (double click included), a second failure offers a
// new chat, the /undo echo is one muted note, and ordinary text that says
// "error" is drawn as before.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const RAW = 'HTTP 400: {"detail":"Bad Request"}'
const PARTIAL = 'This turn did not complete. Some actions may already have run; verify their effects before resending.'
const t0 = 1762560000

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

test('failed turn card: Details, one retry per press, then "Start a new chat"; /undo is a muted note', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let phase = 'failed'
  const base = [
    { id: 9, role: 'user', content: 'what does error 42 mean?', timestamp: t0 - 10 },
    { id: 10, role: 'assistant', content: 'Error 42 means the disk is full.', timestamp: t0 - 9 },
    { id: 11, role: 'user', content: 'book the flight', timestamp: t0 }
  ]
  const failedRow = id => ({ id, role: 'assistant', content: PARTIAL, display_kind: 'failed_turn', display_metadata: { error: RAW }, timestamp: t0 + 1 })
  const rowsNow = () =>
    phase === 'failed'
      ? [...base, failedRow(12)]
      : phase === 'rewound'
        ? base.slice(0, 2)
        : [...base.slice(0, 2), { id: 21, role: 'user', content: 'book the flight', timestamp: t0 + 5 }, failedRow(22)]
  const { panes, workspaces, mount, errors, calls, emit } = await bootPlugin(t, {
    historyFor: profile => ({ session_id: profile, messages: rowsNow(), pagination: { limit: 120, offset: 0, order: 'latest', returned: rowsNow().length } }),
    answers: {
      'session.resume': () => ({
        session_id: 'rt-security',
        running: false,
        message_count: rowsNow().length,
        messages: rowsNow().map(r => ({ ...r, row_id: r.id }))
      }),
      'session.rewind': params => {
        if (params.replay_only) return { rewound_count: 0 }
        phase = 'rewound'
        return { status: 'rewound', rewound_count: 2, target_message: { id: params.target_message_id, content: 'book the flight' } }
      },
      'prompt.submit': () => {
        phase = 'failed-again'
        return { status: 'streaming' }
      },
      'session.active_list': () => ({ sessions: [] })
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Security')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  const card = () => chatEl.querySelector('.gbo-turn-error')
  await waitFor(card, 'the failed-turn card')

  // The card, not the red error or the grey line.
  assert.ok(card().textContent.includes('That reply didn’t go through.'))
  assert.equal(chatEl.querySelector('.gbo-error'), null, 'no raw red error')
  assert.ok(![...chatEl.querySelectorAll('.gbo-notice')].some(n => n.textContent.includes('did not complete')), 'no grey boundary line')
  const detail = card().querySelector('.gbo-turn-error-detail')
  assert.ok(detail.hidden, 'the raw error is collapsed')
  assert.ok(detail.textContent.includes(RAW) && detail.textContent.includes(PARTIAL), 'Details keeps the raw text')
  card().querySelector('.gbo-turn-error-toggle').click()
  await waitFor(() => !card().querySelector('.gbo-turn-error-detail').hidden, 'Details opens')

  // Normal text containing "error" is drawn as before.
  assert.ok(chatEl.textContent.includes('what does error 42 mean?'))
  assert.ok(chatEl.textContent.includes('Error 42 means the disk is full.'))

  // Try again, pressed twice: one rewind, one resubmit of the same message.
  const button = [...card().querySelectorAll('button')].find(b => b.textContent === 'Try again')
  assert.ok(button && !button.disabled)
  button.click()
  button.click()
  await waitFor(() => calls.some(c => c.method === 'prompt.submit'), 'the message is resubmitted')
  await tick(120)
  const rewinds = calls.filter(c => c.method === 'session.rewind' && !c.params.replay_only)
  assert.equal(rewinds.length, 1, 'one rewind for a double press')
  assert.equal(rewinds[0].params.target_message_id, 11, 'the failed user turn is rewound')
  const submits = calls.filter(c => c.method === 'prompt.submit')
  assert.equal(submits.length, 1, 'one resubmit for a double press')
  assert.equal(submits[0].params.text, 'book the flight', 'the original message')

  // It fails again: the card says so and offers a new chat with this bot.
  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { status: 'error', error: RAW, text: `Request rejected.\nDetails: ${RAW}` } })
  const fresh = await waitFor(() => [...chatEl.querySelectorAll('.gbo-turn-error button')].find(b => b.textContent === 'Start a new chat'), 'the new-chat fallback')
  assert.ok(card().textContent.includes('Still failing. Start a new chat'))
  assert.equal(chatEl.querySelectorAll('.gbo-turn-error').length, 1, 'one card for the turn')
  fresh.click()
  await tick()
  assert.ok(calls.some(c => c.method === 'openSession' || (c.method === 'notify' && /another chat/.test(c.params?.message || ''))), 'a new chat with this bot is asked for')

  // A typed /undo: the receipt is one muted note, no monospace block.
  const box = await waitFor(() => {
    const el = chatEl.querySelector('textarea')
    return el && !el.disabled ? el : null
  }, 'an enabled composer')
  errors.length = 0
  type(box, '/undo')
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const note = await waitFor(() => chatEl.querySelector('.gbo-undo-note'), 'the undo note')
  assert.equal(note.textContent, 'Removed the failed reply')
  assert.ok(!chatEl.textContent.includes('message(s)') && !chatEl.textContent.includes('Undid'), 'no receipt jargon')
  assert.equal(chatEl.querySelector('.gbo-command pre'), null, 'no monospace block')
  assert.deepEqual(errors, [])
})
