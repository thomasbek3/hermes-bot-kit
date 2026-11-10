// Override v2 review round 3 (reviews/override-v2-r3.md), controller side:
//
//   H1  an unknown control error never authorizes a second write: /steer is not
//       queued, slash.exec does not fall back to command.dispatch. Only the
//       operation's documented pre-admission refusals do.
//   H2  a rewind that fails with a handler error (or an unknown code) whose
//       text says "method not found" never runs the legacy /undo: only a
//       structured -32601 means "not served".
//   Inventory: every classifier lives in src/core/outcomes.js; the table below
//       lists every call site, and no module keeps an ad-hoc classifier.
//
// Sources: Hermes Agent 2bd378ed1b (see the header of src/core/outcomes.js).

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createCanonicalChat, KICKOFF_TEXT } from '../src/core/create-chat.js'
import {
  classifySubmitFailure,
  controlFailure,
  isMethodNotServed,
  isSessionGoneError,
  looksUnsupported,
  rewindFailure,
  roomPostFailure,
  slashExecFailure,
  steerFailure,
  titleFailure
} from '../src/core/outcomes.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const T = 1762560000
const ROWS = [
  { id: 1, role: 'user', content: 'first', timestamp: T },
  { id: 2, role: 'assistant', content: 'one', timestamp: T + 1 },
  { id: 3, role: 'user', content: 'second', timestamp: T + 2 },
  { id: 4, role: 'assistant', content: 'two', timestamp: T + 3 }
]
const open = async (handlers = {}) => {
  const gw = gateway({ REST: () => ({ messages: ROWS }), ...handlers })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  return { gw, chat }
}
const count = (gw, method) => gw.calls.filter(c => c.method === method).length
const commands = chat => chat.get().chat.items.filter(i => i.kind === 'command')
const item = (chat, rowId) => chat.get().chat.items.find(i => i.rowId === rowId)
const rpc = (code, message, data) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) })
// routing.js asError: the host's error carried as `cause`.
const wrapped = (code, message, data) => Object.assign(new Error(message), { cause: { code, message, ...(data ? { data } : {}) } })
// a raw JSON-RPC frame
const frame = (code, message, data) => ({ message, error: { code, message, ...(data ? { data } : {}) } })

// Errors no contract documents: each must be "uncertain" for every operation.
const UNCERTAIN = [
  ['unknown numeric code after admission', rpc(5999, 'new backend error after admission')],
  ['unknown code, nested cause', wrapped(5999, 'new backend error after admission')],
  ['unknown code, raw frame', frame(5999, 'new backend error after admission')],
  ['unknown canonical reason', rpc(4001, 'something_new', { reason: 'something_new' })],
  ['unknown reason, nested cause', wrapped(4001, 'something_new', { reason: 'something_new' })],
  ['handler error', rpc(-32000, 'handler error: boom')],
  ['handler error naming a missing method', rpc(-32000, 'downstream method not found after mutation')],
  ['unknown code naming a missing method', rpc(5999, 'unknown method: x')],
  ['5000 internal', rpc(5000, 'steer failed: boom')],
  ['4064 profile unavailable (inside the handler)', rpc(4064, 'profile unavailable')],
  ['storage_unavailable', rpc(5001, 'storage_unavailable', { reason: 'storage_unavailable' })],
  ['timeout', new Error('Gateway request timed out')],
  ['socket closed', new Error('WebSocket closed')],
  ['a remote error that only SAYS not connected', rpc(5999, 'peer not connected')]
]

test('v2-r3 H1 classifier: unknown codes, unknown reasons, wrappers, handler errors and prose are uncertain for every control', () => {
  for (const [label, error] of UNCERTAIN) {
    for (const op of ['session.steer', 'slash.exec', 'session.rewind', 'session.title', undefined]) {
      assert.equal(controlFailure(error, op), 'uncertain', `${op}: ${label}`)
    }
    assert.equal(titleFailure(error), 'uncertain', `title: ${label}`)
    assert.equal(roomPostFailure(error), 'uncertain', `room: ${label}`)
    assert.equal(classifySubmitFailure(error).delivery, 'unknown', `submit: ${label}`)
    assert.equal(isMethodNotServed(error), false, `not-served: ${label}`)
  }
})

test('v2-r3 H1 classifier: each operation accepts only its own documented refusals', () => {
  const shared = [
    ['admitted:false', rpc(4001, 'busy', { reason: 'anything', admitted: false })],
    ['admitted:false nested', wrapped(4001, 'busy', { reason: 'anything', admitted: false })],
    ['host: gateway not connected', new Error('Hermes gateway is not connected')],
    ['host: execution identity', new Error('Session execution identity unavailable; reconnect before controlling this turn')],
    ['-32601 legacy', rpc(-32601, 'unknown method: x')],
    ['-32601 canonical', rpc(-32601, 'unknown method: x', { reason: 'unknown_method' })],
    ['-32601 nested', wrapped(-32601, 'unknown method: x')],
    ['4000 params contract', rpc(4000, 'invalid params')],
    ['5035 retiring', rpc(5035, 'backend is retiring; reconnect to continue')]
  ]
  for (const op of ['session.steer', 'slash.exec', 'session.rewind', 'session.title']) {
    for (const [label, error] of shared) assert.equal(controlFailure(error, op), 'refused', `${op}: ${label}`)
  }
  const own = {
    'session.steer': [
      rpc(4002, 'text is required'),
      rpc(4010, 'agent does not support steer'),
      rpc(4001, 'stale_generation', { reason: 'stale_generation' }),
      rpc(4001, 'execution_not_ready', { reason: 'execution_not_ready' }),
      rpc(4001, 'unsupported_control', { reason: 'unsupported_control' })
    ],
    'slash.exec': [
      rpc(4004, 'empty command'),
      rpc(4018, 'skill command: use command.dispatch for /research'),
      rpc(4018, 'snapshot restore mutates live config/state; use command.dispatch for /snapshot restore'),
      rpc(5030, 'slash worker start failed: no python'),
      rpc(4001, 'unsupported_command', { reason: 'unsupported_command' })
    ],
    'session.title': [rpc(4021, 'title required'), rpc(4006, 'session_id required')]
  }
  for (const [op, errors] of Object.entries(own)) {
    for (const error of errors) assert.equal(controlFailure(error, op), 'refused', `${op}: ${error.message}`)
    for (const [other] of Object.entries(own).filter(([o]) => o !== op)) {
      for (const error of errors) {
        if (error.code === 4001) continue // the canonical pre-run reasons overlap by design
        assert.equal(controlFailure(error, other), 'uncertain', `${other} must not borrow ${op}'s ${error.message}`)
      }
    }
  }
  // A 4018 / 5030 that is not the documented routing / start refusal can follow execution.
  assert.equal(slashExecFailure(rpc(4018, 'quick command failed with exit code 1')), 'uncertain')
  assert.equal(slashExecFailure(rpc(5030, 'worker died; slash worker start failed later')), 'uncertain')
  assert.equal(slashExecFailure(rpc(5030, 'worker crashed')), 'uncertain')
  assert.equal(steerFailure(rpc(4018, 'skill command: use command.dispatch for /x')), 'uncertain')
  assert.equal(rewindFailure(rpc(4010, 'agent does not support steer')), 'uncertain')
  assert.equal(titleFailure(rpc(4022, 'Title "Bot Chat" is already in use by session x')), 'conflict')
  assert.equal(titleFailure(rpc(5007, 'database is locked')), 'uncertain')
  assert.equal(roomPostFailure(rpc(4001, 'x', { reason: 'runtime_coordination_required', admitted: false })), 'refused')
  assert.equal(roomPostFailure(new Error('Hermes gateway is not connected')), 'uncertain', 'groups: stock admittedNothing only')
})

test('v2-r3 H2 classifier: "not served" is structured only; read-only availability may use prose', () => {
  assert.equal(isMethodNotServed(rpc(-32601, 'unexpected session.rewind')), true)
  assert.equal(isMethodNotServed(wrapped(-32601, 'x')), true)
  assert.equal(isMethodNotServed(rpc(-32601, 'x', { reason: 'something_else' })), false)
  assert.equal(isMethodNotServed(new Error('unknown method: session.rewind')), false, 'prose alone is not proof')
  assert.equal(isMethodNotServed(rpc(-32000, 'downstream method not found after mutation')), false)
  assert.equal(looksUnsupported(new Error('method not found')), true, 'availability UI may read prose')
  assert.equal(looksUnsupported(rpc(4001, 'busy')), false)
})

test('v2-r3 inventory: session-gone needs a structured code; prose counts only for a host (code-less) error', () => {
  assert.equal(isSessionGoneError(rpc(4001, 'session not found')), true)
  assert.equal(isSessionGoneError(rpc(4001, 'not_found', { reason: 'not_found' })), true)
  assert.equal(isSessionGoneError(wrapped(4001, 'session not found')), true)
  assert.equal(isSessionGoneError(rpc(4001, 'busy', { reason: 'session_busy' })), false)
  assert.equal(isSessionGoneError(rpc(-32000, 'handler error: session not found in db')), false, 'a handler error is not a reaped runtime')
  assert.equal(isSessionGoneError(rpc(4007, 'session no longer live')), false)
  assert.equal(isSessionGoneError(new Error('session rt-1 not in memory')), true)
})

// ── H1 end to end: one gesture, one write ───────────────────────────────────

test('v2-r3 H1 /steer: an unknown error after admission is "not confirmed" and never queued as a prompt', async () => {
  for (const [label, error] of UNCERTAIN) {
    const { gw, chat } = await open({
      'session.steer': () => {
        throw error
      }
    })
    gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
    const res = await chat.runSlash('/steer keep it brief')
    assert.equal(count(gw, 'session.steer'), 1, label)
    assert.equal(count(gw, 'prompt.submit'), 0, `no second write: ${label}`)
    assert.equal(res.ok, false, label)
    assert.match(commands(chat).at(-1).output, /not confirmed/i, label)
    chat.dispose()
  }
})

test('v2-r3 H1 /steer: a documented refusal still keeps the words as the next turn', async () => {
  const refusals = [
    rpc(4010, 'agent does not support steer'),
    rpc(4002, 'text is required'),
    rpc(4001, 'stale_generation', { reason: 'stale_generation' }),
    wrapped(4001, 'execution_not_ready', { reason: 'execution_not_ready' }),
    rpc(4001, 'busy', { reason: 'x', admitted: false }),
    new Error('Session execution identity unavailable; reconnect before controlling this turn')
  ]
  for (const error of refusals) {
    const { gw, chat } = await open({
      'session.steer': () => {
        throw error
      }
    })
    gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
    await chat.runSlash('/steer go faster')
    const submits = gw.calls.filter(c => c.method === 'prompt.submit')
    assert.equal(submits.length, 1, error.message)
    assert.equal(submits[0].params.text, 'go faster')
    chat.dispose()
  }
})

test('v2-r3 H1 slash.exec: an unknown error never falls back to command.dispatch', async () => {
  const extra = [
    ['a 4018 after a quick command ran', rpc(4018, 'quick command failed with exit code 1')],
    ['a 5030 worker failure mid-command', rpc(5030, 'worker crashed')]
  ]
  for (const [label, error] of [...UNCERTAIN, ...extra]) {
    const { gw, chat } = await open({
      'slash.exec': () => {
        throw error
      },
      'command.dispatch': () => ({ type: 'exec', output: 'ran twice' })
    })
    const res = await chat.runSlash('/usage today')
    assert.equal(count(gw, 'slash.exec'), 1, label)
    assert.equal(count(gw, 'command.dispatch'), 0, `no second write: ${label}`)
    assert.equal(res.ok, false, label)
    assert.match(commands(chat).at(-1).output, /may have run/i, label)
    chat.dispose()
  }
})

test('v2-r3 H1 slash.exec: the documented routing / start refusals still fall back', async () => {
  const refusals = [
    rpc(4018, 'skill command: use command.dispatch for /usage'),
    rpc(5030, 'slash worker start failed: no python'),
    rpc(4004, 'empty command'),
    rpc(-32601, 'unknown method: slash.exec')
  ]
  for (const error of refusals) {
    const { gw, chat } = await open({
      'slash.exec': () => {
        throw error
      },
      'command.dispatch': () => ({ type: 'exec', output: 'dispatched' })
    })
    await chat.runSlash('/usage today')
    assert.equal(count(gw, 'command.dispatch'), 1, error.message)
    chat.dispose()
  }
})

// ── H2 end to end: no legacy undo after an uncertain rewind ─────────────────

const H2_ERRORS = [
  ['handler error naming a missing method', rpc(-32000, 'downstream method not found after mutation')],
  ['unknown code naming a missing method', rpc(5999, 'unknown method in downstream call')],
  ['unknown code', rpc(5999, 'new backend error after admission')],
  ['code-less prose', new Error('method not found')],
  ['nested handler error', wrapped(-32000, 'downstream method not found after mutation')],
  ['-32601 with a foreign reason', rpc(-32601, 'method not found', { reason: 'something_else' })]
]

test('v2-r3 H2 "Rewind to here": a handler error / unknown code is uncertain, never a legacy undo', async () => {
  for (const [label, error] of H2_ERRORS) {
    const { gw, chat } = await open({
      'session.rewind': () => {
        throw error
      }
    })
    const res = await chat.rewindTo(item(chat, 3).id)
    assert.equal(count(gw, 'session.rewind'), 1, label)
    assert.equal(count(gw, 'slash.exec'), 0, `no legacy undo: ${label}`)
    assert.equal(count(gw, 'command.dispatch'), 0, label)
    assert.equal(res.ok, false, label)
    assert.equal(res.prefill, undefined, label)
    assert.match(commands(chat).at(-1).output, /may still have happened/i, label)
    await settle()
    chat.dispose()
  }
})

test('v2-r3 H2 typed /undo and /retry: the same errors never reach slash.exec', async () => {
  for (const command of ['/undo', '/retry']) {
    for (const [label, error] of H2_ERRORS) {
      const { gw, chat } = await open({
        'session.rewind': () => {
          throw error
        }
      })
      const res = await chat.runSlash(command)
      assert.equal(count(gw, 'slash.exec'), 0, `${command}: ${label}`)
      assert.equal(count(gw, 'command.dispatch'), 0, `${command}: ${label}`)
      assert.equal(count(gw, 'prompt.submit'), 0, `${command}: ${label}`)
      assert.equal(res.ok, false)
      chat.dispose()
    }
  }
})

test('v2-r3 H2 a gateway that does not serve session.rewind (structured -32601) still uses the legacy /undo', async () => {
  for (const error of [rpc(-32601, 'unknown method: session.rewind'), wrapped(-32601, 'unknown method'), rpc(-32601, 'x', { reason: 'unknown_method' })]) {
    const { gw, chat } = await open({
      'session.rewind': () => {
        throw error
      },
      'slash.exec': () => ({ type: 'prefill', message: 'second' })
    })
    const res = await chat.rewindTo(item(chat, 3).id)
    assert.equal(count(gw, 'slash.exec'), 1)
    assert.equal(res.ok, true)
    chat.dispose()
  }
})

test('v2-r3 H2 a -32601 after the rewind was already served (replay probe answered) is not "not served"', async () => {
  let calls = 0
  const { gw, chat } = await open({
    'session.rewind': () => {
      calls += 1
      if (calls === 1) return { status: 'nothing', rewound_count: 0 }
      throw rpc(-32601, 'unknown method')
    },
    'session.resume': () => ({
      session_id: 'rt-1',
      messages: [
        { role: 'user', row_id: 1, content: 'first' },
        { role: 'assistant', row_id: 2, content: 'one' }
      ]
    })
  })
  const res = await chat.runSlash('/undo')
  assert.equal(count(gw, 'slash.exec'), 0)
  assert.equal(res.ok, false)
  chat.dispose()
})

// ── create-chat: the compat kickoff only after a definitive title refusal ───

const NO_CHAT_BOT = { name: 'fresh' }
const noWait = () => Promise.resolve()

test('v2-r3 inventory: an uncertain eager title never triggers the compat kickoff prompt', async () => {
  for (const [label, error] of [
    ['storage error', rpc(5007, 'database is locked')],
    ['timeout', new Error('Gateway request timed out')],
    ['unknown code', rpc(5999, 'x')]
  ]) {
    const gw = gateway({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => ({ session_id: 'rt', stored_session_id: 'st' }),
      'session.title': () => {
        throw error
      }
    })
    await createCanonicalChat(gw.deps.requestForBot, { ...NO_CHAT_BOT, name: `fresh-${label}` }, { wait: noWait })
    assert.ok(!gw.methods().includes('prompt.submit'), `no kickoff: ${label}`)
  }
  const gw = gateway({
    'session.list': () => ({ sessions: [] }),
    'session.create': () => ({ session_id: 'rt', stored_session_id: 'st' }),
    'session.title': () => {
      throw new Error('Session revision unavailable; reopen the session before editing metadata')
    }
  })
  await createCanonicalChat(gw.deps.requestForBot, { name: 'fresh-host' }, { wait: noWait })
  assert.deepEqual(gw.calls.find(c => c.method === 'prompt.submit')?.params, { session_id: 'rt', text: KICKOFF_TEXT }, 'a host pre-send refusal still kicks off')
})

// ── the classifier table: every call site, one module ───────────────────────

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const CLASSIFIERS = [
  'classifySubmitFailure',
  'submitDelivery',
  'isRuntimeNotFoundRefusal',
  'isIdentityRefusal',
  'isAdmittedConflict',
  'controlFailure',
  'steerFailure',
  'slashExecFailure',
  'rewindFailure',
  'titleFailure',
  'isMethodNotServed',
  'looksUnsupported',
  'isSessionGoneError',
  'roomPostFailure',
  'isHostPreSendFailure'
]

// [file, classifier, calls, what the verdict may authorize]
const CALL_SITES = [
  ['core/session.js', 'classifySubmitFailure', 1, 'restore the draft (a later manual resend) only on not-sent; unknown → delivery check'],
  ['core/session.js', 'isRuntimeNotFoundRefusal', 3, 'one re-attach + identical re-send (4001, nothing ran): a message, and a hidden card or widget intent'],
  ['core/session.js', 'isIdentityRefusal', 1, 'one identity-less re-send (4094 / 4000 naming submission_id)'],
  ['core/session.js', 'isAdmittedConflict', 1, 'settle as the admitted original; never a new turn'],
  ['core/session.js', 'steerFailure', 1, '/steer queued as the next turn only on refused'],
  ['core/session.js', 'slashExecFailure', 1, 'command.dispatch fallback only on refused'],
  ['core/session.js', 'rewindFailure', 1, 'label only ("may still have happened"); never repeated'],
  ['core/session.js', 'isMethodNotServed', 1, 'legacy /undo fallback only before any rewind was served'],
  ['core/session.js', 'looksUnsupported', 3, 'read-only: reconcile via snapshot, answer/connection card says "not available here"'],
  ['core/session.js', 'isSessionGoneError', 4, 're-attach (read), forget local staging of a reaped runtime, Stop is moot'],
  ['core/create-chat.js', 'titleFailure', 1, 'adopt on conflict; compat kickoff only on refused'],
  ['core/emailDrafts.js', 'isMethodNotServed', 1, 'plugin RPC not served (nothing ran): the same call once through the plugin slash command'],
  ['core/rooms.js', 'roomPostFailure', 1, 'give the words back only on admitted:false; else same-event-id retry'],
  ['core/botMeta.js', 'looksUnsupported', 1, 'read-only verdict: keep the save local (no server write)'],
  ['ui/app.ts', 'looksUnsupported', 1, 'read-only: room list shows none'],
  ['ui/Screen.tsx', 'looksUnsupported', 1, 'read-only: screen tab shows unavailable']
]

function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sources(path, out)
    else if (/\.(m?js|tsx?)$/.test(entry.name)) out.push(path)
  }
  return out
}
const code = text =>
  text
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .map(line => line.replace(/\s\/\/ .*$/, ''))
    .join('\n')

test('v2-r3 inventory: the classifier table lists every call site, and no module classifies errors on its own', () => {
  const found = []
  for (const file of sources(SRC)) {
    const rel = file.slice(SRC.length).replaceAll('\\', '/')
    if (rel === 'core/outcomes.js') continue
    const text = code(readFileSync(file, 'utf8'))
    for (const name of CLASSIFIERS) {
      const calls = (text.match(new RegExp(`\\b${name}\\(`, 'g')) || []).length
      if (calls) found.push([rel, name, calls])
    }
    // Ad-hoc classification outside the one module.
    assert.doesNotMatch(text, /-32601|unknown method|method not found|admitted === false|\.test\(\s*String\(\s*(error|err)\??\.message/i, `${rel} classifies errors on its own`)
    assert.doesNotMatch(text, /\b(error|err|e|exc|cause)\??\.code\s*[!=]==?\s*-?\d|\.data\??\.(reason|admitted)\b/, `${rel} reads an error code on its own`)
  }
  const expected = CALL_SITES.map(([file, name, calls]) => [file, name, calls])
  const key = rows => rows.map(r => r.join(' ')).sort()
  assert.deepEqual(key(found), key(expected))
})
