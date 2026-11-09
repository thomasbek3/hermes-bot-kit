// Override v2 review round 1 (reviews/override-v2-r1.md), controller side:
// #2 an uncertain /steer is never re-delivered as a queued prompt, #3 rewind
// and typed /undo, /retry take the canonical rewind mutation (legacy slash
// worker only when the gateway does not serve it) and prefill only after a
// confirmed rewind, #4 truncating edits rebind the surviving row ids, and the
// same-class instance found in the sweep: a slash.exec whose reply was lost is
// never run a second time through command.dispatch.
//
// Shapes come from Hermes Agent 2bd378ed1b: tui_gateway/methods_session_interrupt.py
// (_correction_method: 'queued' | 'rejected'), methods_prompt.py:581-595
// (survivor_row_id_map / survivor_user_row_ids, rebind_survivor_row_ids),
// apps/desktop/src/api/canonical-protocol.ts:378-386, 450 (session.rewind),
// app/session/hooks/use-prompt-actions/slash-session-commands.ts (rewind receipts).

import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const T = 1762560000
const THREE_TURNS = [
  { id: 1, role: 'user', content: 'first', timestamp: T },
  { id: 2, role: 'assistant', content: 'one', timestamp: T + 1 },
  { id: 3, role: 'user', content: 'second', timestamp: T + 2 },
  { id: 4, role: 'assistant', content: 'two', timestamp: T + 3 }
]
const open = async (handlers = {}, rows = THREE_TURNS) => {
  const gw = gateway({ REST: () => ({ messages: rows }), ...handlers })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  return { gw, chat }
}
const item = (chat, rowId) => chat.get().chat.items.find(i => i.rowId === rowId)
const count = (gw, method) => gw.calls.filter(c => c.method === method).length
const commands = chat => chat.get().chat.items.filter(i => i.kind === 'command')
const lostReply = () => new Error('Gateway request timed out')
const refusal = (code, message, data) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) })

// ── #2 /steer ───────────────────────────────────────────────────────────────

test('v2-r1 #2 a steer the gateway accepted but whose reply was lost is never sent again as a queued prompt', async () => {
  const accepted = []
  const { gw, chat } = await open({
    'session.steer': params => {
      accepted.push(params.text)
      throw lostReply()
    }
  })
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  const res = await chat.runSlash('/steer keep it brief')
  assert.deepEqual(accepted, ['keep it brief'], 'one steer reached the gateway')
  assert.equal(count(gw, 'session.steer'), 1)
  assert.equal(count(gw, 'prompt.submit'), 0, 'no second delivery without a second gesture')
  assert.equal(res.ok, false)
  assert.match(commands(chat).at(-1).output, /not confirmed/i)
  assert.match(commands(chat).at(-1).output, /not queued/i)
  chat.dispose()
})

test('v2-r1 #2 an authoritative refusal still keeps the words as the next turn (stock): status rejected, or a coded refusal', async () => {
  for (const steer of [() => ({ status: 'rejected', text: 'x' }), () => { throw refusal(4010, 'agent does not support steer') }]) {
    const { gw, chat } = await open({ 'session.steer': steer })
    gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
    await chat.runSlash('/steer go faster')
    const submits = gw.calls.filter(c => c.method === 'prompt.submit')
    assert.equal(submits.length, 1)
    assert.equal(submits[0].params.text, 'go faster')
    assert.equal(submits[0].params.queued, true)
    chat.dispose()
  }
})

test('v2-r1 #2 an unrecognised steer answer is not a refusal: nothing is queued', async () => {
  const { gw, chat } = await open({ 'session.steer': () => ({ ok: true }) })
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  const res = await chat.runSlash('/steer go faster')
  assert.equal(res.ok, false)
  assert.equal(count(gw, 'prompt.submit'), 0)
  chat.dispose()
})

// ── #3 rewind / undo / retry: canonical first, legacy only when not served ──

test('v2-r1 #3 Rewind on a canonical gateway: session.rewind names the selected durable row; the text comes back only after the receipt', async () => {
  let cut = Infinity
  const { gw, chat } = await open({
    REST: () => ({ messages: THREE_TURNS.filter(r => r.id < cut) }),
    'session.rewind': params => {
      cut = params.target_message_id
      return { status: 'rewound', rewound_count: 4, target_message: { id: params.target_message_id, content: 'first' } }
    }
  })
  const res = await chat.rewindTo(item(chat, 1).id)
  assert.deepEqual(gw.calls.find(c => c.method === 'session.rewind').params, { session_id: 'rt-1', target_message_id: 1 })
  assert.equal(count(gw, 'slash.exec'), 0, 'never the legacy slash route on a canonical gateway')
  assert.equal(count(gw, 'command.dispatch'), 0)
  assert.equal(res.ok, true)
  assert.equal(res.prefill, 'first')
  assert.ok(!item(chat, 1) && !item(chat, 3), 'the rewound turns leave the screen')
  await settle()
  assert.ok(!item(chat, 1) && !item(chat, 3), 'and stay gone after the re-read')
  chat.dispose()
})

test('v2-r1 #3 a refused canonical rewind leaves history and the composer alone', async () => {
  const { gw, chat } = await open({
    'session.rewind': () => {
      throw refusal(4001, 'revision conflict', { reason: 'revision_conflict' })
    }
  })
  const res = await chat.rewindTo(item(chat, 3).id)
  assert.equal(res.ok, false)
  assert.equal(res.prefill, undefined, 'no prefill after a failed rewind')
  assert.equal(count(gw, 'slash.exec'), 0, 'a canonical refusal never falls back to the legacy route')
  await settle()
  assert.ok(item(chat, 3) && item(chat, 4), 'nothing was cut')
  chat.dispose()
})

test('v2-r1 #3 a canonical rewind whose reply was lost: no prefill, no second rewind, no legacy fallback', async () => {
  const { gw, chat } = await open({
    'session.rewind': () => {
      throw lostReply()
    }
  })
  const res = await chat.rewindTo(item(chat, 3).id)
  assert.equal(res.ok, false)
  assert.equal(res.prefill, undefined)
  assert.equal(count(gw, 'session.rewind'), 1)
  assert.equal(count(gw, 'slash.exec'), 0)
  assert.equal(count(gw, 'command.dispatch'), 0)
  chat.dispose()
})

test('v2-r1 #3 legacy gateway (no session.rewind): /undo N through slash.exec; a refused legacy undo prefills nothing', async () => {
  let refuse = false
  const { gw, chat } = await open({
    'slash.exec': () => {
      if (refuse) throw refusal(4004, 'undo: no user messages to undo')
      return { type: 'prefill', message: 'second', notice: '↶ Undid 1 turn' }
    }
  })
  const ok = await chat.rewindTo(item(chat, 3).id)
  assert.deepEqual(gw.calls.find(c => c.method === 'slash.exec').params, { session_id: 'rt-1', command: 'undo 1' })
  assert.equal(ok.ok, true)
  assert.equal(ok.prefill, 'second')
  refuse = true
  await settle()
  const target = item(chat, 1)
  const failed = await chat.rewindTo(target.id)
  assert.equal(failed.ok, false)
  assert.equal(failed.prefill, undefined, 'the old code returned the message text even on failure')
  chat.dispose()
})

const SNAPSHOT = [
  { role: 'user', row_id: 1, content: 'first' },
  { role: 'assistant', row_id: 2, content: 'one' },
  { role: 'user', row_id: 3, content: 'second' },
  { role: 'assistant', row_id: 4, content: 'two' }
]

test('v2-r1 #3 typed /undo on a canonical gateway: replay probe, snapshot-derived target, session.rewind; never slash.exec', async () => {
  const { gw, chat } = await open({
    'session.resume': params => ({ session_id: 'rt-1', running: false, ...(params.omit_messages === false ? { messages: SNAPSHOT } : {}) }),
    'session.rewind': params =>
      params.replay_only
        ? { session_id: params.session_id, status: 'nothing', rewound_count: 0 }
        : { status: 'rewound', rewound_count: 2, target_message: { id: params.target_message_id, content: 'second' } }
  })
  const res = await chat.runSlash('/undo')
  const rewinds = gw.calls.filter(c => c.method === 'session.rewind').map(c => c.params)
  assert.deepEqual(rewinds, [
    { session_id: 'rt-1', derived_target: true, replay_only: true },
    { session_id: 'rt-1', target_message_id: 3, derived_target: true }
  ])
  assert.equal(count(gw, 'slash.exec'), 0)
  assert.deepEqual(res, { ok: true, prefill: 'second' })
  assert.ok(!item(chat, 3) && item(chat, 1), 'the undone turn is cut on screen')
  chat.dispose()
})

test('v2-r1 #3 typed /retry on a canonical gateway rewinds the last turn, then submits its text once', async () => {
  const { gw, chat } = await open({
    'session.resume': params => ({ session_id: 'rt-1', running: false, ...(params.omit_messages === false ? { messages: SNAPSHOT } : {}) }),
    'session.rewind': params =>
      params.replay_only
        ? { session_id: params.session_id, status: 'nothing', rewound_count: 0 }
        : { status: 'rewound', rewound_count: 2, target_message: { id: params.target_message_id, content: 'second' } }
  })
  const res = await chat.runSlash('/retry')
  assert.equal(res.ok, true)
  assert.equal(count(gw, 'slash.exec'), 0)
  const submits = gw.calls.filter(c => c.method === 'prompt.submit')
  assert.equal(submits.length, 1)
  assert.equal(submits[0].params.text, 'second')
  assert.equal(submits[0].params.confirm_truncate, undefined, 'the rewind already cut; the resend is a plain submit')
  chat.dispose()
})

test('v2-r1 #3 typed /undo whose earlier reply was lost replays the retained rewind instead of deriving a new target', async () => {
  const { gw, chat } = await open({
    'session.rewind': params => (params.replay_only ? { status: 'rewound', rewound_count: 2, target_message: { id: 3, content: 'second' } } : assert.fail('derived again'))
  })
  const res = await chat.runSlash('/undo')
  assert.deepEqual(res, { ok: true, prefill: 'second' })
  assert.equal(count(gw, 'session.rewind'), 1)
  chat.dispose()
})

test('v2-r1 #3 typed /undo on a legacy gateway still runs the slash worker', async () => {
  const { gw, chat } = await open({ 'slash.exec': () => ({ type: 'prefill', message: 'second' }) })
  assert.deepEqual(await chat.runSlash('/undo'), { ok: true, prefill: 'second' })
  assert.deepEqual(gw.calls.find(c => c.method === 'slash.exec').params, { session_id: 'rt-1', command: 'undo' })
  chat.dispose()
})

// ── sweep: slash.exec → command.dispatch only after a definite refusal ─────

test('v2-r1 sweep: a slash.exec whose reply was lost is never run again through command.dispatch', async () => {
  const ran = []
  const { gw, chat } = await open({
    'slash.exec': params => {
      ran.push(params.command)
      throw lostReply()
    },
    'command.dispatch': params => {
      ran.push(`dispatch ${params.name}`)
      return { type: 'prefill', message: 'first' }
    }
  })
  // On a legacy gateway, slash.exec routes /undo to the same handler
  // command.dispatch runs (tui_gateway _PENDING_INPUT_COMMANDS): a fallback
  // after a lost reply would undo a second turn.
  const res = await chat.runSlash('/undo')
  assert.deepEqual(ran, ['undo'])
  assert.equal(res.ok, false)
  assert.match(commands(chat).at(-1).output, /may have run/i)
  assert.equal(count(gw, 'command.dispatch'), 0)
  chat.dispose()
})

test('v2-r1 sweep: the routing refusal (4018 "use command.dispatch") still falls back, as stock', async () => {
  const { gw, chat } = await open({
    'slash.exec': () => {
      throw refusal(4018, 'skill command: use command.dispatch for /research')
    },
    'command.dispatch': () => ({ type: 'skill', name: 'research', message: 'SKILL BODY', display: '/research cats' })
  })
  await chat.runSlash('/research cats')
  assert.equal(count(gw, 'command.dispatch'), 1)
  assert.equal(gw.calls.find(c => c.method === 'prompt.submit').params.text, 'SKILL BODY')
  chat.dispose()
})

// ── #4 survivor row ids ─────────────────────────────────────────────────────

const FIVE = [
  { id: 1, role: 'user', content: 'first', timestamp: T },
  { id: 2, role: 'assistant', content: 'one', timestamp: T + 1 },
  { id: 3, role: 'user', content: 'second', timestamp: T + 2 },
  { id: 4, role: 'assistant', content: 'two', timestamp: T + 3 }
]

test('v2-r1 #4 a truncating edit asks for and applies the survivor row map: reactions and a second edit use the new ids before any refresh', async () => {
  const { gw, chat } = await open({
    'prompt.submit': params =>
      params.confirm_truncate ? { status: 'streaming', survivor_row_id_map: { 1: 101, 2: 102, 3: null, 4: null } } : { status: 'streaming' },
    'message.react': params => ({ row_id: params.row_id, reactions: [{ emoji: params.emoji, author: 'user' }] })
  }, FIVE)
  const res = await chat.editMessage(item(chat, 3).id, 'second, edited')
  assert.equal(res.ok, true)
  const submit = gw.calls.find(c => c.method === 'prompt.submit').params
  assert.deepEqual([...submit.rebind_survivor_row_ids].sort((a, b) => a - b), [1, 2, 3, 4], 'every loaded durable id is offered for rebinding')
  assert.ok(chat.get().chat.busy, 'the replacement turn is streaming (the idle refresh is skipped)')
  const survivors = chat.get().chat.items.filter(i => i.kind === 'user' || i.kind === 'assistant').map(i => i.rowId).filter(Boolean)
  assert.deepEqual(survivors, [101, 102], 'retained items address the rewritten rows')
  assert.ok(!chat.get().rows.some(r => r.id === 1 || r.id === 2), 'backing rows rebound too')
  await chat.react(item(chat, 101).id, '👍')
  assert.equal(gw.calls.find(c => c.method === 'message.react').params.row_id, 101)
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'new answer' } })
  await chat.editMessage(item(chat, 101).id, 'first, edited')
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit').at(-1).params.truncate_before_row_id, 101, 'a second edit before refresh names the live row')
  chat.dispose()
})

test('v2-r1 #4 the older positional survivor list rebinds visible user turns; null drops the stale id', async () => {
  const { chat } = await open({
    'prompt.submit': params => (params.confirm_truncate ? { status: 'streaming', survivor_user_row_ids: [null] } : { status: 'streaming' })
  }, FIVE)
  await chat.editMessage(item(chat, 3).id, 'second, edited')
  const first = chat.get().chat.items.find(i => i.kind === 'user' && i.text === 'first')
  assert.equal(first.rowId, undefined, 'a null survivor clears the cached id instead of keeping an archived one')
  chat.dispose()
})

test('v2-r1 #4 paginated history: rows outside the rewritten tip keep their ids; the next tail joins the loaded rows', async () => {
  const older = [
    { id: 1, role: 'user', content: 'old q', timestamp: T - 10 },
    { id: 2, role: 'assistant', content: 'old a', timestamp: T - 9 }
  ]
  const tail = [
    { id: 10, role: 'user', content: 'first', timestamp: T },
    { id: 11, role: 'assistant', content: 'one', timestamp: T + 1 },
    { id: 12, role: 'user', content: 'second', timestamp: T + 2 },
    { id: 13, role: 'assistant', content: 'two', timestamp: T + 3 }
  ]
  let page = 'first'
  const gw = gateway({
    REST: params => {
      if (params.offset > 0) return { messages: older }
      if (page === 'first') return { messages: tail }
      return { messages: [{ id: 110, role: 'user', content: 'first', timestamp: T }, { id: 111, role: 'assistant', content: 'one', timestamp: T + 1 }, { id: 14, role: 'user', content: 'second, edited', timestamp: T + 4 }] }
    },
    'prompt.submit': params => (params.confirm_truncate ? { status: 'streaming', survivor_row_id_map: { 10: 110, 11: 111, 12: null, 13: null } } : { status: 'streaming' })
  })
  const chat = createChatController(BOT, gw.deps, { pageSize: 4 })
  await chat.open()
  chat.get().hasMore || (await chat.loadEarlier())
  await chat.loadEarlier()
  const loadedOld = chat.get().rows.some(r => r.id === 1)
  await chat.editMessage(chat.get().chat.items.find(i => i.rowId === 12).id, 'second, edited')
  assert.ok(chat.get().rows.every(r => ![10, 11, 12, 13].includes(r.id)), 'no stale tip id survives in the loaded rows')
  if (loadedOld) assert.ok(chat.get().rows.some(r => r.id === 1), 'rows outside the tip keep their ids')
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'done' } })
  page = 'second'
  await chat.refresh()
  if (loadedOld) assert.ok(chat.get().rows.some(r => r.id === 1), 'the new tail joined the loaded rows (no gap drop)')
  chat.dispose()
})
