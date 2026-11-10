// Actions behind the roster-side parity surfaces. Every gateway call here is
// one stock Bot Mode (or the app's own Cron page) makes, cited at the call;
// the core modules carry the ported logic and their own citations.

import { attentionFromEvent, clearAttention, noteAttention } from '../core/attention.js'
import { botMetaKey, effectiveMeta, overlayEntry, pruneOverlay, readServerBotMeta, saveBotMetaPatch } from '../core/botMeta.js'
import { cronAddParams, cronEditUpdates, cronJobRestPath, cronRemoveParams, CRON_TRIGGER_REQUEST_TIMEOUT_MS, isStoredJobFor } from '../core/cronOps.js'
import { settingsFromConfig, sheetSavePlan, stepSucceeded } from '../core/modelSheet.js'
import { applyAdvancedConfig, emptyAdvancedState, loadAdvanced } from '../core/profileConfig.js'
import {
  capabilityPayload,
  composeSoul,
  createProfileParams,
  deleteBotProfile,
  describeArgv,
  duplicateLook,
  duplicateName,
  duplicateParams,
  duplicateRow,
  ensureMessagingProtocol,
  newBotChat,
  newBotLook,
  requestOnTarget
} from '../core/profileOps.js'
import { rowKey } from '../core/roster.js'
import { botRestScope, botWorkspaceOwnerKey, createBotRequester, resolveBotConnectionRoute, stockOpenTarget } from '../core/routing.js'
import { mergeUsage, usageFromEvent } from '../core/usage.js'
import { activeConnection, app, backToOverride, beginStockHandoff, loadCron, reloadRoster, selectBot } from './app'
import { roster2, type BotModel, type BotModelSettings } from './rosterStores'
import { host, queryClient } from './sdk'

let requester: any = null
export function request(bot: any, method: string, params: Record<string, unknown> = {}, options: any = {}) {
  requester ??= createBotRequester(host, { activeConnectionId: () => activeConnection() })
  return requester(bot, method, params, options)
}

function notify(kind: string, message: string, extra: Record<string, unknown> = {}) {
  try {
    host?.notify?.({ kind, message, ...extra })
  } catch {
    /* toast is best-effort */
  }
}

function notifyError(error: any, message: string) {
  try {
    if (typeof host?.notifyError === 'function') host.notifyError(error, message)
    else notify('error', `${message}: ${String(error?.message || error)}`)
  } catch {
    /* toast is best-effort */
  }
}

/** Stock invalidates its roster query after every profile write
 *  (queryClient.invalidateQueries({queryKey: ROSTER_KEY})); the override does
 *  the same and re-reads its own copy. */
export function invalidateRoster() {
  try {
    queryClient()?.invalidateQueries?.({ queryKey: ['hermes-bots', 'roster'] })
  } catch {
    /* older desktop */
  }
  reloadRoster()
}

// ── R11 metadata (pin / hide / groups / look) ────────────────────────────

function storageSet(key: string, value: unknown) {
  try {
    app.ctx?.storage?.set?.(key, value)
  } catch {
    /* this window only */
  }
}

export function loadMetaWrites() {
  try {
    const saved = app.ctx?.storage?.get?.('metaWrites', {})
    roster2.metaWrites.set(pruneOverlay(saved && typeof saved === 'object' ? saved : {}))
  } catch {
    roster2.metaWrites.set({})
  }
}

function recordWrite(bot: any, patch: any, outcome: string) {
  const key = botMetaKey(bot)
  roster2.metaWrites.set(writes => {
    const prev = writes[key]?.patch || {}
    const next = pruneOverlay({ ...writes, [key]: overlayEntry({ ...prev, ...patch }, outcome) })
    const sticky = Object.fromEntries(Object.entries(next).filter(([, entry]: any) => entry?.sticky))
    storageSet('metaWrites', sticky)
    return next
  })
}

/** data.ts saveBotMeta, through the bot's own route. The overlay shows the
 *  change at once (stock's local half); a server miss is reported like stock
 *  (an explicit failure is an error; older gateways fall back silently). */
export async function saveMeta(bot: any, patch: any, { rebase, label }: { rebase?: (server: any) => any; label?: string } = {}) {
  const prevImage = effectiveMeta(bot, app.roster.get().localMeta, roster2.metaWrites.get()).image ?? null
  recordWrite(bot, patch, 'pending')
  const result = await saveBotMetaPatch(request, bot, patch, { rebase, prevImage })
  recordWrite(bot, patch, result.serverOutcome)
  if (result.serverOutcome === 'failed' || result.serverOutcome === 'unreachable') {
    notify('error', `${label || 'The change'} was saved on this screen only: ${result.serverOutcome === 'unreachable' ? 'the bot’s machine did not answer' : 'the bot’s Hermes did not take it'}.`)
  }
  if (result.serverOutcome === 'persisted') invalidateRoster()
  return result
}

/** bot-row.tsx:330 (ensureBotMetadata, then the toggle). */
export async function togglePinned(bot: any) {
  const meta = await currentMeta(bot)
  const pinned = Boolean(meta.pinned)
  await saveMeta(bot, { pinned: !pinned }, { label: pinned ? 'Unpin from section' : 'Pin first in section' })
  notify('info', pinned ? `${nameOf(bot, meta)} unpinned from its section` : `${nameOf(bot, meta)} pinned first in its section`)
}

/** bot-row.tsx:350. Hiding the open bot keeps its chat (hiding is display only). */
export async function toggleHidden(bot: any) {
  const meta = await currentMeta(bot)
  const hidden = Boolean(meta.hidden)
  await saveMeta(bot, { hidden: !hidden }, { label: hidden ? 'Unhide' : 'Hide' })
  notify('info', hidden ? `${nameOf(bot, meta)} is back in the roster` : `${nameOf(bot, meta)} hidden from the roster`)
}

function nameOf(bot: any, meta: any) {
  return String(meta?.title || bot?.display_name || bot?.title || bot?.name || 'Bot')
}

/** canonical-chat.ts:684 ensureBotMetadata: a source-scoped row is re-read
 *  from its own backend before a toggle, so the toggle flips what is there now. */
export async function currentMeta(bot: any) {
  if (bot?.sourceScoped) {
    try {
      const server = await readServerBotMeta(request, bot)
      if (server) return effectiveMeta({ ...bot, ui_meta: { ...(bot.ui_meta || {}), 'hermes-bots': server.meta } }, app.roster.get().localMeta, roster2.metaWrites.get())
    } catch {
      /* fall back to the row */
    }
  }
  return effectiveMeta(bot, app.roster.get().localMeta, roster2.metaWrites.get())
}

/** canonical-chat.ts:692 ensureBotProfile: the description its own backend holds. */
export async function ensureBotProfile(bot: any) {
  if (!bot?.sourceScoped) return bot
  try {
    const server = await readServerBotMeta(request, bot)
    return typeof server?.row?.description === 'string' ? { ...bot, description: server.row.description } : bot
  } catch {
    return bot
  }
}

/** Stock Desktop-room records (hermes-bots plugin storage 'group-chats'):
 *  a group with a room keeps seats there too, which a plugin cannot write. */
export function groupHasRoom(group: string): boolean {
  try {
    const raw = globalThis.localStorage?.getItem('hermes.plugin.hermes-bots.group-chats')
    const rooms = raw ? JSON.parse(raw) : null
    return Boolean(rooms && typeof rooms === 'object' && rooms[group])
  } catch {
    return false
  }
}

// ── R9 retry ─────────────────────────────────────────────────────────────

/** roster-pane-content.tsx:92 Retry now → the roster refetch, which re-asks
 *  the active gateway and host.agents() for every source. */
export async function retrySources() {
  if (roster2.retrying.get()) return
  roster2.retrying.set(true)
  try {
    invalidateRoster()
    await new Promise(resolve => setTimeout(resolve, 600))
  } finally {
    roster2.retrying.set(false)
  }
}

// ── R12 row actions ──────────────────────────────────────────────────────

/** Open in new tab: stock's openRosterBot({intent:'tab'}) opens the Bot Chat
 *  as a second core chat tab beside the current one (roster-actions.ts:336,
 *  the same host.openSession options as openStoredBotChat). A side-by-side
 *  override chat (C26) may register itself here and is then preferred. */
let newTabOpener: null | ((bot: any) => Promise<boolean> | boolean) = null
export function setNewTabOpener(fn: typeof newTabOpener) {
  newTabOpener = fn
}

export async function openInNewTab(bot: any) {
  if (newTabOpener) return newTabOpener(bot)
  const canonical = bot?.canonical_session
  const storedId = canonical?.resolved_id || canonical?.id
  if (!storedId || typeof host?.openSession !== 'function') {
    notify('info', 'This bot has no Bot Chat yet; open it here first.')
    return false
  }
  // Never a profile without its route for a bot on another connection: that
  // opens (and stamps) a same-named profile on THIS machine (stockOpenTarget).
  const target = stockOpenTarget(bot, activeConnection())
  if (!target.ok) {
    notify('error', `Not opened in Hermes Bot Mode: ${target.reason}.`)
    return false
  }
  beginStockHandoff()
  try {
    await host.openSession(String(storedId), {
      ...(target.route ? { route: target.route } : {}),
      profile: target.profile,
      intent: 'tab',
      awaitHydration: false,
      forceResume: true,
      keepAllProfilesScope: true,
      workspaceMode: 'bots',
      workspaceOwnerKey: botWorkspaceOwnerKey(bot),
      tabTitle: 'Bot Chat'
    })
    return true
  } catch (error) {
    notifyError(error, 'Could not open the Bot Chat in a new tab')
    return false
  }
}

/** bot-row.tsx:440 New chat with this agent (data.ts newBotChat). */
export function newChatWith(bot: any) {
  beginStockHandoff()
  if (!newBotChat(host, bot, botWorkspaceOwnerKey(bot))) {
    backToOverride()
    notify('error', 'Update Hermes Desktop to open another chat with this bot.')
  }
}

/** bot-row.tsx:418 Duplicate (profile-ops.ts duplicateBot). */
export async function duplicateBot(bot: any) {
  notify('info', `Duplicating ${nameOf(bot, effectiveMeta(bot, app.roster.get().localMeta, roster2.metaWrites.get()))}…`)
  try {
    const source = await ensureBotProfile(bot)
    const name = duplicateName(source, app.roster.get().rows)
    await request(source, 'profiles.create', duplicateParams(source, name))
    if (typeof host?.dropLeftoverProfilePrefs === 'function') host.dropLeftoverProfilePrefs(name, resolveBotConnectionRoute(source).route?.connectionId)
    const look = duplicateLook(effectiveMeta(source, app.roster.get().localMeta, roster2.metaWrites.get()))
    if (look && Object.keys(look).length) await saveMeta(duplicateRow(source, name), look, { label: 'The copy’s look' })
    invalidateRoster()
    notify('success', `Created ${name} — full copy of ${source.name}`)
    return name
  } catch (error) {
    notifyError(error, 'Could not duplicate the bot')
    return null
  }
}

/** roster-pane-dialogs.tsx:131 Delete (profile-ops.ts deleteBot). */
export async function deleteBot(bot: any) {
  await deleteBotProfile(host, bot, activeConnection())
  const key = rowKey(bot)
  roster2.metaWrites.set(writes => {
    const next = { ...writes }
    delete next[botMetaKey(bot)]
    return next
  })
  roster2.attention.set(map => clearAttention(map, key))
  if (app.selectedKey.get() === key) app.selectedKey.set('')
  invalidateRoster()
  notify('success', `Deleted profile ${bot.name}`)
}

/** Edit profile save (edit-profile-dialog.tsx:117): changed look fields via
 *  saveBotMeta, the description via `profile describe`, then the advanced
 *  sections. Returns what failed. */
export async function saveProfileEdits(bot: any, { look, description, advanced }: { look: any | null; description: string; advanced: any | null }) {
  const failed: string[] = []
  if (look) {
    const res = await saveMeta(bot, look, { label: 'The look' })
    if (res.serverOutcome === 'failed') failed.push('look')
  }
  if (description.trim() !== String(bot.description || '').trim()) {
    try {
      await request(bot, 'cli.exec', { argv: describeArgv(bot, description.trim()) })
      invalidateRoster()
    } catch (error) {
      failed.push('description')
      notifyError(error, 'Saved, but the description could not be updated')
    }
  }
  if (advanced && advanced.loaded && (advanced.dirtyModel || advanced.dirtySoul || advanced.dirtySkills || advanced.dirtyToolsets || advanced.dirtyMcp)) {
    const res = await saveAdvanced(bot, advanced)
    if (!res.ok) failed.push(...Object.entries(res.applied || {}).filter(([, ok]) => !ok).map(([k]) => k))
  }
  return failed
}

// ── P6 / C21 profile config ──────────────────────────────────────────────

export function loadProfileConfig(bot: any) {
  return loadAdvanced(request, bot)
}

/** A model needing confirmation is asked here (#95293); the dialog
 *  registers the asker. */
let confirmAsker: null | ((message: string) => Promise<boolean>) = null
export function setConfirmAsker(fn: typeof confirmAsker) {
  confirmAsker = fn
}

export async function saveAdvanced(bot: any, state: any) {
  const rows = app.roster.get().rows
  // soul.ts: no protocol section when the backend injects it (data.ts:885
  // reads the flag off profiles.list); asked of the bot's own backend.
  let injected = Boolean((app.roster.get() as any).protocolInjected)
  if (state?.dirtySoul) {
    try {
      injected = Boolean((await request(bot, 'profiles.list', { include_sessions: false }))?.bot_mode_protocol)
    } catch {
      /* keep the roster's flag */
    }
  }
  const res: any = await applyAdvancedConfig(request, bot, state, {
    ensureSoul: (text: string) => ensureMessagingProtocol(text, bot.name, rows, injected),
    confirm: confirmAsker || undefined
  })
  invalidateRoster()
  // The panel's Model row follows a model save from any of the screens.
  if (state?.dirtyModel) {
    if (res?.applied?.model === true) setBotModel(bot, { provider: String(state.provider || '').trim(), model: String(state.model || '').trim() })
    else void loadBotModel(bot, { force: true })
  }
  return res
}

function setBotModel(bot: any, patch: Partial<BotModel>) {
  const key = rowKey(bot)
  roster2.models.set(all => ({ ...all, [key]: { provider: '', model: '', error: null, ...all[key], ...patch, loading: false, loaded: true } }))
}

/** The bot's configured model for the panel's Model row: the same
 *  profiles.describe read the config screens open with (its model section
 *  only), on the bot's own route. Read once per bot unless `force`. */
export async function loadBotModel(bot: any, { force = false, foreground = false }: { force?: boolean; foreground?: boolean } = {}) {
  const key = rowKey(bot)
  const have = roster2.models.get()[key]
  if (have && !force && (have.loading || have.loaded)) return
  roster2.models.set(all => ({ ...all, [key]: { provider: '', model: '', error: null, loaded: false, ...all[key], loading: true } }))
  try {
    // The sheet opening is a user gesture: its read takes the pool's
    // interactive slot instead of queuing behind warm bot backends.
    const res: any = await request(bot, 'profiles.describe', { name: bot.name }, foreground ? FOREGROUND : {})
    setBotModel(bot, { provider: String(res?.model?.provider || ''), model: String(res?.model?.default || ''), error: null })
  } catch (error: any) {
    roster2.models.set(all => ({ ...all, [key]: { provider: '', model: '', ...all[key], loading: false, loaded: false, error: String(error?.message || error) } }))
  }
}

/** The panel's Model picker: the model section alone, written exactly as
 *  the config screen writes it (saveAdvanced with only dirtyModel set:
 *  profiles.configure {name, model, provider}, the expensive-model
 *  confirmation, or `config unset model` when both are emptied). */
export function saveBotModel(bot: any, value: { provider: string; model: string }) {
  return saveAdvanced(bot, { ...emptyAdvancedState(), loaded: true, provider: value.provider, model: value.model, dirtyModel: true })
}

/** Seed a bot's Model row (the preview and tests). */
export function primeBotModel(bot: any, value: { provider: string; model: string }) {
  setBotModel(bot, { ...value, error: null })
}

const FOREGROUND = { spawnPriority: 'foreground' } as const

function setBotModelSettings(bot: any, patch: Partial<BotModelSettings>) {
  const key = rowKey(bot)
  roster2.modelSettings.set(all => ({ ...all, [key]: { effort: '', speed: '', error: null, ...all[key], ...patch, loading: false, loaded: true } }))
}

/** The sheet's Effort and Speed: `agent.reasoning_effort` and
 *  `agent.service_tier` from the bot's own profile config (`config.get full`
 *  is the user config without defaults, so a missing key reads as Default).
 *  Only those two values are kept. Read once per bot unless `force`. */
export async function loadBotModelSettings(bot: any, { force = false, foreground = false }: { force?: boolean; foreground?: boolean } = {}) {
  const key = rowKey(bot)
  const have = roster2.modelSettings.get()[key]
  if (have && !force && (have.loading || have.loaded)) return
  roster2.modelSettings.set(all => ({ ...all, [key]: { effort: '', speed: '', error: null, loaded: false, ...all[key], loading: true } }))
  try {
    const res: any = await request(bot, 'config.get', { key: 'full', profile: bot.name }, foreground ? FOREGROUND : {})
    setBotModelSettings(bot, { ...settingsFromConfig(res), error: null })
  } catch (error: any) {
    roster2.modelSettings.set(all => ({ ...all, [key]: { effort: '', speed: '', ...all[key], loading: false, loaded: false, error: String(error?.message || error) } }))
  }
}

/** Seed a bot's Effort and Speed (the preview and tests). */
export function primeBotModelSettings(bot: any, value: { effort: string; speed: string }) {
  setBotModelSettings(bot, { ...value, error: null })
}

export interface ModelSheetValue {
  provider: string
  model: string
  effort: string
  speed: string
}

/**
 * The model sheet's one Save: the model the way saveBotModel writes it, then
 * effort and speed (core/modelSheet.js sheetSavePlan), each only when it
 * changed. Every write dials foreground (a user action, like stock's
 * PROFILE_WRITE_METHODS). A refused or failed model stops the save there,
 * since Hermes checks Fast against the profile's model. Returns
 * `{ ok, applied: {model?, effort?, speed?}, confirmation?, errors }`.
 */
export async function saveBotModelSheet(bot: any, before: ModelSheetValue, next: ModelSheetValue) {
  const applied: Record<string, boolean> = {}
  const errors: Record<string, string> = {}
  let confirmation: any = null
  // `hermes --profile <name>` runs on the bot's own machine: the route's
  // backend profile name (config.set's `profile` is rewritten the same way).
  const backend = { name: resolveBotConnectionRoute(bot).route?.targetProfile || bot.name }
  for (const step of sheetSavePlan(backend, before, next) as any[]) {
    if (step.field === 'model') {
      const res: any = await saveBotModel(bot, { provider: next.provider, model: next.model })
      applied.model = res?.applied?.model === true
      confirmation = res?.confirmation || null
      if (!applied.model) break
      continue
    }
    try {
      const res = await request(bot, step.method, step.params, FOREGROUND)
      applied[step.field] = stepSucceeded(step, res)
      if (!applied[step.field]) errors[step.field] = String((res as any)?.output || (res as any)?.hint || 'refused').trim()
    } catch (error: any) {
      applied[step.field] = false
      errors[step.field] = String(error?.message || error)
    }
  }
  const settings: Partial<BotModelSettings> = {}
  if (applied.effort) settings.effort = next.effort
  if (applied.speed) settings.speed = next.speed
  if (Object.keys(settings).length) setBotModelSettings(bot, settings)
  if (Object.values(applied).some(ok => !ok)) void loadBotModelSettings(bot, { force: true })
  return { ok: Object.values(applied).every(Boolean), applied, confirmation, errors }
}

/** skills-hub.tsx:146 search (shared hub, active gateway) / :170 install (bot route). */
export async function searchSkills(query: string) {
  const res = await host.request('skills.manage', { action: 'search', query: String(query || '').trim() })
  return Array.isArray(res?.results) ? res.results : []
}

export async function installSkill(bot: any, name: string) {
  await request(bot, 'skills.manage', { action: 'install', query: name, profile: bot.name })
}

// ── R13 create ───────────────────────────────────────────────────────────

/** The Bot Chat creator (C3) a new bot's intro is handed to: stock's
 *  createCanonicalChat(slug, {kickoff}) (create-dialog.tsx:715). The chat
 *  side registers it; until then a new bot opens on its empty chat. */
let botChatCreator: null | ((bot: any, options: { kickoff: boolean }) => Promise<unknown>) = null
export function setBotChatCreator(fn: typeof botChatCreator) {
  botChatCreator = fn
}

export interface CreateBotInput {
  name: string
  slug: string
  title: string
  description: string
  target: string
  targetLabel?: string
  cloneFrom: string
  noSkills: boolean
  shareAuth: boolean
  customSoul: string
  model: string
  provider: string
  look: { shape: string; color: null | string; image: null | string }
  caps: any | null
  dirtyCaps: any
}

/** create-dialog.tsx:499-760, minus the draft-for-live-capabilities path
 *  (the override stages capability picks and applies them after create,
 *  exactly as stock's submit does when no draft exists). */
export async function createBot(input: CreateBotInput) {
  const remoteTarget = Boolean(input.target)
  const rq = (method: string, params: Record<string, unknown>) => requestOnTarget(host, input.target, method, params)
  const descriptionText = [input.title, input.description].filter(Boolean).join(' — ')
  let injected = false
  try {
    // data.ts:885 serverInjectsProtocol: the target's own flag.
    injected = Boolean((await rq('profiles.list', { include_sessions: false }))?.bot_mode_protocol)
  } catch {
    injected = false
  }
  const rosterForSoul = app.roster.get().rows.filter((b: any) => (remoteTarget ? b.connectionId === input.target : !b.remoteSource))
  await rq(
    'profiles.create',
    createProfileParams({
      slug: input.slug,
      descriptionText,
      cloneFrom: input.cloneFrom,
      remoteTarget,
      noSkills: input.noSkills,
      shareAuth: input.shareAuth,
      soul: composeSoul({ name: input.slug, title: input.title, description: input.description, roster: rosterForSoul, customSoul: input.customSoul, injected }),
      model: input.model,
      provider: input.provider
    })
  )
  if (typeof host?.dropLeftoverProfilePrefs === 'function') host.dropLeftoverProfilePrefs(input.slug, input.target || null)
  try {
    const capPayload = capabilityPayload(input.caps, input.dirtyCaps)
    if (Object.keys(capPayload).length) await rq('profiles.configure', { name: input.slug, ...capPayload })
  } catch {
    /* capability application is best-effort (stock) */
  }
  const look = newBotLook({ ...input.look, title: input.title })
  let row: any = remoteTarget
    ? { name: input.slug, description: descriptionText, title: input.title, connectionId: input.target, remoteSource: true, sourceScoped: true, route: { connectionId: input.target, mode: 'remote', profile: input.slug, targetProfile: input.slug } }
    : { name: input.slug, description: descriptionText, title: input.title }
  // Stock: a remote target gets ui_meta + avatar asset written directly
  // (create-dialog.tsx:582); a local one goes through saveBotMeta, which
  // writes the same ui_meta on the active gateway.
  if (remoteTarget) {
    const { image, ...rest } = look
    void rq('profiles.configure', { name: input.slug, ui_meta: { 'hermes-bots': rest } }).catch(() => undefined)
    if (image) void rq('profiles.set_asset', { name: input.slug, asset: 'avatar', data: image }).catch(() => undefined)
    recordWrite(row, rest, 'persisted')
  } else {
    await saveMeta(row, look, { label: 'The new bot’s look' })
  }
  // setup.runtime_check (create-dialog.tsx:657): a bot with no usable model
  // lands as "created, needs a model" instead of a doomed intro turn.
  const readiness: any = await rq('setup.runtime_check', { profile: input.slug }).catch(() => null)
  const needsModel = readiness?.ok === false
  const who = input.title || input.slug
  notify(needsModel ? 'warning' : 'success', needsModel ? `${who} created — it needs a model before it can answer.` : remoteTarget ? `${who} created on ${input.targetLabel || input.target}` : `${who} created`, needsModel && readiness?.error ? { detail: readiness.error } : {})
  invalidateRoster()
  if (remoteTarget) return { row, needsModel, kickedOff: false }
  // The roster's own row for the new bot (it may carry a route the
  // synthesized one lacks), once the re-read has it.
  row = (await waitForRow(input.slug)) || row
  // Birth the Bot Chat with its intro (stock: local targets only).
  selectBot(row)
  let kickedOff = false
  if (botChatCreator) {
    try {
      await botChatCreator(row, { kickoff: !needsModel })
      kickedOff = !needsModel
    } catch (error) {
      notifyError(error, 'The bot was created, but its Bot Chat could not be started')
    }
  }
  return { row, needsModel, kickedOff }
}

async function waitForRow(name: string, tries = 10) {
  for (let i = 0; i < tries; i += 1) {
    const found = app.roster.get().rows.find((b: any) => b?.name === name && !b?.remoteSource)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return null
}

export async function listConnections(): Promise<any[]> {
  if (typeof host?.connections !== 'function' || typeof host?.requestProfile !== 'function') return []
  try {
    const value = await host.connections()
    return Array.isArray(value) ? value : Array.isArray(value?.connections) ? value.connections : []
  } catch {
    return []
  }
}

/** The clone source's catalog, before the profile exists (create-dialog.tsx:436). */
export async function loadCreateCatalog(target: string, source: string) {
  const rq = (method: string, params: Record<string, unknown>) => requestOnTarget(host, target, method, params)
  const [res, cat]: any = await Promise.all([rq('profiles.describe', { name: source }), rq('mcp.catalog', {}).catch(() => null)])
  const configured = res?.mcp_servers || []
  const have = new Set(configured.map((m: any) => m.name))
  return {
    source,
    skills: res?.skills || [],
    toolsets: res?.toolsets || [],
    mcp: [
      ...configured,
      ...((cat && cat.servers) || [])
        .filter((s: any) => !have.has(s.name))
        .map((s: any) => ({ name: s.name, enabled: false, fromCatalog: true, installed: s.installed, auth: s.auth, requires: s.requires || [], description: s.description || '' }))
    ]
  }
}

/** avatar-image.ts:80 probe and :107 generate (active gateway). */
export async function probeImageGeneration() {
  try {
    return Boolean((await host.request('image.generate', { probe: true }))?.available)
  } catch {
    return false
  }
}

export async function generateAvatar(name: string, title: string, description: string) {
  const who = [title || name, description].filter(Boolean).join(' — ')
  const res = await host.request(
    'image.generate',
    {
      prompt: `Cute minimal robot avatar for an AI agent named "${who}". Friendly simple mascot face, bold flat vector style, solid color background, centered, no text.`,
      aspect_ratio: 'square'
    },
    90_000
  )
  if (!res?.success) throw new Error(res?.error || 'generation failed')
  return String(res.image_data || res.image || '')
}

// ── P3 cron ──────────────────────────────────────────────────────────────

function activeProfile() {
  try {
    return String(host?.state?.profile?.get?.() || '')
  } catch {
    return ''
  }
}

function cronStoreOwns(bot: any) {
  return app.cron.get().key === rowKey(bot)
}

async function reloadCronFor(bot: any) {
  if (cronStoreOwns(bot)) await loadCron(bot)
}

/** cron.tsx:1013 */
export async function createJob(bot: any, form: { title: string; instruction: string; sched: any; continuity: boolean; target: string }) {
  await request(bot, 'cron.manage', cronAddParams({ profile: String(bot.name), ...form, activeProfile: activeProfile() }))
  await reloadCronFor(bot)
  notify('success', `Scheduled: ${form.title}`)
}

/** cron.tsx:507 (remove). Only a job listed for this bot. */
export async function removeJob(bot: any, job: any) {
  const store = app.cron.get()
  if (store.key !== rowKey(bot) || !store.jobs.some((j: any) => j.job_id === job.job_id)) throw new Error('That job is not listed for this bot.')
  await request(bot, 'cron.manage', cronRemoveParams(bot, job))
  await reloadCronFor(bot)
}

function restApi() {
  const api = (globalThis as any).window?.hermesDesktop?.api
  if (typeof api !== 'function') throw new Error('This Hermes build has no REST bridge for jobs')
  return api
}

/** The bot's REST scope (its own connection and profile, routing.js
 *  botRestScope; refuses a row whose route is not known). */
export function botScope(bot: any): { connectionId?: string; profile: string } {
  return botRestScope(bot, activeConnection())
}

/** One dashboard REST call on the bot's own connection and profile
 *  (api/client.ts hermesApiAs). `request` already carries the scope. */
export function botRest(request: { path: string; method?: string; body?: unknown; timeoutMs?: number; connectionId?: string; profile: string; priority?: string }) {
  return restApi()(request)
}

/** apps/desktop/src/api/cron.ts:43 getCronJob, on the bot's scope: the
 *  stored record (full prompt, model pin) the editor edits; the cron.manage
 *  list only carries a 100-character prompt_preview (review v2-r2 H1). */
export async function loadJob(bot: any, job: any) {
  const scope = botRestScope(bot, activeConnection())
  const stored = await restApi()({ ...(scope.connectionId ? { connectionId: scope.connectionId } : {}), profile: scope.profile, priority: 'foreground', path: cronJobRestPath(job), method: 'GET' })
  if (!isStoredJobFor(job, stored)) throw new Error('Hermes did not return this job’s stored record')
  return stored
}

/** apps/desktop/src/api/cron.ts:93 updateCronJob, on the bot's scope.
 *  `job` is the listed job: its id addresses the write. `form.stored` is the
 *  record loadJob returned: it only supplies the content the update is
 *  computed from, and must be that job's record (review v2-r3 M1). */
export async function editJob(
  bot: any,
  job: any,
  form: { title: string; prompt?: string; sched: any; initialSchedule?: string; deliver?: string; model?: string; provider?: string; stored?: any }
) {
  const { stored, ...fields } = form
  if (stored !== undefined && !isStoredJobFor(job, stored)) throw new Error('The loaded record is not this job’s, so nothing was saved')
  const path = cronJobRestPath(job)
  const scope = botRestScope(bot, activeConnection())
  const updates = cronEditUpdates({ profile: String(bot.name), job: stored ?? job, ...fields })
  await restApi()({ ...(scope.connectionId ? { connectionId: scope.connectionId } : {}), profile: scope.profile, priority: 'foreground', path, method: 'PUT', body: { updates } })
  await reloadCronFor(bot)
  notify('success', `Updated: ${form.title}`)
}

/** apps/desktop/src/api/cron.ts:121 triggerCronJob (waits for the run). */
export async function runJob(bot: any, job: any) {
  const id = String(job?.job_id || '')
  if (!id || roster2.running.get()[id]) return
  const scope = botRestScope(bot, activeConnection())
  roster2.running.set(s => ({ ...s, [id]: true }))
  notify('info', `Running ${job.name || id}…`)
  try {
    await restApi()({ ...(scope.connectionId ? { connectionId: scope.connectionId } : {}), profile: scope.profile, priority: 'foreground', path: cronJobRestPath(job, '/trigger'), method: 'POST', timeoutMs: CRON_TRIGGER_REQUEST_TIMEOUT_MS })
    notify('success', `Ran ${job.name || id}`)
  } catch (error) {
    notifyError(error, `Could not run ${job.name || id}`)
  } finally {
    roster2.running.set(s => {
      const next = { ...s }
      delete next[id]
      return next
    })
    await reloadCronFor(bot)
  }
}

// ── R15 attention + C25 usage watchers ───────────────────────────────────

let offEvents: null | (() => void) = null
let offChat: null | (() => void) = null
let usageRuntime = ''

/** session.usage on attach and after each turn (a read). */
async function readUsage(bot: any, runtimeId: string, key: string) {
  try {
    const usage = await request(bot, 'session.usage', { session_id: runtimeId })
    const cur = roster2.usage.get()
    if (cur.key === key && cur.runtimeId === runtimeId) roster2.usage.set({ ...cur, usage: mergeUsage(cur.usage, usage), error: null })
  } catch (error: any) {
    const cur = roster2.usage.get()
    if (cur.key === key && cur.runtimeId === runtimeId) roster2.usage.set({ ...cur, error: String(error?.message || error) })
  }
}

function onChatState(state: any) {
  const key = state?.bot ? rowKey(state.bot) : ''
  const runtimeId = String(state?.runtimeId || '')
  const cur = roster2.usage.get()
  if (cur.key !== key) roster2.usage.set({ key, runtimeId, usage: null, error: null })
  else if (cur.runtimeId !== runtimeId) roster2.usage.set({ ...cur, runtimeId })
  if (runtimeId && runtimeId !== usageRuntime && state?.bot) {
    usageRuntime = runtimeId
    void readUsage(state.bot, runtimeId, key)
  }
  if (!runtimeId) usageRuntime = ''
}

function onGatewayEvent(event: any) {
  const state = app.chat.get()
  const runtimeId = String(state?.runtimeId || '')
  if (!state?.bot || !runtimeId || String(event?.session_id || '') !== runtimeId) return
  const key = rowKey(state.bot)
  const usage = usageFromEvent(event, runtimeId)
  if (usage) {
    const cur = roster2.usage.get()
    if (cur.key === key) roster2.usage.set({ ...cur, usage: mergeUsage(cur.usage, usage) })
  }
  const verdict = attentionFromEvent(event)
  if (verdict?.kind === 'fail') roster2.attention.set(map => noteAttention(map, key, verdict.text))
  else if (verdict?.kind === 'ok') roster2.attention.set(map => clearAttention(map, key))
  if (event?.type === 'message.complete') void readUsage(state.bot, runtimeId, key)
}

export function startRosterParity() {
  loadMetaWrites()
  if (!offChat) {
    offChat = app.chat.subscribe(() => onChatState(app.chat.get()))
    onChatState(app.chat.get())
  }
  if (!offEvents) {
    const tap = typeof app.ctx?.onEvent === 'function' ? app.ctx.onEvent : typeof host?.onEvent === 'function' ? host.onEvent : null
    offEvents = tap ? tap('*', onGatewayEvent) : null
  }
}

const stopHooks = new Set<() => void>()
/** Run on toggle-off (open screens close with the override). */
export function onRosterParityStop(fn: () => void) {
  stopHooks.add(fn)
}

export function stopRosterParity() {
  for (const fn of stopHooks) {
    try {
      fn()
    } catch {
      /* isolated */
    }
  }
  offEvents?.()
  offEvents = null
  offChat?.()
  offChat = null
  usageRuntime = ''
  roster2.dialog.set(null)
}

/** Test seam: feed an event as if it came from the gateway tap. */
export const _onGatewayEvent = onGatewayEvent

export function attentionFor(bot: any) {
  const map = roster2.attention.get()
  return map[rowKey(bot)] || map[botMetaKey(bot)] || null
}
