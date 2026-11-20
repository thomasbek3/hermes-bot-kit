// Loader-faithful (unread look), review of `unread-look` (each written
// before its fix):
// L-1a the roster shrinks (600 -> 200 px) and a jump puts an unread row
//      entirely below the view: the pill says "below";
// L-1b an observer entry computed before a scroll jump and delivered after
//      it does not misplace the row: the pill points where the row is;
// L-2  the pills are real buttons with directional names, and they come
//      before the rows in tab (DOM) order;
// L-4  selecting a row (an ordinary state change) re-registers nothing with
//      the observer;
// L-5  with Reduce Motion on, the jump is instant (one scroll, to the row,
//      then focus there);
// L2-1 at 150 % UI scale (CSS zoom), the pill lands the row in view;
// L2-3 an avatar's contents being replaced re-measures no row.
// Fakes: test/fixtures/pill-env.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { installLayout, installObserver, installReducedMotion, installResizeObserver } from './fixtures/pill-env.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const ROW_H = 60
const NAMES = Array.from({ length: 20 }, (_, i) => `bot${String(i).padStart(2, '0')}`)
const row = (name, i) => ({
  name,
  display_name: `Bot ${String(i).padStart(2, '0')}`,
  connectionId: 'local',
  connectionKind: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: name, targetProfile: name },
  canonical_session: { id: `${name}-root`, preview: `${name} preview`, last_active: 1762560000 - i }
})

test('loader-faithful unread look: pill geometry after resizes and late entries, button semantics and tab order, no re-registration, Reduce Motion', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const unread = new Set(['bot07-root'])
  const listeners = new Set()
  const emit = () => listeners.forEach(fn => fn())
  const view = { height: 600 }
  const motion = { reduce: false }
  let io = null
  let ro = null
  const { panes, mount, errors, React } = await bootPlugin(t, {
    rows: NAMES.map(row),
    tweak: sdk => {
      io = installObserver()
      ro = installResizeObserver()
      sdk.markSessionUnreadFinished = id => (unread.add(id), emit())
      sdk.ackStoredSessionId = id => (unread.delete(id), emit())
      sdk.SessionStatusDot = props => globalThis.__fakeDot(props)
    }
  })
  globalThis.__fakeDot = ({ storedSessionId }) => {
    const on = React.useSyncExternalStore(fn => (listeners.add(fn), () => listeners.delete(fn)), () => unread.has(storedSessionId))
    return React.createElement('span', { className: 'flex' }, on ? React.createElement('span', { role: 'status', className: 'size-1.5 rounded-full bg-(--ui-success)' }) : React.createElement('span', { 'aria-hidden': 'true', className: 'size-1 rounded-full' }))
  }
  t.after(() => {
    delete globalThis.__fakeDot
    delete globalThis.IntersectionObserver
    delete globalThis.ResizeObserver
  })
  t.after(installLayout({ view, rowHeight: ROW_H }))
  t.after(installReducedMotion(motion))
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const scroller = () => rosterEl.querySelector('.gbo-roster-list')
  const pill = side => rosterEl.querySelector(`.gbo-unread-pill.is-${side}`)
  const rowEl = name => [...rosterEl.querySelectorAll('.gbo-row-wrap')].find(w => w.textContent.includes(name))
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  const scrollTo = top => {
    scroller().scrollTop = top
    scroller().dispatchEvent(new window.Event('scroll'))
  }
  const sides = () => `${pill('up') ? 'up' : '-'}/${pill('down') ? 'down' : '-'}`

  await waitFor(() => rosterEl.querySelectorAll('.gbo-row-wrap').length === NAMES.length, 'every row')
  await waitFor(() => io.observed().includes(rowEl('Bot 07')), 'the unread row observed')
  // Bot 07 sits at y 420-480: in the 600 px view.
  io.report()
  await settle()
  assert.equal(sides(), '-/-')

  // L-1a: jump far down (Bot 07 above, a crossing), shrink the roster to
  // 200 px, then jump so Bot 07 sits at y 250-310: entirely below.
  scrollTo(900)
  io.report()
  await waitFor(() => pill('up'), 'above after the jump')
  view.height = 200
  ro.resize()
  await settle()
  scrollTo(170)
  io.report()
  await settle()
  assert.equal(sides(), '-/down', 'L-1a: after the resize the row below is below')

  // L-1b: an entry computed at one scroll position arrives after a jump.
  view.height = 300
  ro.resize()
  scrollTo(0)
  io.report()
  await settle()
  unread.delete('bot07-root') // Bot 12 alone, so the pill can only be its
  unread.add('bot12-root') // y 720-780
  emit()
  await waitFor(() => io.observed().includes(rowEl('Bot 12')), 'Bot 12 observed')
  io.report({ before: () => (scroller().scrollTop = 400) }) // computed at 0, delivered at 400
  scrollTo(900) // Bot 12 at y -180..-120: above, no crossing since the entry
  io.report()
  await settle()
  assert.ok(pill('up'), `L-1b: the late entry did not misplace Bot 12 (${sides()})`)
  unread.delete('bot12-root')
  emit()
  await settle()

  // L-2: one pill each way: real buttons, directional names, before the rows.
  unread.add('bot07-root')
  unread.add('bot00-root') // y 0-60
  unread.add('bot19-root') // y 1140-1200
  emit()
  await waitFor(() => io.observed().length === 3, 'three unread rows observed')
  scrollTo(600)
  io.report()
  await waitFor(() => pill('up') && pill('down'), 'both pills')
  for (const [side, name] of [['up', 'More unreads above'], ['down', 'More unreads below']]) {
    const el = pill(side)
    assert.equal(el.tagName, 'BUTTON', `L-2: the ${side} pill is a button`)
    assert.equal(el.getAttribute('type'), 'button')
    assert.ok(!el.hasAttribute('tabindex') || Number(el.getAttribute('tabindex')) >= 0, 'focusable')
    assert.equal(el.getAttribute('aria-label'), name, `L-2: ${name}`)
  }
  const focusables = [...rosterEl.querySelectorAll('button, [href], input, [tabindex]')].filter(el => !el.disabled && el.getAttribute('tabindex') !== '-1')
  const firstRow = focusables.findIndex(el => el.classList.contains('gbo-row'))
  assert.ok(focusables.indexOf(pill('up')) >= 0 && focusables.indexOf(pill('up')) < firstRow, 'L-2: Tab reaches the top pill before the rows')
  assert.ok(focusables.indexOf(pill('down')) >= 0 && focusables.indexOf(pill('down')) < firstRow, 'L-2: Tab reaches the bottom pill before the rows')

  // L-4: selecting a row is an ordinary state change: nothing re-registers.
  const before = io.calls()
  rowEl('Bot 03').querySelector('button.gbo-row').click()
  await settle()
  await settle()
  assert.deepEqual(io.calls(), before, 'L-4: no observe / unobserve on a selection')

  // L-5: Reduce Motion on: activation scrolls once, instantly, to the
  // nearest unread row below (Bot 19 at 1140: centred, 1140 - 120), and
  // moves focus there.
  const jumps = []
  scroller().scrollTo = options => {
    jumps.push(options)
    scroller().scrollTop = options.top
  }
  const focusedButton = name => rowEl(name).querySelector('button.gbo-row')
  motion.reduce = true
  pill('down').click()
  assert.equal(jumps.length, 1, 'L-5: exactly one scroll')
  assert.deepEqual(jumps[0], { top: 1140 - (300 - ROW_H) / 2, behavior: 'auto' }, 'L-5: to the row, instantly')
  assert.ok(rosterEl.ownerDocument.activeElement === focusedButton('Bot 19'), 'L-5: focus on the destination row')
  motion.reduce = false
  scrollTo(600)
  io.report()
  await waitFor(() => pill('down'), 'the pill again')
  pill('down').click()
  assert.equal(jumps.length, 2)
  assert.deepEqual(jumps[1], { top: 1140 - (300 - ROW_H) / 2, behavior: 'smooth' }, 'smooth otherwise')

  // L2-3: an avatar's contents are replaced (a picture loads): the rows did
  // not move, so no unread row is measured again.
  const proto = window.Element.prototype
  const layoutRead = proto.getBoundingClientRect
  let reads = 0
  proto.getBoundingClientRect = function () {
    reads += 1
    return layoutRead.call(this)
  }
  const face = rowEl('Bot 05').querySelector('.gbo-row-face')
  const picture = rosterEl.ownerDocument.createElement('img')
  face.replaceChild(picture, face.firstElementChild)
  await settle()
  await settle()
  proto.getBoundingClientRect = layoutRead
  assert.equal(reads, 0, `L2-3: an avatar swap re-measures nothing (${reads} rect reads)`)

  // L2-1: at 150 % UI scale (CSS zoom) the pill scrolls to the row in the
  // scroller's own units, and the focused row ends up in view.
  view.zoom = 1.5
  ro.resize()
  scrollTo(0)
  io.report()
  await settle()
  unread.delete('bot00-root')
  unread.delete('bot07-root')
  unread.delete('bot19-root')
  unread.add('bot15-root') // CSS y 900-960, the only unread row
  emit()
  await waitFor(() => io.observed().length === 1 && io.observed()[0] === rowEl('Bot 15'), 'only Bot 15 watched')
  await waitFor(() => pill('down'), 'the pill at 150 %')
  jumps.length = 0
  pill('down').click()
  assert.equal(jumps.length, 1)
  const landed = jumps[0].top
  const cssTop = 15 * ROW_H - landed
  assert.ok(cssTop >= 0 && cssTop + ROW_H <= 300, `L2-1: the focused row is in view after the jump (scrollTop ${landed}, row at ${cssTop})`)
  assert.equal(landed, 15 * ROW_H - (300 - ROW_H) / 2, 'centred in CSS px')
  assert.ok(rosterEl.ownerDocument.activeElement === focusedButton('Bot 15'))
  view.zoom = 1
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
