// PARITY R16 (#35, Spec 106): opening an unread bot clears the plugin's own
// unread dot once fresh history is presented in a visible pane, without
// touching Hermes's native bare-id unread store.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createActivityTracker } from '../src/core/activity.js'
import { rowKey } from '../src/core/roster.js'
import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

test('R16 #35 the open bot is read, not marked: the tracker reads it on moved activity', () => {
  const read = []
  const marks = []
  const row = ts => ({ ...LOCAL, name: 'a', canonical_session: { id: 'a-root', last_active: ts } })
  const t = createActivityTracker({
    selectedKey: () => rowKey(row(0)),
    markUnread: (id, p) => marks.push([id, p]),
    readOpen: bot => read.push(bot.name),
    refreshOpen: () => undefined
  })
  t.track([row(1)])
  t.track([row(2)])
  assert.deepEqual(marks, [])
  assert.deepEqual(read, ['a'])
})

test('loader-faithful R16 #35 (Spec 106): clicking an unread row clears the plugin dot on fresh history, never touches native store', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const nativeCalls = []
  const rows = [{ ...LOCAL, canonical_session: { ...LOCAL.canonical_session, resolved_id: 's-tip', message_count: 4 } }]
  const { panes, mount, errors } = await bootPlugin(t, {
    rows,
    tweak: sdk => {
      sdk.markSessionUnreadFinished = (id, profile) => nativeCalls.push(['mark', id, profile])
      sdk.ackStoredSessionId = (id, profile) => nativeCalls.push(['ack', id, profile])
      sdk.forgetSessionUnread = (ids, profile) => nativeCalls.push(['forget', [...ids], profile])
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const dotOf = el => el?.querySelector('.gbo-unread-dot [role="status"][data-gbo-unread="true"]')
  await waitFor(() => rowOf('Security'), 'the row')

  // Activity while another chat (none) is on screen: plugin dot lights up.
  rows[0] = { ...rows[0], canonical_session: { ...rows[0].canonical_session, last_active: rows[0].canonical_session.last_active + 60, message_count: 5, preview: 'Message from cron: done' } }
  await waitFor(() => dotOf(rowOf('Security')), 'the dot after the next roster refresh', 6000)
  assert.deepEqual(nativeCalls, [], 'native unread store is never touched')

  // Opening it clears the dot, always: the page shows 4 rows while the roster
  // counts 5 (roster and history count differently: folded rows, tool rows),
  // and a count "coverage" test would leave the dot lit forever (spec 106).
  rowOf('Security').click()
  await waitFor(() => !dotOf(rowOf('Security')), 'the dot cleared on open')

  // The next roster poll reports the same activity: the dot stays off.
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.ok(!dotOf(rowOf('Security')), 'not re-lit by the same activity')

  // A new report on this bot while its chat is open and visible is read at once: no dot.
  rows[0] = { ...rows[0], canonical_session: { ...rows[0].canonical_session, last_active: rows[0].canonical_session.last_active + 60, message_count: 6, preview: 'next report' } }
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.ok(!dotOf(rowOf('Security')), 'activity on the open, visible chat is read, not marked')
  assert.deepEqual(nativeCalls, [])
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
