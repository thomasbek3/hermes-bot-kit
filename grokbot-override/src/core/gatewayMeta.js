// Bot Mode meta (shown name, look, description) of bots whose roster row
// carries none: rows of an SSH connection that is not the live gateway.
//
// Hermes Desktop lists an SSH connection without touching it (electron
// main.ts getAgentRoster: `profiles: null, error: 'connect-on-demand'`), so
// such a row has no `ui_meta`, `display_name` or `title`, and the roster fell
// back to the profile name ("Hermes" for `default`) however often the bot was
// renamed. Stock Bot Mode reads those names from the bot's own gateway
// (hermes-bots/relay.ts relayAgentsOn: `profiles.list` on the connection's
// route, title = ui_meta['hermes-bots'].title || display_name). The override
// does the same, but only on reads it makes anyway over a route that is up
// (the remote-avatar list, a save, a toggle's re-read, the edit dialog, a chat
// being opened); it never dials a machine just for a name.
//
// What it reads is kept twice, under the bot's route key
// (`<connectionId>::<profile>`, core/routing.js botRouteKey):
//   - `fresh`: read this app session;
//   - `cache`: the override's plugin storage, so the name is right at start,
//     before (and without) the connection being up, and after a reload.
//
// Resolution for a row (metaFor → core/botMeta.js effectiveMeta):
//   1. the row's own listing data (any row that carries ui_meta,
//      display_name, title or ui_meta_revisions: the live gateway's rows,
//      a remote source that lists with metadata);
//   2. the gateway meta read this session;
//   3. the cached gateway meta;
//   4. the fallback name (displayName: "Hermes" for `default`, else the
//      profile name).
// A save of this desktop still shows over all of them for its write fence.
// Only rows on a REMOTE route take part; local bots are unchanged.

import { botRouteKey, resolveBotConnectionRoute } from './routing.js'

export const GATEWAY_META_STORAGE_KEY = 'botMetaCache'
/** Entries kept in plugin storage (newest first). */
export const GATEWAY_META_MAX = 200
/** One entry larger than this (serialized) is not kept. */
export const GATEWAY_META_ENTRY_MAX_CHARS = 16_000
/** A chat being opened re-reads the meta only when the last read is older. */
export const GATEWAY_META_FRESH_MS = 5 * 60_000

const LISTING_FIELDS = ['ui_meta', 'display_name', 'title', 'ui_meta_revisions']
// Never kept: `chat` (stock drops it), `image` / `pet` (local-only in stock's
// merge, and large).
const DROPPED = new Set(['chat', 'image', 'pet'])

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

/** Whether the row carries name data from its own listing. */
export function hasListingMeta(bot) {
  return Boolean(bot) && LISTING_FIELDS.some(field => Object.prototype.hasOwnProperty.call(bot, field) && bot[field] !== undefined && bot[field] !== null)
}

/** The route key of a row whose meta comes from its gateway, or ''. */
export function gatewayMetaKey(bot) {
  if (!bot || hasListingMeta(bot)) return ''
  const route = resolveBotConnectionRoute(bot).route
  return route && route.mode === 'remote' ? botRouteKey(route) : ''
}

/** A cache entry from a gateway's `profiles.list` row, or null. */
export function gatewayMetaEntry(row, now = Date.now()) {
  if (!plainObject(row)) return null
  const raw = row.ui_meta?.['hermes-bots']
  const meta = {}
  if (plainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) if (!DROPPED.has(key) && value !== undefined) meta[key] = value
  }
  const entry = {
    meta,
    display_name: typeof row.display_name === 'string' ? row.display_name.trim() : '',
    description: typeof row.description === 'string' ? row.description : '',
    at: Number(now) || 0
  }
  try {
    if (JSON.stringify(entry).length > GATEWAY_META_ENTRY_MAX_CHARS) return null
  } catch {
    return null
  }
  return entry
}

/** The shown title an entry carries ('' = none): stock's relay order. */
export function entryTitle(entry) {
  return String(entry?.meta?.title || entry?.display_name || '').trim()
}

/** Entries for the roster rows of one connection from its `profiles.list`
 *  answer: each row is matched by its route's target profile. */
export function entriesFromProfiles(rows, connectionId, profiles, now = Date.now()) {
  const byName = new Map()
  for (const row of Array.isArray(profiles) ? profiles : []) {
    const name = String(row?.name || '').trim()
    if (name && !byName.has(name)) byName.set(name, row)
  }
  const out = {}
  for (const bot of Array.isArray(rows) ? rows : []) {
    const route = resolveBotConnectionRoute(bot).route
    if (!route || route.mode !== 'remote' || route.connectionId !== connectionId) continue
    const listed = byName.get(route.targetProfile || route.profile)
    const entry = listed ? gatewayMetaEntry(listed, now) : null
    if (entry) out[botRouteKey(route)] = entry
  }
  return out
}

/** The entry that names this row: this session's read, else the cache.
 *  null for rows with listing data of their own and for local rows. */
export function gatewayMetaFor(bot, fresh, cache) {
  const key = gatewayMetaKey(bot)
  if (!key) return null
  const entry = (plainObject(fresh) && fresh[key]) || (plainObject(cache) && cache[key]) || null
  return plainObject(entry) && plainObject(entry.meta) ? entry : null
}

/** Whether two entries say the same (ignoring when they were read). */
export function sameEntry(a, b) {
  if (!a || !b) return a === b
  const { at: _a, ...left } = a
  const { at: _b, ...right } = b
  return JSON.stringify(left) === JSON.stringify(right)
}

/** `map` with `entries` written in; `map` itself when nothing changed
 *  (a newer read time alone is a change only with `touch`). */
export function mergeEntries(map, entries, { touch = false } = {}) {
  const base = plainObject(map) ? map : {}
  let next = null
  for (const [key, entry] of Object.entries(entries || {})) {
    if (!key || !plainObject(entry)) continue
    const old = base[key]
    if (old && sameEntry(old, entry) && !touch) continue
    next ??= { ...base }
    next[key] = entry
  }
  return next || base
}

/** The cache as it is stored: valid entries only, newest GATEWAY_META_MAX. */
export function pruneCache(saved) {
  if (!plainObject(saved)) return {}
  const valid = Object.entries(saved).filter(([key, entry]) => key.includes('::') && plainObject(entry) && plainObject(entry.meta))
  if (valid.length <= GATEWAY_META_MAX && valid.length === Object.keys(saved).length) return saved
  valid.sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))
  return Object.fromEntries(valid.slice(0, GATEWAY_META_MAX))
}

/** The entry after a save of `patch` that the gateway took: what it held
 *  (`server`, the namespace the save wrote onto) with the patch on top. */
export function entryAfterSave(previous, written, now = Date.now()) {
  const meta = {}
  for (const [key, value] of Object.entries(plainObject(written) ? written : {})) {
    if (!DROPPED.has(key) && value !== undefined) meta[key] = value
  }
  return {
    meta,
    display_name: String(previous?.display_name || ''),
    description: String(previous?.description || ''),
    at: Number(now) || 0
  }
}
