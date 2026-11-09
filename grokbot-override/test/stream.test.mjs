// Milestone 3: send, streaming reply, interrupt.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const STREAM = JSON.parse(fs.readFileSync(new URL('./fixtures/stream-events.json', import.meta.url), 'utf8'))
const play = (events, state = initialChatState()) => events.reduce((s, e) => applyEvent(s, { ...e, session_id: STREAM.session_id }, 1000), state)
const bubbles = state => state.items.filter(i => i.kind === 'assistant').map(i => i.text)

test('a plain turn streams into one bubble and settles idle', () => {
  const mid = play(STREAM.plain_turn.slice(0, 3))
  assert.equal(mid.busy, true)
  assert.deepEqual(bubbles(mid), ['The answer is unchanged.'])
  assert.equal(mid.items[0].streaming, true)
  const end = play(STREAM.plain_turn)
  assert.equal(end.busy, false)
  assert.deepEqual(bubbles(end), ['The answer is unchanged.'])
  assert.equal(end.items[0].streaming, false)
})

test('a re-sent start and segment (reconnect replay) renders once; the final segment is its own bubble', () => {
  const end = play(STREAM.replayed_segment)
  assert.deepEqual(bubbles(end), ['Commentary before the tool, streamed once.', 'A different final answer.'])
  const tools = end.items.filter(i => i.kind === 'tools')
  assert.equal(tools.length, 1)
  assert.deepEqual(tools[0].tools.map(t => [t.id, t.status, t.duration, t.summary]), [['call-1', 'done', 1.4, 'exit 0']])
  assert.deepEqual(end.items.map(i => i.kind), ['assistant', 'tools', 'assistant'])
})

test('reasoning attaches to the reply it precedes; backend tool labels are used', () => {
  const end = play(STREAM.reasoning_then_reply)
  const reply = end.items.find(i => i.kind === 'assistant')
  assert.equal(reply.reasoning, 'Check the log first.')
  assert.equal(end.items.find(i => i.kind === 'tools').tools[0].label, 'Inspecting app.log')
})

test('a running tool shows as running until it completes', () => {
  const mid = play(STREAM.reasoning_then_reply.slice(0, 4))
  const tool = mid.items.find(i => i.kind === 'tools').tools[0]
  assert.equal(tool.status, 'running')
  assert.equal(mid.busy, true)
})

test('a failed turn ends with an error item; a reused final adds no second bubble', () => {
  const failed = play(STREAM.failed_turn)
  assert.equal(failed.busy, false)
  assert.deepEqual(failed.items.map(i => [i.kind, i.text]), [['error', 'provider returned 429']])
  const reused = play(STREAM.reused_final)
  assert.deepEqual(bubbles(reused), ['Done, see above.'])
})

test('send: optimistic bubble, prompt.submit on the attached runtime, live stream folds in', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const sent = await chat.send('  what it do  ')
  assert.equal(sent, true)
  const submit = gw.calls.find(c => c.method === 'prompt.submit')
  const { submission_id: identity, ...rest } = submit.params
  assert.deepEqual(rest, { session_id: 'rt-1', text: 'what it do' })
  assert.match(identity, /\S{8,}/, 'every send carries a submission id (C6)')
  const user = chat.get().chat.items.at(-1)
  assert.equal(user.kind, 'user')
  assert.equal(user.text, 'what it do')
  assert.equal(user.pending, false)
  assert.equal(chat.get().chat.busy, true)

  for (const event of STREAM.plain_turn) gw.emit({ ...event, session_id: 'rt-1' })
  gw.emit({ type: 'message.delta', session_id: 'someone-else', payload: { text: 'not ours' } })
  const items = chat.get().chat.items
  assert.equal(items.at(-1).text, 'The answer is unchanged.')
  assert.ok(!items.some(i => i.text === 'not ours'), 'events for other sessions are ignored')
  assert.equal(chat.get().chat.busy, false)
})

test('send attaches lazily when the chat was opened read-only', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps, { attachOnOpen: false })
  await chat.open()
  assert.ok(!gw.methods().includes('session.resume'))
  await chat.send('hi')
  assert.deepEqual(gw.methods().slice(-2), ['session.resume', 'prompt.submit'])
})

test('a reaped runtime is re-resumed by the stored id and submitted exactly once more', async () => {
  let resumes = 0
  let submits = 0
  const gw = gateway({
    'session.resume': () => ({ session_id: `rt-${(resumes += 1)}` }),
    'prompt.submit': params => {
      submits += 1
      if (params.session_id === 'rt-1') throw Object.assign(new Error('session not found'), { code: 4001 })
      return { status: 'streaming' }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(await chat.send('again'), true)
  assert.equal(resumes, 2)
  assert.equal(submits, 2)
  assert.equal(chat.get().runtimeId, 'rt-2')
  assert.equal(gw.calls.filter(c => c.method === 'session.resume')[1].params.session_id, 'tip')
})

test('a submit failure marks the bubble, never retries a non-reap error', async () => {
  const gw = gateway({ 'prompt.submit': () => { throw Object.assign(new Error('session busy'), { code: 4009 }) } })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(await chat.send('x'), false)
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit').length, 1)
  assert.match(chat.get().chat.items.at(-1).failed, /session busy/)
})

test('a queued submit while a turn runs is labelled, not treated as a new stream', async () => {
  const gw = gateway({ 'prompt.submit': () => ({ status: 'queued' }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await chat.send('one more thing')
  assert.equal(chat.get().chat.items.at(-1).receipt, 'queued')
  assert.equal(chat.get().receipt, 'queued')
})

test('stop sends session.interrupt for the live runtime', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(await chat.interrupt(), true)
  assert.deepEqual(gw.calls.at(-1), { method: 'session.interrupt', params: { session_id: 'rt-1' }, options: undefined })
})

test('session.reclaimed drops the runtime; the next send re-attaches', async () => {
  let n = 0
  const gw = gateway({ 'session.resume': () => ({ session_id: `rt-${(n += 1)}` }) })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'session.reclaimed', session_id: 'rt-1', payload: { session_id: 'rt-1', stored_session_id: 'tip', reason: 'idle_timeout' } })
  assert.equal(chat.get().runtimeId, '')
  await chat.send('back')
  assert.equal(chat.get().runtimeId, 'rt-2')
  await flush()
})

test('attachments: images by image.attach_bytes, files by file.attach with ref_text appended', async () => {
  const gw = gateway({
    'image.attach_bytes': () => ({ attached: true, path: '/tmp/x.png' }),
    'file.attach': params => ({ attached: true, ref_text: `@file:${params.name}` })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await chat.send('look', [
    { kind: 'image', name: 'shot.png', data: 'data:image/png;base64,AAAA' },
    { kind: 'pdf', name: 'lease.pdf', data: 'data:application/pdf;base64,BBBB' }
  ])
  const image = gw.calls.find(c => c.method === 'image.attach_bytes')
  assert.deepEqual(image.params, { session_id: 'rt-1', content_base64: 'AAAA', filename: 'shot.png' })
  const file = gw.calls.find(c => c.method === 'file.attach')
  assert.deepEqual(file.params, { session_id: 'rt-1', data_url: 'data:application/pdf;base64,BBBB', name: 'lease.pdf' })
  const submit = gw.calls.find(c => c.method === 'prompt.submit')
  assert.equal(submit.params.text, 'look\n\nlease.pdf → @file:lease.pdf')
  assert.deepEqual(chat.get().chat.items.at(-1).attachments, [{ kind: 'image', name: 'shot.png' }, { kind: 'pdf', name: 'lease.pdf' }])
})
