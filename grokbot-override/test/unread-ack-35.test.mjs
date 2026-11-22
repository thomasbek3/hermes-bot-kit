// PARITY R16 (#35): opening a bot clears its unread dot. Hermes's unread
// store has two layers (store/session-unread.ts): the persisted per-profile
// markers, and the transient $unreadFinishedSessionIds the SessionStatusDot
// paints from. markSessionUnreadFinished writes both; ackStoredSessionId
// retires only the persisted marker (stock leaves the transient dot to core's
// selection path, store/session.ts setSelectedStoredSessionId ->
// markSessionRead, which the override's own chat never takes);
// forgetSessionUnread drops both. The fake below keeps the two layers apart,
// as core does, so an ack alone leaves the dot lit.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createActivityTracker } from '../src/core/activity.js'
import { rowKey } from '../src/core/roster.js'
import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

/** Core's unread store, two layers. */
function fakeStore() {
  const markers = new Map() // profile -> Set(durable id)
  const transient = new Set()
  const listeners = new Set()
  const emit = () => listeners.forEach(fn => fn())
  const calls = []
  return {
    calls,
    listeners,
    transient,
    markers,
    mark(id, profile) {
      calls.push(['mark', id, profile])
      transient.add(id)
      if (!markers.has(profile)) markers.set(profile, new Set())
      markers.get(profile).add(id)
      emit()
    },
    ack(id, profile) {
      calls.push(['ack', id, profile])
      markers.get(profile)?.delete(id)
      emit()
    },
    forget(ids, profile) {
      calls.push(['forget', [...ids], profile])
      for (const id of ids) {
        if (!id) continue
        transient.delete(id)
        markers.get(profile)?.delete(id)
      }
      emit()
    }
  }
}

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

test('loader-faithful R16 #35: clicking an unread row clears the dot core paints (transient layer), not only the persisted marker', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const store = fakeStore()
  const rows = [{ ...LOCAL, canonical_session: { ...LOCAL.canonical_session, resolved_id: 's-tip' } }]
  const { panes, mount, errors, React } = await bootPlugin(t, {
    rows,
    tweak: sdk => {
      sdk.markSessionUnreadFinished = (id, profile) => store.mark(id, profile)
      sdk.ackStoredSessionId = (id, profile) => store.ack(id, profile)
      sdk.forgetSessionUnread = (ids, profile) => store.forget(ids, profile)
      sdk.SessionStatusDot = props => globalThis.__ackDot(props)
    }
  })
  globalThis.__ackDot = ({ storedSessionId }) => {
    const on = React.useSyncExternalStore(fn => (store.listeners.add(fn), () => store.listeners.delete(fn)), () => store.transient.has(storedSessionId))
    return React.createElement('span', { className: 'flex' }, on ? React.createElement('span', { role: 'status', className: 'size-1.5 rounded-full bg-(--ui-success)' }) : React.createElement('span', { 'aria-hidden': 'true', className: 'size-1 rounded-full' }))
  }
  t.after(() => delete globalThis.__ackDot)
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const dotOf = el => el?.querySelector('.gbo-unread-dot [role="status"]')
  await waitFor(() => rowOf('Security'), 'the row')

  // Activity while another chat (none) is on screen: marked on the tip.
  rows[0] = { ...rows[0], canonical_session: { ...rows[0].canonical_session, last_active: rows[0].canonical_session.last_active + 60, preview: 'Message from cron: done' } }
  await waitFor(() => dotOf(rowOf('Security')), 'the dot after the next roster refresh', 6000)
  assert.deepEqual(store.calls.find(c => c[0] === 'mark'), ['mark', 's-tip', 'security'])

  // Opening it: the persisted marker AND the painted (transient) dot go.
  rowOf('Security').click()
  await waitFor(() => !dotOf(rowOf('Security')), 'the dot cleared on open')
  assert.ok(!store.transient.has('s-tip'), 'transient dot retired')
  assert.ok(!store.markers.get('security')?.has('s-tip'), 'persisted marker retired')
  const forget = store.calls.find(c => c[0] === 'forget')
  assert.ok(forget && forget[1].includes('s-tip') && forget[1].includes('s-root') && forget[2] === 'security', 'forgets the tip and root under the bot\'s profile')

  // Activity on the bot whose chat is on screen: never re-marked, read again.
  const marksBefore = store.calls.filter(c => c[0] === 'mark').length
  const forgetsBefore = store.calls.filter(c => c[0] === 'forget').length
  rows[0] = { ...rows[0], canonical_session: { ...rows[0].canonical_session, last_active: rows[0].canonical_session.last_active + 60, preview: 'next reply' } }
  await waitFor(() => store.calls.filter(c => c[0] === 'forget').length > forgetsBefore, 'the open bot read on its next activity', 6000)
  assert.equal(store.calls.filter(c => c[0] === 'mark').length, marksBefore, 'not re-marked while on screen')
  assert.ok(!dotOf(rowOf('Security')), 'no dot')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
