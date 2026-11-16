// Background polls, kept light on a struggling gateway.
//
// A remote gateway serves the Desktop's RPC from a small thread pool; a roster
// that re-reads every profile's sessions every few seconds, plus the group
// list and the open chat's tail, can keep that pool saturated on a machine
// with large session stores (and then the user's own "open this chat" waits
// behind the plugin's polls). So every BACKGROUND poll goes through here:
//
// - One lane per connection (gateway route): polls on the same connection
//   never run concurrently with each other; a poll whose lane is busy is
//   skipped and runs on a later tick.
// - Each (connection, poll type) has its own interval: the base cadence while
//   calls are fast; doubled (capped at POLL_BACKOFF_MAX_MS) after a poll that
//   failed or took longer than SLOW_POLL_MS; back to the base after a fast
//   success.
// - Nothing runs while the window is hidden; the caller re-checks on
//   `visibilitychange` -> visible, and whatever came due meanwhile runs then.
//
// FOREGROUND calls (switch bot, open a chat, send, a write and its roster
// re-read) never go through this module: they are never queued, delayed or
// skipped by it.

export const SLOW_POLL_MS = 2_000
export const POLL_BACKOFF_MAX_MS = 5 * 60_000

/**
 * deps: { now(): number, isVisible(): boolean }
 *
 * run(lane, type, baseMs, fn, { force }) -> Promise<{ ran, ok?, slow?, hidden?, busy?, nextMs }>
 *   Runs `fn` when the window is visible, the lane is free and the poll is due
 *   (or `force`, which still respects visibility and the lane). `fn` reports a
 *   failure by throwing or resolving `false`. `nextMs` is how long until this
 *   poll is due again (its current, possibly backed-off, interval after a run).
 */
export function createBackgroundPolls(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const visible = () => {
    try {
      return typeof deps.isVisible === 'function' ? deps.isVisible() !== false : true
    } catch {
      return true
    }
  }
  const lanes = new Map()

  function laneOf(key) {
    const id = String(key || 'local')
    let lane = lanes.get(id)
    if (!lane) {
      lane = { busy: '', polls: new Map() }
      lanes.set(id, lane)
    }
    return lane
  }

  function pollOf(lane, type, baseMs) {
    const base = Math.max(0, Number(baseMs) || 0)
    let poll = lane.polls.get(type)
    if (!poll) {
      poll = { base, interval: base, last: -Infinity }
      lane.polls.set(type, poll)
    }
    if (poll.base !== base) {
      poll.base = base
      if (poll.interval < base) poll.interval = base
    }
    return poll
  }

  /** Milliseconds until the poll is due (0 = due now). */
  function wait(key, type, baseMs) {
    const poll = pollOf(laneOf(key), type, baseMs)
    return Math.max(0, poll.last + poll.interval - now())
  }

  function due(key, type, baseMs) {
    const lane = laneOf(key)
    return visible() && !lane.busy && wait(key, type, baseMs) === 0
  }

  async function run(key, type, baseMs, fn, { force = false } = {}) {
    const lane = laneOf(key)
    const poll = pollOf(lane, type, baseMs)
    if (!visible()) return { ran: false, hidden: true, nextMs: poll.interval }
    if (lane.busy) return { ran: false, busy: true, nextMs: Math.min(poll.interval, Math.max(1, poll.base)) }
    if (!force && wait(key, type, baseMs) > 0) return { ran: false, nextMs: wait(key, type, baseMs) }
    // Claimed synchronously, before the first await: a second run() in the
    // same tick sees the lane busy.
    lane.busy = type
    const start = now()
    poll.last = start
    let ok = true
    try {
      ok = (await fn()) !== false
    } catch {
      ok = false
    } finally {
      lane.busy = ''
    }
    const slow = now() - start > SLOW_POLL_MS
    poll.interval = ok && !slow ? poll.base : Math.min(Math.max(poll.interval, poll.base, 1) * 2, POLL_BACKOFF_MAX_MS)
    return { ran: true, ok, slow, nextMs: poll.interval }
  }

  /** The poll's current interval (the base, or its backed-off value). */
  function interval(key, type, baseMs) {
    return pollOf(laneOf(key), type, baseMs).interval
  }

  function busy(key) {
    return laneOf(key).busy
  }

  return { run, due, wait, interval, busy }
}
