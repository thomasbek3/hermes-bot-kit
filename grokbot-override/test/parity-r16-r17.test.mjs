// PARITY R16 (unread dot) and R17 (inbound activity toasts): the port of
// roster-actions.ts trackInboundActivity, unit and loader-faithful.

import assert from 'node:assert/strict'
import test from 'node:test'

import { botCanonicalSessionId, createActivityTracker } from '../src/core/activity.js'
import { bootPlugin, LOCAL, READY, REMOTE, waitFor } from './loader-boot.mjs'

const row = (name, last_active, preview, extra = {}) => ({
  name,
  connectionId: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: name, targetProfile: name },
  canonical_session: { id: `${name}-root`, resolved_id: `${name}-tip`, last_active, preview },
  ...extra
})

function tracker(over = {}) {
  const marks = []
  const toasts = []
  const refreshed = []
  const t = createActivityTracker({
    selectedKey: () => over.selected || '',
    isHidden: bot => Boolean(bot.hidden),
    label: bot => bot.name,
    markUnread: (id, profile) => marks.push([id, profile]),
    toastsEnabled: () => over.toasts !== false,
    notify: n => toasts.push(n),
    refreshOpen: bot => refreshed.push(bot.name),
    ...over.deps
  })
  return { t, marks, toasts, refreshed }
}

test('R16/R17 the first refresh only seeds; moved activity marks unread on the Bot Chat tip and toasts once per preview', () => {
  const { t, marks, toasts } = tracker()
  t.track([row('a', 100, 'old')])
  assert.deepEqual(marks, [])
  t.track([row('a', 200, 'Message from b: hi')])
  assert.deepEqual(marks, [['a-tip', 'a']])
  assert.equal(toasts[0].title, '🤖 New message for a')
  t.track([row('a', 300, 'Message from b: hi')])
  assert.equal(marks.length, 2, 'marked again')
  assert.equal(toasts.length, 1, 'the same preview never toasts twice')
})

test('R16/R17 the open bot is refreshed, not marked; hidden bots mark silently; toasts are opt-in', () => {
  const open = tracker({ selected: 'local::a' })
  open.t.track([row('a', 1, 'x')])
  open.t.track([row('a', 2, 'y')])
  assert.deepEqual(open.marks, [])
  assert.deepEqual(open.refreshed, ['a'])
  const hidden = tracker()
  hidden.t.track([row('h', 1, 'x', { hidden: true })])
  hidden.t.track([row('h', 2, 'y', { hidden: true })])
  assert.equal(hidden.marks.length, 1)
  assert.equal(hidden.toasts.length, 0)
  const off = tracker({ toasts: false })
  off.t.track([row('o', 1, 'x')])
  off.t.track([row('o', 2, 'y')])
  assert.equal(off.marks.length, 1)
  assert.equal(off.toasts.length, 0)
})

test('R16 reseed forgets watermarks: activity seen while stock Bot Mode was fronted is not replayed', () => {
  const { t, marks } = tracker()
  t.track([row('a', 1, 'x')])
  t.reseed()
  t.track([row('a', 5, 'y')])
  assert.deepEqual(marks, [])
  assert.equal(botCanonicalSessionId({ canonical_session: { id: 'r' } }), 'r')
})

test('loader-faithful R16: the row draws Hermes\'s SessionStatusDot for the Bot Chat id; a roster refresh with new activity marks it unread', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const marks = []
  let remote = { ...REMOTE }
  const { panes, mount, errors, React } = await bootPlugin(t, {
    tweak: sdk => {
      sdk.markSessionUnreadFinished = (id, profile) => marks.push([id, profile])
      sdk.ackStoredSessionId = () => undefined
      sdk.SessionStatusDot = ({ storedSessionId }) => globalThis.__dot(storedSessionId)
      sdk.queryClient = {
        getQueryCache: () => ({
          findAll: () => [{ queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: [LOCAL, remote], sources: [] }, dataUpdatedAt: Date.now() } }]
        })
      }
    }
  })
  globalThis.__dot = id => React.createElement('i', { 'data-dot': id })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rosterEl.querySelector('[data-dot="k-tip"]'), 'the dot keyed by the lineage tip')
  remote = { ...REMOTE, canonical_session: { ...REMOTE.canonical_session, last_active: REMOTE.canonical_session.last_active + 60, preview: 'Message from cron: done' } }
  await waitFor(() => marks.length > 0, 'the next roster refresh', 6000)
  assert.deepEqual(marks[0], ['k-tip', 'scholar'])
  assert.deepEqual(errors, [])
})
