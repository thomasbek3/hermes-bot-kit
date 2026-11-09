// Pass 6 D: runtime metadata rows are hidden in the Bot Chat by default and
// come back with the work rows. Row shapes from Hermes Agent @2bd378ed1b:
//  - tui_gateway/server.py _append_model_switch_marker:
//    {role: 'user', content: '[System: The active model for this chat has changed to …]', display_kind: 'model_switch'}
//  - agent/turn_failure_copy.py FAILED_TURN_NOTICE on the boundary row
//    {role: 'assistant', display_kind: 'failed_turn', display_metadata: {error, error_surface}}
//    (agent/conversation_loop.py _failed_turn_display_metadata).
// Classified by display_kind only, never by text.

import assert from 'node:assert/strict'
import test from 'node:test'

import { historyToItems, PARTIAL_FAILED_TURN_NOTICE, SYSTEM_NOTICE_KINDS } from '../src/core/history.js'
import { visibleItems } from '../src/core/workRows.js'

const MODEL_SWITCH = {
  id: 41,
  role: 'user',
  content:
    '[System: The active model for this chat has changed to gpt-6.1-terra via provider openai-codex. From this point forward, use this runtime metadata when answering questions about what model/provider is active.]',
  display_kind: 'model_switch',
  timestamp: 1794253441
}
const FAILED_TURN = {
  id: 39,
  role: 'assistant',
  content: 'Your request was not processed. Send it again if you still want me to carry it out.',
  display_kind: 'failed_turn',
  timestamp: 1794253430
}
const FAILED_WITH_ERROR = {
  ...FAILED_TURN,
  id: 52,
  display_metadata: JSON.stringify({ error: 'HTTP 429: rate limit reached for gpt-6.1-sol', error_surface: { layer: 'provider', code: 'rate_limited', message: 'Rate limited' } })
}

const rows = [
  { id: 38, role: 'user', content: ':)', timestamp: 1794253420 },
  FAILED_TURN,
  { id: 40, role: 'user', content: 'test now', timestamp: 1794253440 },
  MODEL_SWITCH,
  { id: 42, role: 'assistant', content: 'Working now! :)', timestamp: 1794253445 }
]

test('the model-switch pivot and the failed-turn boundary are system notices, hidden by default', () => {
  const items = historyToItems(rows)
  const notices = items.filter(i => i.kind === 'notice')
  assert.deepEqual(notices.map(n => n.system), ['failed_turn', 'model_switch'])
  assert.deepEqual(visibleItems(items, false).map(i => [i.kind, i.text]), [
    ['user', ':)'],
    ['user', 'test now'],
    ['assistant', 'Working now! :)']
  ])
})

test('the work-rows preference brings them back', () => {
  const shown = visibleItems(historyToItems(rows), true)
  assert.ok(shown.some(i => i.kind === 'notice' && i.text.startsWith('[System: The active model')))
  assert.ok(shown.some(i => i.kind === 'notice' && i.text.startsWith('Your request was not processed')))
})

test('a failed turn’s real error stays visible; only its boundary line hides', () => {
  const items = historyToItems([{ id: 51, role: 'user', content: 'hi', timestamp: 1 }, FAILED_WITH_ERROR])
  assert.deepEqual(visibleItems(items, false).map(i => [i.kind, i.text]), [
    ['user', 'hi'],
    ['error', 'HTTP 429: rate limit reached for gpt-6.1-sol']
  ])
  const surfaceOnly = historyToItems([{ ...FAILED_TURN, display_metadata: { error_surface: { layer: 'provider', code: 'auth_failed', message: 'The provider rejected the API key' } } }])
  assert.deepEqual(visibleItems(surfaceOnly, false).map(i => [i.kind, i.text]), [['error', 'The provider rejected the API key']])
})

test('by display_kind only: the same words typed by a person or said by the bot stay', () => {
  const items = historyToItems([
    { id: 1, role: 'user', content: MODEL_SWITCH.content, timestamp: 1 },
    { id: 2, role: 'assistant', content: FAILED_TURN.content, timestamp: 2 }
  ])
  assert.deepEqual(visibleItems(items, false).map(i => i.kind), ['user', 'assistant'])
})

test('other timeline notices are not system metadata', () => {
  const items = historyToItems([
    { id: 1, role: 'user', content: 'x', display_kind: 'process_complete', display_metadata: { display_text: 'Background process finished' }, timestamp: 1 },
    { id: 2, role: 'user', content: 'y', display_kind: 'async_delegation_complete', display_metadata: { display_text: '2 background agents finished' }, timestamp: 2 }
  ])
  assert.deepEqual(visibleItems(items, false).map(i => i.text), ['Background process finished', '2 background agents finished'])
  for (const kind of ['model_switch', 'personality_switch', 'failed_turn', 'auto_continue', 'internal_notification']) assert.ok(SYSTEM_NOTICE_KINDS.has(kind), kind)
  assert.ok(!SYSTEM_NOTICE_KINDS.has('process_complete') && !SYSTEM_NOTICE_KINDS.has('steer'))
})

test('the partial-turn boundary stays visible as a muted notice line (it asks the user to verify)', () => {
  // agent/turn_failure_copy.py PARTIAL_FAILED_TURN_NOTICE, verbatim.
  assert.equal(PARTIAL_FAILED_TURN_NOTICE, 'This turn did not complete. Some actions may already have run; verify their effects before resending.')
  const partial = { ...FAILED_TURN, id: 60, content: PARTIAL_FAILED_TURN_NOTICE }
  const items = historyToItems([{ id: 59, role: 'user', content: 'deploy it', timestamp: 1 }, partial, MODEL_SWITCH])
  const shown = visibleItems(items, false)
  assert.deepEqual(shown.map(i => [i.kind, i.text]), [
    ['user', 'deploy it'],
    ['notice', PARTIAL_FAILED_TURN_NOTICE]
  ], 'a notice (not a bubble); the other system line stays hidden')
  assert.equal(shown[1].system, undefined)
  // The same words on a normal reply are just a reply.
  assert.deepEqual(visibleItems(historyToItems([{ id: 1, role: 'assistant', content: PARTIAL_FAILED_TURN_NOTICE, timestamp: 1 }]), false).map(i => i.kind), ['assistant'])
})
