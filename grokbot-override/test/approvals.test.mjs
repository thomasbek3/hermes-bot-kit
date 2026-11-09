// Milestone 4: approval cards, tool activity, thinking.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { approvalChoices, approvalFromPayload, cancelApprovals, reconcilePending, upsertApproval } from '../src/core/approvals.js'
import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { createChatController } from '../src/core/session.js'
import { BOT, gateway } from './harness.mjs'

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/approvals.json', import.meta.url), 'utf8'))

test('choices follow the server: explicit list, else once/session/always/deny, smart-denied drops the allow-alls', () => {
  assert.deepEqual(approvalChoices(FIX.approval), ['once', 'session', 'deny'])
  assert.deepEqual(approvalChoices(FIX.no_choices), ['once', 'session', 'always', 'deny'])
  assert.deepEqual(approvalChoices(FIX.smart_denied), ['once', 'deny'])
  assert.deepEqual(approvalChoices({ allow_permanent: false }), ['once', 'session', 'deny'])
})

test('canonical approval.request events key on prompt_id', () => {
  const approval = approvalFromPayload(FIX.canonical_event)
  assert.equal(approval.requestId, 'prompt-7')
  const state = applyEvent(initialChatState(), { type: 'approval.request', session_id: 'rt-1', payload: FIX.canonical_event })
  assert.equal(state.items[0].kind, 'approval')
  assert.equal(state.items[0].status, 'pending')
})

test('upsert is idempotent; cancel and reconcile settle cards', () => {
  const a = approvalFromPayload(FIX.approval)
  let items = upsertApproval([], a, 1)
  items = upsertApproval(items, a, 2)
  assert.equal(items.length, 1)
  assert.equal(cancelApprovals(items, ['req-approval-1'], 'interrupt')[0].status, 'cancelled')
  assert.equal(reconcilePending(items, [])[0].status, 'resolved', 'gone from the queue = answered elsewhere')
  assert.equal(reconcilePending(items, [FIX.approval])[0].status, 'pending')
})

test('approval.cancelled events mark the matching card', () => {
  let state = applyEvent(initialChatState(), { type: 'approval.request', payload: FIX.approval })
  state = applyEvent(state, { type: 'approval.cancelled', payload: FIX.cancelled })
  assert.equal(state.items[0].status, 'cancelled')
  assert.equal(state.items[0].reason, 'interrupt')
})

test('while a turn runs the controller polls approval.pending (a read) and shows the card', async () => {
  let pending = [FIX.approval]
  const gw = gateway({ 'approval.pending': () => ({ approvals: pending }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  gw.emit({ type: 'tool.start', session_id: 'rt-1', payload: { tool_id: 't1', name: 'terminal', context: 'rm -rf ./build' } })
  await gw.runTimers()
  const card = chat.get().chat.items.find(i => i.kind === 'approval')
  assert.ok(card, 'card shown')
  assert.equal(card.command, 'rm -rf ./build')
  assert.deepEqual(gw.calls.find(c => c.method === 'approval.pending').params, { session_id: 'rt-1' })

  // answered in Hermes's own window: the queue empties, the card says so
  pending = []
  await gw.runTimers()
  assert.equal(chat.get().chat.items.find(i => i.kind === 'approval').status, 'resolved')
})

test('answering sends approval.respond with request_id and the full approval window', async () => {
  const gw = gateway({
    'session.resume': () => ({ session_id: 'rt-1', running: true, pending_approval: FIX.approval })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(await chat.respondApproval('req-approval-1', 'session'), true)
  const respond = gw.calls.find(c => c.method === 'approval.respond')
  assert.deepEqual(respond.params, { session_id: 'rt-1', request_id: 'req-approval-1', choice: 'session' })
  assert.equal(respond.options.timeoutMs, 300_000)
  const card = chat.get().chat.items.find(i => i.kind === 'approval')
  assert.equal(card.status, 'answered')
  assert.equal(card.answer, 'session')
  assert.equal(await chat.respondApproval('req-approval-1', 'deny'), false, 'a card is answered once')
})

test('a failed answer puts the card back to pending with the error', async () => {
  const gw = gateway({
    'session.resume': () => ({ session_id: 'rt-1', running: true, pending_approval: FIX.approval }),
    'approval.respond': () => {
      throw new Error('approval expired')
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(await chat.respondApproval('req-approval-1', 'once'), false)
  const card = chat.get().chat.items.find(i => i.kind === 'approval')
  assert.equal(card.status, 'pending')
  assert.match(card.error, /approval expired/)
})

test('when the turn ends, cards still pending are closed and polling stops', async () => {
  const gw = gateway({ 'approval.pending': () => ({ approvals: [FIX.approval] }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  await gw.runTimers()
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'Denied, stopping.' } })
  assert.equal(chat.get().chat.items.find(i => i.kind === 'approval').status, 'cancelled')
  const polls = gw.calls.filter(c => c.method === 'approval.pending').length
  await gw.runTimers()
  await gw.runTimers()
  assert.equal(gw.calls.filter(c => c.method === 'approval.pending').length, polls)
})

test('thinking streams into the reply as collapsed reasoning; tool activity groups per run', () => {
  let s = initialChatState()
  const ev = (type, payload) => (s = applyEvent(s, { type, payload }, 5))
  ev('message.start', {})
  ev('thinking.delta', { text: 'hmm ' })
  ev('reasoning.delta', { text: 'ok' })
  ev('tool.start', { tool_id: 'a', name: 'web_search', context: 'grok bot' })
  ev('tool.start', { tool_id: 'b', name: 'read_file', context: 'notes.md' })
  ev('tool.complete', { tool_id: 'a', duration_s: 2 })
  ev('tool.generating', { name: 'terminal' })
  assert.deepEqual(s.status, { kind: 'tool', text: 'Preparing terminal' })
  ev('message.delta', { text: 'Found it.' })
  ev('message.complete', { text: 'Found it.' })
  assert.deepEqual(s.items.map(i => i.kind), ['tools', 'assistant'])
  assert.deepEqual(s.items[0].tools.map(t => [t.label, t.status]), [['web search: grok bot', 'done'], ['read file: notes.md', 'done']])
  assert.equal(s.items[1].reasoning, 'hmm ok')
  assert.equal(s.status, null)
})
