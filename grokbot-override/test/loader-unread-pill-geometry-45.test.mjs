// Loader-faithful (unread look, Spec 106), pill geometry:
// L-1a resize + jump; L-1b late observer entry; L-2 button semantics & tab order;
// L-4 selection re-registers nothing; L-5 Reduce Motion; L2-1 150% UI scale;
// L2-3 avatar swap re-measures nothing.

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
const unreadEntry = name => ({
  seenCount: 1,
  seenTipId: `${name}-root`,
  latestCount: 2,
  latestTipId: `${name}-root`,
  seenAt: 1762550000000,
  latestAt: 1762560000000,
  updatedAt: 1762560000000
})

test('loader-faithful unread look: pill geometry after resizes and late entries, button semantics and tab order, no re-registration, Reduce Motion', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const view = { height: 600 }
  const motion = { reduce: false }
  let io = null
  let ro = null
  const { panes, mount, errors, internals } = await bootPlugin(t, {
    smoke: true,
    rows: NAMES.map(row),
    storage: { unreadStore: { 'local::bot07': unreadEntry('bot07') } },
    tweak: () => {
      io = installObserver()
      ro = installResizeObserver()
    }
  })
  const setUnread = (names, on) => {
    const cur = { ...internals.roster2.unread.get() }
    for (const name of Array.isArray(names) ? names : [names]) {
      if (on) cur[`local::${name}`] = unreadEntry(name)
      else cur[`local::${name}`] = { ...unreadEntry(name), seenCount: 2, seenAt: 1762560000000 }
    }
    internals.roster2.unread.set(cur)
  }
  t.after(() => {
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
  io.report()
  await settle()
  assert.equal(sides(), '-/-')

  // L-1a: jump far down (Bot 07 above), shrink roster to 200 px, jump so Bot 07 is below.
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
  setUnread('bot07', false)
  setUnread('bot12', true)
  await waitFor(() => io.observed().includes(rowEl('Bot 12')), 'Bot 12 observed')
  io.report({ before: () => (scroller().scrollTop = 400) })
  scrollTo(900)
  io.report()
  await settle()
  assert.ok(pill('up'), `L-1b: the late entry did not misplace Bot 12 (${sides()})`)
  setUnread('bot12', false)
  await settle()

  // L-2: one pill each way: real buttons, directional names, before the rows.
  setUnread(['bot07', 'bot00', 'bot19'], true)
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

  // L-5: Reduce Motion on.
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

  // L2-3: an avatar swap re-measures nothing.
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

  // L2-1: at 150 % UI scale (CSS zoom) the pill scrolls to the row in CSS px.
  view.zoom = 1.5
  ro.resize()
  scrollTo(0)
  io.report()
  await settle()
  setUnread(['bot00', 'bot07', 'bot19'], false)
  setUnread('bot15', true)
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
