// Server avatars for bots on OTHER connections (remote rows).
//
// Hermes Desktop pulls a bot's server avatar (`profiles.get_asset`, the image
// `profiles.set_asset` stored under the profile's assets/) only for rows of
// the ACTIVE source (hermes-bots/roster-pane-lifecycle.ts → profile-ops.ts
// pullServerAvatars). A bot on another machine keeps its generated face even
// when its own gateway has a picture for it. The override fetches those here,
// read-only, through each bot's own route (core/routing.js requestForBot),
// and keeps them for the app session.
//
// - Which rows: `remoteSource` rows with a resolved remote route that their
//   source still serves. Rows of the active source (local bots included) are
//   left to Bot Mode, which already puts their picture in its meta.
// - has_avatar: the union roster carries it when the source's /api/profiles
//   reports it. When a row cannot say (older backends do not), one
//   `profiles.list` per connection (on one of its rows' routes) answers for
//   every profile on that machine, so no per-bot probe is ever made.
// - Fetch: `profiles.get_asset {name, asset:'avatar'}` on the bot's own route,
//   only for has_avatar bots that show no picture of their own yet. One
//   request in flight per bot; a result is kept for AVATAR_TTL_MS (the server
//   exposes no mtime or hash), a failure is retried after AVATAR_RETRY_MS.
//   Until a picture arrives, and after an error, the row keeps its shape.
// - A 160 px PNG is Bot Mode's raster of a vector face (avatar-image.ts
//   isBackfilledFacePng), pushed only for inter-agent notices: not shown,
//   like stock.

import { botRouteKey, resolveBotConnectionRoute } from './routing.js'

export const AVATAR_TTL_MS = 15 * 60_000
export const AVATAR_RETRY_MS = 2 * 60_000
export const AVATAR_LIST_TTL_MS = 5 * 60_000
export const AVATAR_TIMEOUT_MS = 20_000
/** A data URL longer than this is not shown (set_asset caps assets at 2 MB). */
export const AVATAR_MAX_CHARS = 3_000_000

const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/

/** True for a data URL the avatar may show: PNG, JPEG or WebP, base64. */
export function isAvatarDataUrl(value) {
  return typeof value === 'string' && value.length <= AVATAR_MAX_CHARS && DATA_IMAGE.test(value)
}

/** Bot Mode's 160×160 PNG raster of a vector face (avatar-image.ts:138). */
export function isBackfilledFacePng(dataUrl) {
  const prefix = 'data:image/png;base64,'
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) return false
  try {
    const bin = atob(dataUrl.slice(prefix.length, prefix.length + 48))
    if (bin.length < 24) return false
    const word = at => ((bin.charCodeAt(at) << 24) | (bin.charCodeAt(at + 1) << 16) | (bin.charCodeAt(at + 2) << 8) | bin.charCodeAt(at + 3)) >>> 0
    return word(16) === 160 && word(20) === 160
  } catch {
    return false
  }
}

/** The remote route of a row the override fetches an avatar for, or null. */
export function remoteAvatarRoute(bot) {
  if (!bot || !bot.remoteSource || bot.ghost || bot.retained || bot.unserved || bot.sourceReachable === false) return null
  const route = resolveBotConnectionRoute(bot).route
  return route && route.mode === 'remote' ? route : null
}

/**
 * The loader. `request(bot, method, params, options)` is the kit's
 * requestForBot; `hasOwnImage(bot)` says the row already shows a picture
 * (Bot Mode's meta), so nothing is fetched for it; `onChange(images)` gets
 * the route key → data URL map whenever it changes.
 */
export function createRemoteAvatars({ request, hasOwnImage = () => false, onChange = () => undefined, now = () => Date.now() } = {}) {
  /** route key → { image, at, failedAt } */
  const entries = new Map()
  const inflight = new Set()
  /** connectionId → { at, failedAt, flags: Map<targetProfile, boolean> | null } */
  const lists = new Map()
  const listing = new Set()
  let images = {}
  let stopped = false
  let lastRows = []

  function publish() {
    const next = {}
    for (const [key, entry] of entries) if (entry.image) next[key] = entry.image
    const a = Object.keys(images)
    const b = Object.keys(next)
    if (a.length === b.length && b.every(key => images[key] === next[key])) return
    images = next
    onChange(images)
  }

  function forget(key) {
    if (entries.delete(key)) publish()
  }

  /** has_avatar for a row: its own flag, else its connection's list (undefined: not known yet). */
  function flagFor(bot, route) {
    if (typeof bot.has_avatar === 'boolean') return bot.has_avatar
    const list = lists.get(route.connectionId)
    if (!list?.flags) return undefined
    return list.flags.get(route.targetProfile || route.profile) === true
  }

  function listConnection(connectionId, carrier) {
    const t = now()
    const list = lists.get(connectionId)
    if (listing.has(connectionId)) return
    if (list?.flags && t - list.at < AVATAR_LIST_TTL_MS) return
    if (list?.failedAt && t - list.failedAt < AVATAR_RETRY_MS) return
    listing.add(connectionId)
    Promise.resolve()
      .then(() => request(carrier, 'profiles.list', { include_sessions: false }, { timeoutMs: AVATAR_TIMEOUT_MS }))
      .then(result => {
        const flags = new Map()
        for (const row of Array.isArray(result?.profiles) ? result.profiles : []) {
          const name = String(row?.name || '').trim()
          if (name) flags.set(name, row?.has_avatar === true)
        }
        lists.set(connectionId, { at: now(), failedAt: 0, flags })
      })
      .catch(() => {
        lists.set(connectionId, { ...(lists.get(connectionId) || { at: 0, flags: null }), failedAt: now() })
      })
      .finally(() => {
        listing.delete(connectionId)
        // Fetch what the list just answered for. No loop: the list is now
        // fresh or marked failed, so listConnection returns at once.
        if (!stopped) sync(lastRows)
      })
  }

  function fetchAvatar(bot, key, route) {
    inflight.add(key)
    Promise.resolve()
      .then(() => request(bot, 'profiles.get_asset', { name: String(bot.name || route.profile), asset: 'avatar' }, { timeoutMs: AVATAR_TIMEOUT_MS }))
      .then(result => {
        if (stopped) return
        const data = result?.found ? result.data : null
        const image = isAvatarDataUrl(data) && !isBackfilledFacePng(data) ? data : null
        entries.set(key, { image, at: now(), failedAt: 0 })
        publish()
      })
      .catch(() => {
        if (stopped) return
        // Keep a picture already shown; a row with none keeps its shape.
        const prev = entries.get(key)
        entries.set(key, { image: prev?.image || null, at: prev?.at || 0, failedAt: now() })
        publish()
      })
      .finally(() => inflight.delete(key))
  }

  /** Called with the roster rows on every roster change; cheap when nothing is due. */
  function sync(rows) {
    if (stopped) return
    lastRows = Array.isArray(rows) ? rows : []
    const t = now()
    const needList = new Map()
    const seen = new Set()
    for (const bot of lastRows) {
      const route = remoteAvatarRoute(bot)
      if (!route) continue
      const key = botRouteKey(route)
      seen.add(key)
      if (typeof bot.has_avatar !== 'boolean') {
        // The connection's list answers for it (listConnection throttles).
        if (!needList.has(route.connectionId)) needList.set(route.connectionId, [])
        needList.get(route.connectionId).push(bot)
      }
      const flag = flagFor(bot, route)
      if (flag === undefined) continue
      if (!flag) {
        forget(key)
        continue
      }
      if (inflight.has(key)) continue
      if (hasOwnImage(bot)) {
        forget(key)
        continue
      }
      const entry = entries.get(key)
      if (entry?.failedAt && t - entry.failedAt < AVATAR_RETRY_MS) continue
      if (entry && !entry.failedAt && t - entry.at < AVATAR_TTL_MS) continue
      fetchAvatar(bot, key, route)
    }
    for (const [connectionId, bots] of needList) listConnection(connectionId, carrierFor(bots))
    // Rows that left the roster lose their picture.
    let dropped = false
    for (const key of [...entries.keys()]) {
      if (!seen.has(key)) {
        entries.delete(key)
        dropped = true
      }
    }
    if (dropped) publish()
  }

  return {
    sync,
    /** route key → data URL (only pictures to show). */
    images: () => images,
    stop() {
      stopped = true
      entries.clear()
      lists.clear()
      lastRows = []
      images = {}
    }
  }
}

/** The row whose route carries a connection's profiles.list: its `default`
 *  profile when listed, else the first by name (a stable choice). */
function carrierFor(bots) {
  const sorted = [...bots].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return sorted.find(bot => (bot.targetProfile || bot.name) === 'default') || sorted[0]
}
