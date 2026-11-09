// PARITY C22 (edit / regenerate / rewind) and C23 (reactions).

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
  { id: 4, role: 'assistant', content: 'two', timestamp: T + 3, display_metadata: JSON.stringify({ reactions: [{ emoji: '👍', author: 'agent', at: T }] }) }
]
const open = async (handlers = {}) => {
  const gw = gateway({ REST: () => ({ messages: THREE_TURNS }), ...handlers })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  return { gw, chat }
}
const item = (chat, rowId) => chat.get().chat.items.find(i => i.rowId === rowId)
const lastSubmit = gw => gw.calls.filter(c => c.method === 'prompt.submit').at(-1)

test('C22 edit the last user turn: truncating prompt.submit with explicit consent, by durable row id', async () => {
  const { gw, chat } = await open()
  const res = await chat.editMessage(item(chat, 3).id, 'second, edited')
  assert.equal(res.ok, true)
  const { submission_id, ...params } = lastSubmit(gw).params
  assert.ok(submission_id)
  // rebind_survivor_row_ids: every loaded durable id (stock rewind.ts:366; review v2-r1 #4).
  assert.deepEqual(params, { session_id: 'rt-1', text: 'second, edited', confirm_truncate: true, truncate_before_row_id: 3, rebind_survivor_row_ids: [1, 2, 3, 4] })
  assert.ok(!chat.get().chat.items.some(i => i.rowId === 4), 'the cut turns leave the screen')
  chat.dispose()
})

test('C22 editing an older turn archives later ones: confirm_deep_truncate; the first turn also confirm_empty_truncate', async () => {
  const { gw, chat } = await open()
  assert.equal(chat.laterTurns(item(chat, 1).id), 1)
  await chat.editMessage(item(chat, 1).id, 'first, edited')
  const params = lastSubmit(gw).params
  assert.equal(params.truncate_before_row_id, 1)
  assert.equal(params.confirm_deep_truncate, true)
  assert.equal(params.confirm_empty_truncate, true)
  chat.dispose()
})

test('C22 regenerate resends the user turn the reply answered', async () => {
  const { gw, chat } = await open()
  await chat.regenerate(item(chat, 2).id)
  const params = lastSubmit(gw).params
  assert.equal(params.text, 'first')
  assert.equal(params.truncate_before_row_id, 1)
  assert.equal(params.confirm_deep_truncate, true)
  chat.dispose()
})

test('C22 never while a turn runs; a refused rewrite restores the transcript', async () => {
  let refuse = true
  const { gw, chat } = await open({
    'prompt.submit': () => {
      if (refuse) throw Object.assign(new Error('confirm_truncate requires …'), { code: 4004 })
      return { status: 'streaming' }
    }
  })
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  assert.equal((await chat.regenerate(item(chat, 4).id)).ok, false)
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit').length, 0)
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'two' } })
  const res = await chat.editMessage(item(chat, 3).id, 'x')
  assert.equal(res.delivery, 'not-sent')
  await settle()
  assert.ok(item(chat, 4), 'refused: the transcript comes back from the stored rows')
  refuse = false
  chat.dispose()
})

test('C22 rewind runs the gateway\'s /undo for the right number of turns; the text comes back for the composer', async () => {
  const { gw, chat } = await open({ 'slash.exec': () => ({ type: 'prefill', message: 'first' }) })
  const res = await chat.rewindTo(item(chat, 1).id)
  assert.deepEqual(gw.calls.find(c => c.method === 'slash.exec').params, { session_id: 'rt-1', command: 'undo 2' })
  assert.equal(res.prefill, 'first')
  chat.dispose()
})

test('C23 reactions: stored ones are shown; a tap is optimistic, then the gateway list wins; a failure rolls back', async () => {
  let fail = false
  const { gw, chat } = await open({
    'message.react': params => {
      if (fail) throw new Error('message not found in this session')
      return { row_id: params.row_id, reactions: [{ emoji: params.emoji, author: 'user', at: T }, { emoji: '👍', author: 'agent', at: T }] }
    }
  })
  assert.deepEqual(item(chat, 4).reactions.map(r => r.emoji), ['👍'])
  await chat.react(item(chat, 4).id, '❤️')
  assert.deepEqual(gw.calls.find(c => c.method === 'message.react').params, { session_id: 'rt-1', row_id: 4, emoji: '❤️', author: 'user' })
  assert.deepEqual(item(chat, 4).reactions.map(r => r.emoji), ['❤️', '👍'])
  fail = true
  await chat.react(item(chat, 4).id, '😂')
  assert.deepEqual(item(chat, 4).reactions.map(r => r.emoji), ['❤️', '👍'], 'rolled back')
  chat.dispose()
})

test('C23 the agent\'s live reaction paints the message (message.reaction)', async () => {
  const { gw, chat } = await open()
  gw.emit({ type: 'message.reaction', session_id: 'rt-1', payload: { row_id: 3, role: 'user', reactions: [{ emoji: '‼️', author: 'agent' }] } })
  assert.deepEqual(item(chat, 3).reactions, [{ emoji: '‼️', author: 'agent' }])
  chat.dispose()
})

test('C23 a live message without a row id reacts by newest_role', async () => {
  const { gw, chat } = await open({ 'message.react': () => ({ row_id: 9, reactions: [{ emoji: '👍', author: 'user' }] }) })
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'fresh reply' } })
  const live = chat.get().chat.items.findLast(i => i.kind === 'assistant')
  await chat.react(live.id, '👍')
  const params = gw.calls.find(c => c.method === 'message.react').params
  assert.equal(params.newest_role, 'assistant')
  assert.equal(params.row_id, undefined)
  assert.equal(chat.get().chat.items.find(i => i.id === live.id).rowId, 9, 'learns its row id')
  chat.dispose()
})
