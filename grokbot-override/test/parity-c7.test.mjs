// PARITY C7: sleep / wake. When the bot's socket comes back (`gateway.ready`
// for its connection) during a turn, the screen asks the gateway what is
// running instead of trusting what it last saw; another connection's
// reconnect changes nothing.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await flush()
}

test('C7 gateway.ready on the bot\'s own connection during a turn reconciles; a turn the gateway reports idle settles from history', async () => {
  let idle = false
  const gw = gateway({
    'session.active_list': params => ({ sessions: [{ id: params.current_session_id, status: idle ? 'idle' : 'working' }] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  assert.equal(chat.get().chat.busy, true)
  const before = gw.calls.filter(c => c.method === 'session.active_list').length
  gw.emit({ type: 'gateway.ready', connectionId: 'some-other-machine' })
  await settle()
  assert.equal(gw.calls.filter(c => c.method === 'session.active_list').length, before, 'another connection: nothing')
  idle = true // the turn finished while the machine slept
  gw.emit({ type: 'gateway.ready', connectionId: 'home-server' })
  await settle()
  assert.equal(chat.get().chat.busy, false, 'settled from the gateway, not guessed')
  assert.ok(gw.calls.some(c => c.method === 'REST' && c.params.offset === 0), 'the stored reply is read')
  assert.equal(gw.calls.filter(c => c.method === 'prompt.submit').length, 0, 'nothing re-sent')
  chat.dispose()
})
