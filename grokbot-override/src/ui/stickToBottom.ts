// Stick-to-bottom for the transcript. The view follows new messages while the
// reader is at the bottom, and keeps following when content grows after it
// rendered (an image decodes, a card or preview frame sizes itself, a code
// block lays out): OverlayScroll reports every content resize and a pinned
// view goes back to the bottom before paint. Once the reader scrolls up
// nothing moves them until they come back down, send a message, or press the
// jump-to-latest button, which shows when a newer message arrives while they
// are away. "Show earlier messages" keeps their place: the distance from the
// bottom is recorded before the older page loads and restored after it lands.

import * as React from 'react'

/** How close to the bottom still counts as "at the bottom" (CSS px). Small on
 *  purpose: a reader a few lines up is reading, and a transcript update must
 *  not pull them down (it was 80px, three lines). */
export const STICK_PX = 16

const fromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

/** `dep`: what changes when the transcript changes (its items). `mine`: the id
 *  of the reader's newest message (a new one pins). `latest`: the id of the
 *  newest message (a change while away shows the jump button). */
export function useStickToBottom(dep: unknown, mine: string, latest = '') {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const stick = React.useRef(true)
  const lastMine = React.useRef(mine)
  const lastLatest = React.useRef(latest)
  // Distance from the scroll top to the content end, recorded before an older
  // page is prepended; null when nothing is being restored.
  const keep = React.useRef<number | null>(null)
  const [unseen, setUnseen] = React.useState(false)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (mine !== lastMine.current) {
      lastMine.current = mine
      if (mine) stick.current = true
    }
    const newer = latest !== lastLatest.current
    lastLatest.current = latest
    if (!el) return
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current
      return
    }
    if (stick.current) el.scrollTop = el.scrollHeight
    else if (newer && latest) setUnseen(true)
  }, [dep, mine, latest])

  React.useLayoutEffect(() => {
    if (stick.current && unseen) setUnseen(false)
  })

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    stick.current = fromBottom(el) < STICK_PX
    if (stick.current) setUnseen(false)
  }

  /** Content grew or shrank after it rendered: a pinned view stays pinned. */
  const onContentResize = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    if (keep.current !== null) el.scrollTop = el.scrollHeight - keep.current
    else if (stick.current) el.scrollTop = el.scrollHeight
  }, [])

  const pin = () => {
    stick.current = true
  }

  /** Run `load` (it prepends older rows) keeping what the reader sees in
   *  place: the first message they could see stays at the same offset. */
  const keepPlace = async (load: () => Promise<unknown> | unknown) => {
    const el = ref.current
    if (el) keep.current = el.scrollHeight - el.scrollTop
    try {
      await load()
    } finally {
      const restore = () => {
        const target = ref.current
        if (target && keep.current !== null) target.scrollTop = target.scrollHeight - keep.current
      }
      restore()
      // The store's update may commit after this await resolves: keep the
      // anchor one more frame so the layout effect of that commit restores
      // it too, then let go.
      const done = () => {
        restore()
        keep.current = null
        const target = ref.current
        if (target) stick.current = fromBottom(target) < STICK_PX
      }
      const raf = (globalThis as any).requestAnimationFrame
      if (typeof raf === 'function') raf(() => done())
      else setTimeout(done, 16)
    }
  }

  /** The jump button: scroll smoothly to the newest message and pin. */
  const jump = () => {
    const el = ref.current
    stick.current = true
    setUnseen(false)
    if (!el) return
    const top = el.scrollHeight
    try {
      if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'smooth' })
      else el.scrollTop = top
    } catch {
      el.scrollTop = top
    }
  }

  return { ref, onScroll, onContentResize, pin, stick, keepPlace, jump, unseen }
}
