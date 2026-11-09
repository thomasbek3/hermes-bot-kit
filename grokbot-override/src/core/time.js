// Time labels: roster ages ("now", "5m", "Yesterday", "Nov 6") and transcript
// dividers ("Today 7:15 PM"). A divider goes above the first item and above
// any item that starts a new day or follows a gap of an hour or more.

export const DIVIDER_GAP_MS = 60 * 60 * 1000

function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "12:46 PM": a bubble's hover time. */
export function clock(ms, locale) {
  return new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

export function dayLabel(ms, nowMs = Date.now(), locale) {
  const days = Math.round((startOfDay(nowMs) - startOfDay(ms)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const d = new Date(ms)
  if (days < 7) return d.toLocaleDateString(locale, { weekday: 'long' })
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear()
  return d.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
}

export function dividerLabel(ms, nowMs = Date.now(), locale) {
  return `${dayLabel(ms, nowMs, locale)} ${clock(ms, locale)}`
}

/** Compact roster age. */
export function shortAge(ms, nowMs = Date.now(), locale) {
  if (!ms) return ''
  const diff = Math.max(0, nowMs - ms)
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (startOfDay(ms) === startOfDay(nowMs)) return clock(ms, locale)
  return dayLabel(ms, nowMs, locale)
}

/** Items interleaved with divider markers `{ kind: 'divider', id, label }`. */
export function withDividers(items, nowMs = Date.now(), locale) {
  const out = []
  let previous = null
  for (const item of items) {
    const at = Number(item?.at || 0)
    if (at > 0 && (previous === null || startOfDay(at) !== startOfDay(previous) || at - previous >= DIVIDER_GAP_MS)) {
      out.push({ kind: 'divider', id: `divider:${item.id}`, label: dividerLabel(at, nowMs, locale) })
    }
    if (at > 0) previous = at
    out.push(item)
  }
  return out
}
