// Rough edges 16, part 2: a bot that chooses not to reply answers with a
// silence sentinel (Hermes Agent gateway/response_filters.py
// LIVE_GATEWAY_SILENT_MARKERS: "[SILENT]", "NO_REPLY", …). The gateway drops
// it from the delivered text, but the stored row and the roster preview keep
// it. The override never draws a reply whose whole text is a marker: no
// bubble (not an empty one), no roster preview, no unread mark, no toast, no
// NEW line. A reply that mentions the word elsewhere is a normal reply.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createActivityTracker } from '../src/core/activity.js'
import { historyToItems } from '../src/core/history.js'
import { firstUnreadId } from '../src/core/newMarker.js'
import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { previewOf } from '../src/core/roster.js'
import { couldBeSilenceReply, isSilenceReply, SILENCE_MARKERS } from '../src/core/silence.js'
import { visibleItems } from '../src/core/workRows.js'
import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

const skip = !READY && 'dev dependencies not installed'
const MENTIONS = 'Reply with [SILENT] when there is nothing to say.'

test('the sentinel: every Hermes marker, case, spacing and edge punctuation; never a mention', () => {
  for (const marker of SILENCE_MARKERS) assert.ok(isSilenceReply(marker), marker)
  for (const text of ['[SILENT]', ' [silent] ', '**NO_REPLY**', 'NO   REPLY', '.NO_REPLY', 'silent.', '\n[SILENT]\n']) assert.ok(isSilenceReply(text), JSON.stringify(text))
  for (const text of ['', '   ', MENTIONS, '[SILENT] nothing new', 'Silent retry succeeded', '[SILENT', 'NO problem', 'The reply was [SILENT], intentionally.']) {
    assert.ok(!isSilenceReply(text), JSON.stringify(text))
  }
  assert.ok(couldBeSilenceReply('[SIL') && couldBeSilenceReply('NO'), 'a stream on its way to a marker')
  assert.ok(!couldBeSilenceReply('NO problem') && !couldBeSilenceReply('Hello'))
})

const rows = [
  { id: 1, role: 'user', content: 'ping me if anything changes', timestamp: 100 },
  { id: 2, role: 'assistant', content: '[SILENT]', timestamp: 101 },
  { id: 3, role: 'user', content: 'what should you reply?', timestamp: 102 },
  { id: 4, role: 'assistant', content: MENTIONS, timestamp: 103 }
]

test('history: a stored [SILENT] reply draws nothing; a reply that mentions it draws normally', () => {
  const items = historyToItems(rows)
  for (const showWork of [false, true]) {
    assert.deepEqual(visibleItems(items, showWork).map(i => [i.kind, i.text]), [
      ['user', 'ping me if anything changes'],
      ['user', 'what should you reply?'],
      ['assistant', MENTIONS]
    ])
  }
})

test('history: a silent reply that thought keeps only its Thought row (work rows); never an empty bubble', () => {
  const items = historyToItems([{ id: 2, role: 'assistant', content: 'NO_REPLY', reasoning: 'nothing new', timestamp: 1 }])
  assert.deepEqual(visibleItems(items, false), [], 'nothing with the work rows hidden')
  assert.deepEqual(visibleItems(items, true).map(i => [i.kind, i.text, i.reasoning]), [['assistant', '', 'nothing new']])
})

test('live: a streamed [SILENT] never shows, and the completed turn leaves no bubble', () => {
  let s = applyEvent(initialChatState(), { type: 'message.start', payload: {} }, 1)
  s = applyEvent(s, { type: 'message.delta', payload: { text: '[SIL' } }, 2)
  assert.deepEqual(visibleItems(s.items, true), [], 'held while it could still be a marker')
  s = applyEvent(s, { type: 'message.delta', payload: { text: 'ENT]' } }, 3)
  assert.deepEqual(visibleItems(s.items, true), [])
  s = applyEvent(s, { type: 'message.complete', payload: { text: '[SILENT]' } }, 4)
  assert.deepEqual(s.items, [], 'no item at all')
  assert.equal(s.busy, false)
  // Completed without a stream (gateway delivered it whole).
  const whole = applyEvent(applyEvent(initialChatState(), { type: 'message.start', payload: {} }, 1), { type: 'message.complete', payload: { text: 'NO_REPLY' } }, 2)
  assert.deepEqual(whole.items, [])
  // A normal reply that starts like a marker shows once it diverges.
  let n = applyEvent(initialChatState(), { type: 'message.delta', payload: { text: 'NO' } }, 1)
  assert.deepEqual(visibleItems(n.items, false), [])
  n = applyEvent(n, { type: 'message.delta', payload: { text: ' problem' } }, 2)
  assert.deepEqual(visibleItems(n.items, false).map(i => i.text), ['NO problem'])
})

test('roster preview: a silent newest message shows no preview; a mention shows', () => {
  const bot = preview => ({ name: 'a', canonical_session: { id: 'r', preview, last_active: 10 } })
  assert.equal(previewOf(bot('[SILENT]')).preview, '')
  assert.equal(previewOf(bot(MENTIONS)).preview, MENTIONS)
})

test('unread and toasts: a silent reply marks nothing and toasts nothing; a real one does', () => {
  const marks = []
  const toasts = []
  const t = createActivityTracker({ selectedKey: () => '', isHidden: () => false, label: b => b.name, markUnread: id => marks.push(id), toastsEnabled: () => true, notify: n => toasts.push(n) })
  const row = (at, preview) => [{ name: 'a', connectionId: 'local', canonical_session: { id: 'a-root', resolved_id: 'a-tip', last_active: at, preview } }]
  t.track(row(100, 'hi'))
  t.track(row(200, '[SILENT]'))
  assert.deepEqual([marks, toasts], [[], []])
  t.track(row(300, 'Here is the summary.'))
  assert.deepEqual(marks, ['a-tip'])
  assert.equal(toasts.length, 1)
})

test('NEW line: never above a silent reply', () => {
  const items = [
    { kind: 'user', id: 'u', text: 'x', at: 1 },
    { kind: 'assistant', id: 's', text: '[SILENT]', at: 5 },
    { kind: 'assistant', id: 'r', text: 'real', at: 6 }
  ]
  assert.equal(firstUnreadId(items, 2), 'r')
  assert.equal(firstUnreadId(items.slice(0, 2), 2), null)
})

test('loader: the stored [SILENT] reply is not drawn, the mention is', { skip }, async t => {
  const withSilent = profile => {
    const page = history(profile)
    page.messages = [...page.messages, ...rows.map(r => ({ ...r, id: r.id + 20, timestamp: 1762560100 + r.id }))]
    return page
  }
  const booted = await bootPlugin(t, { historyFor: withSilent, showWork: true })
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const workspace = await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')
  const chatEl = booted.mount(workspace.render)
  await waitFor(() => chatEl.textContent.includes(MENTIONS), 'transcript')
  const bubbles = [...chatEl.querySelectorAll('.bubble.is-agent')].map(b => b.textContent.trim())
  assert.ok(!bubbles.includes('[SILENT]'), 'no [SILENT] bubble')
  assert.ok(!bubbles.includes(''), 'no empty bubble')
  assert.ok(bubbles.some(b => b.includes(MENTIONS)))
})
