// Roster: the same rows Bot Mode shows, grouped into sections.
//
// Rows come from Bot Mode's own roster query cache when it holds a fresh
// snapshot (identical rows by construction), else from the same two reads Bot
// Mode makes (`profiles.list` on the active gateway + `host.agents()`), merged
// by a port of `mergeMultiSourceRoster` from apps/desktop/src/plugins/
// hermes-bots/data.ts (Hermes Agent, MIT, (c) Nous Research) without its
// offline-row retention.

import { botRouteKey, resolveBotConnectionRoute } from './routing.js'
import { sectionIdFor } from './sections.js'
import { shownReplyText } from './silence.js'

export const STOCK_ROSTER_KEY = ['hermes-bots', 'roster']
export const STOCK_CACHE_MAX_AGE_MS = 20_000

/** The freshest stock roster snapshot in a react-query cache, or null. */
export function readStockRoster(queryClient, activeConnectionId, now = Date.now()) {
  const cache = queryClient?.getQueryCache?.()
  if (!cache || typeof cache.findAll !== 'function') return null
  let best = null
  for (const query of cache.findAll({ queryKey: STOCK_ROSTER_KEY })) {
    const key = query?.queryKey
    if (!Array.isArray(key) || key[0] !== STOCK_ROSTER_KEY[0] || key[1] !== STOCK_ROSTER_KEY[1]) continue
    const data = query?.state?.data
    const updatedAt = Number(query?.state?.dataUpdatedAt || 0)
    if (!data || !Array.isArray(data.profiles)) continue
    const keyConnection = key.length > 2 ? key[2] ?? null : null
    const matches = (keyConnection || null) === (activeConnectionId || null)
    const score = (matches ? 1e15 : 0) + updatedAt
    if (!best || score > best.score) best = { score, data, updatedAt, matches }
  }
  if (!best) return null
  return {
    profiles: best.data.profiles,
    sources: Array.isArray(best.data.sources) ? best.data.sources : [],
    updatedAt: best.updatedAt,
    fresh: best.matches && now - best.updatedAt <= STOCK_CACHE_MAX_AGE_MS
  }
}

/** Merge the active gateway's rich rows with the union agent roster. */
export function mergeRoster(local, union, activeConnectionId) {
  const localProfiles = Array.isArray(local?.profiles) ? local.profiles : []
  const agents = Array.isArray(union?.agents) ? union.agents : []
  const activeId = String(activeConnectionId || '').trim()
  const activeByName = new Map()

  for (const profile of localProfiles) {
    const name = String(profile?.name || '').trim()
    if (!name || profile?.remoteSource) continue
    if (profile?.sourceScoped && activeId && profile.connectionId !== activeId) continue
    if (!activeByName.has(name)) activeByName.set(name, { ...profile, name })
  }

  const profiles = [...activeByName.values()]
  const seen = new Set()

  for (const agent of agents) {
    const profile = String(agent?.profile || '').trim()
    const connectionId = String(agent?.connectionId || '').trim()
    const sourceKey = `${connectionId}::${profile || 'default'}`
    if (!profile || seen.has(sourceKey)) continue
    seen.add(sourceKey)

    const isActiveSource = activeId ? connectionId === activeId : agent.connectionKind === 'local'
    const route = {
      connectionId,
      mode: agent.connectionKind === 'local' ? 'local' : 'remote',
      profile,
      targetProfile: agent.targetProfile || profile
    }
    const row = isActiveSource ? activeByName.get(profile) : null

    if (row) {
      Object.assign(row, {
        handle: agent.handle,
        connectionId: agent.connectionId,
        connectionKind: agent.connectionKind,
        connectionLabel: agent.connectionLabel,
        targetProfile: route.targetProfile,
        route,
        sourceScoped: true,
        ...(agent.reachable === false ? { unserved: true } : {})
      })
      continue
    }
    if (isActiveSource) continue

    profiles.push({
      name: profile,
      ...(agent.profileMetadata || {}),
      handle: agent.handle,
      connectionId,
      connectionKind: agent.connectionKind,
      connectionLabel: agent.connectionLabel,
      targetProfile: route.targetProfile,
      route,
      remoteSource: true,
      sourceScoped: true,
      ...(agent.reachable === false ? { unserved: true } : {})
    })
  }

  return profiles
}

/** The profile names each source listed on a fresh read (host.agents):
 *  connectionId -> Set of profile names, only for a source that answered
 *  (reachable, no error, not a remembered/stale listing) with at least one
 *  agent. A source missing here is never pruned. */
export function liveRosterNames(union) {
  const live = new Map()
  const agents = Array.isArray(union?.agents) ? union.agents : []
  for (const source of Array.isArray(union?.sources) ? union.sources : []) {
    const id = String(source?.connectionId || '').trim()
    if (!id || source.reachable !== true || source.error || source.stale || source.cached) continue
    const names = new Set(
      agents
        .filter(agent => String(agent?.connectionId || '').trim() === id)
        .map(agent => String(agent?.profile || '').trim())
        .filter(Boolean)
    )
    if (names.size) live.set(id, names)
  }
  return live
}

/** Rows without the ones their source no longer lists (a bot deleted on that
 *  machine stays in a cached roster otherwise). Rows of a source with no
 *  fresh answer, and rows without a connection, are kept. */
export function dropDeadRows(rows, live) {
  if (!(live instanceof Map) || !live.size) return rows
  return rows.filter(row => {
    const id = String(row?.connectionId || '').trim()
    const names = id ? live.get(id) : null
    return !names || names.has(String(row?.name || '').trim())
  })
}

/** Annotate rows with their source's reachability (`sources` from host.agents). */
export function annotateSources(rows, sources) {
  const byId = new Map((Array.isArray(sources) ? sources : []).map(source => [String(source?.connectionId || ''), source]))
  return rows.map(row => {
    const source = byId.get(String(row?.connectionId || ''))
    if (!source) return row
    const reachable = source.reachable === false || source.error ? false : source.reachable ?? null
    return { ...row, sourceReachable: reachable, sourceError: source.error || null }
  })
}

/** Stable identity of a roster row (same as Bot Mode's selection key). */
export function rowKey(bot) {
  const route = resolveBotConnectionRoute(bot).route
  return route ? botRouteKey(route) : String(bot?.name || 'default')
}

/** Bot Mode's per-bot meta: the row's `ui_meta['hermes-bots']` merged under
 *  the desktop's local snapshot (`hermes.plugin.hermes-bots.bot-meta-v2`). */
export function botMeta(bot, localMeta) {
  const server = bot?.ui_meta?.['hermes-bots']
  const route = resolveBotConnectionRoute(bot).route
  const local =
    (route && localMeta?.[botRouteKey(route)]) || (!route && localMeta?.[bot?.name]) || localMeta?.[bot?.name] || null
  return { ...(server && typeof server === 'object' ? server : {}), ...(local && typeof local === 'object' ? local : {}) }
}

export function displayName(bot, meta) {
  const isDefault = String(bot?.name || '') === 'default'
  return (
    String(meta?.title || bot?.display_name || bot?.title || '').trim() ||
    (isDefault ? 'Hermes' : String(bot?.name || 'Bot').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
  )
}

export function handleOf(bot) {
  const handle = String(bot?.handle || '').trim()
  if (handle) return handle.startsWith('@') ? handle : `@${handle}`
  return `@${String(bot?.name || '') === 'default' ? 'hermes' : bot?.name || ''}`
}

/** The roster preview: the canonical Bot Chat's preview, else the last session's. */
export function previewOf(bot) {
  const session = bot?.canonical_session?.preview ? bot.canonical_session : bot?.last_session
  const text = typeof session?.preview === 'string' ? session.preview.replace(/\s+/g, ' ').trim() : ''
  // The preview is the newest stored message: a silent reply shows nothing.
  const preview = shownReplyText(text)
  const at = Number(bot?.canonical_session?.last_active || bot?.last_session?.last_active || 0)
  return { preview, at: at > 0 ? (at < 1e12 ? at * 1000 : at) : 0 }
}

/** How a row's owning gateway is doing, as Bot Mode paints it
 *  (data.ts:1650 botSourceStatus). An SSH source that is not the live
 *  gateway reports `connect-on-demand` with reachable false: it is
 *  AVAILABLE (it dials on the first request), never dimmed. */
export function botSourceStatus(bot) {
  const error = String(bot?.sourceError || '').trim()
  if (bot?.sourceMissing) return { available: false, key: 'missing', label: 'Gateway removed', tone: 'bad' }
  if (error === 'connect-on-demand') return { available: true, key: 'on-demand', label: 'On demand', tone: 'muted' }
  if (error || bot?.sourceReachable === false || bot?.unserved) {
    return { available: false, key: 'unavailable', label: 'Unavailable', tone: 'warn' }
  }
  if (bot?.sourceReachable === true) return { available: true, key: 'ready', label: 'Ready', tone: 'good' }
  return { available: true, key: 'unknown', label: 'Status unknown', tone: 'muted' }
}

/** A row the roster dims: exactly the rows Bot Mode marks unavailable. */
export function sourceUnreachable(bot) {
  return !botSourceStatus(bot).available
}

const UNASSIGNED = 'Unassigned'

/** The name keys a copied Bot Sections layout uses for a bot. */
export function sectionNameKeys(bot, meta) {
  return [bot?.name, displayName(bot, meta), handleOf(bot).slice(1)]
}

/** The roster's own section a bot is in ('' = Default; core/sections.js). */
export function ownSectionOf(bot, sections, metaFor) {
  return sectionIdFor(sections, rowKey(bot), sectionNameKeys(bot, metaFor(bot)))
}

/** Group rows into sections. The roster's own sections (core/sections.js)
 *  come first, in their order; a bot in none of them is grouped the default
 *  way: Bot Mode's user sections (meta.sectionName), else one section per
 *  connection. Own sections carry `id` and `own: true`; with `keepEmpty` an
 *  own section with no bots is still listed (so a new one can be filled). */
export function buildSections(rows, { metaFor, sections = null, query = '', keepEmpty = false }) {
  const q = String(query || '').trim().toLowerCase()
  const visible = rows.filter(bot => {
    const meta = metaFor(bot)
    if (meta?.hidden || bot?.ghost) return false
    if (!q) return true
    return [bot.name, displayName(bot, meta), handleOf(bot), meta?.title].some(v => String(v || '').toLowerCase().includes(q))
  })

  const order = (a, b) => {
    const ma = metaFor(a)
    const mb = metaFor(b)
    if (Boolean(ma?.pinned) !== Boolean(mb?.pinned)) return ma?.pinned ? -1 : 1
    return displayName(a, ma).localeCompare(displayName(b, mb))
  }

  const ownList = Array.isArray(sections?.sections) ? sections.sections : []
  const mine = new Map(ownList.map(section => [section.id, []]))
  const rest = []
  for (const bot of visible) {
    const id = ownList.length ? ownSectionOf(bot, sections, metaFor) : ''
    if (id && mine.has(id)) mine.get(id).push(bot)
    else rest.push(bot)
  }
  const ownSections = ownList
    .map(section => ({ id: section.id, name: section.name, own: true, collapsed: Boolean(section.collapsed), bots: mine.get(section.id).sort(order) }))
    .filter(section => keepEmpty || section.bots.length > 0)
  return [...ownSections, ...defaultSections(rest, metaFor, order)]
}

/** The grouping a bot has without a section of its own. */
function defaultSections(visible, metaFor, order) {
  let sectionOf
  let ladder
  if (visible.some(bot => metaFor(bot)?.sectionName)) {
    const names = []
    for (const bot of visible) {
      const name = String(metaFor(bot)?.sectionName || '').trim()
      if (name && !names.includes(name)) names.push(name)
    }
    ladder = [...names, UNASSIGNED]
    sectionOf = bot => String(metaFor(bot)?.sectionName || '').trim() || UNASSIGNED
  } else {
    const labels = []
    for (const bot of visible) {
      const label = connectionLabel(bot)
      if (!labels.includes(label)) labels.push(label)
    }
    ladder = labels
    sectionOf = connectionLabel
  }

  const buckets = new Map(ladder.map(name => [name, []]))
  for (const bot of visible) {
    const name = sectionOf(bot)
    if (!buckets.has(name)) buckets.set(name, [])
    buckets.get(name).push(bot)
  }
  return [...buckets.entries()]
    .map(([name, bots]) => ({ name, bots: bots.sort(order) }))
    .filter(section => section.bots.length > 0)
}

export function connectionLabel(bot) {
  if (!bot?.remoteSource && (!bot?.connectionKind || bot.connectionKind === 'local')) return 'This device'
  return String(bot?.connectionLabel || bot?.connectionId || 'Remote')
}
