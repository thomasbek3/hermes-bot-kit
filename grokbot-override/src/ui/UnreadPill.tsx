// "More unreads" (Grok Bot's roster pill): a floating blue pill over the
// roster's scroll area while an unread row is scrolled out of view above it
// (at the top, arrow up) or below it (at the bottom, arrow down); a click
// scrolls to the nearest such row.
//
// Which rows are unread is read from what the roster draws (Unread.tsx:
// Hermes's own dot in its unread state), so the pill and the dots can never
// disagree and Hermes's store stays the only record. A MutationObserver keeps
// the membership (rows whose dot appears or clears, rows re-ordered); an
// IntersectionObserver (root: the scroller) reports each one crossing in or
// out of view, with its rect, from which the row's offset in the list is
// kept. One rule decides "out of view" everywhere: less than half of the row
// shows (core/unreadPill.js sideOf), for the pill and for its target alike.
// A jump past the view crosses no threshold, so the observer stays silent:
// a scroll re-sides the out-of-view rows from their kept offsets and the
// scroller's scrollTop (no layout read, no scan). The nearest row is worked
// out only when the pill is used, which also moves focus to that row.

import * as React from 'react'

import { IN_VIEW_RATIO, nearestUnread, scrollTopFor, sideOf } from '../core/unreadPill.js'
import { IconArrowUp } from './icons'
import { UNREAD_DOT_SELECTOR } from './Unread'

/** The element of one bot in the roster list (a row, or a pinned tile). */
const ITEM_SELECTOR = '.gbo-row-wrap, .gbo-pin-wrap'
/** Its focusable button. */
const ITEM_BUTTON = 'button.gbo-row, button.gbo-pin'

type Sides = { up: boolean; down: boolean }
type Direction = 'up' | 'down'
type Watch = { side: null | Direction; offset: null | number; height: number }

/** Which side an observer entry lies on when it is out of view (null: in view). */
export function entrySide(entry: any): null | Direction {
  return sideOf(entry?.boundingClientRect, entry?.rootBounds) as null | Direction
}

export function useUnreadPill(scrollerRef: React.MutableRefObject<any>) {
  const [sides, setSides] = React.useState<Sides>({ up: false, down: false })
  const jumpRef = React.useRef<null | ((direction: Direction) => void)>(null)

  React.useEffect(() => {
    const scroller: HTMLElement | null = scrollerRef.current
    const IO = (globalThis as any).IntersectionObserver
    const MO = (globalThis as any).MutationObserver
    if (!scroller || typeof IO !== 'function' || typeof MO !== 'function') return undefined
    const raf = (globalThis as any).requestAnimationFrame
    const caf = (globalThis as any).cancelAnimationFrame
    // Unread rows under watch: their side (null: in view) and kept offset.
    const watched = new Map<Element, Watch>()
    let viewHeight = 0
    let collectFrame: any = null
    let scrollFrame: any = null
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

    const io = new IO(
      (entries: any[]) => {
        if (!alive) return
        const top = scroller.scrollTop
        for (const entry of entries) {
          const watch = watched.get(entry.target)
          if (!watch) continue
          const rect = entry.boundingClientRect
          const root = entry.rootBounds
          watch.side = entrySide(entry)
          if (rect && root) {
            watch.offset = rect.top - root.top + top
            watch.height = rect.bottom - rect.top
            viewHeight = root.bottom - root.top
          }
        }
        publish()
      },
      { root: scroller, threshold: [0, IN_VIEW_RATIO, 1] }
    )

    // Membership, on DOM changes only (coalesced to one pass per frame).
    function collect() {
      collectFrame = null
      if (!alive) return
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
      for (const el of rows) {
        // Re-observed on every change: a re-ordered row reports afresh.
        if (watched.has(el)) io.unobserve(el)
        else watched.set(el, { side: null, offset: null, height: 0 })
        io.observe(el)
      }
      publish()
    }

    // A scroll re-sides the out-of-view rows from their kept offsets.
    function reside() {
      scrollFrame = null
      if (!alive || !(viewHeight > 0)) return
      const top = scroller!.scrollTop
      let changed = false
      for (const watch of watched.values()) {
        if (watch.side === null || watch.offset === null) continue
        const side = sideOf({ top: watch.offset - top, bottom: watch.offset - top + watch.height }, { top: 0, bottom: viewHeight }) as null | Direction
        // In view by the kept offset: the observer reports the crossing.
        if (side && side !== watch.side) {
          watch.side = side
          changed = true
        }
      }
      if (changed) publish()
    }

    const frameOf = (fn: () => void) => (typeof raf === 'function' ? raf(fn) : (fn(), null))
    function schedule() {
      if (!alive || collectFrame !== null) return
      collectFrame = frameOf(collect)
    }
    function onScroll() {
      if (!alive || scrollFrame !== null) return
      scrollFrame = frameOf(reside)
    }

    const mo = new MO(schedule)
    mo.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'role'] })
    scroller.addEventListener('scroll', onScroll, { passive: true })
    collect()

    jumpRef.current = (direction: Direction) => {
      const box = scroller.getBoundingClientRect()
      const candidates = [...watched].filter(([, watch]) => watch.side === direction).map(([el]) => ({ el, rect: el.getBoundingClientRect() }))
      const target = nearestUnread(direction, candidates, box)
      if (!target) return
      const top = scrollTopFor(target.rect, box, scroller.scrollTop)
      if (typeof (scroller as any).scrollTo === 'function') (scroller as any).scrollTo({ top, behavior: 'smooth' })
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
