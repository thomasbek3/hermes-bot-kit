// Bot Mode's per-bot metadata (pin, hide, title, look, groups) as the override
// reads and writes it. Ports from apps/desktop/src/plugins/hermes-bots
// (Hermes Agent, MIT, (c) Nous Research):
//
//   - effectiveMeta      ← profile-ops.ts:250 mergeServerMeta (server ui_meta
//                          beats the local snapshot; local-only `image`/`pet`
//                          survive; the backend's title wins; `chat` dropped)
//   - persistBotMetaPatch ← data.ts:372 (CAS read-modify-write of the bot's
//                          `hermes-bots` ui_meta via profiles.list +
//                          profiles.configure, 3 attempts)
//   - settleServerOutcome ← data.ts:425 (persisted / unsupported / failed /
//                          unreachable)
//   - avatar asset push   ← data.ts:533 (profiles.set_asset when the image changed)
//
// The local half of stock's save writes Bot Mode's own plugin storage and its
// in-memory atom, which a plugin cannot reach. The override keeps its own
// overlay instead (`writes`): a patch it saved wins for the write fence
// (data.ts:295 BOT_META_WRITE_FENCE_MS), after which the server row (which
// carries the same value once the write landed) decides again. On a gateway
// with no ui_meta contract ('unsupported') stock's local copy IS the save;
// the override keeps that overlay with no expiry, on this desktop only.

import { looksUnsupported } from './outcomes.js'
import { botRouteKey, resolveBotConnectionRoute } from './routing.js'

export const BOT_META_WRITE_FENCE_MS = 60_000
export const BOT_META_CAS_ATTEMPTS = 3

/** The key every metadata record is filed under (data.ts botOwner). */
export function botMetaKey(bot) {
  const route = resolveBotConnectionRoute(bot).route
  return route ? botRouteKey(route) : String(bot?.name || 'default')
}

/** The Bot Mode title a row's own backend reports (profile-ops.ts:237
 *  serverReportedTitle): '' when it reports none, undefined when it cannot say. */
export function serverReportedTitle(bot, server) {
  if (server) return String(server.title || '').trim()
  if (bot && Object.prototype.hasOwnProperty.call(bot, 'ui_meta_revisions')) return ''
  return typeof bot?.title === 'string' ? bot.title.trim() : undefined
}

/** Local snapshot record for a row: route key first, then the bare name
 *  (routing.ts botRosterMeta). */
export function localMetaFor(bot, localMeta) {
  const route = resolveBotConnectionRoute(bot).route
  const byRoute = route ? localMeta?.[botRouteKey(route)] : null
  const byName = localMeta?.[bot?.name]
  const record = byRoute || byName || null
  return record && typeof record === 'object' ? record : null
}

/**
 * What Bot Mode shows for a row after its roster reconcile, plus this
 * desktop's own pending writes.
 *
 * `writes`: key -> { patch, at, sticky } (the override's overlay).
 */
export function effectiveMeta(bot, localMeta, writes = {}, now = Date.now()) {
  const raw = bot?.ui_meta?.['hermes-bots']
  const server = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  const mine = localMetaFor(bot, localMeta) || {}
  let merged = { ...mine }
  // A retained or unreachable row cannot correct anything (profile-ops.ts:261).
  const authoritative = !(bot?.retained || bot?.sourceReachable === false)
  if (authoritative) {
    const title = serverReportedTitle(bot, server)
    if (server || (title !== undefined && Object.keys(mine).length)) {
      merged = { ...mine, ...(server || {}) }
      if (title) merged.title = title
      else if (title !== undefined) delete merged.title
      if (mine.image) merged.image = mine.image
      if (
        Array.isArray(server?.groups) &&
        Object.prototype.hasOwnProperty.call(mine, 'group') &&
        !Object.prototype.hasOwnProperty.call(server, 'group')
      ) {
        delete merged.group
      }
    }
  }
  delete merged.chat
  const write = writes?.[botMetaKey(bot)]
  if (write && (write.sticky || now - Number(write.at || 0) < BOT_META_WRITE_FENCE_MS)) {
    merged = { ...merged, ...write.patch }
  }
  return merged
}

export function isBotHidden(meta) {
  return Boolean(meta?.hidden)
}

export function isBotPinned(meta) {
  return Boolean(meta?.pinned)
}

/** The bot's `hermes-bots` namespace as its own backend holds it now
 *  (data.ts:336 readServerBotMeta). */
export async function readServerBotMeta(request, bot) {
  const route = resolveBotConnectionRoute(bot).route
  // The read is the first half of a user's save: it dials foreground like the write.
  const result = await request(bot, 'profiles.list', { include_sessions: false }, route ? { spawnPriority: 'foreground' } : {})
  const target = route?.targetProfile || String(bot?.name || '')
  const row = (Array.isArray(result?.profiles) ? result.profiles : []).find(profile => profile?.name === target)
  if (!row) return null
  const meta = row.ui_meta?.['hermes-bots']
  const revisions = row.ui_meta_revisions
  return {
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
    revision: revisions && typeof revisions === 'object' ? Math.max(0, Number(revisions['hermes-bots'] || 0)) : null,
    row
  }
}

/** One save's patch written onto the server's current namespace, with CAS
 *  (data.ts:372). `rebase(serverMeta)` recomputes the patch per attempt. */
export async function persistBotMetaPatch(request, bot, patch, { rebase, progress = { reached: false } } = {}) {
  const name = String(bot?.name || '').trim()
  for (let attempt = 0; attempt < BOT_META_CAS_ATTEMPTS; attempt += 1) {
    const server = await readServerBotMeta(request, bot)
    progress.reached = true
    if (!server) return null
    const { chat: _chat, ...base } = server.meta
    const { image: _image, pet: _pet, ...fields } = rebase ? rebase(server.meta) : patch
    const params = { name, ui_meta: { 'hermes-bots': { ...base, ...fields } } }
    if (server.revision !== null) params.ui_meta_expected_revisions = { 'hermes-bots': server.revision }
    const result = await request(bot, 'profiles.configure', params)
    if (!result?.applied?.ui_meta_conflicts) return result
  }
  return { applied: { ui_meta: false } }
}

/** data.ts:425: the three-way (four-way) outcome of the server half. */
export async function settleServerOutcome(pending, routed, progress) {
  try {
    const result = await pending
    if (result?.applied?.ui_meta === true) return 'persisted'
    return result && typeof result === 'object' && result.applied && typeof result.applied === 'object' ? 'failed' : 'unsupported'
  } catch (error) {
    // Read-only verdict (the save stays local); never a server re-write.
    if (!routed || looksUnsupported(error)) return 'unsupported'
    return progress.reached ? 'failed' : 'unreachable'
  }
}

/**
 * Save a metadata patch for one bot the way stock saveBotMeta does
 * (data.ts:504), minus the local snapshot (see the header). Resolves the
 * server outcome. `prevImage`: the image the bot had before, so the avatar
 * asset is only pushed when it changed (data.ts:533).
 */
export async function saveBotMetaPatch(request, bot, patch, { rebase, prevImage = null } = {}) {
  const route = resolveBotConnectionRoute(bot).route
  const progress = { reached: false }
  let pending = null
  try {
    pending = persistBotMetaPatch(request, bot, patch, { rebase, progress })
  } catch {
    pending = null
  }
  if (patch && 'image' in patch && patch.image !== (prevImage ?? null)) {
    const name = String(bot?.name || '')
    const params = patch.image ? { name, asset: 'avatar', data: patch.image } : { name, asset: 'avatar', clear: true }
    Promise.resolve()
      .then(() => request(bot, 'profiles.set_asset', params))
      .catch(() => undefined)
  }
  const outcome = pending ? await settleServerOutcome(pending, Boolean(route), progress) : 'unsupported'
  return { serverOutcome: outcome, serverPersisted: outcome === 'persisted' }
}

/** The overlay entry a save leaves behind (see the header). */
export function overlayEntry(patch, outcome, now = Date.now()) {
  return { patch: { ...patch }, at: now, sticky: outcome === 'unsupported' }
}

/** Overlay entries past the fence are dropped (sticky ones stay). */
export function pruneOverlay(writes, now = Date.now()) {
  const next = {}
  for (const [key, entry] of Object.entries(writes || {})) {
    if (entry?.sticky || now - Number(entry?.at || 0) < BOT_META_WRITE_FENCE_MS) next[key] = entry
  }
  return next
}

// ── groups (group-membership.ts) ─────────────────────────────────────────

/** group-membership.ts:154 botGroups */
export function botGroups(meta) {
  const groups = []
  const seen = new Set()
  const values = Array.isArray(meta?.groups) ? meta.groups : [meta?.group]
  for (const value of values) {
    if (typeof value !== 'string') continue
    const group = value.trim()
    if (group && !seen.has(group)) {
      seen.add(group)
      groups.push(group)
    }
  }
  return groups
}

/** group-membership.ts:478 knownGroups, over the effective metas. */
export function knownGroups(metas) {
  const names = new Set()
  for (const meta of metas || []) for (const group of botGroups(meta)) names.add(group)
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** group-membership.ts:181 groupMembershipPatch */
export function groupMembershipPatch(meta, group, enabled) {
  const name = String(group || '').trim()
  let groups = botGroups(meta)
  if (enabled) {
    if (name && !groups.includes(name)) groups = [...groups, name]
  } else {
    groups = groups.filter(existing => existing !== name)
  }
  return { groups, group: groups[0] || null }
}
