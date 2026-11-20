// Loader-faithful (unread look): the unread dot sits at the row's right
// edge (the last thing in the row, not a badge on the avatar), and on the
// avatar of a pinned tile. Read tracking is the existing one, unchanged: the
// roster refresh marks a moved bot in Hermes's store, opening it acks it.
// Hermes's store is faked as a set of unread stored ids.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

const OWL = { ...LOCAL, name: 'owl', display_name: 'Owl', route: { ...LOCAL.route, profile: 'owl', targetProfile: 'owl' }, canonical_session: { id: 'o-root', preview: 'owl preview', last_active: 1762550000 } }

test('loader-faithful unread look: the dot at the row\'s right edge, on a pinned avatar; marked by the refresh, cleared on open', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const unread = new Set()
  const listeners = new Set()
  const emit = () => listeners.forEach(fn => fn())
  const marks = []
  const rows = [LOCAL, OWL]
  const { panes, mount, errors, React } = await bootPlugin(t, {
    rows,
    storage: { pinnedBots: ['local::owl'] },
    tweak: sdk => {
      sdk.markSessionUnreadFinished = (id, profile) => (marks.push([id, profile]), unread.add(id), emit())
      sdk.ackStoredSessionId = id => (unread.delete(id), emit())
      sdk.SessionStatusDot = props => globalThis.__fakeDot(props)
    }
  })
  globalThis.__fakeDot = ({ storedSessionId }) => {
    const on = React.useSyncExternalStore(fn => (listeners.add(fn), () => listeners.delete(fn)), () => unread.has(storedSessionId))
    return React.createElement('span', { className: 'flex' }, on ? React.createElement('span', { role: 'status', className: 'size-1.5 rounded-full bg-(--ui-success)' }) : React.createElement('span', { 'aria-hidden': 'true', className: 'size-1 rounded-full' }))
  }
  t.after(() => delete globalThis.__fakeDot)
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const dotOf = el => el?.querySelector('.gbo-unread-dot [role="status"]')
  await waitFor(() => rowOf('Security'), 'the row')

  // The existing tracker: a refresh that sees new activity marks it.
  rows[0] = { ...LOCAL, canonical_session: { ...LOCAL.canonical_session, last_active: LOCAL.canonical_session.last_active + 60, preview: 'Message from cron: done' } }
  await waitFor(() => dotOf(rowOf('Security')), 'the dot after the next roster refresh', 6000)
  assert.deepEqual(marks[0], ['s-root', 'security'])
  const dot = rowOf('Security').querySelector('.gbo-unread-dot')
  // (Booleans, not elements: a failing assert would print the whole jsdom tree.)
  assert.ok(Boolean(dot) && rowOf('Security').lastElementChild === dot, 'at the row\'s right edge (the row\'s last child, after the text)')
  assert.ok(!(rowOf('Security').querySelector('.gbo-row-face .gbo-unread-dot')), 'no badge on the avatar')
  assert.ok(rowOf('Security').querySelector('.gbo-row-face .gbo-run-dot'), 'the avatar keeps the running cue\'s place')
  // Computed (the plugin's stylesheet): the row lays out left to right and
  // the dot keeps its place last: no flex order moves it, the row is not
  // reversed; and the dot itself is visible and sized.
  const cs = el => getComputedStyle(el)
  assert.ok(!/reverse/.test(cs(rowOf('Security')).flexDirection), 'the row is not reversed')
  const orderOf = el => Number(cs(el).order || 0)
  const items = [...rowOf('Security').children]
  assert.ok(items.every(item => item === dot || orderOf(item) <= orderOf(dot)), 'L-3: computed: nothing comes after the dot (flex order)')
  const inner = dot.querySelector('[role="status"]')
  assert.ok(cs(dot).display !== 'none' && cs(inner).display !== 'none' && cs(inner).visibility !== 'hidden', 'the dot is visible')
  assert.ok(cs(inner).width !== '0px' && cs(inner).height !== '0px', 'and sized')

  // A pinned bot: the dot on its avatar.
  unread.add('o-root')
  emit()
  const pin = await waitFor(() => rosterEl.querySelector('button.gbo-pin'), 'the pinned tile')
  await waitFor(() => dotOf(pin), 'the pinned dot')
  assert.ok(pin.querySelector('.pinned__avatar .gbo-unread-dot [role="status"]'), 'on the pinned avatar')
  const pinDot = pin.querySelector('.pinned__avatar .gbo-unread-dot')
  assert.equal(getComputedStyle(pinDot).position, 'absolute', 'L-3: computed: the pinned dot is placed on the avatar (absolute)')
  assert.notEqual(getComputedStyle(pinDot).display, 'none')

  // Opening clears it (the existing ack on open).
  rowOf('Security').click()
  await waitFor(() => !dotOf(rowOf('Security')), 'cleared on open')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
