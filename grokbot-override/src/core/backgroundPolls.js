// Background polls, kept light on a struggling gateway.
//
// A remote gateway serves the Desktop's RPC from a small thread pool; a roster
// that re-reads every profile's sessions every few seconds, plus the group
// list and the open chats' tails, can keep that pool saturated on a machine
// with large session stores (and then the user's own "open this chat" waits
// behind the plugin's polls). So every BACKGROUND poll goes through here:
//
// - Lanes, one per connection (gateway route). A run claims its own lane plus
//   any other lanes its work touches, all or nothing; a run whose lanes are
//   not all free is skipped and tried again on a later tick. So two
//   background polls never run at once on one connection. A `global` run (the
//   union roster, which Electron reads from every registered non-SSH
//   connection, including ones the plugin has not seen yet) needs every lane
//   free except the ones it names as untouched, and holds them all, also
//   lanes first used while it runs. Once a global run is due but blocked it
//   holds a reservation: running jobs settle, but no NEW background job
//   starts on a lane it needs until it has run (so staggered per-connection
//   polls can never starve it). Hiding the window or reset() drops the
//   reservation.
// - A deadline: a run older than POLL_DEADLINE_MS stops holding its lanes
//   against OTHER poll types (the next claim retires it and backs it off) and
//   its `live()` turns false, so its late answer is dropped and it starts no
//   further request. The same poll on the same lane is never started again
//   while the old run is unsettled: a plugin cannot cancel a Desktop request,
//   so this relies on the Desktop's own transport timeouts (its REST bridge
//   aborts a fetch after 30 s; gateway RPCs time out) to settle it.
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
//   `live()` turns false and their lanes are free. An unsettled run still
//   blocks its own (lane, type) until it settles, across the reset.
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
 * run(lane, type, baseMs, fn, { force, lanes, global, resumeMinMs })
 *   -> Promise<{ ran, ok?, slow?, stale?, hidden?, busy?, pending?, nextMs }>
 *   `fn(live)` does the work; it reports a failure by throwing or resolving
 *   `false`, and checks `live()` before each further request and before
 *   applying anything. `global: { except: [lane…] }` claims every lane but
 *   those (see above).
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
  // the global run holding every lane but its exceptions
  let globalJob = null
  // `${lane}\n${type}` -> { base, interval, last, resume }
  const polls = new Map()
  // `${lane}\n${type}` of runs whose work has not settled (kept across reset)
  const unsettled = new Set()
  // a due global run waiting for its lanes: { id, except }
  let reserved = null

  const laneId = key => String(key || 'local')
  const pollKey = (key, type) => `${laneId(key)}\n${type}`

  function pollOf(key, type, baseMs) {
    const id = pollKey(key, type)
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

  function release(run) {
    for (const id of run.lanes) if (owners.get(id) === run) owners.delete(id)
    if (globalJob === run) globalJob = null
  }

  function retire(run) {
    if (run.retired || run.done) return
    run.retired = true
    run.poll.interval = backoff(run.poll)
    release(run)
  }

  /** A run that still holds lanes, or null after retiring it (deadline) or
   *  dropping it (a reset). */
  function current(run) {
    if (!run) return null
    if (run.generation !== generation || run.retired || run.done) {
      if (run.generation !== generation) release(run)
      return null
    }
    if (expired(run)) {
      retire(run)
      return null
    }
    return run
  }

  /** The run holding a lane. */
  function holder(id) {
    const own = current(owners.get(id))
    if (own) return own
    if (owners.has(id)) owners.delete(id)
    const all = current(globalJob)
    return all && !all.except.has(id) ? all : null
  }

  /** Whether a global run (except `except`) could claim now. */
  function globalBlocked(except) {
    if (current(globalJob)) return true
    for (const id of [...owners.keys()]) if (!except.has(id) && holder(id)) return true
    return false
  }

  function waitOf(poll, resumeMinMs = 0) {
    const gap = poll.resume ? Math.max(0, Number(resumeMinMs) || 0) : poll.interval
    return Math.max(0, poll.last + gap - now())
  }

  async function run(key, type, baseMs, fn, { force = false, lanes = [], global = null, resumeMinMs = 0 } = {}) {
    const main = laneId(key)
    const ids = [...new Set([main, ...lanes.map(laneId)])]
    const except = global ? new Set((global.except || []).map(laneId).filter(id => id !== main)) : null
    const poll = pollOf(main, type, baseMs)
    const id = pollKey(main, type)
    if (!visible()) {
      reserved = null
      return { ran: false, hidden: true, nextMs: waitOf(poll, resumeMinMs) }
    }
    const busyResult = { ran: false, busy: true, nextMs: Math.max(1, Math.min(poll.interval, poll.base)) }
    if (unsettled.has(id)) return { ran: false, busy: true, pending: true, nextMs: Math.max(1, poll.base) }
    const wait = waitOf(poll, resumeMinMs)
    if (except) {
      if (!force && wait > 0) return { ran: false, nextMs: wait }
      if (ids.some(lane => holder(lane)) || globalBlocked(except)) {
        reserved = { id, except }
        return busyResult
      }
    } else {
      if (ids.some(lane => holder(lane))) return busyResult
      if (reserved && reserved.id !== id && ids.some(lane => !reserved.except.has(lane))) return { ...busyResult, reserved: true }
      if (!force && wait > 0) return { ran: false, nextMs: wait }
    }
    if (reserved?.id === id) reserved = null
    // Claimed synchronously, before the first await: a second run() in the
    // same tick sees the lanes busy.
    const job = { type, poll, lanes: ids, except: except || new Set(), start: now(), generation, done: false, retired: false }
    for (const lane of ids) owners.set(lane, job)
    if (except) globalJob = job
    unsettled.add(id)
    poll.last = job.start
    poll.resume = false
    let ok = true
    try {
      ok = (await fn(() => isLive(job))) !== false
    } catch {
      ok = false
    } finally {
      unsettled.delete(id)
    }
    const stale = !isLive(job)
    release(job)
    const sameGeneration = job.generation === generation
    if (stale) {
      // Past its deadline (backed off once, here or when it was retired) or
      // from before a reset: nothing it read was applied.
      if (!job.retired && sameGeneration) poll.interval = backoff(poll)
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
    globalJob = null
    reserved = null
    polls.clear()
  }

  function due(key, type, baseMs, { lanes = [], resumeMinMs = 0 } = {}) {
    const ids = [laneId(key), ...lanes.map(laneId)]
    return visible() && !unsettled.has(pollKey(key, type)) && !ids.some(id => holder(id)) && waitOf(pollOf(key, type, baseMs), resumeMinMs) === 0
  }

  /** The poll's current interval (the base, or its backed-off value). */
  function interval(key, type, baseMs) {
    return pollOf(key, type, baseMs).interval
  }

  /** The type of the run holding a lane ('' = free). */
  function busy(key) {
    return holder(laneId(key))?.type || ''
  }

  /** Whether a (lane, type) run's work is still unsettled. */
  function pending(key, type) {
    return unsettled.has(pollKey(key, type))
  }

  /** Whether a due global run holds a reservation. */
  function reservedFor() {
    return reserved ? reserved.id : ''
  }

  return { run, resume, want, reset, due, interval, busy, pending, reservedFor }
}

/**
 * Idle-refresh passes, one per connection, fair across passes: each pass
 * re-reads the open chats' tails in turn starting after the last chat whose
 * read was ATTEMPTED and settled (applied, failed, or answered past the
 * deadline and dropped), so a chat that keeps timing out never holds the
 * others back (a streaming chat skips only its own read). A pass stops when
 * `live()` or `isVisible()` turns false; a pass from before reset() moves no
 * cursor. Resolves false when any read failed (the pass backs off).
 */
export function createIdleRotation() {
  const served = new Map()
  let generation = 0
  async function pass(lane, chats, live, isVisible = () => true) {
    const mine = generation
    const list = Array.isArray(chats) ? chats.filter(Boolean) : []
    const start = list.indexOf(served.get(lane)) + 1
    let ok = true
    for (let i = 0; i < list.length; i += 1) {
      if (!live() || !isVisible()) break
      const chat = list[(start + i) % list.length]
      let result = true
      try {
        result = await chat.idleRefresh(live)
      } catch {
        result = false
      }
      if (result === false) ok = false
      if (mine === generation) served.set(lane, chat)
    }
    return ok
  }
  function reset() {
    generation += 1
    served.clear()
  }
  return { pass, reset }
}

/** One pass over `chats` from the first (no rotation). */
export async function refreshInTurn(chats, live, isVisible = () => true) {
  return createIdleRotation().pass('', chats, live, isVisible)
}
