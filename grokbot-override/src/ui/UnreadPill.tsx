// "More unreads" (Grok Bot's roster pill): a floating blue pill over the
// roster's scroll area while an unread row is scrolled out of view above it
// (at the top, arrow up) or below it (at the bottom, arrow down); a click
// scrolls to the nearest such row.
//
// Which rows are unread is read from what the roster draws (Unread.tsx:
// Hermes's own dot in its unread state), so the pill and the dots can never
// disagree and Hermes's store stays the only record.
//
// Geometry: each unread row's offset in the list and its height, and the
// view's height, are measured together in one synchronous read (the row's
// rect, the scroller's rect and its scrollTop at the same moment), only when
// the structure or the layout changes: a row joins (its dot appears), rows
// are added, removed or moved (MutationObserver, element changes only), or
// the scroller is resized (ResizeObserver). Which side a row lies on is then
// worked out from those offsets and the CURRENT scrollTop, with one rule
// (core/unreadPill.js sideOf: less than half in view is out of view) for
// showing the pill and for picking its target. An IntersectionObserver entry
// is only a cue to re-side, never a source of geometry, so an entry
// computed before a scroll jump cannot misplace a row; a scroll re-sides
// too (a jump past the view crosses no threshold). Scrolling reads no
// layout and scans nothing. Ordinary state changes (a row selected, a
// preview's text) re-register nothing. The nearest row is resolved only
// when the pill is used: it scrolls there (instantly with Reduce Motion)
// and moves focus to that row.

import * as React from 'react'

import { IN_VIEW_RATIO, nearestUnread, scrollTopFor, sideOf } from '../core/unreadPill.js'
import { IconArrowUp } from './icons'
import { reducedMotion } from './stickToBottom'
import { UNREAD_DOT_SELECTOR } from './Unread'

/** The element of one bot in the roster list (a row, or a pinned tile). */
const ITEM_SELECTOR = '.gbo-row-wrap, .gbo-pin-wrap'
/** Its focusable button. */
const ITEM_BUTTON = 'button.gbo-row, button.gbo-pin'

type Sides = { up: boolean; down: boolean }
type Direction = 'up' | 'down'
type Watch = { side: null | Direction; offset: null | number; height: number }

/** Whether a mutation record can change which rows are unread: a node
 *  added or removed (not just text), or an attribute inside an unread dot. */
function touchesMembership(record: any) {
  if (record.type === 'childList') return elementsIn(record)
  const target = record.target
  return Boolean(target && typeof target.closest === 'function' && target.closest('.gbo-unread-dot'))
}

/** A childList record that adds or removes elements (a structure change). */
function elementsIn(record: any) {
  if (record.type !== 'childList') return false
  for (const node of [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])] as any[]) if (node?.nodeType === 1) return true
  return false
}

export function useUnreadPill(scrollerRef: React.MutableRefObject<any>) {
  const [sides, setSides] = React.useState<Sides>({ up: false, down: false })
  const jumpRef = React.useRef<null | ((direction: Direction) => void)>(null)

  React.useEffect(() => {
    const scroller: HTMLElement | null = scrollerRef.current
    const IO = (globalThis as any).IntersectionObserver
    const MO = (globalThis as any).MutationObserver
    const RO = (globalThis as any).ResizeObserver
    if (!scroller || typeof IO !== 'function' || typeof MO !== 'function') return undefined
    const raf = (globalThis as any).requestAnimationFrame
    const caf = (globalThis as any).cancelAnimationFrame
    // Unread rows under watch: their side (null: in view) and measured offset.
    const watched = new Map<Element, Watch>()
    let viewHeight = 0
    let collectFrame: any = null
    let scrollFrame: any = null
    let pendingStructure = false
    let alive = true

    const publish = () => {
      let up = false
      let down = false
      for (const watch of watched.values()) {
        if (watch.side === 'up') up = true
        else if (watch.side === 'down') down = true
      }
      setSides(prev => (prev.up === up && prev.down === down ? prev : { up, down }))
    }

    /** One synchronous read: the scroller's box and scrollTop and each
     *  given row's rect, so offsets and the view height belong together. */
    function measure(rows: Iterable<Element>) {
      const box = scroller!.getBoundingClientRect()
      const top = scroller!.scrollTop
      viewHeight = Math.max(0, box.bottom - box.top)
      for (const el of rows) {
        const watch = watched.get(el)
        if (!watch) continue
        const rect = el.getBoundingClientRect()
        watch.offset = rect.top - box.top + top
        watch.height = Math.max(0, rect.bottom - rect.top)
      }
    }

    /** Sides from the measured offsets and the current scrollTop. */
    function reside() {
      scrollFrame = null
      if (!alive) return
      const top = scroller!.scrollTop
      const view = { top: 0, bottom: viewHeight }
      for (const watch of watched.values()) {
        watch.side = viewHeight > 0 && watch.offset !== null ? (sideOf({ top: watch.offset - top, bottom: watch.offset - top + watch.height }, view) as null | Direction) : null
      }
      publish()
    }

    // The observer: a cue that something crossed in or out of view.
    const io = new IO(
      (entries: any[]) => {
        if (alive && entries.some(entry => watched.has(entry.target))) reside()
      },
      { root: scroller, threshold: [0, IN_VIEW_RATIO, 1] }
    )

    // Membership and measurements, on relevant DOM changes only.
    function collect() {
      collectFrame = null
      if (!alive) return
      const structure = pendingStructure
      pendingStructure = false
      const rows = new Set<Element>()
      for (const dot of Array.from(scroller!.querySelectorAll(UNREAD_DOT_SELECTOR))) {
        const row = dot.closest(ITEM_SELECTOR)
        if (row && scroller!.contains(row)) rows.add(row)
      }
      for (const el of [...watched.keys()]) {
        if (rows.has(el)) continue
        io.unobserve(el)
        watched.delete(el)
      }
      const joined: Element[] = []
      for (const el of rows) {
        if (watched.has(el)) continue
        watched.set(el, { side: null, offset: null, height: 0 })
        io.observe(el)
        joined.push(el)
      }
      // Rows moved (a structure change): every offset is measured again;
      // otherwise only the rows that joined.
      measure(structure ? watched.keys() : joined)
      reside()
    }

    const frameOf = (fn: () => void) => (typeof raf === 'function' ? raf(fn) : (fn(), null))
    function schedule(structure: boolean) {
      if (!alive) return
      if (structure) pendingStructure = true
      if (collectFrame === null) collectFrame = frameOf(collect)
    }
    function onScroll() {
      if (!alive || scrollFrame !== null) return
      scrollFrame = frameOf(reside)
    }

    const mo = new MO((records: any[]) => {
      if (records.some(touchesMembership)) schedule(records.some(elementsIn))
    })
    mo.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'role'] })
    // A resize changes the view's height and the rows' offsets.
    const ro = typeof RO === 'function' ? new RO(() => schedule(true)) : null
    ro?.observe(scroller)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    pendingStructure = true
    collect()

    jumpRef.current = (direction: Direction) => {
      const box = scroller.getBoundingClientRect()
      const candidates = [...watched].filter(([, watch]) => watch.side === direction).map(([el]) => ({ el, rect: el.getBoundingClientRect() }))
      const target = nearestUnread(direction, candidates, box)
      if (!target) return
      const top = scrollTopFor(target.rect, box, scroller.scrollTop)
      if (typeof (scroller as any).scrollTo === 'function') (scroller as any).scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' })
      else scroller.scrollTop = top
      // The pill goes away once the row shows: focus moves to the row.
      const button = target.el.querySelector(ITEM_BUTTON) as HTMLElement | null
      try {
        button?.focus({ preventScroll: true })
      } catch {
        button?.focus()
      }
    }

    return () => {
      alive = false
      jumpRef.current = null
      if (typeof caf === 'function') {
        if (collectFrame !== null) caf(collectFrame)
        if (scrollFrame !== null) caf(scrollFrame)
      }
      io.disconnect()
      mo.disconnect()
      ro?.disconnect()
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [scrollerRef])

  const jump = React.useCallback((direction: Direction) => jumpRef.current?.(direction), [])
  return { sides, jump }
}

export function UnreadPills({ sides, jump }: { sides: Sides; jump: (direction: Direction) => void }) {
  return (
    <>
      {sides.up ? (
        <button type="button" className="gbo-unread-pill is-up" aria-label="More unreads above" onClick={() => jump('up')}>
          <IconArrowUp />
          More unreads
        </button>
      ) : null}
      {sides.down ? (
        <button type="button" className="gbo-unread-pill is-down" aria-label="More unreads below" onClick={() => jump('down')}>
          <span className="gbo-unread-pill-down" aria-hidden="true">
            <IconArrowUp />
          </span>
          More unreads
        </button>
      ) : null}
    </>
  )
}
