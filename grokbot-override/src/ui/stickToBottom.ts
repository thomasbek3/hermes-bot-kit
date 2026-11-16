// Stick-to-bottom for the transcript. The view follows new messages while the
// reader is at the bottom, and keeps following when content grows after it
// rendered (an image decodes, a card or preview frame sizes itself, a code
// block lays out, the live reply streams): OverlayScroll reports every
// content resize and a pinned view goes back to the bottom before paint.
// Once the reader scrolls up nothing moves them until they come back down,
// send a message, or press the jump-to-latest button, which shows when a
// newer message arrives while they are away. "Show earlier messages" keeps
// their place: a row they can see is recorded with its position in the
// viewport, and only that row's displacement (older rows landing above it)
// is undone; growth below it (a streaming reply) moves nothing.

import * as React from 'react'

/** How close to the bottom still counts as "at the bottom" (CSS px). Small on
 *  purpose: a reader a few lines up is reading, and a transcript update must
 *  not pull them down (it was 80px, three lines). */
export const STICK_PX = 16

/** Longest a jump-to-latest animation may take before it is settled. */
export const JUMP_MAX_MS = 1200

/** Marks each message (a user or bot bubble's root) with its React identity,
 *  so the reader's message is found again when its group is re-created (an
 *  older page can join bubbles at a group's front, which re-keys the group). */
export const ANCHOR_ATTR = 'data-gbo-key'

const fromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

function reducedMotion(): boolean {
  try {
    const mm = (globalThis as any).window?.matchMedia ?? (globalThis as any).matchMedia
    return typeof mm === 'function' && Boolean(mm('(prefers-reduced-motion: reduce)')?.matches)
  } catch {
    return false
  }
}

type Mark = { el: Element; key: string | null; top: number }
/** Every reading unit visible when the older page was asked for, best first:
 *  messages (keyed, found again even when their group is re-created) before
 *  decorative rows (a time divider can vanish when older rows join its time
 *  run). Restoring uses the first one that is still on screen. */
type Anchor = Mark[]

/** The reading units of the transcript: every message inside a group (a
 *  group is one row of the column but can be taller than the viewport and
 *  grow at its end), and every other row of the column (dividers, tool rows,
 *  cards) as itself. The "Show earlier messages" button is no reading place. */
function unitsOf(scroller: HTMLElement): Element[] {
  const column = scroller.firstElementChild
  if (!column) return []
  const out: Element[] = []
  for (const row of Array.from(column.children)) {
    if (row.classList.contains('gbo-more')) continue
    const messages = row.classList.contains('group') ? Array.from(row.children) : []
    if (messages.length) out.push(...messages)
    else out.push(row)
  }
  return out
}

/** The units with any part inside the viewport, each with the distance of
 *  its TOP edge from the viewport top (negative when it starts above). The
 *  top edge, because a unit only ever grows at its end (a streaming reply,
 *  an image decoding): growth there must not move the reader. Keyed
 *  messages come first; null when nothing is visible. */
function captureAnchor(scroller: HTMLElement): Anchor | null {
  const top = scroller.getBoundingClientRect().top
  const view = scroller.clientHeight
  const marks: Mark[] = []
  for (const unit of unitsOf(scroller)) {
    const rect = unit.getBoundingClientRect()
    if (rect.bottom - top <= 0) continue
    if (view > 0 && rect.top - top >= view) break
    marks.push({ el: unit, key: unit.getAttribute(ANCHOR_ATTR), top: rect.top - top })
  }
  if (!marks.length) return null
  return [...marks.filter(m => m.key), ...marks.filter(m => !m.key)]
}

/** The first mark still on screen (the same element, or the message now
 *  carrying its key when its group was re-created) and where its top edge
 *  is now, relative to the viewport top. */
function locate(scroller: HTMLElement, anchor: Anchor): { mark: Mark; now: number } | null {
  const origin = scroller.getBoundingClientRect().top
  let units: Element[] | null = null
  for (const mark of anchor) {
    let unit: Element | null = mark.el.isConnected && scroller.contains(mark.el) ? mark.el : null
    if (!unit && mark.key) {
      units = units || unitsOf(scroller)
      unit = units.find(u => u.getAttribute(ANCHOR_ATTR) === mark.key) || null
    }
    if (unit) return { mark, now: unit.getBoundingClientRect().top - origin }
  }
  return null
}

/** `dep`: what changes when the transcript changes (its items). `mine`: the id
 *  of the reader's newest message (a new one pins). `latest`: the id of the
 *  newest message (a change while away shows the jump button). */
export function useStickToBottom(dep: unknown, mine: string, latest = '') {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const stick = React.useRef(true)
  const lastMine = React.useRef(mine)
  const lastLatest = React.useRef(latest)
  // While an older page loads: the row the reader sees and where. null when
  // nothing is being restored.
  const keep = React.useRef<Anchor | null>(null)
  // Which "Show earlier" load owns `keep`: a send, a jump or a chat switch
  // during the load drops it (bumping this), and the load's completion then
  // neither restores the old place nor overwrites the newer pin.
  const keepGen = React.useRef(0)
  // The scrollTop this hook last set itself: a scroll event elsewhere is the
  // reader moving.
  const wrote = React.useRef<number | null>(null)
  // A jump-to-latest in flight (smooth scrolling): its progress events do not
  // unpin, growth re-targets it, and the reader's own input cancels it.
  const jumping = React.useRef<null | { timer: any }>(null)
  const [unseen, setUnseen] = React.useState(false)

  const setTop = (el: HTMLElement, top: number) => {
    el.scrollTop = top
    wrote.current = el.scrollTop
  }

  /** Put the anchor row back where the reader saw it. */
  const restore = () => {
    const el = ref.current
    const anchor = keep.current
    if (!el || !anchor) return
    const hit = locate(el, anchor)
    if (!hit) return
    const shift = hit.now - hit.mark.top
    if (Math.abs(shift) >= 0.5) setTop(el, el.scrollTop + shift)
  }

  /** A newer intent (a send, a jump, another chat) supersedes the place a
   *  pending older page would restore. */
  const dropKeep = () => {
    if (!keep.current) return
    keep.current = null
    keepGen.current += 1
  }

  const scrollToBottom = (el: HTMLElement, smooth: boolean) => {
    const top = el.scrollHeight
    if (smooth && typeof el.scrollTo === 'function') {
      try {
        el.scrollTo({ top, behavior: 'smooth' })
        return
      } catch {
        /* fall through */
      }
    }
    setTop(el, top)
  }

  /** The time limit: elapsed time is not the reader taking over. Settle at
   *  the current bottom at once and stay pinned (later growth follows). */
  const finishJump = () => {
    const run = jumping.current
    if (!run) return
    jumping.current = null
    clearTimeout(run.timer)
    stick.current = true
    setUnseen(false)
    const el = ref.current
    if (el) setTop(el, el.scrollHeight)
  }

  const endJump = () => {
    const run = jumping.current
    if (!run) return
    jumping.current = null
    clearTimeout(run.timer)
    const el = ref.current
    if (!el) return
    stick.current = fromBottom(el) < STICK_PX
    // Interrupted before the bottom: the newest message is still unseen.
    setUnseen(!stick.current && Boolean(lastLatest.current))
  }

  React.useLayoutEffect(() => {
    const el = ref.current
    if (mine !== lastMine.current) {
      lastMine.current = mine
      if (mine) {
        // Your own new message: follow it, whatever an older page would
        // have restored.
        stick.current = true
        dropKeep()
      }
    }
    const newer = latest !== lastLatest.current
    lastLatest.current = latest
    if (!el) return
    if (keep.current) {
      restore()
      // A message arriving while the older page loads is still news.
      if (newer && latest && !stick.current) setUnseen(true)
      return
    }
    if (jumping.current) scrollToBottom(el, !reducedMotion())
    else if (stick.current) setTop(el, el.scrollHeight)
    else if (newer && latest) setUnseen(true)
  }, [dep, mine, latest])

  React.useLayoutEffect(() => {
    if (stick.current && unseen && !jumping.current) setUnseen(false)
  })

  // The reader's own input ends a jump in flight (they took over).
  React.useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const cancel = () => {
      if (!jumping.current) return
      endJump()
    }
    const onKey = (event: any) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event?.key)) cancel()
    }
    el.addEventListener('wheel', cancel, { passive: true } as any)
    el.addEventListener('touchstart', cancel, { passive: true } as any)
    el.addEventListener('pointerdown', cancel)
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('wheel', cancel)
      el.removeEventListener('touchstart', cancel)
      el.removeEventListener('pointerdown', cancel)
      el.removeEventListener('keydown', onKey)
      if (jumping.current) clearTimeout(jumping.current.timer)
    }
  }, [])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const ours = wrote.current !== null && Math.abs(el.scrollTop - wrote.current) < 1
    wrote.current = null
    if (jumping.current) {
      // Progress of our own animation: stay pinned; arriving ends it.
      if (fromBottom(el) < STICK_PX) endJump()
      return
    }
    if (keep.current && !ours) {
      // The reader moved while the older page loads: keep what they see now.
      keep.current = captureAnchor(el) || keep.current
    }
    stick.current = fromBottom(el) < STICK_PX
    if (stick.current) setUnseen(false)
  }

  /** Content grew or shrank after it rendered: a pinned view stays pinned,
   *  a jump in flight re-targets the new bottom, a loading older page keeps
   *  the reader's row in place. */
  const onContentResize = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    if (keep.current) restore()
    else if (jumping.current) scrollToBottom(el, !reducedMotion())
    else if (stick.current) setTop(el, el.scrollHeight)
  }, [])

  const pin = () => {
    stick.current = true
    dropKeep()
  }

  /** The reader grabbed the overlay scrollbar (OverlayScroll's thumb sits
   *  outside the scroller, so its drag never reaches the listeners above):
   *  a jump in flight ends there. */
  const onReaderInput = () => {
    if (jumping.current) endJump()
  }

  /** Run `load` (it prepends older rows) keeping what the reader sees in
   *  place: the first row they can see stays at the same offset. */
  const keepPlace = async (load: () => Promise<unknown> | unknown) => {
    const el = ref.current
    const gen = (keepGen.current += 1)
    keep.current = el ? captureAnchor(el) : null
    const mineNow = () => keepGen.current === gen && keep.current !== null
    try {
      await load()
    } finally {
      if (mineNow()) restore()
      // The store's update may commit after this await resolves: keep the
      // anchor one more frame so the layout effect of that commit restores
      // it too, then let go.
      const done = () => {
        // Superseded (a send, a jump, another chat): leave its pin alone.
        if (!mineNow()) return
        restore()
        keep.current = null
        const target = ref.current
        if (target) {
          stick.current = fromBottom(target) < STICK_PX
          if (stick.current) setUnseen(false)
        }
      }
      const raf = (globalThis as any).requestAnimationFrame
      if (typeof raf === 'function') raf(() => done())
      else setTimeout(done, 16)
    }
  }

  /** The jump button: scroll to the newest message (smoothly unless the
   *  reader asked for reduced motion) and pin. */
  const jump = () => {
    const el = ref.current
    stick.current = true
    setUnseen(false)
    dropKeep()
    if (!el) return
    const smooth = !reducedMotion() && typeof el.scrollTo === 'function'
    if (jumping.current) clearTimeout(jumping.current.timer)
    jumping.current = smooth ? { timer: setTimeout(finishJump, JUMP_MAX_MS) } : null
    scrollToBottom(el, smooth)
  }

  return { ref, onScroll, onContentResize, onReaderInput, pin, stick, keepPlace, jump, unseen }
}
