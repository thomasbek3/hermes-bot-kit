// Loader-faithful (unread look, Spec 106): the plugin's own unread dot sits at
// the row's right edge (the last thing in the row, not a badge on the avatar),
// and on the avatar of a pinned tile. Driven by the plugin's own unread store
// (never Hermes's native unread store), cleared when opened with fresh history.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

const OWL = { ...LOCAL, name: 'owl', display_name: 'Owl', route: { ...LOCAL.route, profile: 'owl', targetProfile: 'owl' }, canonical_session: { id: 'o-root', preview: 'owl preview', last_active: 1762550000 } }

test('loader-faithful unread look: the dot at the row\'s right edge, on a pinned avatar; marked by the refresh, cleared on open', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const nativeMarks = []
  const rows = [LOCAL, OWL]
  const { panes, mount, errors, React } = await bootPlugin(t, {
    rows,
    storage: {
      pinnedBots: ['local::owl'],
      unreadStore: {
        'local::owl': { seenCount: 1, seenTipId: 'o-root', latestCount: 2, latestTipId: 'o-root', seenAt: 1762540000000, latestAt: 1762550000000, updatedAt: 1762550000000 }
      }
    },
    tweak: sdk => {
      sdk.markSessionUnreadFinished = (id, profile) => nativeMarks.push([id, profile])
      sdk.ackStoredSessionId = () => undefined
      sdk.SessionStatusDot = () => React.createElement('span', { className: 'flex' }, React.createElement('span', { 'aria-hidden': 'true', className: 'size-1 rounded-full' }))
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const dotOf = el => el?.querySelector('.gbo-unread-dot [role="status"][data-gbo-unread="true"]')
  await waitFor(() => rowOf('Security'), 'the row')

  // A refresh that sees new activity marks Security in the plugin's own store.
  rows[0] = { ...LOCAL, canonical_session: { ...LOCAL.canonical_session, last_active: LOCAL.canonical_session.last_active + 60, preview: 'Message from cron: done' } }
  await waitFor(() => dotOf(rowOf('Security')), 'the dot after the next roster refresh', 6000)
  assert.deepEqual(nativeMarks, [], 'native unread store is never touched')
  const dot = rowOf('Security').querySelector('.gbo-unread-dot')
  assert.ok(Boolean(dot) && rowOf('Security').lastElementChild === dot, 'at the row\'s right edge (the row\'s last child, after the text)')
  assert.ok(!(rowOf('Security').querySelector('.gbo-row-face .gbo-unread-dot')), 'no badge on the avatar')
  assert.ok(rowOf('Security').querySelector('.gbo-row-face .gbo-run-dot'), 'the avatar keeps the running cue\'s place')
  const cs = el => getComputedStyle(el)
  assert.ok(!/reverse/.test(cs(rowOf('Security')).flexDirection), 'the row is not reversed')
  const orderOf = el => Number(cs(el).order || 0)
  const items = [...rowOf('Security').children]
  assert.ok(items.every(item => item === dot || orderOf(item) <= orderOf(dot)), 'L-3: computed: nothing comes after the dot (flex order)')
  const inner = dot.querySelector('[role="status"]')
  assert.ok(cs(dot).display !== 'none' && cs(inner).display !== 'none' && cs(inner).visibility !== 'hidden', 'the dot is visible')
  assert.ok(cs(inner).width !== '0px' && cs(inner).height !== '0px', 'and sized')

  // A pinned bot: the dot on its avatar.
  const pin = await waitFor(() => rosterEl.querySelector('button.gbo-pin'), 'the pinned tile')
  await waitFor(() => dotOf(pin), 'the pinned dot')
  assert.ok(pin.querySelector('.pinned__avatar .gbo-unread-dot [role="status"][data-gbo-unread="true"]'), 'on the pinned avatar')
  const pinDot = pin.querySelector('.pinned__avatar .gbo-unread-dot')
  assert.equal(getComputedStyle(pinDot).position, 'absolute', 'L-3: computed: the pinned dot is placed on the avatar (absolute)')
  assert.notEqual(getComputedStyle(pinDot).display, 'none')

  // Opening clears it after fresh history loads in the visible pane.
  rowOf('Security').click()
  await waitFor(() => !dotOf(rowOf('Security')), 'cleared on open')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
