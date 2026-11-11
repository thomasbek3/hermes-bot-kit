// The failed-turn card and the /undo note (core/turnError.js), and the card's
// Try again (session.js retryTurn = the supported /retry). Row and event
// shapes from Hermes Agent @2bd378ed1b:
//  - the boundary row {role: 'assistant', display_kind: 'failed_turn',
//    display_metadata: {error}} (agent/conversation_loop.py
//    _close_durable_failed_turn, agent/turn_failure_copy.py);
//  - message.complete {status: 'error', error, text: turn_error_text(…)}
//    (tui_gateway/prompt_turn.py _complete_turn_payload);
//  - the /undo receipt "↶ Undid 1 turn (7 message(s)). …"
//    (tui_gateway/methods_tools.py:882).

import assert from 'node:assert/strict'
import test from 'node:test'

import { historyToItems, PARTIAL_FAILED_TURN_NOTICE } from '../src/core/history.js'
import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { createChatController } from '../src/core/session.js'
import { FAILED_TITLE, isUndoEcho, UNDO_NOTE, withTurnCards } from '../src/core/turnError.js'
import { visibleItems } from '../src/core/workRows.js'
import { BOT, flush, gateway } from './harness.mjs'

const RAW = 'HTTP 400: {"detail":"Bad Request"}'
const rows = [
  { id: 1, role: 'user', content: 'book the flight', timestamp: 1 },
  { id: 2, role: 'assistant', content: PARTIAL_FAILED_TURN_NOTICE, display_kind: 'failed_turn', display_metadata: { error: RAW }, timestamp: 2 }
]
const drawn = (items, opts) => withTurnCards(visibleItems(items, false), opts)
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}

test('a failed turn is one card; the raw error and the grey boundary line are its Details', () => {
  const out = drawn(historyToItems(rows))
  assert.deepEqual(out.map(i => i.kind), ['user', 'turn-error'])
  const card = out[1]
  assert.equal(card.detail, `${RAW}\n${PARTIAL_FAILED_TURN_NOTICE}`)
  assert.equal(card.prompt, 'book the flight')
  assert.equal(card.canRetry, true)
  assert.equal(card.stillFailing, false)
  assert.equal(FAILED_TITLE, 'That reply didn’t go through.')
})

test('a live failed turn: the card carries the raw error; Hermes’s error copy is not a bot bubble', () => {
  let state = initialChatState([{ kind: 'user', id: 'u', text: 'hi' }])
  state = applyEvent(state, { type: 'message.start', payload: {} })
  state = applyEvent(state, {
    type: 'message.complete',
    payload: { status: 'error', error: RAW, text: `Request rejected. Your message was not answered.\nDetails: ${RAW}\nTry again.` }
  })
  assert.deepEqual(drawn(state.items).map(i => [i.kind, i.detail ?? i.text]), [['user', 'hi'], ['turn-error', RAW]])
  // Real reply text kept by a failed turn (`partial`) still shows.
  let partial = initialChatState([{ kind: 'user', id: 'u', text: 'hi' }])
  partial = applyEvent(partial, { type: 'message.start', payload: {} })
  partial = applyEvent(partial, { type: 'message.complete', payload: { status: 'error', error: RAW, partial: true, text: 'Half an answer' } })
  assert.deepEqual(drawn(partial.items).map(i => i.kind), ['user', 'assistant', 'turn-error'])
})

test('only the newest failed turn offers Try again, and never while a turn runs', () => {
  const items = [
    { kind: 'user', id: 'u1', text: 'a' },
    { kind: 'error', id: 'e1', text: 'x' },
    { kind: 'user', id: 'u2', text: 'b' },
    { kind: 'error', id: 'e2', text: 'y' }
  ]
  assert.deepEqual(withTurnCards(items).filter(i => i.kind === 'turn-error').map(i => i.canRetry), [false, true])
  assert.equal(withTurnCards(items, { busy: true }).at(-1).canRetry, false)
  const answered = [...items, { kind: 'user', id: 'u3', text: 'c' }]
  assert.ok(withTurnCards(answered).every(i => !i.canRetry))
})

test('a second failure after Try again says "Still failing"', () => {
  const after = [
    { kind: 'user', id: 'u9', text: 'book the flight' },
    { kind: 'error', id: 'live:e:2', text: RAW }
  ]
  const retry = { running: false, from: 'h:2-error', text: 'book the flight', failed: false }
  assert.equal(withTurnCards(after, { retry }).at(-1).stillFailing, true)
  // A retry that itself failed leaves the same card, now still failing.
  const same = [{ kind: 'user', id: 'u', text: 'x' }, { kind: 'error', id: 'h:2-error', text: RAW }]
  assert.equal(withTurnCards(same, { retry: { ...retry, failed: true } }).at(-1).stillFailing, true)
  // A different message failing is a fresh failure.
  const other = [{ kind: 'user', id: 'u', text: 'something else' }, { kind: 'error', id: 'live:e:3', text: RAW }]
  assert.equal(withTurnCards(other, { retry }).at(-1).stillFailing, false)
  // While the retry runs the card says so.
  assert.equal(withTurnCards(same, { retry: { ...retry, running: true } }).at(-1).retrying, true)
})

test('the /undo echo is one muted note; other commands and normal text are unchanged', () => {
  const legacy = { kind: 'command', id: 'c1', command: '/undo', output: '↶ Undid 1 turn (7 message(s)). Edit and resubmit, or send a new message.' }
  const canonical = { kind: 'command', id: 'c2', command: '/undo 2', output: '↶ Undid 3 messages. Edit and resend, or send something new.' }
  assert.ok(isUndoEcho(legacy) && isUndoEcho(canonical))
  assert.deepEqual(withTurnCards([legacy, canonical]).map(i => [i.kind, i.text]), [
    ['undo-note', UNDO_NOTE],
    ['undo-note', UNDO_NOTE]
  ])
  const keep = [
    { kind: 'command', id: 'c3', command: '/status', output: '↶ Undid nothing' },
    { kind: 'command', id: 'c4', command: '/undo', output: 'Nothing to undo.' },
    { kind: 'command', id: 'c5', command: '/undo', output: 'error: busy', error: true },
    { kind: 'user', id: 'u', text: 'why did I get an error?' },
    { kind: 'assistant', id: 'a', text: 'The error was a typo in the config.' },
    { kind: 'notice', id: 'n', text: 'Background task finished' }
  ]
  assert.equal(withTurnCards(keep), keep, 'nothing to change: the very same list')
})

test('Try again runs the supported /retry once: rewind the failed turn, resubmit the same message', async () => {
  const gw = gateway({
    'session.rewind': params =>
      params.replay_only ? { rewound_count: 0 } : { status: 'rewound', rewound_count: 2, target_message: { id: params.target_message_id, content: 'book the flight' } },
    'session.resume': () => ({
      session_id: 'rt-1',
      running: false,
      messages: [
        { role: 'user', content: 'book the flight', row_id: 1 },
        { role: 'assistant', content: PARTIAL_FAILED_TURN_NOTICE, display_kind: 'failed_turn', row_id: 2 }
      ]
    }),
    REST: () => ({ session_id: 'tip', messages: rows, pagination: { limit: 120, offset: 0, order: 'latest', returned: 2 } })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const first = chat.retryTurn('h:2-error', 'book the flight')
  const second = await chat.retryTurn('h:2-error', 'book the flight')
  assert.deepEqual(second, { ok: false }, 'a second press while the first runs is refused')
  assert.equal(chat.get().turnRetry.running, true)
  assert.deepEqual(await first, { ok: true })
  await settle()
  const rewinds = gw.calls.filter(c => c.method === 'session.rewind' && !c.params.replay_only)
  assert.equal(rewinds.length, 1)
  assert.equal(rewinds[0].params.target_message_id, 1, 'the failed user turn is the target')
  const submits = gw.calls.filter(c => c.method === 'prompt.submit')
  assert.equal(submits.length, 1, 'resubmitted exactly once')
  assert.equal(submits[0].params.text, 'book the flight', 'the original message')
  assert.ok(!gw.calls.some(c => c.method === 'slash.exec'), 'the canonical rewind, not the legacy worker')
  assert.ok(!chat.get().chat.items.some(i => i.kind === 'command'), 'no /retry block left in the chat')
  assert.deepEqual({ ...chat.get().turnRetry }, { running: false, from: 'h:2-error', text: 'book the flight', failed: false })
  chat.dispose()
})

test('a legacy gateway: Try again is its own /retry through slash.exec', async () => {
  const gw = gateway({
    'session.rewind': () => {
      throw Object.assign(new Error('unknown method'), { code: -32601 })
    },
    'slash.exec': () => ({ type: 'send', message: 'book the flight' })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.deepEqual(await chat.retryTurn('e1', 'book the flight'), { ok: true })
  assert.deepEqual(gw.calls.find(c => c.method === 'slash.exec').params, { session_id: 'rt-1', command: 'retry' })
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit').length, 1)
  chat.dispose()
})
