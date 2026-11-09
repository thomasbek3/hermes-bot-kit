// Regression tests for the round-3 review findings (reviews/override-r3.md).
// Controller and pure-core findings; the bubble status line is in
// review-r3-app.test.mjs. No network. The error shapes are Hermes's own
// (commit 2bd378ed1b): tui_gateway/methods_prompt.py, session_registry.py,
// rpc_dispatch.py, gateway/session_controls.py, apps/shared json-rpc-channel.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatController, submitDelivery } from '../src/core/session.js'
import { draftOwnerKey, restoreAfterFailure } from '../src/core/drafts.js'
import { createBotRequester } from '../src/core/routing.js'
import { BOT, flush, gateway } from './harness.mjs'

// A legacy tui_gateway refuses the submission_id key before any handler runs
// (contracts/base.py extra="forbid" -> rpc_dispatch 4000): the override then
// sends once without it, and that identityless send is what these tests are
// about (C6 keeps the never-twice rule for it).
const legacy = fail => params => {
  if (params?.submission_id) throw Object.assign(new Error('invalid params for prompt.submit: submission_id: Extra inputs are not permitted'), { code: 4000 })
  return fail(params)
}

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const count = (gw, method) => gw.calls.filter(c => c.method === method).length
const assistants = chat => chat.get().chat.items.filter(i => i.kind === 'assistant')
const ROWS = [
  { id: 1, role: 'user', content: 'hi', timestamp: 1762560000 },
  { id: 2, role: 'assistant', content: 'hello', timestamp: 1762560001 }
]

/** What the host throws for a JSON-RPC error frame (JsonRpcGatewayError). */
class JsonRpcGatewayError extends Error {
  constructor(message, { code, data } = {}) {
    super(message)
    this.name = 'JsonRpcGatewayError'
    this.code = code
    this.data = data
  }
}
const rpcError = (code, message, data) => new JsonRpcGatewayError(message, { code, data })

// methods_prompt.py:752-754
const UNCONFIRMED = () =>
  rpcError(
    4090,
    'The gateway is running a turn in this chat and did not confirm your message in time. It may already be queued there: check the chat before sending it again.',
    { reason: 'SESSION_OWNER_UNCONFIRMED' }
  )
// methods_prompt.py:764-766
const OWNER_BUSY = (images = false) =>
  rpcError(
    4090,
    `The gateway is running a turn in this chat and ${images ? 'an image cannot join its queue, so it was removed from this message' : 'the gateway refused it'}. Nothing was sent. Send it again when the current turn ends.`,
    { reason: 'SESSION_OWNER_BUSY' }
  )

// ── #1 an unconfirmed admission is not "not sent" ──────────────────────────

test('r3 #1 the classifier follows the Hermes submit contract, not the mere presence of a code', () => {
  const unknown = [
    ['4090 SESSION_OWNER_UNCONFIRMED', UNCONFIRMED()],
    ['4090 without a reason', rpcError(4090, 'refused')],
    ['4090 with an unknown reason', rpcError(4090, 'refused', { reason: 'SOMETHING_NEW' })],
    ['-32000 handler error (may follow the worker start)', rpcError(-32000, 'handler error: boom')],
    ['5000 internal', rpcError(5000, 'internal')],
    ['4064 profile unavailable', rpcError(4064, 'profile unavailable')],
    ['canonical 5001 storage_unavailable (can follow the commit)', rpcError(5001, 'storage_unavailable', { reason: 'storage_unavailable' })],
    ['canonical admission_conflict', rpcError(4001, 'admission_conflict', { reason: 'admission_conflict', field: 'request_id' })],
    ['canonical reason outside the pre-commit list', rpcError(4001, 'session_busy', { reason: 'session_busy' })],
    ['timeout', new Error('request timed out after 30s: prompt.submit')],
    ['socket closed', new Error('WebSocket closed')],
    ['wrapped (routing.js asError) unconfirmed', Object.assign(new Error('x'), { code: 4090, cause: { code: 4090, message: 'x', data: { reason: 'SESSION_OWNER_UNCONFIRMED' } } })]
  ]
  for (const [label, error] of unknown) assert.equal(submitDelivery(error), 'unknown', label)
  const refused = [
    ['4090 SESSION_OWNER_BUSY', OWNER_BUSY()],
    ['4090 SESSION_NOT_OWNED', rpcError(4090, 'owned elsewhere', { reason: 'SESSION_NOT_OWNED' })],
    ['4090 MAX_CONCURRENT_SESSIONS', rpcError(4090, 'limit', { reason: 'MAX_CONCURRENT_SESSIONS' })],
    ['4001 session not found (_sess_nowait)', rpcError(4001, 'session not found')],
    ['4007 stale runtime', rpcError(4007, 'session no longer live; retry resume')],
    ['4009 session busy', rpcError(4009, 'session busy')],
    ['4000 params contract', rpcError(4000, 'invalid params for prompt.submit: x')],
    ['5035 retiring', rpcError(5035, 'backend is retiring; reconnect to continue')],
    ['5072 storage, rolled back', rpcError(5072, 'Session storage is unavailable, so this message was not saved.', { code: 'x' })],
    ['canonical queue_full', rpcError(4001, 'queue_full', { reason: 'queue_full' })],
    ['canonical admitted:false', rpcError(4001, 'busy', { reason: 'whatever', admitted: false })],
    ['not connected (before the frame is written)', new Error('gateway not connected')]
  ]
  for (const [label, error] of refused) assert.equal(submitDelivery(error), 'not-sent', label)
})

test('r3 #1 a 4090 SESSION_OWNER_UNCONFIRMED is "delivery unknown": no composer restore, no retry', async () => {
  const gw = gateway({
    'prompt.submit': legacy(() => {
      throw UNCONFIRMED()
    })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('queued maybe')
  assert.equal(result.delivery, 'unknown')
  const owner = draftOwnerKey(BOT)
  assert.equal(restoreAfterFailure({ result, sentOwner: owner, currentOwner: owner, currentText: '', currentFiles: [] }), false, 'never put back in the composer')
  const retried = await chat.retry(result.clientId)
  assert.equal(retried.ok, false)
  assert.equal(count(gw, 'prompt.submit'), 2, 'the id-carrying attempt (refused by contract) and one identityless send')
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit' && !c.params.submission_id).length, 1, 'never sent a second copy')
})

test('r3 #1 the structured reason survives the real requester wrapping (cause.data)', async () => {
  const gw = gateway()
  const host = {
    request: async () => {
      throw new Error('unexpected active-gateway call')
    },
    requestProfile: async (route, method, params) => {
      if (method === 'prompt.submit') {
        // a host that rejects with the raw error member of the frame
        throw { code: 4090, message: 'did not confirm your message in time', data: { reason: 'SESSION_OWNER_UNCONFIRMED' } }
      }
      return gw.deps.requestForBot(BOT, method, params)
    }
  }
  const chat = createChatController(BOT, { ...gw.deps, requestForBot: createBotRequester(host) })
  await chat.open()
  const result = await chat.sendDraft('wrapped')
  assert.equal(result.delivery, 'unknown')
})

test('r3 #1 a canonical 4001 refusal is never mistaken for a reaped runtime (no automatic re-submit)', async () => {
  let resumes = 0
  const gw = gateway({
    'session.resume': () => ({ session_id: `rt-${(resumes += 1)}`, running: false }),
    'prompt.submit': () => {
      throw rpcError(4001, 'session_busy', { reason: 'session_busy' })
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('once')
  assert.equal(count(gw, 'prompt.submit'), 1, 'no re-resume and re-submit')
  assert.equal(result.delivery, 'unknown')
})

// ── #2 a failed or empty history check never authorises a resend ───────────

test('r3 #2 three failed history reads leave the send unknown; retry never re-submits', async () => {
  let failReads = false
  const gw = gateway({
    'prompt.submit': legacy(() => {
      failReads = true
      throw new Error('request timed out after 30s: prompt.submit')
    }),
    REST: () => {
      if (failReads) throw new Error('HTTP 502')
      return { messages: ROWS }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('lost ack')
  for (let i = 0; i < 4; i += 1) await gw.runTimers()
  await settle()
  const bubble = chat.get().chat.items.find(i => i.id === result.clientId)
  assert.equal(bubble.delivery, 'unknown')
  assert.equal(bubble.checked, true)
  assert.equal(bubble.checkFailed, true)
  const retried = await chat.retry(result.clientId)
  assert.equal(retried.ok, false)
  assert.equal(retried.delivery, 'unknown')
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit' && !c.params.submission_id).length, 1, 'still one identityless submit')
})

test('r3 #2 admitted but not yet visible: "not found" stays unknown; a read-only recheck finds it later', async () => {
  let visible = false
  const gw = gateway({
    'prompt.submit': legacy(() => {
      throw new Error('request timed out after 30s: prompt.submit')
    }),
    REST: () => ({ messages: visible ? [...ROWS, { id: 3, role: 'user', content: 'slow queue', timestamp: 1762560100 }] : ROWS })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('slow queue')
  await gw.runTimers()
  await settle()
  let bubble = chat.get().chat.items.find(i => i.id === result.clientId)
  assert.equal(bubble.delivery, 'unknown', 'absence from one page is not a refusal')
  assert.equal(bubble.checked, true)
  assert.equal((await chat.retry(result.clientId)).ok, false)
  chat.dropFailed(result.clientId) // a composer restore is not allowed for unknown either
  assert.ok(chat.get().chat.items.some(i => i.id === result.clientId), 'the unknown bubble stays')
  visible = true // the owner ran the queued prompt
  await chat.recheck(result.clientId)
  await settle()
  assert.ok(!chat.get().chat.items.some(i => i.failed), 'found: no longer unknown')
  assert.equal(chat.get().chat.items.filter(i => i.kind === 'user' && i.text === 'slow queue').length, 1)
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit' && !c.params.submission_id).length, 1)
})

test('r3 #2 the idle refresh resolves an unknown send when its row shows up', async () => {
  let visible = false
  const gw = gateway({
    'prompt.submit': () => {
      throw new Error('WebSocket closed')
    },
    REST: () => ({ messages: visible ? [...ROWS, { id: 3, role: 'user', content: 'eventually', timestamp: 1762560100 }] : ROWS })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('eventually')
  await gw.runTimers()
  await settle()
  assert.equal(chat.get().chat.items.find(i => i.id === result.clientId).delivery, 'unknown')
  visible = true
  await chat.refresh()
  assert.ok(!chat.get().chat.items.some(i => i.failed))
  assert.equal(count(gw, 'prompt.submit'), 1)
})

// ── #3 composer restoration keeps (and cleans up) staged images ────────────

const IMG = { id: 'img-1', kind: 'image', name: 'paste.png', data: 'data:image/png;base64,AAAA', owner: draftOwnerKey(BOT) }

function stagingGateway({ refuse }) {
  let submits = 0
  let n = 0
  const gw = gateway({
    'image.attach_bytes': () => ({ attached: true, path: `/cache/images/upload_${(n += 1)}.png`, count: 1 }),
    'image.detach': () => ({ detached: true, count: 0 }),
    'prompt.submit': () => {
      submits += 1
      if (submits === 1) throw refuse()
      return { status: 'streaming' }
    }
  })
  return gw
}

/** The composer's own path: restore when restoreAfterFailure says so, then
 *  hand the bubble back to the controller (Chat.tsx onRestored). */
function composerRestore(chat, result) {
  const owner = draftOwnerKey(BOT)
  const restore = restoreAfterFailure({ result, sentOwner: owner, currentOwner: owner, currentText: '', currentFiles: [] })
  if (restore) chat.dropFailed(result.clientId)
  return restore
}

test('r3 #3 a restored draft re-uses the image already staged on the same runtime', async () => {
  const gw = stagingGateway({ refuse: () => rpcError(4009, 'session busy') })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('look', [IMG])
  assert.equal(result.delivery, 'not-sent')
  assert.equal(composerRestore(chat, result), true)
  const again = await chat.sendDraft('look', [IMG])
  assert.equal(again.ok, true)
  assert.equal(count(gw, 'image.attach_bytes'), 1, 'the image is not staged twice')
  assert.equal(count(gw, 'image.detach'), 0)
})

test('r3 #3 an image removed from a restored draft is detached before the next send', async () => {
  const gw = stagingGateway({ refuse: () => rpcError(4009, 'session busy') })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('look', [IMG])
  composerRestore(chat, result)
  const again = await chat.sendDraft('text only') // the user removed the image
  assert.equal(again.ok, true)
  const methods = gw.methods()
  const detach = methods.lastIndexOf('image.detach')
  assert.ok(detach >= 0, 'the staged image was detached')
  assert.ok(detach < methods.lastIndexOf('prompt.submit'), 'before the text was submitted')
  assert.equal(gw.calls.find(c => c.method === 'image.detach').params.path, '/cache/images/upload_1.png')
})

test('r3 #3 removing the image in the composer detaches it at once', async () => {
  const gw = stagingGateway({ refuse: () => rpcError(4009, 'session busy') })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('look', [IMG])
  composerRestore(chat, result)
  await chat.discardStaged([IMG.id])
  assert.equal(count(gw, 'image.detach'), 1)
  await chat.sendDraft('text only')
  assert.equal(count(gw, 'image.detach'), 1, 'nothing left to detach')
})

test('r3 #3 a detach that fails blocks the send ("not sent") instead of letting the image ride along', async () => {
  const gw = stagingGateway({ refuse: () => rpcError(4009, 'session busy') })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('look', [IMG])
  composerRestore(chat, result)
  gw.deps.requestForBot = (inner => async (bot, method, params, options) => {
    if (method === 'image.detach') {
      gw.calls.push({ method, params })
      throw new Error('request timed out after 30s: image.detach')
    }
    return inner(bot, method, params, options)
  })(gw.deps.requestForBot)
  const again = await chat.sendDraft('text only')
  assert.equal(again.delivery, 'not-sent')
  assert.equal(count(gw, 'prompt.submit'), 1, 'the text was not submitted with the image still staged')
})

test('r3 #3 an owner-FIFO refusal unstaged the image: the restored draft stages it again', async () => {
  const gw = stagingGateway({ refuse: () => OWNER_BUSY(true) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('look', [IMG])
  assert.equal(result.delivery, 'not-sent')
  composerRestore(chat, result)
  assert.equal((await chat.sendDraft('look', [IMG])).ok, true)
  assert.equal(count(gw, 'image.attach_bytes'), 2, 'Hermes removed it, so it is attached again')
})

test('r3 #3 a staging-only (canonical) image receipt is passed to prompt.submit as an attachment', async () => {
  const gw = gateway({
    'image.attach_bytes': () => ({ attached: true, path: '/home/cache/images/upload_9.png', mime: 'image/png', name: 'upload_9.png', count: 1 })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal((await chat.sendDraft('see', [IMG])).ok, true)
  const submit = gw.calls.find(c => c.method === 'prompt.submit')
  assert.deepEqual(submit.params.attachments, [{ path: '/home/cache/images/upload_9.png', mime: 'image/png' }])
})

// ── #4 a reconciliation snapshot can create the live bubble ────────────────

function runningGateway(snapshots) {
  let resumes = 0
  return gateway({
    'session.resume': () => snapshots[Math.min((resumes += 1) - 1, snapshots.length - 1)],
    'session.active_list': () => ({ sessions: [{ id: 'rt-1', status: 'working' }] })
  })
}
const snap = assistant => ({ session_id: 'rt-1', running: true, inflight: { streaming: true, assistant } })

test('r3 #4 a replay gap before the first delta recovers the text into a new live bubble', async () => {
  const gw = runningGateway([snap(''), snap('recovered text')])
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await settle()
  gw.emit({ type: 'session.replay_gap', session_id: 'rt-1', payload: {} })
  await settle()
  const live = assistants(chat).filter(i => i.streaming)
  assert.equal(live.length, 1, 'a live bubble exists')
  assert.equal(live[0].text, 'recovered text')
  gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: ' and more' } })
  assert.equal(assistants(chat).filter(i => i.streaming)[0].text, 'recovered text and more', 'later deltas extend it')
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'recovered text and more' } })
  await settle()
  assert.deepEqual(assistants(chat).map(i => i.text), ['hello', 'recovered text and more'])
  assert.equal(count(gw, 'prompt.submit'), 0)
})

test('r3 #4 after a tool boundary the recovered bubble holds only the new segment', async () => {
  const gw = runningGateway([snap(''), snap('Let me check.Found it')])
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await settle()
  gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: 'Let me check.' } })
  gw.emit({ type: 'tool.start', session_id: 'rt-1', payload: { tool_id: 't1', name: 'terminal' } })
  gw.emit({ type: 'tool.complete', session_id: 'rt-1', payload: { tool_id: 't1', summary: 'exit 0' } })
  gw.emit({ type: 'session.replay_gap', session_id: 'rt-1', payload: {} })
  await settle()
  assert.deepEqual(assistants(chat).map(i => i.text), ['hello', 'Let me check.', 'Found it'])
  gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: ' now.' } })
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'Found it now.' } })
  await settle()
  assert.deepEqual(assistants(chat).map(i => i.text), ['hello', 'Let me check.', 'Found it now.'])
  assert.deepEqual(chat.get().chat.items.slice(-3).map(i => i.kind), ['assistant', 'tools', 'assistant'])
})

test('r3 #4 an existing bubble after a tool boundary is not refilled with the sealed segment', async () => {
  const gw = runningGateway([snap(''), snap('Let me check.Found it')])
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await settle()
  gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: 'Let me check.' } })
  gw.emit({ type: 'tool.start', session_id: 'rt-1', payload: { tool_id: 't1', name: 'terminal' } })
  gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: 'Fou' } })
  gw.emit({ type: 'session.replay_gap', session_id: 'rt-1', payload: {} })
  await settle()
  assert.deepEqual(assistants(chat).map(i => i.text), ['hello', 'Let me check.', 'Found it'])
})

test('r3 #4 a snapshot that does not match the sealed text is not guessed at', async () => {
  const gw = runningGateway([snap(''), snap('Something else entirely')])
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await settle()
  gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: 'Let me check.' } })
  gw.emit({ type: 'tool.start', session_id: 'rt-1', payload: { tool_id: 't1', name: 'terminal' } })
  gw.emit({ type: 'session.replay_gap', session_id: 'rt-1', payload: {} })
  await settle()
  assert.deepEqual(assistants(chat).map(i => i.text), ['hello', 'Let me check.'], 'left for message.complete to settle')
})
