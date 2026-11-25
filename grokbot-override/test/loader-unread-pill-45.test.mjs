// Loader-faithful (unread look, Spec 106): the roster's "More unreads" pill.
// It shows only while an unread row (plugin's own unread dot) is scrolled out
// of view, on the side it lies (top: arrow up; bottom: arrow down), and a click
// (or a key) scrolls the roster to the nearest such row and focuses it.
// Scrolling itself reads no layout and scans nothing.

import assert from 'node:assert/strict'
import test from 'node:test'

import { installLayout, installObserver } from './fixtures/pill-env.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const ROW_H = 60
const VIEW_H = 300
const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango']
const row = (name, i) => ({
  name,
  display_name: name[0].toUpperCase() + name.slice(1),
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

test('loader-faithful unread look: "More unreads" shows only while an unread row is off screen, on its side, and scrolls to it', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let io = null
  const { panes, mount, errors, internals } = await bootPlugin(t, {
    smoke: true,
    rows: NAMES.map(row),
    storage: { unreadStore: { 'local::hotel': unreadEntry('hotel') } },
    tweak: () => {
      io = installObserver()
    }
  })
  const setUnread = (name, on) => {
    const cur = { ...internals.roster2.unread.get() }
    if (on) cur[`local::${name}`] = unreadEntry(name)
    else cur[`local::${name}`] = { ...unreadEntry(name), seenCount: 2, seenAt: 1762560000000 }
    internals.roster2.unread.set(cur)
  }
  t.after(() => {
    delete globalThis.IntersectionObserver
  })
  t.after(installLayout({ view: { height: VIEW_H }, rowHeight: ROW_H }))
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const scroller = () => rosterEl.querySelector('.gbo-roster-list')
  const pill = side => rosterEl.querySelector(`.gbo-unread-pill.is-${side}`)
  const rowEl = name => [...rosterEl.querySelectorAll('.gbo-row-wrap')].find(w => w.textContent.includes(name))
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))

  await waitFor(() => rosterEl.querySelectorAll('.gbo-row-wrap').length === NAMES.length, 'every row')
  await waitFor(() => io.observed().includes(rowEl('Hotel')), 'the unread row under the observer')
  assert.ok(io.observed().length === 1 && io.observed()[0] === rowEl('Hotel'), 'only unread rows are observed')
  await waitFor(() => pill('down'), 'the pill at the bottom')
  io.report()
  await settle()
  assert.ok(!(pill('up')), 'nothing unread above')
  assert.match(pill('down').textContent, /More unreads/)
  assert.ok(pill('down').querySelector('svg'), 'with its arrow')
  assert.ok(pill('down').closest('.gbo-roster-scroll') === rosterEl.querySelector('.gbo-roster-scroll'), 'floating over the roster scroll area')
  assert.ok(!scroller().contains(pill('down')), 'outside the scrolled content')

  // #8 Scrolling reads no layout and scans nothing (the observer reports).
  const proto = window.Element.prototype
  const layoutRead = proto.getBoundingClientRect
  let reads = 0
  let scans = 0
  proto.getBoundingClientRect = function () {
    reads += 1
    return layoutRead.call(this)
  }
  const scan = scroller().querySelectorAll.bind(scroller())
  scroller().querySelectorAll = selector => ((scans += 1), scan(selector))
  for (let i = 0; i < 20; i += 1) {
    scroller().scrollTop = i * 3
    scroller().dispatchEvent(new window.Event('scroll'))
  }
  await settle()
  scroller().scrollTop = 0
  assert.deepEqual([reads, scans], [0, 0], 'no rect read and no roster scan while scrolling')
  proto.getBoundingClientRect = layoutRead
  delete scroller().querySelectorAll

  // A key on the focused pill scrolls to it (centred) and moves focus to the row.
  const targets = []
  scroller().scrollTo = ({ top }) => {
    targets.push(top)
    scroller().scrollTop = top
  }
  const focusCalls = []
  const focus = window.HTMLElement.prototype.focus
  window.HTMLElement.prototype.focus = function (options) {
    focusCalls.push([this, options])
    return focus.call(this, options)
  }
  t.after(() => (window.HTMLElement.prototype.focus = focus))
  pill('down').focus()
  pill('down').click()
  assert.deepEqual(targets, [7 * ROW_H - (VIEW_H - ROW_H) / 2], 'scrolled to the nearest unread row, centred')
  const hotelButton = rowEl('Hotel').querySelector('button.gbo-row')
  assert.ok(Boolean(hotelButton) && rosterEl.ownerDocument.activeElement === hotelButton, 'focus lands on the destination row')
  assert.ok(focusCalls.at(-1)?.[0] === hotelButton, 'focused the row')
  assert.deepEqual(focusCalls.at(-1)?.[1], { preventScroll: true }, 'without a second scroll')
  io.report()
  await waitFor(() => !pill('down'), 'the pill gone once the row is in view')
  assert.ok(!(pill('up')))

  // Scrolled further down, an unread row above the view puts the pill on top.
  setUnread('alpha', true)
  await waitFor(() => io.observed().includes(rowEl('Alpha')), 'a second unread row observed')
  scroller().scrollTop = 6 * ROW_H
  io.report()
  await waitFor(() => pill('up'), 'the pill at the top')
  assert.match(pill('up').textContent, /More unreads/)
  pill('up').click()
  assert.equal(targets.at(-1), 0, 'up to the unread row above (clamped at the top)')
  io.report()
  await waitFor(() => !pill('up'), 'gone again')

  // A row whose dot clears is no longer watched: nothing off screen, no pill.
  scroller().scrollTop = 6 * ROW_H
  io.report()
  await waitFor(() => pill('up'), 'the pill for Alpha')
  setUnread('alpha', false)
  await waitFor(() => !pill('up'), 'read: the pill goes')
  assert.ok(!io.observed().includes(rowEl('Alpha')))

  // Hotel a third in view at the bottom (scrollTop 140: y 280-340).
  scroller().scrollTop = 140
  io.report()
  await waitFor(() => pill('down'), 'the pill for a row less than half in view')
  pill('down').click()
  assert.equal(targets.at(-1), 140 + 280 - (VIEW_H - ROW_H) / 2, 'its pill reaches it')
  io.report()
  await waitFor(() => !pill('down'), 'in view')

  // a jump far below puts Hotel above the view (a crossing: reported)...
  scroller().scrollTop = 1000
  io.report()
  await waitFor(() => pill('up'), 'the pill on top')
  // ...and a jump back to the top puts it below without any crossing: the
  // observer says nothing, the scroll itself must turn the pill.
  scroller().scrollTop = 0
  io.report()
  scroller().dispatchEvent(new window.Event('scroll'))
  await waitFor(() => pill('down') && !pill('up'), 'the pill turned with the jump')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
