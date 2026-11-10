// Rough edges 16, part 1: a background process finishing leaves a producer
// card in the transcript (display_kind 'process_complete', display_text
// "Background Process Finished: <command>", Hermes Agent
// tools/process_registry_notifications.py process_completion_display_text).
// The command is often an absolute path. The card is a work row: hidden by
// default, and when the work rows are shown it reads "Background task
// finished" with the full line in its tooltip only. Errors and approvals
// keep showing. Demo paths only.

import assert from 'node:assert/strict'
import test from 'node:test'

import { backgroundNoticeLabel, historyToItems } from '../src/core/history.js'
import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { activityLabel, visibleItems } from '../src/core/workRows.js'
import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

const skip = !READY && 'dev dependencies not installed'
const PATH = '/opt/demo/tools/python-3.0/bin/python worker.py'
const CARD = `Background Process Finished: ${PATH}`

const card = (id, text = CARD, extra = {}) => ({
  id,
  role: 'user',
  content: `[IMPORTANT: Background process proc_1 completed (exit 0).\nCommand: ${PATH}\nOutput: done]`,
  display_kind: 'process_complete',
  display_metadata: JSON.stringify({ display_text: text }),
  timestamp: 1762560010,
  ...extra
})

const noAbsolutePath = s => assert.doesNotMatch(String(s), /(^|\s)\/[A-Za-z]/, `no absolute path in ${JSON.stringify(s)}`)

test('history: the card is a labelled work row; the command only in its title', () => {
  const items = historyToItems([{ id: 1, role: 'user', content: 'run it', timestamp: 1762560000 }, card(2), { id: 3, role: 'assistant', content: 'Done.', timestamp: 1762560020 }])
  const notice = items.find(i => i.kind === 'notice')
  assert.equal(notice.text, 'Background task finished')
  assert.equal(notice.title, CARD)
  assert.equal(notice.system, 'process_complete')
  noAbsolutePath(notice.text)
  assert.deepEqual(visibleItems(items, false).map(i => i.kind), ['user', 'assistant'], 'hidden by default')
  assert.deepEqual(visibleItems(items, true).map(i => i.kind), ['user', 'notice', 'assistant'], 'shown with the work rows')
})

test('labels: every outcome Hermes writes gets a short label without the command', () => {
  const cases = [
    [CARD, 'Background task finished'],
    [`Background Process Failed (exit 2): ${PATH}`, 'Background task failed'],
    [`Background Process Terminated: ${PATH}`, 'Background task stopped'],
    [`Background Process Lost: ${PATH}`, 'Background task lost'],
    [`Background Process Failed to Start: ${PATH}`, 'Background task failed to start'],
    ['3 Background Processes Finished', '3 background tasks finished'],
    ['', 'Background task finished']
  ]
  for (const [text, label] of cases) {
    assert.equal(backgroundNoticeLabel('process_complete', text), label, text)
    noAbsolutePath(backgroundNoticeLabel('process_complete', text))
  }
  assert.equal(backgroundNoticeLabel('async_delegation_complete', 'Subagent Task Completed: tidy /opt/demo'), 'Background agent work finished')
})

test('history: without display_text the label still never prints the model prompt or the path', () => {
  const [notice] = historyToItems([{ ...card(5), display_metadata: null }])
  assert.equal(notice.text, 'Background task finished')
  noAbsolutePath(notice.text)
  assert.ok(notice.title.length <= 300)
})

test('live: a producer card on message.start is labelled too; a process status line never prints the path', () => {
  const state = applyEvent(initialChatState(), { type: 'message.start', payload: { display_text: CARD, display_kind: 'process_complete' } }, 1)
  const notice = state.items.at(-1)
  assert.deepEqual([notice.kind, notice.text, notice.title, notice.system], ['notice', 'Background task finished', CARD, 'process_complete'])
  const plain = applyEvent(initialChatState(), { type: 'message.start', payload: { display_text: 'Resumed' } }, 1).items.at(-1)
  assert.deepEqual([plain.text, plain.system], ['Resumed', undefined], 'other cards unchanged')
  const busy = applyEvent({ ...initialChatState(), busy: true }, { type: 'status.update', payload: { kind: 'process', text: CARD } }, 1)
  assert.equal(activityLabel(busy, false), 'Background task finished')
  assert.equal(activityLabel(applyEvent(busy, { type: 'status.update', payload: { kind: 'status', text: 'Reading' } }, 1), false), 'Reading')
})

test('errors stay visible with the work rows hidden', () => {
  const items = historyToItems([
    card(1),
    { id: 2, role: 'assistant', content: 'x', display_kind: 'failed_turn', display_metadata: { error: 'HTTP 500 from the provider' }, timestamp: 3 }
  ])
  assert.deepEqual(visibleItems(items, false).map(i => [i.kind, i.text]), [['error', 'HTTP 500 from the provider']])
})

// The loader harness boots once per file: one chat, toggled with the
// override's own "show work rows" palette command.
test('loader: hidden by default; with the work rows shown, the label shows and the line is only the tooltip', { skip }, async t => {
  const withCard = profile => {
    const page = history(profile)
    page.messages = [...page.messages, card(15), { id: 16, role: 'assistant', content: 'All set.', timestamp: 1762560030 }]
    return page
  }
  const booted = await bootPlugin(t, { historyFor: withCard })
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const workspace = await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')
  const chatEl = booted.mount(workspace.render)
  await waitFor(() => chatEl.textContent.includes('All set.'), 'transcript')
  assert.equal(chatEl.querySelector('.gbo-notice'), null, 'hidden by default')
  assert.ok(!chatEl.innerHTML.includes('/opt/demo'))

  booted.panes.find(p => p.id === 'palette-show-work').data.run()
  const notice = await waitFor(() => chatEl.querySelector('.gbo-notice'), 'the notice')
  assert.equal(notice.textContent, 'Background task finished')
  assert.equal(notice.getAttribute('title'), CARD)
  assert.ok(!chatEl.textContent.includes('/opt/demo'), 'the path is not in the text')
})
