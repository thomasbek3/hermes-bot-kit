// The "Bot's computer" card in the profile panel: its status line and the
// small thumbnail on its right (Grok Bot's Computer card).
//
// Where the miniature comes from: ONLY frames the viewer already showed in
// this app. While the viewer is live and on screen it copies a downscaled
// still of its own canvas every so often, and once more when the stream
// closes; a tiny JPEG of the last one is kept in memory and in the plugin's
// storage, keyed `<connectionId>::<profile>`, so it survives a reload.
// Nothing here talks to the gateway: no request, no socket, no screen start,
// so the gateway's idle stop is never stamped. (Stock's `display.thumbnail`
// is read-only on the backend, but the SDK's requestProfile may dial a pooled
// socket for a route nobody holds open and offers no "already connected"
// probe, so the card does not call it.)
//
// A screen that is asleep always shows the sleeping placeholder, never a
// stale frame; an awake screen with no cached frame shows a neutral glyph.

import { resolveBotConnectionRoute, botRouteKey } from './routing.js'

export const THUMB_STORAGE_KEY = 'screen-thumbs'
export const THUMB_MAX_BYTES = 20_000
export const THUMB_MAX_ENTRIES = 50
/** How often an open, live, visible viewer refreshes its still (local only). */
export const THUMB_CAPTURE_MS = 20_000
/** The still's pixel size: the card's 64x40 thumbnail at 2x. */
export const THUMB_SIZE = Object.freeze({ width: 128, height: 80 })

/** `<connectionId>::<profile>`; a row on the active gateway uses that
 *  connection (or "local"). */
export function thumbKey(bot, activeConnectionId = null) {
  const resolved = resolveBotConnectionRoute(bot)
  if (resolved.route) return botRouteKey(resolved.route)
  return `${activeConnectionId || 'local'}::${String(bot?.name || 'default')}`
}

/** The card's status word, from the panel's display.status (the conditions
 *  the old row used; "Running" reads "Awake" now). */
export function computerStatus(status) {
  if (status == null) return { state: 'loading', label: '…' }
  if (status.error || status.supported === false) return { state: 'unavailable', label: 'Unavailable' }
  return status.running ? { state: 'awake', label: 'Awake' } : { state: 'asleep', label: 'Asleep' }
}

/** What the thumbnail draws: 'sleep' (face + z), 'shot' (the cached still),
 *  'glyph' (awake, no still yet) or 'blank' (status still loading). */
export function computerCard(status, frame) {
  const { state, label } = computerStatus(status)
  if (state === 'awake') return frame ? { state, label, thumb: 'shot', src: frame } : { state, label, thumb: 'glyph', src: null }
  if (state === 'loading') return { state, label, thumb: 'blank', src: null }
  return { state, label, thumb: 'sleep', src: null }
}

/** A still we may keep: a JPEG/PNG/WebP data URL under the size cap. */
export function acceptableFrame(url, maxBytes = THUMB_MAX_BYTES) {
  return typeof url === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(url) && url.length <= maxBytes
}

function readAll(storage) {
  try {
    const raw = storage?.get?.(THUMB_STORAGE_KEY, null)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && acceptableFrame(entry.url) && Number.isFinite(entry.at)) out[key] = { url: entry.url, at: entry.at }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * The frame cache: memory first, mirrored to plugin storage (`storage` is the
 * plugin ctx's get/set; absent in tests or old desktops: memory only).
 * At most `maxEntries` stills, the oldest dropped first; a still over
 * `maxBytes` is refused.
 */
export function createThumbCache({ storage = null, maxEntries = THUMB_MAX_ENTRIES, maxBytes = THUMB_MAX_BYTES, now = Date.now } = {}) {
  let entries = null
  const listeners = new Set()
  const load = () => (entries ??= readAll(storage))
  const persist = () => {
    try {
      storage?.set?.(THUMB_STORAGE_KEY, entries)
    } catch {
      /* memory still holds it */
    }
  }
  const emit = () => {
    for (const fn of [...listeners]) fn()
  }
  return {
    get(key) {
      return load()[key]?.url ?? null
    },
    put(key, url) {
      if (!key || !acceptableFrame(url, maxBytes)) return false
      const all = load()
      if (all[key]?.url === url) return true
      all[key] = { url, at: now() }
      const keys = Object.keys(all)
      if (keys.length > maxEntries) {
        keys.sort((a, b) => all[a].at - all[b].at)
        for (const old of keys.slice(0, keys.length - maxEntries)) delete all[old]
      }
      persist()
      emit()
      return true
    },
    size() {
      return Object.keys(load()).length
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** Point at another storage (read on the next get); listeners are not
     *  called, so it is safe during a render. */
    reset(nextStorage) {
      storage = nextStorage ?? storage
      entries = null
    }
  }
}

/**
 * Downscale a canvas into a small JPEG data URL (cover-cropped to 16:10), or
 * null when there is nothing worth keeping (no canvas, an empty framebuffer,
 * an encode error, or still over the cap at the lowest quality). `doc` is
 * injectable for tests.
 */
export function snapshotCanvas(source, { doc = globalThis.document, maxBytes = THUMB_MAX_BYTES, size = THUMB_SIZE } = {}) {
  try {
    const sw = Number(source?.width) || 0
    const sh = Number(source?.height) || 0
    if (!doc || sw < 2 || sh < 2) return null
    const out = doc.createElement('canvas')
    out.width = size.width
    out.height = size.height
    const ctx = out.getContext('2d')
    if (!ctx) return null
    const want = size.width / size.height
    let cw = sw
    let ch = sh
    if (sw / sh > want) cw = sh * want
    else ch = sw / want
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, size.width, size.height)
    for (const quality of [0.72, 0.5]) {
      const url = out.toDataURL('image/jpeg', quality)
      if (acceptableFrame(url, maxBytes)) return url
    }
    return null
  } catch {
    return null
  }
}
