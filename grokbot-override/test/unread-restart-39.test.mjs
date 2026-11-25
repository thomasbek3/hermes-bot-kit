// PARITY R16 (#39): unread dots must not come back after a Hermes restart for
// already-read bots.
//
// On a real Hermes cold start, `enable()` runs `refreshRoster()` before
// `queryClient` has a stock snapshot and before `profiles.list` answers, so
// `app.roster.rows` is initially `[]`. If `createActivityTracker.track([])`
// consumes its one-shot `seeded = true` on that empty array (or if a
// late-arriving bot has no prior watermark), the very first real roster marks
// every bot with historical `last_active > 0` as unread in core's store
// (transient `$unreadFinishedSessionIds` + persisted
// `hermes.desktop.unreadFinishedSessions`).
//
// The fake unread store below models both layers of Hermes's
// `store/session-unread.ts` AND persistence across a simulated restart
// (re-creating the store from persisted disk storage while `reload()` boots a
// fresh plugin.js instance with an empty cold-start queryClient cache).

import assert from 'node:assert/strict'
import test from 'node:test'

import { createActivityTracker } from '../src/core/activity.js'
import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

const botRow = (name, last_active, preview = 'hi', extra = {}) => ({
  name,
  display_name: name[0].toUpperCase() + name.slice(1),
  connectionId: 'local',
  connectionKind: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: name, targetProfile: name },
  canonical_session: { id: `${name}-root`, resolved_id: `${name}-tip`, last_active, preview },
  ...extra
})

/** Model Hermes's store/session-unread.ts: persisted markers + seenCounts in
 *  `disk` (localStorage), transient `$unreadFinishedSessionIds` in memory, and
 *  cold-boot rehydrate + recompute for any listed rows. */
function createPersistedUnreadStore(disk) {
  const readJson = key => {
    try {
      return disk.has(key) ? JSON.parse(disk.get(key)) : {}
    } catch {
      return {}
    }
  }
  const writeJson = (key, value) => disk.set(key, JSON.stringify(value))
  const norm = p => String(p ?? '').trim() || 'default'

  const transient = new Set()
  const listeners = new Set()
  const emit = () => listeners.forEach(fn => fn())
  const calls = []

  const getMarkers = () => readJson('hermes.desktop.unreadFinishedSessions')
  const setMarkers = next => writeJson('hermes.desktop.unreadFinishedSessions', next)
  const getSeen = () => readJson('hermes.desktop.sessionSeenCounts')
  const setSeen = next => writeJson('hermes.desktop.sessionSeenCounts', next)

  return {
    calls,
    listeners,
    transient,
    diskMarkers: () => getMarkers(),
    diskSeen: () => getSeen(),
    mark(id, profile) {
      calls.push(['mark', id, profile])
      transient.add(id)
      const key = norm(profile)
      const markers = getMarkers()
      const bucket = Array.isArray(markers[key]) ? markers[key] : []
      if (!bucket.includes(id)) {
        markers[key] = [...bucket, id]
        setMarkers(markers)
      }
      emit()
    },
    ack(id, profile) {
      calls.push(['ack', id, profile])
      if (!id) return
      const key = norm(profile)
      const markers = getMarkers()
      if (Array.isArray(markers[key])) {
        const next = markers[key].filter(x => x !== id)
        if (next.length) markers[key] = next
        else delete markers[key]
        setMarkers(markers)
      }
      emit()
    },
    forget(ids, profile) {
      calls.push(['forget', [...ids], profile])
      const drop = new Set(ids.filter(Boolean))
      if (!drop.size) return
      const key = norm(profile)
      const seen = getSeen()
      if (seen[key]) {
        const kept = Object.fromEntries(Object.entries(seen[key]).filter(([id]) => !drop.has(id)))
        if (Object.keys(kept).length) seen[key] = kept
        else delete seen[key]
        setSeen(seen)
      }
      const markers = getMarkers()
      if (Array.isArray(markers[key])) {
        const kept = markers[key].filter(id => !drop.has(id))
        if (kept.length) markers[key] = kept
        else delete markers[key]
        setMarkers(markers)
      }
      for (const id of drop) transient.delete(id)
      emit()
    },
    /** Recompute transient set from persisted markers + seenCounts for any
     *  listed rows (mirrors session-unread.ts:onListChange on cold boot). */
    recompute(listedRows = []) {
      const markers = getMarkers()
      const seen = getSeen()
      for (const row of listedRows) {
        const key = norm(row.profile)
        const durableId = row._lineage_root_id || row.id
        const wm = seen[key]?.[durableId]
        const bucket = markers[key] || []
        const marked = bucket.includes(durableId) || bucket.includes(row.id)
        const exceeds = typeof wm === 'number' && Number.isFinite(row.message_count) && row.message_count > wm
        if (marked || exceeds) transient.add(row.id)
      }
      emit()
    }
  }
}

test('R16 #39 empty roster on boot does not consume seeding; first populated roster seeds without marking', () => {
  const marks = []
  const t = createActivityTracker({
    selectedKey: () => '',
    markUnread: (id, profile) => marks.push([id, profile])
  })
  // Cold start: roster is empty before profiles.list / stock cache resolves.
  t.track([])
  t.track([])
  // First real roster arrives with historical last_active timestamps.
  t.track([botRow('alpha', 1762560000), botRow('beta', 1762550000)])
  assert.deepEqual(marks, [], 'first populated roster must seed, not mark historical bots unread')

  // Real new message on beta: now marks unread.
  t.track([botRow('alpha', 1762560000), botRow('beta', 1762550060, 'new reply')])
  assert.deepEqual(marks, [['beta-tip', 'beta']])
})

test('R16 #39 late-arriving bot seeds on first sight; brand-new bot (ts=0) marks on its first message', () => {
  const marks = []
  const t = createActivityTracker({
    selectedKey: () => '',
    markUnread: (id, profile) => marks.push([id, profile])
  })
  t.track([botRow('alpha', 1762560000)])
  // Late-arriving bot (e.g. from union roster or another source) with history,
  // plus a brand-new bot with no messages yet.
  const fresh = { ...botRow('fresh', 0, ''), canonical_session: { id: 'fresh-root', last_active: 0, preview: '' } }
  t.track([botRow('alpha', 1762560000), botRow('late', 1762540000), fresh])
  assert.deepEqual(marks, [], 'first sight of a late-arriving bot must not mark it unread')

  // Later real activity on both late and fresh: both mark unread.
  t.track([
    botRow('alpha', 1762560000),
    botRow('late', 1762540120, 'hello'),
    botRow('fresh', 1762560120, 'first msg')
  ])
  assert.deepEqual(marks, [['late-tip', 'late'], ['fresh-tip', 'fresh']])
})

test('loader-faithful R16 #39: read bots stay read across a simulated Hermes restart (cold-start empty roster + persisted store)', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const disk = new Map()
  let unread = createPersistedUnreadStore(disk)
  let stockCache = [] // Empty on cold start, as in real Hermes Desktop.

  const second = {
    ...LOCAL,
    name: 'archivist',
    display_name: 'Archivist',
    route: { connectionId: 'local', mode: 'local', profile: 'archivist', targetProfile: 'archivist' },
    canonical_session: { id: 'a-root', resolved_id: 'a-tip', preview: 'archive ready', last_active: 1762550000 }
  }
  const serverRows = [
    { ...LOCAL, canonical_session: { ...LOCAL.canonical_session, resolved_id: 's-tip' } },
    second
  ]

  const { panes, mount, errors, React, reload } = await bootPlugin(t, {
    rows: serverRows,
    answers: {
      'profiles.list': () => ({ profiles: serverRows.map(r => ({ ...r, canonical_session: { ...r.canonical_session } })) })
    },
    tweak: sdk => {
      sdk.queryClient = {
        getQueryCache: () => ({ findAll: () => stockCache }),
        invalidateQueries: () => undefined
      }
      sdk.markSessionUnreadFinished = (id, profile) => unread.mark(id, profile)
      sdk.ackStoredSessionId = (id, profile) => unread.ack(id, profile)
      sdk.forgetSessionUnread = (ids, profile) => unread.forget(ids, profile)
      sdk.SessionStatusDot = props => globalThis.__restartDot(props)
    }
  })

  globalThis.__restartDot = ({ storedSessionId }) => {
    const on = React.useSyncExternalStore(
      fn => (unread.listeners.add(fn), () => unread.listeners.delete(fn)),
      () => unread.transient.has(storedSessionId)
    )
    return React.createElement(
      'span',
      { className: 'flex' },
      on
        ? React.createElement('span', { role: 'status', className: 'size-1.5 rounded-full bg-(--ui-success)' })
        : React.createElement('span', { 'aria-hidden': 'true', className: 'size-1 rounded-full' })
    )
  }
  t.after(() => delete globalThis.__restartDot)

  let rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const dotOf = el => el?.querySelector('.gbo-unread-dot [role="status"]')

  // Boot 1 (cold start): rows arrive from profiles.list after initial empty
  // refreshRoster(). Neither bot should be marked unread.
  await waitFor(() => rowOf('Security') && rowOf('Archivist'), 'initial rows from profiles.list', 6000)
  assert.ok(!dotOf(rowOf('Security')), 'Boot 1 cold start: Security must not be falsely marked unread')
  assert.ok(!dotOf(rowOf('Archivist')), 'Boot 1 cold start: Archivist must not be falsely marked unread')
  assert.deepEqual(unread.calls.filter(c => c[0] === 'mark'), [], 'Boot 1 cold start: no markSessionUnreadFinished calls')

  // Real new message on Security while it is not open: dot lights up.
  serverRows[0] = {
    ...serverRows[0],
    canonical_session: { ...serverRows[0].canonical_session, last_active: serverRows[0].canonical_session.last_active + 60, preview: 'new alert' }
  }
  // Feed the updated snapshot through the stock cache (next 3 s tick picks it up).
  stockCache = [{ queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: serverRows, sources: [] }, dataUpdatedAt: Date.now() } }]
  await waitFor(() => dotOf(rowOf('Security')), 'Security dot on real new message', 6000)
  assert.ok(unread.transient.has('s-tip'), 'transient dot set')
  assert.ok((unread.diskMarkers().security || []).includes('s-tip'), 'persisted marker set')

  // User clicks Security to read it: both transient and persisted layers clear.
  rowOf('Security').click()
  await waitFor(() => !dotOf(rowOf('Security')), 'Security dot cleared on click')
  assert.ok(!unread.transient.has('s-tip'), 'transient cleared on read')
  assert.equal(unread.diskMarkers().security, undefined, 'persisted marker cleared on read')

  // Simulated Hermes restart: fresh unread store rehydrated from the same
  // persisted `disk`, empty cold-start queryClient cache, fresh plugin.js boot.
  unread = createPersistedUnreadStore(disk)
  unread.recompute([])
  stockCache = []
  await reload()
  rosterEl = mount(panes.find(p => p.id === 'roster').render)

  await waitFor(() => rowOf('Security') && rowOf('Archivist'), 'rows after simulated restart', 6000)
  assert.ok(!dotOf(rowOf('Security')), 'After restart: already-read Security must stay read')
  assert.ok(!dotOf(rowOf('Archivist')), 'After restart: Archivist must stay read')
  assert.deepEqual(unread.calls.filter(c => c[0] === 'mark'), [], 'After restart: no spurious mark calls')

  // Post-restart genuinely new message on Archivist (not open): dot appears.
  serverRows[1] = {
    ...serverRows[1],
    canonical_session: { ...serverRows[1].canonical_session, last_active: serverRows[1].canonical_session.last_active + 60, preview: 'post-restart note' }
  }
  stockCache = [{ queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: serverRows, sources: [] }, dataUpdatedAt: Date.now() } }]
  await waitFor(() => dotOf(rowOf('Archivist')), 'Archivist dot on post-restart new message', 6000)
  assert.ok(!dotOf(rowOf('Security')), 'Security remains read')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
