// The work fold says how long the turn took: "Worked for 3m 12s · 12 tools"
// (41s under a minute, "1h 4m" past an hour), from the user's message to the
// reply's completion, using timestamps the items already carry. No time for
// a running turn or when a timestamp is missing (the old "N tools" line).

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { historyToItems } from '../src/core/history.js'
import { foldLabel, formatWorked, withWorkTimes } from '../src/core/workTime.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const T0 = Date.UTC(2026, 10, 24, 9, 0, 0)
const tools = (id, n, extra = {}) => ({ kind: 'tools', id, at: T0 + 1000, tools: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, name: 'terminal', label: 'Ran a command', status: 'done' })), ...extra })

test('formatting: seconds under a minute, minutes and seconds, hours and minutes', () => {
  assert.equal(formatWorked(41_000), '41s')
  assert.equal(formatWorked(400), '1s', 'under a second reads 1s')
  assert.equal(formatWorked(59_600), '1m 0s')
  assert.equal(formatWorked(192_000), '3m 12s')
  assert.equal(formatWorked(3_840_000), '1h 4m')
  assert.equal(foldLabel({ done: 12, workedMs: 192_000 }), 'Worked for 3m 12s · 12 tools')
  assert.equal(foldLabel({ done: 1, workedMs: 41_000 }), 'Worked for 41s · 1 tool')
  assert.equal(foldLabel({ done: 3, toolSecs: 40 }), '3 tools · 40s', 'no turn time: the old line')
  assert.equal(foldLabel({ done: 3 }), '3 tools')
  assert.ok(foldLabel({ done: 99, workedMs: 36_000_000 }).length <= 32, 'short on a phone')
})

test('from the user message to the reply: the time goes on the turn\'s last fold only', () => {
  const items = [
    { kind: 'user', id: 'u1', text: 'go', at: T0 },
    tools('g1', 2),
    { kind: 'assistant', id: 'a1', text: 'checking more', at: T0 + 30_000 },
    tools('g2', 3),
    { kind: 'assistant', id: 'a2', text: 'done', at: T0 + 192_000 },
    { kind: 'user', id: 'u2', text: 'thanks', at: T0 + 300_000 },
    { kind: 'assistant', id: 'a3', text: 'np', at: T0 + 305_000 }
  ]
  const out = withWorkTimes(items)
  assert.equal(out.find(i => i.id === 'g1').workedMs, undefined)
  assert.equal(out.find(i => i.id === 'g2').workedMs, 192_000)
  assert.equal(foldLabel({ done: 3, workedMs: out.find(i => i.id === 'g2').workedMs }), 'Worked for 3m 12s · 3 tools')
  assert.equal(withWorkTimes(out), out, 'stable: nothing new, same array')
})

test('never guessed: a running turn, no user message on screen, a missing or backwards timestamp, no reply', () => {
  const running = [{ kind: 'user', id: 'u', text: 'go', at: T0 }, tools('g', 2), { kind: 'assistant', id: 'a', text: 'still going', at: T0 + 5000, streaming: true }]
  assert.equal(withWorkTimes(running, { busy: true })[1].workedMs, undefined, 'live: no time until complete')
  assert.equal(withWorkTimes(running, { busy: false })[1].workedMs, 5000)
  // An earlier page not loaded: the fold's turn starts off screen.
  assert.equal(withWorkTimes([tools('g', 2), { kind: 'assistant', id: 'a', text: 'x', at: T0 }])[0].workedMs, undefined)
  // History rows without a timestamp.
  assert.equal(withWorkTimes([{ kind: 'user', id: 'u', text: 'go', at: null }, tools('g', 1), { kind: 'assistant', id: 'a', text: 'x', at: T0 }])[1].workedMs, undefined)
  assert.equal(withWorkTimes([{ kind: 'user', id: 'u', text: 'go', at: T0 }, tools('g', 1), { kind: 'assistant', id: 'a', text: 'x', at: null }])[1].workedMs, undefined)
  assert.equal(withWorkTimes([{ kind: 'user', id: 'u', text: 'go', at: T0 + 9000 }, tools('g', 1), { kind: 'assistant', id: 'a', text: 'x', at: T0 }])[1].workedMs, undefined)
  // A turn that ended on its tools with no reply and no completion stamp.
  assert.equal(withWorkTimes([{ kind: 'user', id: 'u', text: 'go', at: T0 }, tools('g', 1)])[1].workedMs, undefined)
  // A stale time is dropped when the turn is running again (a retry).
  const stamped = withWorkTimes(running)
  assert.equal(withWorkTimes(stamped, { busy: true })[1].workedMs, undefined)
})

test('history: the stored rows\' timestamps (user row to the last reply row)', () => {
  const rows = [
    { role: 'user', content: 'build it', timestamp: (T0 / 1000) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{}' } }], timestamp: T0 / 1000 + 2 },
    { role: 'tool', tool_call_id: 'c1', name: 'terminal', content: 'ok', timestamp: T0 / 1000 + 20 },
    { role: 'assistant', content: 'Built.', timestamp: T0 / 1000 + 41 }
  ]
  const items = withWorkTimes(historyToItems(rows))
  const fold = items.find(i => i.kind === 'tools')
  assert.equal(fold.workedMs, 41_000)
  assert.equal(foldLabel({ done: fold.tools.length, workedMs: fold.workedMs }), 'Worked for 41s · 1 tool')
})

test('live: message.complete stamps the reply\'s completion; the time runs to it, not to the first delta', () => {
  let s = initialChatState([{ kind: 'user', id: 'u', text: 'go', at: T0 }])
  s = applyEvent(s, { type: 'message.start', payload: { turn_id: 't1' } }, T0 + 100)
  s = applyEvent(s, { type: 'tool.start', payload: { tool_id: 'x', name: 'terminal' } }, T0 + 1000)
  s = applyEvent(s, { type: 'tool.complete', payload: { tool_id: 'x', duration_s: 3 } }, T0 + 4000)
  s = applyEvent(s, { type: 'message.delta', payload: { text: 'Here' } }, T0 + 5000)
  assert.equal(withWorkTimes(s.items, { busy: s.busy }).find(i => i.kind === 'tools').workedMs, undefined, 'still running')
  s = applyEvent(s, { type: 'message.delta', payload: { text: ' it is' } }, T0 + 60_000)
  s = applyEvent(s, { type: 'message.complete', payload: { text: 'Here it is' } }, T0 + 72_000)
  assert.equal(s.busy, false)
  const reply = s.items.find(i => i.kind === 'assistant')
  assert.equal(reply.at, T0 + 5000)
  assert.equal(reply.completedAt, T0 + 72_000)
  assert.equal(withWorkTimes(s.items, { busy: s.busy }).find(i => i.kind === 'tools').workedMs, 72_000)
  // A silent turn (tools, no reply): its fold carries the completion.
  let q = initialChatState([{ kind: 'user', id: 'u', text: 'go', at: T0 }])
  q = applyEvent(q, { type: 'message.start', payload: { turn_id: 't2' } }, T0 + 100)
  q = applyEvent(q, { type: 'tool.start', payload: { tool_id: 'y', name: 'terminal' } }, T0 + 1000)
  q = applyEvent(q, { type: 'message.complete', payload: { text: '[SILENT]' } }, T0 + 9000)
  assert.equal(withWorkTimes(q.items).find(i => i.kind === 'tools').workedMs, 9000)
})

test('the chat draws "Worked for … · N tools" on a finished turn\'s fold, and the old line while it runs', { skip }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const m = await import(pathToFileURL(file).href)
  const items = [
    { kind: 'user', id: 'u1', text: 'go', at: T0 },
    tools('g1', 12),
    { kind: 'assistant', id: 'a1', text: 'Done.', at: T0 + 192_000 }
  ]
  const done = m.render({ items, busy: false, showWork: true })
  assert.match(done, /Worked for 3m 12s · 12 tools/)
  const live = m.render({ items: [...items.slice(0, 2), { ...items[2], streaming: true }], busy: true, showWork: true })
  assert.doesNotMatch(live, /Worked for/)
  assert.match(live, /12 tools/)
})
