// Plugin's own unread store (Spec 106): drives the blue unread dot and the
// "More unreads" pill for EVERY bot row (both local and remote/SSH), without
// reading or writing Hermes's bare-id native unread store.
//
// - Persisted in plugin storage (`UNREAD_STORE_KEY` -> localStorage
//   `hermes.plugin.grokbot-override.unreadStore`).
// - Keyed by `<stableConnectionId>::<profile>`:
//   - Local bots always normalize to `local::<profile>` (preventing cold-start
//     bare-name vs scoped-route splits).
//   - Remote bots use `<hostOrInstallId>::<profile>` when the source carries a
//     stable host/install identity (so re-creating a connection for the same
//     host keeps the same key and the old connectionId does not linger), else
//     `<connectionId>::<profile>`.
// - Value shape:
//     { seenCount, seenTipId, latestCount, latestTipId, updatedAt,
//       seenAt?, latestAt?, latestSource? }
//   `latestSource` is 'canonical' when latest came from the Bot Chat
//   (canonical_session) and 'last' when it came from the last_session
//   fallback. Entries stored before spec 106b have none.
// - First time a bot is ever observed with readable session fields:
//   seed `seen = latest` (no flood of dots on install; clears previously stuck
//   native dots).
// - Null / unreadable session fields: no change (neither mark nor seed).
// - Unread = new activity in the bot's Bot Chat (canonical_session) ONLY is
//   newer than seen. Every user-visible message lands there: a cron job that
//   delivers (deliver=bot-chat) appends its report to the Bot Chat. A cron
//   run's own session (last_session, e.g. "Upwork job scout · Nov 25 10:53",
//   new every run, mostly ending [SILENT]) never lights the dot, not even when
//   a poll catches it mid-run with a non-silent preview (spec 106b).
//   last_session is used only when the bot has no readable canonical_session.
// - Re-baseline (spec 106b): an entry whose latest came from a non-canonical
//   tip (stored by the old "newest of canonical and last" rule, or by the
//   last_session fallback) is reset to seen = latest = Bot Chat on the next
//   observation of a readable Bot Chat, so a false cron dot clears by itself.
// - Seen = set ONLY when the bot's chat is open in a VISIBLE pane and fresh,
//   non-empty history covering the latest message is presented. Hidden tabs,
//   failed/empty/cached reads do not mark seen. Opening a bot with a fresh
//   visible read always clears it (no count-coverage test, Problem 2).

import { sourceHostId } from './ownership.js'
import { resolveBotConnectionRoute } from './routing.js'
import { isSilenceReply } from './silence.js'

export const UNREAD_STORE_KEY = 'unreadStore'
export const MAX_UNREAD_ENTRIES = 500

function toMillis(value) {
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/** A stored millisecond value (already normalized by toMillis on the way in):
 *  never re-scaled, so a small stored value is not mistaken for seconds. */
function storedMs(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function finiteCount(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

function sessionCount(session) {
  if (!session || typeof session !== 'object') return null
  const live = finiteCount(session.live_message_count)
  if (live !== null) return live
  return finiteCount(session.message_count)
}

function sessionTipId(session) {
  if (!session || typeof session !== 'object') return ''
  return String(session.resolved_id || session.id || '').trim()
}

function sessionReadable(session) {
  if (!session || typeof session !== 'object') return false
  const tip = sessionTipId(session)
  const count = sessionCount(session)
  const rawAt = session.last_active
  const hasNumericAt = rawAt !== null && rawAt !== undefined && rawAt !== '' && Number.isFinite(Number(rawAt))
  // A session with an id and either a numeric count or numeric timestamp (even 0
  // for a brand-new empty session) is readable; all-null fields are unreadable.
  if (tip && (count !== null || hasNumericAt)) return true
  if (count !== null && count > 0) return true
  if (hasNumericAt && Number(rawAt) > 0) return true
  return false
}

/** Stable unread store key for a bot row: `<connectionIdentity>::<profile>`.
 *  Local bots always use `local::<profile>`. Remote bots use their stable host
 *  or installId when known (from `sources`, `ownership`, or `bot`), falling
 *  back to `<connectionId>::<profile>`. */
export function unreadBotKey(bot, sources = [], ownership = null) {
  if (!bot || typeof bot !== 'object') return ''
  const route = resolveBotConnectionRoute(bot).route
  const profile = String(route?.profile || bot.name || '').trim()
  if (!profile) return ''
  const isLocal = !bot.remoteSource && (!route || route.mode === 'local') && (!bot.connectionKind || bot.connectionKind === 'local')
  if (isLocal) return `local::${profile}`
  const connectionId = String(route?.connectionId || bot.connectionId || '').trim()
  if (!connectionId || connectionId === 'local') return `local::${profile}`
  const source = Array.isArray(sources) ? sources.find(s => String(s?.connectionId || '').trim() === connectionId) : null
  const host = sourceHostId(source) || ownership?.stableHost?.(connectionId) || sourceHostId(bot)
  return `${host || connectionId}::${profile}`
}

/** The raw `connectionId::profile` key (used to migrate entries when a stable
 *  host identity arrives later from `sources`). */
export function rawConnectionKey(bot) {
  if (!bot || typeof bot !== 'object') return ''
  const route = resolveBotConnectionRoute(bot).route
  const profile = String(route?.profile || bot.name || '').trim()
  const connectionId = String(route?.connectionId || bot.connectionId || '').trim()
  if (!profile || !connectionId || connectionId === 'local') return ''
  return `${connectionId}::${profile}`
}

/** Extract a bot's unread activity: its Bot Chat (`canonical_session`) only.
 *  `last_session` (cron runs, other conversations) is used only when the bot
 *  has no readable canonical_session at all. Returns null when session fields
 *  are null or unreadable (so callers neither mark nor seed). */
export function extractBotActivity(bot) {
  if (!bot || typeof bot !== 'object') return null
  const canonical = sessionReadable(bot.canonical_session) ? bot.canonical_session : null
  const last = canonical ? null : sessionReadable(bot.last_session) ? bot.last_session : null
  const active = canonical || last
  if (!active) return null
  const tipId = sessionTipId(active)
  const count = sessionCount(active)
  const at = toMillis(active.last_active)
  const preview = String(active.preview || '')
  return {
    tipId,
    count,
    at,
    preview,
    silent: isSilenceReply(preview),
    isCanonical: Boolean(canonical)
  }
}

/** Validate and normalize a single stored entry. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const seenTipId = typeof raw.seenTipId === 'string' ? raw.seenTipId : ''
  const latestTipId = typeof raw.latestTipId === 'string' ? raw.latestTipId : ''
  const seenCount = finiteCount(raw.seenCount)
  const latestCount = finiteCount(raw.latestCount)
  const seenAt = storedMs(raw.seenAt)
  const latestAt = storedMs(raw.latestAt)
  const updatedAt = storedMs(raw.updatedAt)
  const latestSource = raw.latestSource === 'canonical' || raw.latestSource === 'last' ? raw.latestSource : ''
  return {
    seenCount,
    seenTipId,
    latestCount,
    latestTipId,
    updatedAt,
    ...(seenAt ? { seenAt } : {}),
    ...(latestAt ? { latestAt } : {}),
    ...(latestSource ? { latestSource } : {})
  }
}

/** Read a persisted unread store from plugin storage. */
export function loadUnreadStore(saved) {
  const out = {}
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out
  for (const [key, raw] of Object.entries(saved)) {
    if (typeof key !== 'string' || !key.includes('::')) continue
    const entry = normalizeEntry(raw)
    if (entry) out[key] = entry
  }
  return pruneUnreadStore(out)
}

/** Bound the store to MAX_UNREAD_ENTRIES, dropping the oldest entries first. */
export function pruneUnreadStore(store) {
  const keys = Object.keys(store)
  if (keys.length <= MAX_UNREAD_ENTRIES) return store
  keys.sort((a, b) => Number(store[a]?.updatedAt || 0) - Number(store[b]?.updatedAt || 0))
  const next = { ...store }
  for (const drop of keys.slice(0, keys.length - MAX_UNREAD_ENTRIES)) delete next[drop]
  return next
}

/** True iff the store entry has latest activity newer than what was seen. */
export function isEntryUnread(entry) {
  if (!entry || typeof entry !== 'object') return false
  const latestTip = String(entry.latestTipId || '')
  const seenTip = String(entry.seenTipId || '')
  const latestCount = finiteCount(entry.latestCount)
  const seenCount = finiteCount(entry.seenCount)
  const latestAt = storedMs(entry.latestAt)
  const seenAt = storedMs(entry.seenAt)

  if (!latestTip && latestCount === null && !latestAt) return false

  // Different tip (e.g. a Bot Chat compression lineage tip rotation with
  // activity): unread if the new tip has
  // messages or a newer timestamp than what was seen.
  if (latestTip && seenTip && latestTip !== seenTip) {
    if (latestCount !== null && latestCount > 0) return true
    if (latestAt > seenAt) return true
    return false
  }

  // Same tip (or tip absent): compare message counts when both are present.
  if (latestCount !== null && seenCount !== null) {
    return latestCount > seenCount
  }

  // Fallback when message_count is absent: compare timestamps.
  if (latestAt > seenAt) return true

  // A tip appeared where none was seen before and it has messages.
  if (latestTip && !seenTip && latestCount !== null && latestCount > 0) return true

  return false
}

/** True iff this bot row should paint the plugin's blue unread dot. */
export function isBotUnread(store, bot, sources = [], ownership = null) {
  if (!store || typeof store !== 'object') return false
  const key = unreadBotKey(bot, sources, ownership)
  if (key && isEntryUnread(store[key])) return true
  const raw = rawConnectionKey(bot)
  if (raw && raw !== key && isEntryUnread(store[raw])) return true
  return false
}

function sameEntry(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.seenCount === b.seenCount &&
    a.seenTipId === b.seenTipId &&
    a.latestCount === b.latestCount &&
    a.latestTipId === b.latestTipId &&
    (a.seenAt || 0) === (b.seenAt || 0) &&
    (a.latestAt || 0) === (b.latestAt || 0) &&
    (a.latestSource || '') === (b.latestSource || '')
  )
}

/** Observe a single bot's latest roster activity. Pure. */
export function observeBot(store, key, activity, { now = Date.now(), migrateFrom = '' } = {}) {
  if (!key || !activity) return { store, changed: false }
  let base = store
  let prev = base[key]
  let migrated = false
  if (!prev && migrateFrom && migrateFrom !== key && base[migrateFrom]) {
    prev = base[migrateFrom]
    migrated = true
  }

  const source = activity.isCanonical ? 'canonical' : 'last'
  const baseline = () => ({
    seenCount: activity.count,
    seenTipId: activity.tipId,
    latestCount: activity.count,
    latestTipId: activity.tipId,
    updatedAt: now,
    ...(activity.at ? { seenAt: activity.at, latestAt: activity.at } : {}),
    latestSource: source
  })

  let entry
  if (!prev) {
    // First time this bot is ever observed: seed seen = latest (no dot flood).
    entry = baseline()
  } else if (activity.isCanonical && prev.latestSource !== 'canonical' && activity.tipId && prev.latestTipId && activity.tipId !== prev.latestTipId) {
    // Spec 106b re-baseline: latest was recorded from a non-Bot-Chat tip (a
    // cron run's session under the old rule, or the last_session fallback).
    // Reset to the Bot Chat so that false dot clears without opening the bot.
    // Exception: the user had already seen this very Bot Chat tip and it has
    // grown since; that is a real unread, so keep what was seen.
    const prevSeenCount = finiteCount(prev.seenCount)
    if (prev.seenTipId === activity.tipId && prevSeenCount !== null && activity.count !== null && activity.count > prevSeenCount) {
      entry = { ...baseline(), seenCount: prevSeenCount, ...(storedMs(prev.seenAt) ? { seenAt: storedMs(prev.seenAt) } : {}) }
    } else {
      entry = baseline()
    }
  } else {
    const prevLatestAt = storedMs(prev.latestAt)
    const prevSeenAt = storedMs(prev.seenAt)
    const prevLatestCount = finiteCount(prev.latestCount)
    const prevSeenCount = finiteCount(prev.seenCount)
    const sameTip = !activity.tipId || !prev.latestTipId || activity.tipId === prev.latestTipId

    let nextLatestTip = prev.latestTipId
    let nextLatestCount = prevLatestCount
    let nextLatestAt = prevLatestAt
    let nextSeenTip = prev.seenTipId
    let nextSeenCount = prevSeenCount
    let nextSeenAt = prevSeenAt

    if (sameTip) {
      const tip = activity.tipId || prev.latestTipId
      const countMoved = activity.count !== null && (prevLatestCount === null || activity.count > prevLatestCount)
      const atMoved = activity.at > prevLatestAt
      // Filling in a previously missing count on the same timestamp without
      // new activity should not invent an unread dot for an already-read bot.
      if (prevLatestCount === null && activity.count !== null && !atMoved && !isEntryUnread(prev)) {
        nextLatestTip = tip
        nextLatestCount = activity.count
        nextSeenTip = tip
        nextSeenCount = activity.count
      } else if (countMoved || atMoved) {
        nextLatestTip = tip
        if (activity.count !== null) nextLatestCount = prevLatestCount !== null ? Math.max(prevLatestCount, activity.count) : activity.count
        nextLatestAt = Math.max(prevLatestAt, activity.at)
        if (activity.silent) {
          // Bot chose [SILENT]: keep seen aligned so no dot lights up.
          nextSeenTip = nextLatestTip
          nextSeenCount = nextLatestCount
          nextSeenAt = Math.max(prevSeenAt, nextLatestAt)
        }
      }
    } else {
      // Tip changed (e.g. a Bot Chat compression lineage rotation, or the
      // Bot Chat appearing for a bot that had only last_session). Only adopt if not older than what we
      // already observed.
      const notOlder = activity.at >= prevLatestAt || (prevLatestAt === 0 && (activity.count || 0) > 0)
      if (notOlder) {
        nextLatestTip = activity.tipId
        nextLatestCount = activity.count
        nextLatestAt = Math.max(prevLatestAt, activity.at)
        if (activity.silent) {
          nextSeenTip = nextLatestTip
          nextSeenCount = nextLatestCount
          nextSeenAt = Math.max(prevSeenAt, nextLatestAt)
        }
      }
    }

    entry = {
      seenCount: nextSeenCount,
      seenTipId: nextSeenTip,
      latestCount: nextLatestCount,
      latestTipId: nextLatestTip,
      updatedAt: now,
      ...(nextSeenAt ? { seenAt: nextSeenAt } : {}),
      ...(nextLatestAt ? { latestAt: nextLatestAt } : {}),
      // Which session latest now comes from (unchanged if this poll was ignored).
      ...(nextLatestTip === activity.tipId ? { latestSource: source } : prev.latestSource ? { latestSource: prev.latestSource } : {})
    }
    if (!migrated && sameEntry(prev, entry) && !(migrateFrom && base[migrateFrom])) return { store, changed: false }
  }

  const next = { ...base, [key]: entry }
  if (migrateFrom && migrateFrom !== key) delete next[migrateFrom]
  return { store: pruneUnreadStore(next), changed: true }
}

/** Observe all rows in a roster snapshot. Pure. */
export function observeRoster(store, rows, sources = [], { now = Date.now(), ownership = null } = {}) {
  let cur = store
  let changed = false
  for (const bot of Array.isArray(rows) ? rows : []) {
    const key = unreadBotKey(bot, sources, ownership)
    if (!key) continue
    const activity = extractBotActivity(bot)
    if (!activity) continue
    const raw = rawConnectionKey(bot)
    const res = observeBot(cur, key, activity, { now, migrateFrom: raw && raw !== key ? raw : '' })
    if (res.changed) {
      cur = res.store
      changed = true
    }
  }
  return { store: cur, changed }
}

/**
 * Mark a bot as seen: its chat is open in a VISIBLE pane and a fresh read of
 * it has been presented. Then seen = the latest activity recorded for that
 * bot (its Bot Chat, or last_session for a bot without one), so opening a bot always clears its dot and the
 * next roster poll reporting the same activity does not re-light it. Only
 * activity newer than this lights it again.
 *
 * There is deliberately no message-count "coverage" test: the roster's count
 * and the history page's rows are computed differently (folded rows, tool
 * rows, older gateways without live_message_count), so a count watermark can
 * stay one short forever and the dot never clears (spec 106, Problem 2).
 *
 * presentation: {
 *   visible: boolean,       // window and pane visible
 *   fresh: boolean,         // a fresh network read (not the cached seed, not failed)
 *   nonEmpty: boolean,      // the fresh read returned messages
 *   emptyChat?: boolean,    // the fresh read returned none AND nothing cached is on screen
 *   sessionId: string,      // session id the fresh read resolved to
 *   count: number | null,   // messages shown
 *   lastAt: number          // newest shown message timestamp, in ms
 * }
 * A hidden pane, a cached seed, or an empty read while cached rows are on
 * screen never marks seen.
 */
export function markBotSeen(store, bot, sources = [], presentation = null, { now = Date.now(), ownership = null } = {}) {
  if (!presentation || !presentation.visible || !presentation.fresh) return { store, changed: false }
  if (!presentation.nonEmpty && !presentation.emptyChat) return { store, changed: false }
  const key = unreadBotKey(bot, sources, ownership)
  if (!key) return { store, changed: false }
  const raw = rawConnectionKey(bot)
  const migrateFrom = raw && raw !== key && store[raw] ? raw : ''
  const prev = store[key] || (migrateFrom ? store[migrateFrom] : null)
  // Never observed by the roster yet: nothing to clear, and seeding from the
  // page (whose count is computed unlike the roster's) could invent a dot on
  // the first poll. The first roster observation seeds seen = latest.
  if (!prev) return { store, changed: false }

  const shownTip = String(presentation.sessionId || '').trim()
  const shownCount = finiteCount(presentation.count)
  // Already milliseconds (session.js makeFreshHistory normalizes row
  // timestamps); re-scaling a ms value as seconds would push seen 1000x into
  // the future and no later activity could ever light the dot.
  const shownAt = storedMs(presentation.lastAt)

  const prevLatestTip = String(prev?.latestTipId || '')
  const prevLatestCount = finiteCount(prev?.latestCount)
  const prevLatestAt = storedMs(prev?.latestAt)
  const prevSeenAt = storedMs(prev?.seenAt)

  // Latest stays what the roster recorded; the shown session only fills in a
  // missing tip, or raises the count when it is that same session.
  const tip = prevLatestTip || shownTip
  let count = prevLatestCount
  if (shownCount !== null && (!prevLatestTip || prevLatestTip === shownTip)) count = count === null ? shownCount : Math.max(count, shownCount)
  const at = Math.max(prevLatestAt, prevSeenAt, shownAt)
  const entry = {
    seenCount: count,
    seenTipId: tip,
    latestCount: count,
    latestTipId: tip,
    updatedAt: now,
    ...(at ? { seenAt: at, latestAt: at } : {}),
    ...(prev.latestSource ? { latestSource: prev.latestSource } : {})
  }

  if (!migrateFrom && sameEntry(prev, entry)) return { store, changed: false }
  const next = { ...store, [key]: entry }
  if (migrateFrom) delete next[migrateFrom]
  return { store: pruneUnreadStore(next), changed: true }
}
