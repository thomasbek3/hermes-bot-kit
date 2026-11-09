// A scroll area whose scrollbar takes no layout width: the native bar is
// hidden, and a thin thumb floats over the content's right edge, shown only
// while the pointer is over the area (or the thumb is being dragged). Used by
// the roster list, the transcript and the profile panel.

import * as React from 'react'

const MIN_THUMB_PX = 28

/** Thumb geometry for a scroller, or null when nothing overflows. */
export function thumbGeometry(scrollTop: number, scrollHeight: number, clientHeight: number) {
  if (!(clientHeight > 0) || scrollHeight <= clientHeight + 1) return null
  const size = Math.max(MIN_THUMB_PX, Math.round((clientHeight * clientHeight) / scrollHeight))
  const travel = clientHeight - size
  const range = scrollHeight - clientHeight
  const offset = range > 0 ? Math.round((Math.min(Math.max(scrollTop, 0), range) / range) * travel) : 0
  return { size, offset, travel, range }
}

type Props = Omit<React.HTMLAttributes<HTMLElement>, 'ref'> & {
  /** The scroller's own element: `div` by default, `aside` for the panel. */
  as?: 'div' | 'aside'
  /** Extra class on the positioned wrapper. */
  wrapClassName?: string
  /** Receives the scroller element (the Transcript's stick-to-bottom ref). */
  scrollRef?: React.MutableRefObject<any>
}

export function OverlayScroll({ as = 'div', wrapClassName, scrollRef, className, onScroll, children, ...rest }: Props) {
  const scroller = React.useRef<HTMLElement | null>(null)
  const thumb = React.useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = React.useState(false)

  const update = React.useCallback(() => {
    const el = scroller.current
    const bar = thumb.current
    if (!el || !bar) return
    const geo = thumbGeometry(el.scrollTop, el.scrollHeight, el.clientHeight)
    if (!geo) {
      bar.dataset.scrollable = 'false'
      return
    }
    bar.dataset.scrollable = 'true'
    bar.style.height = `${geo.size}px`
    bar.style.transform = `translateY(${el.offsetTop + geo.offset}px)`
  }, [])

  React.useLayoutEffect(() => {
    update()
    const el = scroller.current
    const RO = (globalThis as any).ResizeObserver
    if (!el || typeof RO !== 'function') return undefined
    const observer = new RO(update)
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(update) : null
    mo?.observe(el, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      mo?.disconnect()
    }
  }, [update])

  const setScroller = (el: HTMLElement | null) => {
    scroller.current = el
    if (scrollRef) scrollRef.current = el
  }

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = scroller.current
    if (!el || event.button !== 0) return
    const geo = thumbGeometry(el.scrollTop, el.scrollHeight, el.clientHeight)
    if (!geo || geo.travel <= 0) return
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget
    const startY = event.clientY
    const startTop = el.scrollTop
    const perPx = geo.range / geo.travel
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      /* capture is a nicety */
    }
    setDragging(true)
    const move = (e: PointerEvent) => {
      el.scrollTop = startTop + (e.clientY - startY) * perPx
    }
    const end = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      setDragging(false)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }

  return (
    <div className={`gbo-oscroll${wrapClassName ? ` ${wrapClassName}` : ''}${dragging ? ' is-dragging' : ''}`}>
      {React.createElement(
        as,
        {
          ...rest,
          className: `gbo-oscroll-view${className ? ` ${className}` : ''}`,
          ref: setScroller,
          onScroll: (event: React.UIEvent<HTMLElement>) => {
            update()
            onScroll?.(event)
          }
        },
        children
      )}
      <div className="gbo-oscroll-thumb" ref={thumb} data-scrollable="false" aria-hidden="true" onPointerDown={startDrag} />
    </div>
  )
}
