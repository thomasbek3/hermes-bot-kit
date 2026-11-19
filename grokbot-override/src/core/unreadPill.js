// "More unreads" (Grok Bot's roster pill): which way an unread row lies out
// of view, and where to scroll to reach the nearest one. Pure geometry; the
// roster's UnreadPill.tsx feeds it the unread rows an IntersectionObserver
// reports out of view, with their rects and the scroller's.

/** A row counts as in view when at least half of it shows: the one rule
 *  for showing the pill and for picking its target. */
export const IN_VIEW_RATIO = 0.5

/** Where a rect lies against the view: null while at least half of it is in
 *  view, else 'up' or 'down' by the side its middle is on. */
export function sideOf(rect, view) {
  if (!rect || !view) return null
  const height = rect.bottom - rect.top
  const overlap = Math.max(0, Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top))
  if (height > 0 ? overlap / height >= IN_VIEW_RATIO : overlap > 0) return null
  return (rect.top + rect.bottom) / 2 < (view.top + view.bottom) / 2 ? 'up' : 'down'
}

/** `{ up, down }`: is there an out-of-view unread row above / below?
 *  `items` are `{ rect }` of the rows reported out of view. */
export function pillSides(items, view) {
  let up = false
  let down = false
  for (const item of Array.isArray(items) ? items : []) {
    const side = sideOf(item?.rect, view)
    if (side === 'up') up = true
    else if (side === 'down') down = true
  }
  return { up, down }
}

/** The out-of-view unread row nearest the view in `direction`, or null. */
export function nearestUnread(direction, items, view) {
  let best = null
  for (const item of Array.isArray(items) ? items : []) {
    if (sideOf(item?.rect, view) !== direction) continue
    if (!best) best = item
    else if (direction === 'up' ? item.rect.bottom > best.rect.bottom : item.rect.top < best.rect.top) best = item
  }
  return best
}

/** The scrollTop that centres `rect` in the view (never below 0). */
export function scrollTopFor(rect, view, scrollTop) {
  const viewHeight = Math.max(0, view.bottom - view.top)
  const height = Math.max(0, rect.bottom - rect.top)
  const target = scrollTop + (rect.top - view.top) - Math.max(0, (viewHeight - height) / 2)
  return Math.max(0, Math.round(target))
}
