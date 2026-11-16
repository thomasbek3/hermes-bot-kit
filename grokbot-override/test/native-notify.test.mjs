// T7: native OS notifications for the open override chat, the pure part
// (core/nativeNotify.js): which chat-state transitions notify, dedupe, the
// focus guard, silence, failed turns, and bodies that never carry the reply,
// the approval command, a question or any secret prompt text.

import assert from 'node:assert/strict'
import test from 'node:test'

import { BODIES, createSeen, finishedReply, nativeNotifications } from '../src/core/nativeNotify.js'

const BOT = { name: 'scout' }
const st = (chat, { bot = BOT, runtimeId = 'rt-1' } = {}) => ({ bot, runtimeId, phase: 'ready', chat: { busy: false, waiting: null, items: [], ...chat } })
const user = (id, text = 'hi') => ({ kind: 'user', id, text })
const reply = (id, text, extra = {}) => ({ kind: 'assistant', id, text, ...extra })
const away = (seen, extra = {}) => ({ focused: false, seen, name: 'Scout', ...extra })

/** Run a sequence of states through one tracker; collect every notification. */
function run(states, opts) {
  const out = []
  let prev = null
  for (const s of states) {
    out.push(...nativeNotifications(prev, s, opts))
    prev = s
  }
  return out
}

test('turn done: busy → idle with a new reply notifies once, with a generic body', () => {
  const seen = createSeen()
  const idle0 = st({ items: [user('u1'), reply('a1', 'old answer')] })
  const busy = st({ busy: true, items: [user('u1'), reply('a1', 'old answer'), user('local:u2', 'secret plan')] })
  const streaming = st({ busy: true, items: [...busy.chat.items, reply('live:a2', 'the new', { streaming: true })] })
  const done = st({ items: [...busy.chat.items, reply('live:a2', 'the new answer with private detail')] })
  const out = run([idle0, busy, streaming, done], away(seen))
  assert.deepEqual(out, [{ id: 'done:live:a2', kind: 'done', title: 'Scout', body: BODIES.done }])
  assert.ok(!JSON.stringify(out).includes('private'), 'never the reply text')
  // The stored row replacing the live one (new id, same text) never refires.
  const stored = st({ items: [user('u1'), reply('a1', 'old answer'), user('u2', 'secret plan'), reply('a2', 'the new answer with private detail')] })
  assert.deepEqual(nativeNotifications(done, stored, away(seen)), [])
  // Nor does a later busy → idle that produced no new reply (e.g. a resume).
  const busyAgain = st({ ...stored.chat, busy: true })
  assert.deepEqual(run([stored, busyAgain, { ...stored }], away(seen)), [])
})

test('focus: nothing fires while the Hermes window is focused, and it is not replayed after blur', () => {
  const seen = createSeen()
  const busy = st({ busy: true, items: [user('u1')] })
  const done = st({ items: [user('u1'), reply('a1', 'done')] })
  assert.deepEqual(nativeNotifications(busy, done, { focused: true, seen, name: 'Scout' }), [])
  const later = st({ items: [user('u1'), reply('a1', 'done')] })
  assert.deepEqual(nativeNotifications(done, later, away(seen)), [])
})

test('silent replies and failed turns never notify', () => {
  for (const text of ['[SILENT]', 'NO_REPLY', ' silent ']) {
    const seen = createSeen()
    const out = run([st({ busy: true, items: [user('u1')] }), st({ items: [user('u1'), reply('a1', text)] })], away(seen))
    assert.deepEqual(out, [], text)
  }
  const seen = createSeen()
  const failed = st({ items: [user('u1'), reply('a1', 'partial'), { kind: 'error', id: 'e1', text: 'HTTP 400' }] })
  assert.deepEqual(run([st({ busy: true, items: [user('u1')] }), failed], away(seen)), [])
  assert.equal(finishedReply([user('u1'), reply('a1', 'x', { streaming: true })]), null, 'a streaming reply is not finished')
  assert.equal(finishedReply([reply('a0', 'old'), user('u1')]), null, 'the previous turn\'s reply is not this turn\'s')
})

test('approval: one notification per new pending card, generic body, never the command', () => {
  const seen = createSeen()
  const base = st({ busy: true, items: [user('u1')] })
  const card = { kind: 'approval', id: 'approval:r1', requestId: 'r1', status: 'pending', command: 'rm -rf /secret/place', description: 'dangerous' }
  const withCard = st({ busy: true, items: [user('u1'), card] })
  const out = run([base, withCard, { ...withCard }], away(seen))
  assert.deepEqual(out, [{ id: 'approval:approval:r1', kind: 'approval', title: 'Scout', body: BODIES.approval }])
  assert.ok(!JSON.stringify(out).includes('secret'))
  // A resolved card or the same card again: nothing.
  const resolved = st({ busy: true, items: [user('u1'), { ...card, status: 'resolved' }] })
  assert.deepEqual(nativeNotifications(withCard, resolved, away(seen)), [])
})

test('input needed: clarify, sudo, secret and vault prompts notify once with a generic line', () => {
  const cases = [
    [{ kind: 'clarify', id: 'q1', text: 'Which private repo?', questions: [{ qid: 'q1', question: 'Which private repo?' }] }, 'Has a question for you.'],
    [{ kind: 'sudo', id: 's1', text: 'apt install secret-thing' }, 'Needs your input.'],
    [{ kind: 'secret', id: 'k1', envVar: 'API_KEY', text: 'Paste the private key' }, 'Needs your input.'],
    [{ kind: 'vault-login', id: 'v1', origin: 'https://bank.example', text: 'bank.example' }, 'Needs your input.'],
    [{ kind: 'connection', id: 'op1', opId: 'op1', text: 'a private service' }, 'Needs a connection approved.']
  ]
  for (const [waiting, body] of cases) {
    const seen = createSeen()
    const before = st({ busy: true, items: [user('u1')] })
    const after = st({ busy: true, items: [user('u1')], waiting })
    const out = run([before, after, { ...after }], away(seen))
    assert.equal(out.length, 1, waiting.kind)
    assert.equal(out[0].kind, 'input')
    assert.equal(out[0].body, body)
    for (const leak of ['private', 'secret', 'API_KEY', 'bank']) assert.ok(!`${out[0].title} ${out[0].body}`.includes(leak), `${waiting.kind}: no ${leak}`)
  }
})

test('a new chat is a baseline: switching bots or runtimes never notifies what was already there', () => {
  const seen = createSeen()
  const card = { kind: 'approval', id: 'approval:r9', requestId: 'r9', status: 'pending' }
  const a = st({ busy: true, items: [user('u1')] })
  const b = st({ items: [user('u1'), reply('a1', 'there'), card], waiting: { kind: 'clarify', id: 'q9', text: 'x' } }, { bot: { name: 'other' }, runtimeId: 'rt-2' })
  assert.deepEqual(nativeNotifications(a, b, away(seen, { keyOf: bot => bot.name })), [])
  assert.deepEqual(nativeNotifications(null, a, away(seen)), [])
  assert.deepEqual(nativeNotifications(a, null, away(seen)), [])
  // The title falls back to the bot name, then "Bot".
  const busy = st({ busy: true, items: [user('u1')] })
  const done = st({ items: [user('u1'), reply('a1', 'ok')] })
  assert.equal(nativeNotifications(busy, done, { focused: false, seen: createSeen() })[0].title, 'scout')
})
