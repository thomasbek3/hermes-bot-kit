// Activity summaries of bots on OTHER connections (remote and SSH rows), so
// their rows get previews and plugin unread dots like the active source's rows.
//
// The union roster (host.agents) gives an SSH row only its name and metadata:
// no `canonical_session` / `last_session`, so the plugin's unread store would
// never see it move. The session fields come from `profiles.list` with
// `include_sessions: true`, asked once per remote connection on one of its
// rows' own routes (same carrier choice as core/remoteAvatars.js) on that
// connection's background poll lane (60 s, respecting backoff, skipped while
// hidden), and laid over that connection's rows here.

import { createOwnership } from './ownership.js'
import { carrierFor } from './remoteAvatars.js'
import { botSourceStatus, sameData } from './roster.js'
import { resolveBotConnectionRoute } from './routing.js'

export const FROM_LIST = Symbol('gbo.sessionsFromList')
export const REMOTE_ACTIVITY_MS = 60_000
export const REMOTE_ACTIVITY_TIMEOUT_MS = 20_000
/** The session fields a sessions-on list carries per profile. */
export const SESSION_FIELDS = ['canonical_session', 'last_session', 'worker_session']

/** A row's remote route, or null (local rows, the active source's rows, ghosts). */
export function remoteActivityRoute(bot) {
  if (!bot || !bot.remoteSource || bot.ghost) return null
  const route = resolveBotConnectionRoute(bot).route
  return route && route.mode === 'remote' && route.connectionId ? route : null
}

/** Whether a row may START its connection's read: a remote route on an
 *  available source (retained SSH connect-on-demand rows included). */
export function canStartRead(bot) {
  return Boolean(remoteActivityRoute(bot)) && botSourceStatus(bot).available
}

/** Whether a row carries session fields of its own (not laid over here). */
function hasOwnSessions(bot) {
  return !bot?.[FROM_LIST] && SESSION_FIELDS.some(key => bot?.[key] !== undefined)
}

/** connectionId -> the row whose route carries that connection's list, for
 *  every remote connection with a row that may start a read and that has no
 *  session fields of its own. */
export function remoteActivityCarriers(rows) {
  const byConnection = new Map()
  for (const bot of Array.isArray(rows) ? rows : []) {
    if (!canStartRead(bot) || hasOwnSessions(bot)) continue
    const { connectionId } = remoteActivityRoute(bot)
    if (!byConnection.has(connectionId)) byConnection.set(connectionId, [])
    byConnection.get(connectionId).push(bot)
  }
  const carriers = new Map()
  for (const [connectionId, bots] of byConnection) carriers.set(connectionId, carrierFor(bots))
  return carriers
}

/** profile name -> its session fields, from a `profiles.list` answer. */
export function sessionFieldsByName(result) {
  const byName = new Map()
  for (const row of Array.isArray(result?.profiles) ? result.profiles : []) {
    const name = String(row?.name || '').trim()
    if (!name) continue
    const fields = {}
    for (const key of SESSION_FIELDS) fields[key] = row?.[key] ?? null
    byName.set(name, fields)
  }
  return byName
}

/** `rows` with each remote row's session fields taken from its connection's
 *  verified list (`lists`: connectionId -> { identity, byName }). A row with
 *  fields of its own keeps them; a row whose connection has no list (or no
 *  entry for it) loses the fields laid over before. Unchanged rows keep
 *  their identity, and the array itself is returned when nothing changed. */
export function withRemoteSessions(rows, lists) {
  if (!Array.isArray(rows)) return rows
  let changed = false
  const next = rows.map(bot => {
    if (!bot || hasOwnSessions(bot)) return bot
    const route = remoteActivityRoute(bot)
    const list = route ? lists?.get?.(route.connectionId) : null
    const fields = list?.byName?.get?.(route.targetProfile || route.profile)
    if (fields) {
      if (bot[FROM_LIST] === list.identity && SESSION_FIELDS.every(key => sameData(bot[key], fields[key]))) return bot
      changed = true
      return { ...bot, ...fields, [FROM_LIST]: list.identity }
    }
    if (!bot[FROM_LIST]) return bot
    changed = true
    const bare = { ...bot }
    for (const key of [...SESSION_FIELDS, FROM_LIST]) delete bare[key]
    return bare
  })
  return changed ? next : rows
}

/**
 * The per-connection lists. `request(bot, method, params, options)` is the
 * kit's requestForBot; `ownership` is core/ownership.js's table; `onChange()`
 * runs whenever a list arrives with new data, expires or is dropped;
 * `onProfiles(connectionId, profiles)` receives the full profiles list when
 * available.
 */
export function createRemoteActivity({
  request,
  ownership = createOwnership(),
  onChange = () => undefined,
  onProfiles = () => undefined,
  setTimer = defaultTimer,
  timeoutMs = REMOTE_ACTIVITY_TIMEOUT_MS
} = {}) {
  /** connectionId -> { identity, byName } (only verified, unexpired answers) */
  let lists = new Map()
  /** Connections with a row that may start a read (null: not synced yet). */
  let startable = null
  /** connectionId -> the newest read sequence that settled the list */
  const settled = new Map()
  let seq = 0
  let stopped = false

  function publish(next) {
    lists = next
    if (!stopped) onChange()
  }

  function drop(connectionId) {
    settled.delete(connectionId)
    if (!lists.has(connectionId)) return
    const next = new Map(lists)
    next.delete(connectionId)
    publish(next)
  }

  /** One connection's sessions-on list, through `carrier`'s route. Resolves
   *  false on a failure (the poll backs off); never throws. */
  async function read(connectionId, carrier, live = () => true) {
    if (stopped) return true
    const mine = ++seq
    const owner = ownership.token(connectionId)
    const current = () =>
      !stopped && ownership.token(connectionId) === owner && (!startable || startable.has(connectionId)) && (settled.get(connectionId) || 0) <= mine
    let timedOut = false
    const cancel = setTimer(() => {
      timedOut = true
      if (current()) drop(connectionId)
    }, timeoutMs)
    try {
      const result = await request(carrier, 'profiles.list', { include_sessions: true }, { timeoutMs })
      if (!current()) return true
      settled.set(connectionId, mine)
      const accepted = live() && ownership.accept(connectionId, result?.install_id)
      if (!accepted) {
        drop(connectionId)
        settled.set(connectionId, mine)
        return !live()
      }
      const profiles = Array.isArray(result?.profiles) ? result.profiles : []
      try {
        onProfiles(connectionId, profiles)
      } catch {
        /* metadata enrichment is best-effort */
      }
      const byName = sessionFieldsByName(result)
      const prev = lists.get(connectionId)
      const same =
        prev &&
        prev.identity === owner &&
        prev.byName.size === byName.size &&
        [...byName].every(([name, fields]) => prev.byName.has(name) && SESSION_FIELDS.every(key => sameData(prev.byName.get(name)[key], fields[key])))
      if (!same) publish(new Map(lists).set(connectionId, { identity: owner, byName }))
      return true
    } catch {
      if (current()) {
        drop(connectionId)
        settled.set(connectionId, mine)
      }
      return false
    } finally {
      if (!timedOut) cancel?.()
    }
  }

  /** The connections with a row that may start a read: the others' lists
   *  expire, and their pending reads are void. */
  function sync(startableIds) {
    startable = new Set(startableIds)
    for (const id of [...lists.keys()]) if (!startable.has(id)) drop(id)
  }

  return {
    read,
    sync,
    drop,
    lists: () => lists,
    stop() {
      stopped = true
      lists = new Map()
      settled.clear()
    },
    start() {
      stopped = false
    }
  }
}

function defaultTimer(fn, ms) {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}
