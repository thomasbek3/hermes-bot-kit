// Spec 106, Problem 2 (owner, 2026-11-25): local bots like GANDALF YO stayed
// unread forever. The fresh read of the Bot Chat returns no messages (the
// history page and the roster count differently), so a coverage test never
// passed. Opening the bot must still clear the dot (and the same activity
// must not re-light it). Spec 106b: only Bot Chat activity lights the dot, so
// activity in another session (a cron run) must not light it at all.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

test('Spec 106 loader-faithful: a Bot Chat whose fresh read is empty still clears on open, stays clear while open; activity elsewhere never lights it', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const t0 = 1762560000
  const gandalf = {
    ...LOCAL,
    name: 'gandalf',
    display_name: 'GANDALF YO',
    route: { connectionId: 'local', mode: 'local', profile: 'gandalf', targetProfile: 'gandalf' },
    canonical_session: { id: 'g-botchat', resolved_id: 'g-botchat', preview: '', message_count: 0, last_active: t0 },
    last_session: { id: 'g-other', preview: 'older talk', message_count: 6, last_active: t0 + 10 }
  }
  const rows = [gandalf]
  const { panes, mount, errors } = await bootPlugin(t, {
    rows,
    answers: {
      'session.list': () => ({ sessions: [{ id: 'g-botchat', title: 'Bot Chat', message_count: 0 }] }),
      'session.resume': () => ({ session_id: 'rt-gandalf', running: false, message_count: 0 })
    },
    historyFor: () => ({ session_id: 'g-botchat', messages: [], pagination: { limit: 120, offset: 0, order: 'latest', returned: 0 } })
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const dotOf = el => el?.querySelector('.gbo-unread-dot [role="status"][data-gbo-unread="true"]')
  await waitFor(() => rowOf('GANDALF YO'), 'the row')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.ok(!dotOf(rowOf('GANDALF YO')), 'first observation seeds no dot')

  // A cron run in another session (spec 106b): no dot.
  rows[0] = { ...rows[0], last_session: { id: 'g-cron-1', preview: 'Message from cron: working', message_count: 8, last_active: t0 + 100 } }
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.ok(!dotOf(rowOf('GANDALF YO')), 'activity outside the Bot Chat does not light the dot')

  // A report lands in the Bot Chat: dot.
  rows[0] = { ...rows[0], canonical_session: { ...rows[0].canonical_session, preview: 'Message from cron: report', message_count: 1, last_active: t0 + 110 } }
  await waitFor(() => dotOf(rowOf('GANDALF YO')), 'the dot after a report in the Bot Chat', 6000)

  // Opening the bot (its fresh Bot Chat read comes back empty) clears it.
  rowOf('GANDALF YO').click()
  await waitFor(() => !dotOf(rowOf('GANDALF YO')), 'the dot cleared on open of an empty Bot Chat')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.ok(!dotOf(rowOf('GANDALF YO')), 'the same activity does not re-light it')

  // The next report while the chat is open and visible is read at once.
  rows[0] = { ...rows[0], canonical_session: { ...rows[0].canonical_session, preview: 'Message from cron: next', message_count: 2, last_active: t0 + 200 } }
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.ok(!dotOf(rowOf('GANDALF YO')), 'activity while the bot is open and visible is read')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
