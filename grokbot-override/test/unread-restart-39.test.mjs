// PARITY R16 (#39, Spec 106): unread dots must not come back after a Hermes
// restart for already-read bots, and genuinely unread bots must stay unread
// across a restart. Driven by the plugin's own persisted unreadStore.

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

test('R16 #39 empty roster on boot does not consume seeding; first populated roster seeds without marking', () => {
  const marks = []
  const t = createActivityTracker({
    selectedKey: () => '',
    markUnread: (id, profile) => marks.push([id, profile])
  })
  t.track([])
  t.track([])
  t.track([botRow('alpha', 1762560000), botRow('beta', 1762550000)])
  assert.deepEqual(marks, [], 'first populated roster must seed, not mark historical bots unread')

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
  const fresh = { ...botRow('fresh', 0, ''), canonical_session: { id: 'fresh-root', last_active: 0, preview: '' } }
  t.track([botRow('alpha', 1762560000), botRow('late', 1762540000), fresh])
  assert.deepEqual(marks, [], 'first sight of a late-arriving bot must not mark it unread')

  t.track([
    botRow('alpha', 1762560000),
    botRow('late', 1762540120, 'hello'),
    botRow('fresh', 1762560120, 'first msg')
  ])
  assert.deepEqual(marks, [['late-tip', 'late'], ['fresh-tip', 'fresh']])
})

test('loader-faithful R16 #39 (Spec 106): read bots stay read and unread bots stay unread across a simulated Hermes restart', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const nativeMarks = []
  let stockCache = [] // Empty on cold start, as in real Hermes Desktop.

  const second = {
    ...LOCAL,
    name: 'archivist',
    display_name: 'Archivist',
    route: { connectionId: 'local', mode: 'local', profile: 'archivist', targetProfile: 'archivist' },
    canonical_session: { id: 'a-root', resolved_id: 'a-tip', preview: 'archive ready', last_active: 1762550000, message_count: 3 }
  }
  const serverRows = [
    { ...LOCAL, canonical_session: { ...LOCAL.canonical_session, resolved_id: 's-tip', message_count: 3 } },
    second
  ]

  const { panes, mount, errors, reload } = await bootPlugin(t, {
    rows: serverRows,
    answers: {
      'profiles.list': () => ({ profiles: serverRows.map(r => ({ ...r, canonical_session: { ...r.canonical_session } })) })
    },
    tweak: sdk => {
      sdk.queryClient = {
        getQueryCache: () => ({ findAll: () => stockCache }),
        invalidateQueries: () => undefined
      }
      sdk.markSessionUnreadFinished = (id, profile) => nativeMarks.push([id, profile])
      sdk.ackStoredSessionId = () => undefined
      sdk.forgetSessionUnread = () => undefined
    }
  })

  let rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const dotOf = el => el?.querySelector('.gbo-unread-dot [role="status"][data-gbo-unread="true"]')

  // Boot 1 (cold start): rows arrive from profiles.list after initial empty
  // refreshRoster(). First observation seeds both as seen: neither gets a dot.
  await waitFor(() => rowOf('Security') && rowOf('Archivist'), 'initial rows from profiles.list', 6000)
  assert.ok(!dotOf(rowOf('Security')), 'Boot 1 cold start: Security must not be falsely marked unread')
  assert.ok(!dotOf(rowOf('Archivist')), 'Boot 1 cold start: Archivist must not be falsely marked unread')
  assert.deepEqual(nativeMarks, [], 'native unread store is untouched')

  // Real new message on Security while not open: dot lights up.
  serverRows[0] = {
    ...serverRows[0],
    canonical_session: { ...serverRows[0].canonical_session, last_active: serverRows[0].canonical_session.last_active + 60, message_count: 4, preview: 'new alert' }
  }
  stockCache = [{ queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: serverRows, sources: [] }, dataUpdatedAt: Date.now() } }]
  await waitFor(() => dotOf(rowOf('Security')), 'Security dot on real new message', 6000)

  // User clicks Security to read it: fresh history (4 messages) clears it.
  rowOf('Security').click()
  await waitFor(() => !dotOf(rowOf('Security')), 'Security dot cleared on open')

  // Simulated Hermes restart: empty cold-start queryClient cache, fresh plugin.js boot on same storage.
  stockCache = []
  await reload()
  rosterEl = mount(panes.find(p => p.id === 'roster').render)

  await waitFor(() => rowOf('Security') && rowOf('Archivist'), 'rows after simulated restart', 6000)
  assert.ok(!dotOf(rowOf('Security')), 'After restart: already-read Security must stay read')
  assert.ok(!dotOf(rowOf('Archivist')), 'After restart: Archivist must stay read')

  // Post-restart genuinely new message on Archivist (not open): dot appears.
  serverRows[1] = {
    ...serverRows[1],
    canonical_session: { ...serverRows[1].canonical_session, last_active: serverRows[1].canonical_session.last_active + 60, message_count: 4, preview: 'post-restart note' }
  }
  stockCache = [{ queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: serverRows, sources: [] }, dataUpdatedAt: Date.now() } }]
  await waitFor(() => dotOf(rowOf('Archivist')), 'Archivist dot on post-restart new message', 6000)
  assert.ok(!dotOf(rowOf('Security')), 'Security remains read')

  // Reload while Archivist is still unread: Archivist MUST stay unread!
  stockCache = []
  await reload()
  rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowOf('Security') && rowOf('Archivist'), 'rows after second restart', 6000)
  assert.ok(dotOf(rowOf('Archivist')), 'After restart: unread Archivist must stay unread')
  assert.ok(!dotOf(rowOf('Security')), 'After restart: read Security must stay read')
  assert.deepEqual(nativeMarks, [])
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
