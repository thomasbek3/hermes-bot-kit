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

test('(review P2) a synthetic background turn starts its own turn: its fold never counts from the earlier user message', () => {
  const items = [
    { kind: 'user', id: 'u', text: 'start the build', at: T0 },
    { kind: 'assistant', id: 'a', text: 'Started.', at: T0 + 5000 },
    // An hour later Hermes runs a turn for the finished background process.
    { kind: 'notice', id: 'n', text: 'Background task finished', system: 'process_complete', at: T0 + 3_600_000 },
    tools('g', 1),
    { kind: 'assistant', id: 'b', text: 'Build passed.', at: T0 + 3_603_000 }
  ]
  const fold = withWorkTimes(items).find(i => i.id === 'g')
  assert.notEqual(fold.workedMs, 3_603_000, 'never an hour for a 3 s background turn')
  assert.equal(fold.workedMs, 3000)
  // The same from history rows (display_kind async_delegation_complete).
  const rows = [
    { role: 'user', content: 'delegate it', timestamp: T0 / 1000 },
    { role: 'assistant', content: 'Delegated.', timestamp: T0 / 1000 + 2 },
    { role: 'user', display_kind: 'async_delegation_complete', content: 'Agent work finished: report ready', timestamp: T0 / 1000 + 3600 },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c9', function: { name: 'read_file', arguments: '{}' } }], timestamp: T0 / 1000 + 3601 },
    { role: 'tool', tool_call_id: 'c9', name: 'read_file', content: 'ok', timestamp: T0 / 1000 + 3602 },
    { role: 'assistant', content: 'Here is the report.', timestamp: T0 / 1000 + 3604 }
  ]
  const hfold = withWorkTimes(historyToItems(rows)).find(i => i.kind === 'tools')
  assert.equal(hfold.workedMs, 4000)
  // A background turn whose notice has no time: no time at all.
  const noStart = items.map(i => (i.id === 'n' ? { ...i, at: null } : i))
  assert.equal(withWorkTimes(noStart).find(i => i.id === 'g').workedMs, undefined)
})

test('(review P2) the end is the latest reply: one without a timestamp, or an end before the last tools, gives no time', () => {
  const items = [
    { kind: 'user', id: 'u', text: 'go', at: T0 },
    { kind: 'assistant', id: 'a1', text: 'Looking…', at: T0 + 10_000 },
    { ...tools('g', 2), at: T0 + 20_000 },
    { kind: 'assistant', id: 'a2', text: 'Done.', at: null }
  ]
  assert.equal(withWorkTimes(items).find(i => i.id === 'g').workedMs, undefined, 'never the interim reply\'s 10 s')
  const early = [
    { kind: 'user', id: 'u', text: 'go', at: T0 },
    { ...tools('g', 2), at: T0 + 20_000 },
    { kind: 'assistant', id: 'a', text: 'Done.', at: T0 + 10_000 }
  ]
  assert.equal(withWorkTimes(early).find(i => i.id === 'g').workedMs, undefined, 'an end before the tools ran is wrong')
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
  // A silent turn (tools, no reply row): nothing is stamped, so no time.
  let q = initialChatState([{ kind: 'user', id: 'u', text: 'go', at: T0 }])
  q = applyEvent(q, { type: 'message.start', payload: { turn_id: 't2' } }, T0 + 100)
  q = applyEvent(q, { type: 'tool.start', payload: { tool_id: 'y', name: 'terminal' } }, T0 + 1000)
  q = applyEvent(q, { type: 'message.complete', payload: { text: '[SILENT]' } }, T0 + 9000)
  assert.ok(q.items.every(i => i.completedAt === undefined))
  assert.equal(withWorkTimes(q.items).find(i => i.kind === 'tools').workedMs, undefined)
})

for (const kind of ['process_complete', 'async_delegation_complete']) {
  test(`(review round 2) a silent completion of a ${kind} turn stamps nothing in the earlier turn`, () => {
    // A user turn with tools and a reply...
    let s = initialChatState([{ kind: 'user', id: 'u', text: 'build it', at: T0 }])
    s = applyEvent(s, { type: 'message.start', payload: { turn_id: 't1' } }, T0 + 100)
    s = applyEvent(s, { type: 'tool.start', payload: { tool_id: 'x', name: 'terminal' } }, T0 + 1000)
    s = applyEvent(s, { type: 'tool.complete', payload: { tool_id: 'x' } }, T0 + 2000)
    s = applyEvent(s, { type: 'message.complete', payload: { text: 'Started.' } }, T0 + 3000)
    const reply = s.items.find(i => i.kind === 'assistant')
    assert.equal(reply.completedAt, T0 + 3000)
    // ...an hour later Hermes runs a background turn that ends silently.
    const card = kind === 'process_complete' ? 'Background Process Finished: make' : 'Agent work finished: report'
    s = applyEvent(s, { type: 'message.start', payload: { turn_id: 't2', display_text: card, display_kind: kind } }, T0 + 3_600_000)
    s = applyEvent(s, { type: 'message.complete', payload: { text: '[SILENT]' } }, T0 + 3_605_000)
    assert.equal(s.items.find(i => i.id === reply.id).completedAt, T0 + 3000, 'the earlier reply keeps its own completion')
    assert.ok(s.items.filter(i => i.kind !== 'assistant').every(i => i.completedAt === undefined), 'nothing else stamped')
    assert.equal(withWorkTimes(s.items).find(i => i.kind === 'tools').workedMs, 3000, 'the first turn stays 3s, never 3603s')
  })
}

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
