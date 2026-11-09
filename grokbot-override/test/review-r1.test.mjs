// Regression tests for the round-1 review findings (reviews/override-r1.md).
// Each reproduces the failure the review describes against the fake gateway,
// then pins the fixed behaviour. No network, no app.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { createChatController, HISTORY_PAGE } from '../src/core/session.js'
import { draftOwnerKey, readDraftFiles } from '../src/core/drafts.js'
import { mentionedBots } from '../src/core/mentions.js'
import { BOT, flush, gateway, pooledGateway } from './harness.mjs'

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/approvals.json', import.meta.url), 'utf8'))

const otherBot = name => ({ ...BOT, name, route: { ...BOT.route, profile: name, targetProfile: name } })

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── #1 routed chat retains its gateway socket ──────────────────────────────

test('#1 a pooled remote route that reaps at zero leases still opens, sends, attaches, answers and stops', async () => {
  const pool = pooledGateway()
  const chat = createChatController(BOT, pool.deps)
  await chat.open()
  assert.equal(chat.get().runtimeId, 'rt-1')
  assert.equal(pool.alive('rt-1'), true, 'the runtime survives the end of session.resume')

  assert.equal(
    await chat.send('look', [
      { kind: 'image', name: 'shot.png', data: 'data:image/png;base64,AAAA', owner: draftOwnerKey(BOT) },
      { kind: 'pdf', name: 'a.pdf', data: 'data:application/pdf;base64,BBBB', owner: draftOwnerKey(BOT) }
    ]),
    true
  )
  assert.equal(pool.calls.filter(c => c.method === 'session.resume').length, 1, 'no re-resume: the runtime was never reaped')
  assert.equal(pool.calls.filter(c => c.method === 'prompt.submit').length, 1)

  pool.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  pool.emit({ type: 'approval.request', session_id: 'rt-1', payload: FIX.approval })
  assert.equal(await chat.respondApproval('req-approval-1', 'once'), true)
  assert.equal(await chat.interrupt(), true)
  assert.deepEqual(pool.failures, [], 'no RPC hit a reaped runtime')

  chat.dispose()
  assert.equal(pool.leases(), 0, 'dispose releases the route lease')
  assert.equal(pool.releases, 1)
  chat.dispose()
  assert.equal(pool.releases, 1, 'released exactly once')
})

test('#1 the lease is acquired once, foreground, before the first session.resume', async () => {
  const pool = pooledGateway()
  const chat = createChatController(BOT, pool.deps)
  await chat.open()
  await chat.send('one')
  await chat.send('two')
  assert.equal(pool.retains.length, 1)
  assert.equal(pool.order.indexOf('retain') < pool.order.indexOf('session.resume'), true)
  chat.dispose()
})

test('#1 disposing while the lease is still being acquired releases it when it lands', async () => {
  const gate = deferred()
  const pool = pooledGateway({ retainGate: gate.promise })
  const chat = createChatController(BOT, pool.deps)
  const opening = chat.open()
  await flush()
  chat.dispose()
  gate.resolve()
  await opening
  await flush()
  assert.equal(pool.leases(), 0)
  assert.equal(pool.releases, 1)
})

test('#1 a host without retainProfile (or a failed acquire) still runs the chat', async () => {
  const pool = pooledGateway({ retainFails: true })
  const chat = createChatController(BOT, pool.deps)
  await chat.open()
  assert.equal(chat.get().phase, 'ready')
  const plain = gateway()
  const chat2 = createChatController(BOT, plain.deps)
  await chat2.open()
  assert.equal(chat2.get().runtimeId, 'rt-1')
})

test('#1 a runtime lost mid-turn (poll says session gone) settles the turn and never resends the prompt', async () => {
  let gone = false
  const gw = gateway({
    'approval.pending': () => {
      if (gone) throw Object.assign(new Error('session not found'), { code: 4001 })
      return { approvals: [] }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await chat.send('long job')
  assert.equal(chat.get().chat.busy, true)
  gone = true
  await gw.runTimers()
  await flush()
  assert.equal(chat.get().chat.busy, false, 'busy is no longer latched')
  assert.equal(chat.get().runtimeId, '')
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit').length, 1, 'the prompt is not re-sent')
})

test('#1 a failed stop is reported, not swallowed', async () => {
  const gw = gateway({ 'session.interrupt': () => { throw new Error('socket closed') } })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(await chat.interrupt(), false)
  assert.match(chat.get().stopError, /socket closed/)
})

// ── #3 approval reconciliation ─────────────────────────────────────────────

test('#3 a stale empty approval.pending reply cannot disable a request that arrived after it was sent', async () => {
  const poll = deferred()
  let first = true
  const gw = gateway({
    'approval.pending': () => {
      if (first) {
        first = false
        return poll.promise
      }
      return { approvals: [FIX.approval] }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  const ticking = gw.runTimers() // the poll is now in flight
  await flush()
  gw.emit({ type: 'approval.request', session_id: 'rt-1', payload: FIX.approval })
  poll.resolve({ approvals: [] }) // older than the event
  await ticking
  let card = chat.get().chat.items.find(i => i.kind === 'approval')
  assert.equal(card.status, 'pending', 'the stale empty list is discarded')

  // even a locally inferred "resolved" card comes back when the gateway lists it again
  gw.emit({ type: 'approval.request', session_id: 'rt-1', payload: FIX.approval })
  await gw.runTimers()
  card = chat.get().chat.items.find(i => i.kind === 'approval')
  assert.equal(card.status, 'pending')
  assert.equal(await chat.respondApproval('req-approval-1', 'once'), true)
})

test('#3 an authoritative list revives a card that was only inferred resolved', async () => {
  const { reconcilePending, upsertApproval, approvalFromPayload } = await import('../src/core/approvals.js')
  let items = upsertApproval([], approvalFromPayload(FIX.approval), 1)
  items = reconcilePending(items, [])
  assert.equal(items[0].status, 'resolved')
  items = reconcilePending(items, [FIX.approval])
  assert.equal(items[0].status, 'pending')
  // an answer given here is never revived
  items = items.map(i => ({ ...i, status: 'answered', answer: 'once' }))
  assert.equal(reconcilePending(items, [FIX.approval])[0].status, 'answered')
})

test('#3 approval.respond that resolved nothing is not shown as answered', async () => {
  const gw = gateway({ 'approval.respond': () => ({ resolved: 0 }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  gw.emit({ type: 'approval.request', session_id: 'rt-1', payload: FIX.approval })
  assert.equal(await chat.respondApproval('req-approval-1', 'once'), false)
  const card = chat.get().chat.items.find(i => i.kind === 'approval')
  assert.equal(card.status, 'expired')
})

test('#3 canonical approval.settled clears the card', () => {
  let state = applyEvent(initialChatState(), { type: 'approval.request', payload: FIX.canonical_event })
  state = applyEvent(state, { type: 'approval.settled', payload: { prompt_id: 'prompt-7' } })
  assert.equal(state.items[0].status, 'resolved')
})

// ── #5 idle refresh keeps loaded pages and local items ─────────────────────

function pagedHistory(total) {
  // rows 1..total, oldest first; order=latest pages count back from the newest
  let size = total
  const rows = () => Array.from({ length: size }, (_, i) => ({ id: i + 1, role: i % 2 ? 'assistant' : 'user', content: `m${i + 1}`, timestamp: 1762560000 + i }))
  return {
    grow: n => (size += n),
    REST: ({ offset, limit }) => {
      const all = rows()
      const end = all.length - offset
      return { messages: all.slice(Math.max(0, end - limit), Math.max(0, end)) }
    }
  }
}

test('#5 refresh after "Show earlier messages" keeps the earlier page and a consistent offset', async () => {
  const history = pagedHistory(400)
  const gw = gateway({ REST: history.REST })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await chat.loadEarlier()
  assert.equal(chat.get().loadedCount, 240)
  const before = chat.get().chat.items.length
  assert.equal(before, 240)

  await chat.refresh()
  assert.equal(chat.get().chat.items.length, 240, 'the earlier page is still on screen')
  assert.equal(chat.get().loadedCount, 240)

  history.grow(3) // three new rows arrive from another surface
  await chat.refresh()
  assert.equal(chat.get().chat.items.length, 243)
  assert.equal(chat.get().loadedCount, 243)

  await chat.loadEarlier()
  const rest = gw.calls.filter(c => c.method === 'REST').at(-1)
  assert.equal(rest.params.offset, 243, 'the next page starts right after the retained rows')
  const texts = chat.get().chat.items.map(i => i.text)
  assert.equal(new Set(texts).size, texts.length, 'no row twice')
  assert.equal(texts.length, 363)
  assert.deepEqual(texts.slice(0, 2), ['m41', 'm42'])
  assert.equal(texts.at(-1), 'm403')
})

test('#5 a failed send survives an idle refresh', async () => {
  const gw = gateway({ 'prompt.submit': () => { throw Object.assign(new Error('session busy'), { code: 4009 }) } })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(await chat.send('did this go?'), false)
  await chat.refresh()
  const failed = chat.get().chat.items.find(i => i.failed)
  assert.ok(failed, 'the unsent bubble is still there')
  assert.equal(failed.text, 'did this go?')
  assert.equal(chat.get().chat.items.at(-1).id, failed.id, 'and stays where it was')
})

// ── #6 resumed snapshot with text and an approval ──────────────────────────

test('#6 deltas after a snapshot with inflight text and a pending approval extend the assistant bubble', async () => {
  const gw = gateway({
    'session.resume': () => ({
      session_id: 'rt-1',
      running: true,
      inflight: { streaming: true, assistant: 'hello' },
      pending_approval: FIX.approval
    })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: ' world' } })
  const items = chat.get().chat.items
  const assistant = items.find(i => i.id.startsWith('inflight:'))
  const card = items.find(i => i.kind === 'approval')
  assert.equal(assistant.text, 'hello world')
  assert.equal(card.text, undefined)
  assert.equal(card.streaming, undefined)
})

// ── #4 file reads cannot cross bots ────────────────────────────────────────

test('#4 a file read that finishes after the bot changed is dropped', async () => {
  const reading = deferred()
  let owner = draftOwnerKey(BOT)
  const result = readDraftFiles([{ name: 'a.txt', size: 3, type: 'text/plain' }], {
    owner,
    isCurrent: key => key === owner,
    read: () => reading.promise
  })
  owner = draftOwnerKey(otherBot('other')) // switched to bot B
  reading.resolve('data:text/plain;base64,YWJj')
  const { files } = await result
  assert.deepEqual(files, [])
})

test('#4 send refuses attachments read for another bot and makes no attachment RPC', async () => {
  const gw = gateway({ 'file.attach': () => ({ ref_text: '@file:a' }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const foreign = { kind: 'file', name: 'a.txt', data: 'data:text/plain;base64,YWJj', owner: draftOwnerKey(otherBot('bot-a')) }
  assert.equal(await chat.send('hi', [foreign]), false)
  assert.ok(!gw.methods().includes('file.attach'))
  assert.ok(!gw.methods().includes('prompt.submit'))
})

// ── #7 pending input requests and mentions ─────────────────────────────────

test('#7 a clarify request shows as waiting for an answer, and clears when settled', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  gw.emit({ type: 'clarify.request', session_id: 'rt-1', payload: { prompt_id: 'c-1', question: 'Which branch?', choices: ['main', 'dev'] } })
  const waiting = chat.get().chat.waiting
  assert.equal(waiting.kind, 'clarify')
  assert.equal(waiting.id, 'c-1')
  assert.equal(waiting.text, 'Which branch?')
  assert.deepEqual(waiting.questions, [{ qid: 'c-1', question: 'Which branch?', choices: ['main', 'dev'], multiSelect: false }])
  gw.emit({ type: 'clarify.settled', session_id: 'rt-1', payload: { prompt_id: 'c-1' } })
  assert.equal(chat.get().chat.waiting, null)
})

test('#7 a resumed snapshot with an open sudo/secret request shows as waiting', async () => {
  const gw = gateway({
    'session.resume': () => ({ session_id: 'rt-1', running: true, open_requests: [{ id: 'r9', method: 'secret', params: { prompt: 'GitHub token' } }] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.get().chat.waiting.kind, 'secret')
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'ok' } })
  assert.equal(chat.get().chat.waiting, null)
})

test('#7 @mentions of other roster bots are detected (not emails, not code, not the open bot)', () => {
  const roster = [
    { ...BOT },
    { name: 'research', connectionId: 'local', handle: 'researcher' },
    { name: 'default', connectionId: 'local' },
    { name: 'scout', connectionId: 'local', display_name: 'Scout Bot' }
  ]
  const names = text => mentionedBots(text, roster, BOT).map(b => b.name)
  assert.deepEqual(names('ask @researcher about it'), ['research'])
  assert.deepEqual(names('@research hi'), ['research'])
  assert.deepEqual(names('@hermes ping'), ['default'])
  assert.deepEqual(names('@scout-bot go'), ['scout'])
  assert.deepEqual(names('mail me at me@research.org'), [])
  assert.deepEqual(names('run `@research` literally'), [])
  assert.deepEqual(names('@scholar talking to myself'), [], 'the open bot is not a relay target')
  assert.deepEqual(names('@nobody here'), [])
})

test('HISTORY_PAGE stays 120 (the reproductions above assume it)', () => {
  assert.equal(HISTORY_PAGE, 120)
})
