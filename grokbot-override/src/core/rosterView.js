// What the roster lists: filters, the hidden section, gateway options, and the
// source status a section heading or row shows. Ports from
// apps/desktop/src/plugins/hermes-bots (Hermes Agent, MIT, (c) Nous Research):
//
//   - rosterActivityMatches, ACTIVE_WINDOW_S, RECENT window  ← row-helpers.ts:67,164
//   - workerActiveAt (150 s)                                ← row-helpers.ts:86-96
//   - botActivitySession                                    ← data.ts:1765
//   - activityOf (max(created, last message))               ← roster-pane-derivation.ts:255
//   - rosterGatewayOptions, filterBotsByGateway             ← roster-sections.tsx:18,85
//   - botSourceStatus                                       ← data.ts:1650
//   - deriveRosterPresentation (filter count, hidden
//     section rules, when search / filters show)           ← roster-pane-derivation.ts:191
//   - the filter menu entries                               ← roster-pane-toolbar.tsx:190-260

import { botSourceStatus, displayName, handleOf } from './roster.js'

export const ACTIVE_WINDOW_S = 90
export const RECENT_ACTIVITY_WINDOW_S = 7 * 24 * 60 * 60
export const WORKER_ACTIVE_WINDOW_S = 150
export const BOT_ROSTER_SEARCH_THRESHOLD = 8

export const KIND_FILTERS = [
  ['all', 'Bots and groups'],
  ['bots', 'Bots only'],
  ['groups', 'Groups only']
]

export const ACTIVITY_FILTERS = [
  ['all', 'Any activity'],
  ['active', 'Active now'],
  ['recent', 'Recently active'],
  ['older', 'Older']
]

export const DEFAULT_FILTERS = Object.freeze({ kind: 'all', activity: 'all', gateway: 'all' })

export function botActivitySession(bot) {
  const preferred = bot?.canonical_session
  const last = bot?.last_session
  if (!preferred || !last) return preferred || last || null
  return (preferred.last_active || 0) >= (last.last_active || 0) ? preferred : last
}

/** Milliseconds: the newest of (bot created, last message). */
export function activityOf(bot, meta) {
  const created = Number(meta?.created || bot?.ui_meta?.['hermes-bots']?.created || 0)
  const lastMsg = Number(botActivitySession(bot)?.last_active || 0) * 1000
  return Math.max(created, lastMsg)
}

export function workerActiveAt(bot, now = Date.now()) {
  const ts = Number(bot?.worker_session?.last_active || 0)
  return Boolean(ts && now / 1000 - ts < WORKER_ACTIVE_WINDOW_S)
}

/** row-helpers.ts activeBots, for one row: a running turn on screen, a
 *  message inside the last 90 s, or a live worker. */
export function botActiveNow(bot, { working = false, now = Date.now() } = {}) {
  if (working || workerActiveAt(bot, now)) return true
  const last = Number(botActivitySession(bot)?.last_active || 0)
  return Boolean(last && now / 1000 - last < ACTIVE_WINDOW_S)
}

export function rosterActivityMatches(row, filter, now = Date.now()) {
  if (!filter || filter === 'all') return true
  if (filter === 'active') return Boolean(row?.active)
  const activity = Number(row?.activity || 0)
  const recent = Boolean(activity && now - activity <= RECENT_ACTIVITY_WINDOW_S * 1000)
  return filter === 'recent' ? recent : !recent
}

export function filterBotsByGateway(rows, connectionId) {
  if (!connectionId || connectionId === 'all') return rows
  return (rows || []).filter(bot => String(bot?.connectionId || '') === connectionId)
}

export { botSourceStatus }

export function rosterGatewayOptions(sources, rows) {
  const byId = new Map()
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = String(source?.connectionId || '').trim()
    if (id) byId.set(id, { ...source, connectionId: id, count: 0 })
  }
  for (const bot of rows || []) {
    const id = String(bot?.connectionId || '').trim()
    if (!id) continue
    const source = byId.get(id) || {
      connectionId: id,
      kind: bot.connectionKind,
      label: bot.connectionLabel || id,
      reachable: bot.sourceReachable,
      error: bot.sourceError,
      count: 0
    }
    source.count += 1
    byId.set(id, source)
  }
  return [...byId.values()].sort((a, b) =>
    String(a.label || a.connectionId).localeCompare(String(b.label || b.connectionId), undefined, { sensitivity: 'base' })
  )
}

/** Unreachable sources a Retry can re-read (R9): the gateway options whose
 *  status is not available. */
export function unreachableSources(options) {
  return (options || []).filter(option => !botSourceStatus({ sourceError: option.error, sourceReachable: option.reachable }).available)
}

function matchesQuery(bot, meta, q) {
  if (!q) return true
  const needle = q.replace(/^@/, '')
  return [bot.name, displayName(bot, meta), handleOf(bot), meta?.title].some(v => String(v || '').toLowerCase().includes(needle))
}

/**
 * Split the roster into what the list shows and the Hidden section.
 *
 * `metaFor(bot)` the effective meta; `filters` {kind, activity, gateway};
 * `workingKey` the open chat's row key while its turn runs;
 * `groupCount` how many group rows exist (they come from the group chats
 * surface; with none, 'groups' lists nothing and the kind filter says so).
 * Returns rows (visible, filtered), hidden (filtered hidden rows) and the
 * presentation flags.
 */
export function deriveRosterView(rows, { metaFor, filters = DEFAULT_FILTERS, query = '', workingKey = '', keyOf, sources = [], hiddenExpanded = false, groupCount = 0, now = Date.now() } = {}) {
  const f = { ...DEFAULT_FILTERS, ...(filters || {}) }
  const q = String(query || '').trim().toLowerCase()
  const all = (rows || []).filter(bot => !bot?.ghost)
  const gatewayOptions = rosterGatewayOptions(sources, all)
  const gateway = f.gateway === 'all' || gatewayOptions.some(o => o.connectionId === f.gateway) ? f.gateway : 'all'
  const activityRow = bot => ({ activity: activityOf(bot, metaFor(bot)), active: botActiveNow(bot, { working: Boolean(keyOf && keyOf(bot) === workingKey && workingKey), now }) })
  const keep = bot => matchesQuery(bot, metaFor(bot), q) && rosterActivityMatches(activityRow(bot), f.activity, now)

  const hiddenAll = all.filter(bot => metaFor(bot)?.hidden)
  const visibleAll = all.filter(bot => !metaFor(bot)?.hidden)
  const visible = f.kind === 'groups' ? [] : filterBotsByGateway(visibleAll, gateway).filter(keep)
  const hiddenMatching = f.kind === 'groups' ? [] : filterBotsByGateway(hiddenAll, gateway).filter(keep)

  const activeFilterCount = (f.kind === 'all' ? 0 : 1) + (f.activity === 'all' ? 0 : 1) + (gateway === 'all' ? 0 : 1)
  const hasConstraint = Boolean(q) || activeFilterCount > 0
  const itemCount = all.length + groupCount
  return {
    rows: visible,
    hidden: hiddenMatching,
    hiddenCount: hiddenAll.length,
    showHiddenSection: hiddenAll.length > 0 && (!hasConstraint || hiddenMatching.length > 0),
    showHiddenRows: hiddenExpanded || hasConstraint,
    allHidden: !hasConstraint && visibleAll.length === 0 && groupCount === 0 && hiddenAll.length > 0,
    activeFilterCount,
    hasConstraint,
    gateway,
    gatewayOptions,
    showSearch: gatewayOptions.length > 1 || itemCount >= BOT_ROSTER_SEARCH_THRESHOLD || Boolean(q),
    showFilters: gatewayOptions.length > 1 || groupCount > 0 || itemCount >= BOT_ROSTER_SEARCH_THRESHOLD || activeFilterCount > 0
  }
}
