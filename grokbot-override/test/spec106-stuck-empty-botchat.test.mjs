// Spec 106, Problem 2 (owner, 2026-11-25): local bots like GANDALF YO stayed
// unread forever. Their newest activity is in a regular (non-Bot-Chat)
// session and their Bot Chat itself is empty, so the fresh read of the Bot
// Chat returns no messages. Opening the bot must still clear the dot (and the
// same activity must not re-light it). Re-lighting on a later report is
// covered by spec106-own-unread.test.mjs (cron-run-43).

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

test('Spec 106 loader-faithful: a bot with an empty Bot Chat and activity elsewhere clears on open, and stays clear while it is open', { skip: !READY && 'dev dependencies not installed' }, async t => {
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

  // A report lands in the non-Bot-Chat session: dot.
  rows[0] = { ...rows[0], last_session: { id: 'g-other', preview: 'Message from cron: report', message_count: 8, last_active: t0 + 100 } }
  await waitFor(() => dotOf(rowOf('GANDALF YO')), 'the dot after a report in another session', 6000)

  // Opening the bot (its Bot Chat is empty) clears it.
  rowOf('GANDALF YO').click()
  await waitFor(() => !dotOf(rowOf('GANDALF YO')), 'the dot cleared on open of an empty Bot Chat')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.ok(!dotOf(rowOf('GANDALF YO')), 'the same activity does not re-light it')

  // The next report while the chat is open and visible is read at once.
  rows[0] = { ...rows[0], last_session: { id: 'g-cron-2', preview: 'Message from cron: next', message_count: 2, last_active: t0 + 200 } }
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.ok(!dotOf(rowOf('GANDALF YO')), 'activity while the bot is open and visible is read')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
