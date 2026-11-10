// The "NEW" line in the open Bot Chat: a thin red rule with a small "NEW"
// label, directly above the first bot message the user has not seen.
//
// What "seen" means: the override keeps, per bot (roster rowKey), the time of
// the newest transcript item that was on screen while the user was looking:
// window focused and visible, the chat open, the transcript scrolled to its
// bottom (plugin storage key `seenAt`). It is the same signal that clears
// the row's unread dot (Unread.tsx: core's unread store, acked when the chat
// opens); that store keeps no message position, so the position is kept here.
//
// The line is decided when the chat is opened (or becomes active) with its
// history loaded, and then stays put while the chat stays open, even after the
// messages are read. Bot messages that arrive while the user is looking move
// the watermark at once and so never start a line. A bot never seen before
// has no watermark: the first sight seeds it, so a fresh install draws no
// line on every chat. The line only goes above a bot reply that comes after
// the user's own last message (an answer to what they just sent is not news
// above their own words), and above the time divider that starts that reply.

export const SEEN_KEY = 'seenAt'
export const MAX_SEEN = 200

/** The stored watermarks read back: key -> positive finite ms. */
export function seenFrom(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, at] of Object.entries(value)) {
    if (typeof key === 'string' && key && typeof at === 'number' && Number.isFinite(at) && at > 0) out[key] = at
  }
  return out
}

/** `seen` with `key` raised to `at` (never lowered), bounded to MAX_SEEN
 *  entries (the oldest watermarks dropped first). Returns `seen` itself when
 *  nothing changes. */
export function raiseSeen(seen, key, at) {
  if (!key || !(at > 0) || (seen[key] || 0) >= at) return seen
  const next = { ...seen, [key]: at }
  const keys = Object.keys(next)
  if (keys.length > MAX_SEEN) {
    keys.sort((a, b) => next[a] - next[b])
    for (const drop of keys.slice(0, keys.length - MAX_SEEN)) if (drop !== key) delete next[drop]
  }
  return next
}

/** The newest item time in the transcript (0 if none carries one). */
export function newestAt(items) {
  let max = 0
  for (const item of items || []) {
    const at = Number(item?.at || 0)
    if (at > max) max = at
  }
  return max
}

/** The id of the first unseen bot message after the user's own last message,
 *  or null. `seenAt` undefined (never seen): null. */
export function firstUnreadId(items, seenAt) {
  if (!(typeof seenAt === 'number' && Number.isFinite(seenAt))) return null
  const list = Array.isArray(items) ? items : []
  let start = 0
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.kind === 'user') {
      start = i + 1
      break
    }
  }
  for (let i = start; i < list.length; i += 1) {
    const item = list[i]
    if (item?.kind === 'assistant' && !item.streaming && Number(item.at || 0) > seenAt) return String(item.id)
  }
  return null
}

/** Rows (withDividers output) with the NEW marker `{ kind: 'new', id }`
 *  placed above the item `id`, and above the time divider right before it, so
 *  the NEW line comes first and the time line second. Unchanged when `id` is
 *  null or not among the rows. */
export function withNewMarker(rows, id) {
  if (!id) return rows
  const at = rows.findIndex(row => row?.kind !== 'divider' && String(row?.id) === String(id))
  if (at < 0) return rows
  const before = at > 0 && rows[at - 1]?.kind === 'divider' ? at - 1 : at
  return [...rows.slice(0, before), { kind: 'new', id: `new:${id}` }, ...rows.slice(before)]
}

/**
 * One open chat's marker, step by step (pure; the UI calls it on every
 * transcript change and on focus, visibility and scroll changes).
 *
 * state: { markers: {key: id|null}, seen: {key: ms} } — `markers[key]`
 * undefined means "not decided for this open yet".
 * input: { key, items, ready, looking }.
 * Returns the next state (the same object when nothing changed).
 */
export function stepMarker(state, { key, items, ready, looking }) {
  if (!key || !ready) return state
  let { markers, seen } = state
  const known = Object.prototype.hasOwnProperty.call(seen, key)
  const current = markers[key]
  if (current === undefined || (current === null && !looking)) {
    // Decide at open (from the watermark as it was before this look); while
    // none is shown, a bot message that arrives while the user is not looking
    // starts one. One that arrives while they look never does.
    const id = known ? firstUnreadId(items, seen[key]) : null
    if (id !== current) markers = { ...markers, [key]: id }
  }
  const newest = newestAt(items)
  // First sight seeds the watermark; looking raises it.
  if (!known || looking) seen = raiseSeen(seen, key, newest || (known ? 0 : 1))
  return markers === state.markers && seen === state.seen ? state : { markers, seen }
}

/** Forget the marker for `key` (the chat is opened again: decide afresh). */
export function resetMarker(state, key) {
  if (!key || !Object.prototype.hasOwnProperty.call(state.markers, key)) return state
  const markers = { ...state.markers }
  delete markers[key]
  return { ...state, markers }
}
