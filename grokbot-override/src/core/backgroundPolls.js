// Background polls, kept light on a struggling gateway.
//
// A remote gateway serves the Desktop's RPC from a small thread pool; a roster
// that re-reads every profile's sessions every few seconds, plus the group
// list and the open chats' tails, can keep that pool saturated on a machine
// with large session stores (and then the user's own "open this chat" waits
// behind the plugin's polls). So every BACKGROUND poll goes through here:
//
// - Lanes, one per connection (gateway route). A run claims its own lane plus
//   any other lanes its work touches (`lanes`: the union roster read touches
//   every non-SSH source), all or nothing; a run whose lanes are not all free
//   is skipped and tried again on a later tick. So two background polls never
//   run at once on one connection.
// - A deadline: a run older than POLL_DEADLINE_MS no longer holds its lanes
//   (the next claim retires it and backs that poll off), and its `live()`
//   turns false, so a late answer is discarded by the caller, never applied.
// - Each (connection, poll type) has its own interval: the base cadence while
//   calls are fast; doubled (capped at POLL_BACKOFF_MAX_MS) after a run that
//   failed (threw or returned false) or took longer than SLOW_POLL_MS; back to
//   the base after a fast success.
// - Nothing starts while the window is hidden. `resume()` (the window is
//   visible again) and `want(lane, type)` (activity on the open chat) mark a
//   poll due once regardless of its backoff: it runs at the next chance its
//   lanes are free, but never sooner than `resumeMinMs` after its last run
//   (the full roster read keeps its 60 s minimum).
// - `reset()` (the plugin is switched off or stopped) retires every run: their
//   `live()` turns false and their lanes are free.
//
// FOREGROUND calls (switch bot, open a chat, send, a write and its roster
// re-read, creating or disbanding a room) never go through this module: they
// are never queued, delayed or skipped by it.

export const SLOW_POLL_MS = 2_000
export const POLL_BACKOFF_MAX_MS = 5 * 60_000
export const POLL_DEADLINE_MS = 30_000

/**
 * deps: { now(): number, isVisible(): boolean }
 *
 * run(lane, type, baseMs, fn, { force, lanes, resumeMinMs })
 *   -> Promise<{ ran, ok?, slow?, stale?, hidden?, busy?, nextMs }>
 *   `fn(live)` does the work; it reports a failure by throwing or resolving
 *   `false`, and applies its result only while `live()` is true.
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
  let generation = 0
  // lane id -> the run holding it
  const owners = new Map()
  // `${lane}\n${type}` -> { base, interval, last, resume }
  const polls = new Map()

  const laneId = key => String(key || 'local')

  function pollOf(key, type, baseMs) {
    const id = `${laneId(key)}\n${type}`
    let poll = polls.get(id)
    if (!poll) {
      poll = { base: 0, interval: 0, last: -Infinity, resume: false }
      polls.set(id, poll)
    }
    if (baseMs !== undefined) {
      const base = Math.max(0, Number(baseMs) || 0)
      if (poll.base !== base) {
        poll.base = base
        if (poll.interval < base) poll.interval = base
      }
    }
    return poll
  }

  const backoff = poll => Math.min(Math.max(poll.interval, poll.base, 1) * 2, POLL_BACKOFF_MAX_MS)
  const expired = run => now() - run.start >= POLL_DEADLINE_MS
  const isLive = run => !run.done && !run.retired && run.generation === generation && !expired(run)

  function retire(run) {
    if (run.retired || run.done) return
    run.retired = true
    run.poll.interval = backoff(run.poll)
    for (const id of run.lanes) if (owners.get(id) === run) owners.delete(id)
  }

  /** The run holding a lane, after retiring one past its deadline. */
  function holder(id) {
    const run = owners.get(id)
    if (!run) return null
    if (run.generation !== generation) {
      owners.delete(id)
      return null
    }
    if (expired(run)) {
      retire(run)
      return null
    }
    return run
  }

  function waitOf(poll, resumeMinMs = 0) {
    const gap = poll.resume ? Math.max(0, Number(resumeMinMs) || 0) : poll.interval
    return Math.max(0, poll.last + gap - now())
  }

  async function run(key, type, baseMs, fn, { force = false, lanes = [], resumeMinMs = 0 } = {}) {
    const main = laneId(key)
    const ids = [...new Set([main, ...lanes.map(laneId)])]
    const poll = pollOf(main, type, baseMs)
    if (!visible()) return { ran: false, hidden: true, nextMs: waitOf(poll, resumeMinMs) }
    if (ids.some(id => holder(id))) return { ran: false, busy: true, nextMs: Math.max(1, Math.min(poll.interval, poll.base)) }
    const wait = waitOf(poll, resumeMinMs)
    if (!force && wait > 0) return { ran: false, nextMs: wait }
    // Claimed synchronously, before the first await: a second run() in the
    // same tick sees the lanes busy.
    const job = { type, poll, lanes: ids, start: now(), generation, done: false, retired: false }
    for (const id of ids) owners.set(id, job)
    poll.last = job.start
    poll.resume = false
    let ok = true
    try {
      ok = (await fn(() => isLive(job))) !== false
    } catch {
      ok = false
    }
    const stale = !isLive(job)
    for (const id of ids) if (owners.get(id) === job) owners.delete(id)
    if (stale) {
      // Past its deadline (backed off once, here or when it was retired) or
      // from before a reset: nothing it read was applied.
      if (!job.retired && job.generation === generation) poll.interval = backoff(poll)
      job.done = true
      return { ran: true, ok: false, stale: true, nextMs: poll.interval }
    }
    job.done = true
    const slow = now() - job.start > SLOW_POLL_MS
    poll.interval = ok && !slow ? poll.base : backoff(poll)
    return { ran: true, ok, slow, nextMs: poll.interval }
  }

  /** The window is visible again: every poll is due once, backoff aside. */
  function resume() {
    for (const poll of polls.values()) poll.resume = true
  }

  /** One poll is due once, backoff aside (e.g. activity on the open chat). */
  function want(key, type) {
    pollOf(key, type).resume = true
  }

  /** Retire every run and forget every cadence (the plugin was switched off). */
  function reset() {
    generation += 1
    owners.clear()
    polls.clear()
  }

  function due(key, type, baseMs, { lanes = [], resumeMinMs = 0 } = {}) {
    const ids = [laneId(key), ...lanes.map(laneId)]
    return visible() && !ids.some(id => holder(id)) && waitOf(pollOf(key, type, baseMs), resumeMinMs) === 0
  }

  /** The poll's current interval (the base, or its backed-off value). */
  function interval(key, type, baseMs) {
    return pollOf(key, type, baseMs).interval
  }

  /** The type of the run holding a lane ('' = free). */
  function busy(key) {
    return holder(laneId(key))?.type || ''
  }

  return { run, resume, want, reset, due, interval, busy }
}

/** One idle-refresh pass on a connection: every chat's tail in turn, so
 *  side-by-side chats all stay current (a streaming chat skips its own read,
 *  never the others'). Stops when `live()` or `isVisible()` turns false.
 *  False when any read failed (the pass backs off). */
export async function refreshInTurn(chats, live, isVisible = () => true) {
  let ok = true
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!live() || !isVisible()) break
    if ((await chat.idleRefresh(live)) === false) ok = false
  }
  return ok
}
