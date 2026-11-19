// The override's runtime: toggle, roster loop, the open chat, fallbacks.

import { canonicalIds, CANONICAL_CHAT_TITLE, expectHistory, findCanonicalChat, openedSessionId } from '../core/canonical.js'
import { historyToItems } from '../core/history.js'
import {
  annotateSources,
  botForSession,
  keepRows,
  sameData,
  dropDeadRows,
  liveRosterNames,
  botMeta,
  buildSections,
  displayName,
  mergeRoster,
  ownSectionOf,
  readStockRoster,
  rowKey,
  sourceUnreachable
} from '../core/roster.js'
import { botRestScope, botRouteProblem, botWorkspaceOwnerKey, createBotRequester, isLocalBot, resolveBotConnectionRoute, retainBotRoute, stockOpenTarget } from '../core/routing.js'
import { cronListParams, cronToggleParams, jobActive, sortJobs } from '../core/cron.js'
import { filePath, isDataUrl, mediaReadRequest } from '../core/media.js'
import { workspaceReadRequest } from '../core/directives.js'
import { transcribeRequest } from '../core/voice.js'
import { createChatController, IDLE_REFRESH_MS, seedFromState } from '../core/session.js'
import { createStockController, OVERRIDE_ROSTER_PANE_ID, STOCK_PANE_ID } from '../core/stock.js'
import { dragPanelWidth, PANEL_WIDTH, PANEL_WIDTH_KEY, storedPanelWidth } from '../core/panelWidth.js'
import { PINS_KEY, pinsFrom, pinState, togglePin } from '../core/pins.js'
import {
  addSection,
  assignBot,
  deleteSection,
  emptySections,
  LEGACY_SECTIONS_PLUGIN,
  loadSections,
  moveSection,
  renameSection,
  SECTIONS_KEY,
  toggleSectionCollapsed
} from '../core/sections.js'
import { LEGACY_SHOW_WORK_KEY, LEGACY_SHOW_WORK_PLUGIN, loadShowWork, SHOW_WORK_KEY } from '../core/workRows.js'
import { botCanonicalSessionId, createActivityTracker } from '../core/activity.js'
import { looksUnsupported } from '../core/outcomes.js'
import { resetMarker, SEEN_KEY, seenFrom, stepMarker } from '../core/newMarker.js'
import { createRoom, createRoomController, createRoomRequester, listRooms, ROOM_LIST_MS, roomRoute } from '../core/rooms.js'
import { createBackgroundPolls, createIdleRotation } from '../core/backgroundPolls.js'
import { CANONICAL_HYDRATION_TIMEOUT_MS, host, queryClient, readPluginStorage, sdk } from './sdk'
// ── roster-side parity (R6 R9 R11-R13 R15 P3 P4 P6 C21 C25) ──
import { effectiveMeta } from '../core/botMeta.js'
import { gatewayMetaFor } from '../core/gatewayMeta.js'
import { createRemoteAvatars } from '../core/remoteAvatars.js'
import { noteGatewayProfiles, startRosterParity, stopRosterParity } from './rosterActions'
import { roster2 } from './rosterStores'
// ── end roster-side parity imports ──
import { createStore, type Store } from './store'
import { CSS, STYLE_ID } from './styles'

declare const __GBO_PROBE__: boolean

export const PLUGIN_ID = 'grokbot-override'
export const WORKSPACE_ID = 'grokbot-override'
const ROSTER_TICK_MS = 3_000
// The own roster read: the FULL `profiles.list` (with each profile's session
// summaries) on the active gateway, at most once per 60 s while the window is
// visible (and Bot Mode's own snapshot is not fresh), never while it is
// hidden, backed off while the gateway is slow or failing
// (core/backgroundPolls.js). In the background it is two separate polls: the
// rich read on the active connection's lane only (other connections never
// hold it up), and the union roster (host.agents) as a global poll every
// 60 s; each repaints with the other's last answer. A foreground read (a
// write's re-read, Retry) does both at once.
//
// Why the full payload and not `{ include_sessions: false }`: the roster's
// previews (roster.js previewOf), unread dots and activity toasts
// (activity.js: canonical_session / last_session `last_active` + `preview`),
// the "working" mark (rosterView.js worker_session), the canonical Bot Chat id
// a click opens (canonical.js, botForSession, ackBot) all come ONLY from the
// session fields, and `include_sessions` is the handler's only knob (Hermes
// tui_gateway/methods_profiles.py "profiles.list": a boolean, no limit; the
// gateway already reads just the Bot Chat row and the newest session per
// profile). A light read would blank all of those, so the session data is
// fetched less often instead of lighter. While Bot Mode's own snapshot is
// fresh only the union poll runs (it prunes deleted bots, dropDeadRows).
export const OWN_FETCH_MIN_MS = 60_000
// Even while the stock snapshot is fresh, re-list the sources this often so
// bots deleted on a machine leave the roster (dropDeadRows).
export const OWN_VERIFY_MS = 60_000
/** The periodic own read's request: the full roster (see above). */
export const OWN_ROSTER_PARAMS = Object.freeze({})

// The override starts on (it is the kit's main plugin); the palette toggle
// switches back to stock Bot Mode and that choice is remembered.
export const DEFAULT_ON = true

export interface RosterState {
  rows: any[]
  sources: any[]
  origin: 'none' | 'stock' | 'own'
  error: null | string
  updatedAt: number
  localMeta: Record<string, any>
  /** The active gateway's bot_mode_protocol flag (data.ts:885). */
  protocolInjected?: boolean
}

/** The roster's own sections (core/sections.js). */
export interface SectionsState {
  version: number
  sections: Array<{ id: string; name: string; collapsed: boolean }>
  assign: Record<string, string>
}

export const app = {
  ctx: null as any,
  enabled: createStore<boolean>(false),
  roster: createStore<RosterState>({
    rows: [],
    sources: [],
    origin: 'none',
    error: null,
    updatedAt: 0,
    localMeta: {}
  }),
  query: createStore(''),
  // Collapsed default sections (by name); the own sections keep theirs.
  collapsed: createStore<string[]>([]),
  // The roster's own sections, in the override's plugin storage.
  sections: createStore<SectionsState>(emptySections()),
  selectedKey: createStore(''),
  panelOpen: createStore(true),
  // The profile panel's width (core/panelWidth.js), dragged from its hairline.
  panelWidth: createStore<number>(PANEL_WIDTH.default),
  // The workspace pane is narrower than the profile panel needs: the panel
  // becomes a drawer over the chat, opened only on request (review r1 #9).
  narrow: createStore(false),
  drawerOpen: createStore(false),
  chat: createStore<any>(null),
  cron: createStore<{ key: string; loading: boolean; error: null | string; jobs: any[]; busy: Record<string, boolean> }>({
    key: '',
    loading: false,
    error: null,
    jobs: [],
    busy: {}
  }),
  screen: createStore<{ key: string; status: any }>({ key: '', status: null }),
  // Gateway-owned group chats on the active source (PARITY R14).
  rooms: createStore<{ route: any; rooms: any[]; error: null | string; loaded: boolean }>({ route: null, rooms: [], error: null, loaded: false }),
  computerViewer: createStore<{ present: boolean; visible: boolean }>({ present: false, visible: false }),
  // Thought and tool rows in the Bot Chat (core/workRows.js): hidden unless
  // the override's "show work rows" setting is on.
  showWork: createStore<boolean>(false),
  // Bots pinned to the top of the sidebar (core/pins.js): route keys in pin
  // order, kept in the override's own plugin storage.
  pinnedBots: createStore<string[]>([]),
  // Whether the roster pane is on screen (Hermes's sidebar open): the chat
  // header shows its own sidebar toggle while it is not.
  rosterShown: createStore<boolean>(true),
  // The sidebar footer's name ('' = unknown: the footer says "You").
  userName: createStore<string>('')
}

let requestForBot: any = null
let controller: any = null
let controllerKey = ''
// Chats the user closed (or switched away from) while a send or a turn was
// still running: kept attached, without UI, until that settles (review r2 #5).
const retiring = new Map<string, any>()
let offController: null | (() => void) = null
let paneDispose: null | (() => void) = null
let closeWorkspace: null | (() => void) = null
// Whether the chat tab was on screen (plugin storage; informational). The
// plugin's own teardown never clears it, only the user's close does.
export const CHAT_OPEN_KEY = 'chatOpen'
let closingQuietly = false
// The main pane belongs to the override while it is on (see claimMainPane).
let unwatchMain: Array<() => void> = []
let claimQueued = false
let stock: any = null
let observer: MutationObserver | null = null
let rosterTimer: null | (() => void) = null
// Server avatars of bots on other connections (core/remoteAvatars.js).
let remoteAvatars: null | ReturnType<typeof createRemoteAvatars> = null
let unwatchAvatars: null | (() => void) = null
// When the own read last answered (it may have changed nothing).
let lastOwnRead = 0
// What each source listed on the last fresh read (core/roster.js liveRosterNames).
let liveNames: Map<string, Set<string>> = new Map()
// Background polls (roster, source re-list, rooms, the open chats' idle
// refresh): one lane per connection, a deadline, backoff, nothing while
// hidden (core/backgroundPolls.js). `pollEpoch` moves on disable/stop: work
// started before it never applies a result or starts a follow-up.
let pollClock: () => number = () => Date.now()
export const polls = createBackgroundPolls({ now: () => pollClock(), isVisible: () => isVisible() })
let pollEpoch = 0
/** Tests: drive the background polls' clock. */
export function setPollClock(now: null | (() => number)) {
  pollClock = now || (() => Date.now())
}
/** The lane of the active connection (the roster, its re-list and rooms). */
function activeLane() {
  return activeConnectionId() || 'local'
}
/** The lane of a bot's own connection (its chat's idle refresh). */
function botLane(bot: any) {
  try {
    const route = resolveBotConnectionRoute(bot).route
    if (route?.connectionId) return String(route.connectionId)
  } catch {
    /* fall through */
  }
  if (bot?.connectionId) return String(bot.connectionId)
  return isLocalBot(bot, activeConnectionId()) ? 'local' : activeLane()
}
/** The union roster (host.agents) is read by Electron from EVERY registered
 *  connection, reading `/api/profiles` from each non-SSH one, including
 *  connections the plugin has not seen yet; the plugin cannot list the
 *  registry, so that read is a `global` background run: it waits until no
 *  other background poll runs anywhere and holds every lane while it runs,
 *  except the lanes known to be SSH sources (they answer from an inventory
 *  probe, not their gateway): from the last union answer, the roster rows
 *  and the open chats. */
function sshLanes(): string[] {
  const ids = new Set<string>()
  const add = (id: any, kind: any) => {
    const lane = String(id || '').trim()
    if (lane && String(kind || '') === 'ssh') ids.add(lane)
  }
  for (const source of app.roster.get().sources || []) add(source?.connectionId, source?.kind)
  for (const row of app.roster.get().rows || []) add(row?.route?.connectionId || row?.connectionId, row?.connectionKind)
  for (const chats of idleChatsByLane().values()) for (const chat of chats) {
    const bot = chat?.get?.()?.bot
    add(botLane(bot), bot?.connectionKind)
  }
  // A lane listed as SSH by one record and as a gateway by another is held.
  for (const source of app.roster.get().sources || []) {
    if (String(source?.kind || '') !== 'ssh') ids.delete(String(source?.connectionId || '').trim())
  }
  return [...ids]
}
/** False when the union answer says a source it read failed (a per-source
 *  error other than "connect on demand"): the poll backs off. */
function unionHealthy(union: any) {
  return !(Array.isArray(union?.sources) ? union.sources : []).some(
    (source: any) => source?.error && String(source.error) !== 'connect-on-demand' && String(source?.kind || '') !== 'ssh'
  )
}

// One freshness order for everything that rewrites the roster (own reads and
// source re-lists): a read applies only if nothing newer superseded it. Any
// later read supersedes a background read; only a later foreground read (or
// disable) supersedes a foreground one, so a slow background answer never
// undoes a write's re-read (or a Retry).
// One freshness order per kind of read (the rich `profiles.list`, the union
// roster): an answer applies only if nothing newer of its kind superseded
// it. Any later read supersedes a background read; only a later foreground
// read (or disable) supersedes a foreground one, so a slow background answer
// never undoes a write's re-read (or a Retry).
type ReadKind = 'rich' | 'union'
const readGens: Record<ReadKind, { all: number; fg: number }> = { rich: { all: 0, fg: 0 }, union: { all: 0, fg: 0 } }
function beginRead(kinds: ReadKind[], foreground: boolean) {
  const snap = kinds.map(kind => {
    readGens[kind].all += 1
    if (foreground) readGens[kind].fg += 1
    return { kind, all: readGens[kind].all, fg: readGens[kind].fg }
  })
  return () => snap.every(({ kind, all, fg }) => (foreground ? fg === readGens[kind].fg : all === readGens[kind].all))
}
function supersedeReads() {
  for (const gen of Object.values(readGens)) {
    gen.all += 1
    gen.fg += 1
  }
}
// The last answers of each kind, so either poll can repaint the merged roster.
let lastLocal: null | { connection: null | string; data: any } = null
let lastUnion: any = null

/** Paint the own roster from a rich read and a union answer (either may be
 *  the last one known). */
function paintOwn(local: any, union: any, active: null | string) {
  // No union answer yet: keep the sources already known (never forget them).
  const sources = union ? (Array.isArray(union.sources) ? union.sources : []) : app.roster.get().sources || []
  const rows = dropDeadRows(annotateSources(mergeRoster(local, union, active), sources), liveNames)
  lastOwnRead = Date.now()
  app.roster.set(s => {
    // updatedAt moves only with a real change; lastOwnRead says how fresh it is.
    return mergeRosterState(s, { rows, sources, origin: 'own', error: null, updatedAt: lastOwnRead, protocolInjected: Boolean(local?.bot_mode_protocol) })
  })
  trackActivity()
}

/** The background rich read: `profiles.list` on the active connection only. */
async function readRich(live: () => boolean = () => true): Promise<boolean> {
  const current = beginRead(['rich'], false)
  const fresh = () => current() && live()
  const active = activeConnectionId()
  try {
    const local = await host.request('profiles.list', { ...OWN_ROSTER_PARAMS })
    if (!fresh()) return true
    lastLocal = { connection: active, data: local }
    paintOwn(local, lastUnion, active)
    return true
  } catch (error: any) {
    if (!fresh()) return false
    const message = String(error?.message || error)
    app.roster.set(s => (s.error === message ? s : { ...s, error: message }))
    return false
  }
}

/** The background union read (host.agents): repaints the own roster with the
 *  last rich read of the active connection, or, while the stock snapshot is
 *  in use, drops the rows a source no longer returns (rows are never added
 *  from it alone). False: the read failed or a non-SSH source errored. */
async function readUnion(live: () => boolean = () => true): Promise<boolean> {
  if (typeof host?.agents !== 'function') return true
  const current = beginRead(['union'], false)
  try {
    const union = await host.agents()
    if (!current() || !live()) return true
    lastUnion = union
    liveNames = liveRosterNames(union)
    const active = activeConnectionId()
    if (app.roster.get().origin === 'own' && lastLocal && lastLocal.connection === active) {
      paintOwn(lastLocal.data, union, active)
    } else {
      app.roster.set(s => {
        const rows = dropDeadRows(s.rows, liveNames)
        return rows.length === s.rows.length ? s : { ...s, rows }
      })
    }
    return unionHealthy(union)
  } catch {
    return false
  }
}
let raf = 0
let unwatchPane: null | (() => void) = null
let unwatchComputer: null | (() => void) = null

// ── storage ──────────────────────────────────────────────────────────────

function storageGet<T>(key: string, fallback: T): T {
  try {
    const value = app.ctx?.storage?.get?.(key, fallback)
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function storageSet(key: string, value: unknown) {
  try {
    app.ctx?.storage?.set?.(key, value)
  } catch {
    /* holds for this window */
  }
}

// ── roster ───────────────────────────────────────────────────────────────

export function activeConnectionId(): null | string {
  try {
    return host?.state?.connectionId?.get?.() ?? host?.activeConnectionId?.() ?? null
  } catch {
    return null
  }
}

// Bot Mode's local meta, parsed again only when its stored text changes, so
// a roster tick hands the store the same object (T2).
const LOCAL_META_KEY = 'hermes.plugin.hermes-bots.bot-meta-v2'
let sideRaw: null | string | undefined = undefined
let sideMeta: Record<string, any> = {}

function readSideData() {
  let raw: null | string = null
  try {
    raw = globalThis.localStorage?.getItem(LOCAL_META_KEY) ?? null
  } catch {
    raw = null
  }
  if (raw !== sideRaw) {
    sideRaw = raw
    const localMeta = readPluginStorage<Record<string, any>>('hermes-bots', 'bot-meta-v2', {}) || {}
    sideMeta = localMeta && typeof localMeta === 'object' ? localMeta : {}
  }
  return { localMeta: sideMeta }
}

/** The roster state with only what changed replaced; `s` itself when
 *  nothing did (store.ts skips an identical value, so nobody re-renders).
 *  A new `updatedAt` alone is not a change. */
function mergeRosterState(s: RosterState, patch: Partial<RosterState>): RosterState {
  let changed = false
  const next: any = { ...s }
  for (const [key, value] of Object.entries(patch)) {
    const old = (s as any)[key]
    let kept = value
    if (key === 'rows') kept = keepRows(old, value as any[])
    else if (key === 'sources' && sameData(old, value)) kept = old
    if (key !== 'updatedAt' && !Object.is(kept, old)) changed = true
    next[key] = kept
  }
  return changed ? next : s
}

/** The own roster read (see OWN_FETCH_MIN_MS). Never throws; false = the
 *  read failed, in whole or in part (a failed union roster or a source that
 *  errored): whatever answered is still painted, the background poll backs
 *  off. `live()` false or a newer read = the answer is dropped. */
async function fetchOwnRoster({ foreground = false, live = () => true }: { foreground?: boolean; live?: () => boolean } = {}): Promise<boolean> {
  const current = beginRead(['rich', 'union'], foreground)
  const fresh = () => current() && live()
  try {
    const active = activeConnectionId()
    const local = await host.request('profiles.list', { ...OWN_ROSTER_PARAMS })
    // Between the two reads: a stopped plugin, a newer read, a run past its
    // deadline, or (background) a hidden window starts no union read.
    if (!fresh() || (!foreground && !isVisible())) return true
    let union: any = null
    let unionOk = true
    if (typeof host.agents === 'function') {
      try {
        union = await host.agents()
        unionOk = unionHealthy(union)
      } catch {
        union = null
        unionOk = false
      }
    }
    if (!fresh()) return true
    lastLocal = { connection: active, data: local }
    if (union) {
      lastUnion = union
      liveNames = liveRosterNames(union)
    }
    paintOwn(local, union, active)
    return unionOk
  } catch (error: any) {
    if (!fresh()) return false
    const message = String(error?.message || error)
    app.roster.set(s => (s.error === message ? s : { ...s, error: message }))
    return false
  }
}

// ── unread marks and activity toasts (PARITY R16, R17) ───────────────────
// Bot Mode runs this tracker in its own roster pane, which is not on screen
// while the override is; so the override runs the same one (core/
// activity.js) on its own roster refresh. While stock Bot Mode is fronted
// (a peek) the override pauses and re-seeds afterwards, so the two never
// mark or toast the same activity twice.
const activity = createActivityTracker({
  selectedKey: () => (controller ? controllerKey : ''),
  isHidden: (bot: any) => Boolean(metaFor(bot)?.hidden),
  label: (bot: any) => String(metaFor(bot)?.title || bot.display_name || bot.title || bot.name),
  markUnread: (sessionId: string, profile: string) => {
    try {
      ;(sdk as any).markSessionUnreadFinished?.(sessionId, profile)
    } catch {
      /* older desktop */
    }
  },
  toastsEnabled: () => readPluginStorage<boolean>('hermes-bots', 'activity-toasts', false) === true,
  notify: (n: any) => host?.notify?.(n),
  // Activity on the open chat: a background re-read (coalesced, on its
  // connection's lane, never while hidden), not a direct read.
  refreshOpen: () => requestOpenRefresh()
})
let activityPaused = false

function trackActivity() {
  if (!app.enabled.get()) return
  if (stock?.isPeeking?.()) {
    activityPaused = true
    return
  }
  if (activityPaused) {
    activityPaused = false
    activity.reseed()
  }
  activity.track(app.roster.get().rows)
}

/** Opening a bot reads its activity (roster-actions.ts:286 ackStoredSessionId). */
function ackBot(bot: any) {
  const id = botCanonicalSessionId(bot)
  if (!id) return
  try {
    ;(sdk as any).ackStoredSessionId?.(id, bot.name)
  } catch {
    /* older desktop */
  }
}

export function refreshRoster() {
  const side = readSideData()
  const cached = readStockRoster(queryClient(), activeConnectionId())
  // An own read newer than the stock snapshot wins (a Retry, or a stock
  // roster that stopped refreshing while its pane is off screen).
  const own = app.roster.get()
  if (cached && cached.profiles.length && !(own.origin === 'own' && Math.max(own.updatedAt, lastOwnRead) > cached.updatedAt)) {
    // A stock snapshot taken while the union roster failed has no sources
    // (data.ts keeps its rows painted as unreachable and the pane falls back
    // to its remembered sources): annotate with the last sources known here.
    const sources = cached.sources.length ? cached.sources : own.sources
    app.roster.set(s =>
      mergeRosterState(s, {
        ...side,
        rows: dropDeadRows(annotateSources(cached.profiles, sources), liveNames),
        sources,
        origin: 'stock',
        error: null,
        updatedAt: cached.updatedAt
      })
    )
  } else {
    app.roster.set(s => mergeRosterState(s, side))
  }
  // Local bookkeeping (unread marks, toasts) runs even while hidden; the
  // network polls below do not.
  ownReadWanted = !cached || !cached.fresh
  noteVisibility()
  trackActivity()
  pumpPolls()
}

// ── background passes ────────────────────────────────────────────────────
// Every 3 s tick (and after each finished run) offers each background poll a
// turn: the roster read (or re-list) on the active connection and every lane
// the union roster touches, the room list on the active connection, and one
// idle-refresh pass per connection with open chats (every eligible chat in
// turn, so side-by-side chats all stay current). A poll whose lanes are busy
// or which is not due is skipped; nothing is awaited here, so a slow
// connection never holds another one's polls.

let ownReadWanted = true
// The union poll's own key (it is not tied to one connection).
export const UNION_LANE = '*union'
let lastSeenVisible = true
const idleRotation = createIdleRotation()

/** Both sides of every visibility change, from the visibilitychange event
 *  and from the 3 s tick (a missed event): on hidden -> visible, however
 *  short the hide, every poll is due once, backoff aside. */
function noteVisibility() {
  const visible = isVisible()
  if (visible && !lastSeenVisible) polls.resume()
  lastSeenVisible = visible
}

function pumpPolls() {
  if (!isVisible()) return
  const epoch = pollEpoch
  const after = (result: Promise<any>) =>
    void result.then(r => {
      if (r?.ran && epoch === pollEpoch) pumpPolls()
    })
  const lane = activeLane()
  // The rich read holds only the active connection; the union read is a
  // global poll that, once due, reserves its lanes (core/backgroundPolls.js).
  if (ownReadWanted) after(polls.run(lane, 'roster', OWN_FETCH_MIN_MS, live => readRich(live), { resumeMinMs: OWN_FETCH_MIN_MS }))
  after(polls.run(UNION_LANE, 'union', OWN_VERIFY_MS, live => readUnion(live), { global: { except: sshLanes() } }))
  after(polls.run(lane, 'rooms', ROOM_LIST_MS, live => listRoomsNow(live, true)))
  for (const [chatLane, chats] of idleChatsByLane()) {
    after(polls.run(chatLane, 'idle', IDLE_REFRESH_MS, live => idleRotation.pass(chatLane, chats, live, isVisible)))
  }
}

/** The chats with an idle refresh, by their bot's connection. */
function idleChatsByLane() {
  const byLane = new Map<string, any[]>()
  const add = (chat: any) => {
    if (!chat || chat.isDisposed?.() || chat.isRetiring?.() || typeof chat.idleRefresh !== 'function') return
    const lane = botLane(chat.get?.()?.bot)
    const list = byLane.get(lane) || []
    if (!list.includes(chat)) list.push(chat)
    byLane.set(lane, list)
  }
  add(controller)
  for (const tab of tabs.values()) add(tab.controller)
  return byLane
}

/** Activity on the open chat: its connection's idle pass is due once. */
function requestOpenRefresh() {
  const bot = controller?.get?.()?.bot
  if (!bot) return
  polls.want(botLane(bot), 'idle')
  pumpPolls()
}

/** Bot Mode's effective meta for a row: server ui_meta over the local
 *  snapshot, plus this desktop's own pending writes (core/botMeta.js). A row
 *  with no listing meta (an SSH source) is named by its own gateway's meta,
 *  read this session or cached (core/gatewayMeta.js). */
export function metaFor(bot: any) {
  const { fresh, cache } = roster2.gatewayMeta.get()
  return effectiveMeta(bot, app.roster.get().localMeta, roster2.metaWrites.get(), Date.now(), gatewayMetaFor(bot, fresh, cache))
}

export function activeConnection(): null | string {
  return activeConnectionId()
}

/** Re-read the roster now (stock's invalidate-after-write, and R9 Retry). */
export function reloadRoster() {
  // Foreground (a write, R9 Retry): straight to the gateway, never through
  // the background lanes, and it supersedes a background read or re-list in
  // flight.
  void fetchOwnRoster({ foreground: true })
}

export function sections() {
  const r = app.roster.get()
  return buildSections(r.rows, { metaFor, sections: app.sections.get(), query: app.query.get() })
}

export function findBot(key: string) {
  if (!key) return null
  return app.roster.get().rows.find(bot => rowKey(bot) === key) || null
}

/** The roster's current row for a bot object that may be stale (a chat
 *  opened before its route arrived): the same key, else the same name on the
 *  same connection now that it carries a route. */
export function freshBot(bot: any) {
  if (!bot) return null
  const same = findBot(rowKey(bot))
  if (same) return same
  const name = String(bot.name || '')
  const connectionId = String(bot.connectionId || '')
  return (
    app.roster.get().rows.find(
      row => String(row?.name || '') === name && String(row?.connectionId || '') === connectionId && resolveBotConnectionRoute(row).route
    ) || bot
  )
}

// ── chat ─────────────────────────────────────────────────────────────────

function readHistory(bot: any, sessionId: string, { limit, offset }: { limit: number; offset: number }) {
  const api = (globalThis as any).window?.hermesDesktop?.api
  if (typeof api !== 'function') return Promise.reject(new Error('This Hermes build has no transcript reader'))
  const scope = botRestScope(bot, activeConnectionId())
  const query = new URLSearchParams({
    profile: scope.profile,
    limit: String(limit),
    offset: String(offset),
    order: 'latest',
    include_compacted: 'true',
    inline_images: 'false'
  })
  return api({
    ...(scope.connectionId ? { connectionId: scope.connectionId } : {}),
    profile: scope.profile,
    path: `/api/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`
  })
}

// ── owner-safe media (PARITY C15) ────────────────────────────────────────
// A media path in a bot's message is read from the bot's OWN backend, never
// the active gateway (lib/media.ts resolveMediaDisplaySrc :113-165): an
// explicit local owner through the native file bridge, any other owner
// through `/api/fs/read-data-url` pinned to its connection and profile.
const mediaCache = new Map<string, Promise<string>>()
const MEDIA_CACHE_MAX = 60

// A file read must come back as a data: URL; anything else (a javascript: or
// http: URL from a misbehaving backend) is refused rather than rendered.
function dataUrlOnly(url: string, path: string): string {
  if (!isDataUrl(url)) throw new Error(`Could not read ${path}`)
  return url
}

export function readBotMedia(bot: any, path: string): Promise<string> {
  let scope: { connectionId?: string; profile: string }
  try {
    scope = botRestScope(bot, activeConnectionId())
  } catch (error) {
    return Promise.reject(error)
  }
  const key = `${scope.connectionId || ''}|${scope.profile}|${path}`
  const hit = mediaCache.get(key)
  if (hit) return hit
  const desktop = (globalThis as any).window?.hermesDesktop
  const route = resolveBotConnectionRoute(bot).route
  const local = route ? route.mode === 'local' : isLocalBot(bot, activeConnectionId())
  const read = (async () => {
    if (local && typeof desktop?.readFileDataUrl === 'function') {
      const result = await desktop.readFileDataUrl(filePath(path))
      if (result && typeof result === 'object') throw new Error(result.message || `Could not read ${path}`)
      return dataUrlOnly(String(result || ''), path)
    }
    if (typeof desktop?.api !== 'function') throw new Error('This Hermes build cannot read files')
    const result = await desktop.api(mediaReadRequest(path, scope))
    return dataUrlOnly(typeof result === 'string' ? result : String(result?.dataUrl || ''), path)
  })()
  mediaCache.set(key, read)
  read.catch(() => mediaCache.delete(key))
  while (mediaCache.size > MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value as string)
  return read
}

/** Read a text file of the bot's session workspace from the bot's OWN
 *  backend (Cards 7: `::card` JSON, `::preview` HTML): `rel` is resolved by
 *  the gateway against that session's working directory, never against the
 *  active chat's. Resolves the read-text reply ({ text, binary, truncated }). */
export async function readBotWorkspaceText(bot: any, rel: string, sessionId: string): Promise<any> {
  const desktop = (globalThis as any).window?.hermesDesktop
  if (typeof desktop?.api !== 'function') throw new Error('This Hermes build cannot read files')
  return desktop.api(workspaceReadRequest(rel, sessionId, botRestScope(bot, activeConnectionId())))
}

/** Transcribe a recording on the bot's own backend (PARITY C29). */
export async function transcribeForBot(bot: any, dataUrl: string, mimeType: string): Promise<string> {
  const api = (globalThis as any).window?.hermesDesktop?.api
  if (typeof api !== 'function') throw new Error('This Hermes build cannot transcribe audio')
  const result = await api(transcribeRequest(dataUrl, mimeType, botRestScope(bot, activeConnectionId())))
  return String(result?.transcript || '').trim()
}

function onEvent(type: string, listener: (event: any) => void) {
  if (typeof app.ctx?.onEvent === 'function') return app.ctx.onEvent(type, listener)
  return typeof host?.onEvent === 'function' ? host.onEvent(type, listener) : () => undefined
}

function setTimer(fn: () => void, ms: number) {
  if (typeof app.ctx?.setTimeout === 'function') return app.ctx.setTimeout(fn, ms)
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

/** Hold the bot's pooled route open while its chat is attached (review r1 #1).
 *  Rejects when a route that needs holding cannot be held; the chat then
 *  makes no session-scoped call (review r2 #4, routing.js retainBotRoute). */
function retainRoute(bot: any, options?: { spawnPriority?: 'background' | 'foreground' }) {
  return retainBotRoute(host, bot, options)
}

function isVisible() {
  try {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  } catch {
    return true
  }
}

export function chatDeps() {
  // idleByHost: the chats' idle refresh is the background pass above.
  return { requestForBot, readHistory, onEvent, setTimer, retainRoute, isVisible, idleByHost: true }
}

// ── bot switch without the flash (T9) ────────────────────────────────────
// The last few bots' transcripts, cron jobs and screen status, by row key:
// a switch back shows them at once while the real reads run (stale while
// revalidate). In memory only; rows are what the chat already showed.
const SEED_MAX = 8
const chatSeeds = new Map<string, any>()
const cronSeeds = new Map<string, any[]>()
const screenSeeds = new Map<string, any>()

function remember<T>(map: Map<string, T>, key: string, value: T) {
  if (!key) return
  map.delete(key)
  map.set(key, value)
  while (map.size > SEED_MAX) map.delete(map.keys().next().value as string)
}

function rememberChat(key: string, chat: any) {
  const seed = seedFromState(chat?.get?.())
  if (seed) remember(chatSeeds, key, seed)
}

/** The remembered transcript for this bot, unless the roster already names
 *  a different Bot Chat for it. */
function seedFor(bot: any, key: string) {
  const seed = chatSeeds.get(key)
  if (!seed) return null
  const listed = canonicalIds(bot?.canonical_session)
  if (listed.length && !listed.some(id => canonicalIds(seed.canonical).includes(id))) {
    chatSeeds.delete(key)
    return null
  }
  return seed
}

function clearSeeds() {
  chatSeeds.clear()
  cronSeeds.clear()
  screenSeeds.clear()
}

/** Detach the open chat from the screen. By default it retires: an idle chat
 *  is disposed now (lease, listener, refresh), one with a send or a turn in
 *  flight finishes in the background, bounded. `hard`: dispose everything
 *  (the plugin is turned off). */
function disposeController({ hard = false } = {}) {
  offController?.()
  offController = null
  const current = controller
  const key = controllerKey
  controller = null
  controllerKey = ''
  app.chat.set(null)
  if (current) {
    if (!hard) rememberChat(key, current)
    if (hard) current.dispose()
    else if (current.retire()) retiring.set(key, current)
  }
  if (hard) {
    for (const chat of retiring.values()) chat.dispose()
    retiring.clear()
    for (const chat of orphanedChats) chat.dispose()
    orphanedChats.clear()
    clearSeeds()
  }
}

function adopt(next: any, key: string) {
  controllerKey = key
  controller = next
  offController = next.subscribe((state: any) => app.chat.set(state))
  app.chat.set(next.get())
}

/** Whether a chat controller holds another Bot Chat than `storedId` (a
 *  replacement opened through Hermes): it may not be reused for it (review
 *  tighter-b r3 #1). No requested session: any. */
function holdsOtherChat(chat: any, storedId: string) {
  if (!storedId) return false
  const state = chat?.get?.()
  return !canonicalIds(state?.canonical).includes(storedId)
}

// Retiring chats of a Bot Chat that was replaced while they finish: kept so
// turning the override off still disposes them.
const orphanedChats = new Set<any>()

export function selectBot(bot: any, { openWorkspace = true, session = '' }: { openWorkspace?: boolean; session?: string } = {}) {
  const key = rowKey(bot)
  if (key !== app.selectedKey.get()) app.drawerOpen.set(false)
  app.selectedKey.set(key)
  storageSet('selected', key)
  resetNewLine(key)
  ackBot(bot)
  if (openWorkspace) ensureWorkspace(chatTabTitle(bot))
  else retitleWorkspace(chatTabTitle(bot))
  if (controllerKey === key && controller && !holdsOtherChat(controller, session)) {
    const phase = controller.get().phase
    if (phase === 'no-chat' && openWorkspace) void controller.create()
    else if (phase === 'error' || phase === 'no-chat') void controller.open()
    return
  }
  disposeController()
  let parked = retiring.get(key)
  retiring.delete(key)
  if (parked && holdsOtherChat(parked, session)) {
    // It finishes its own turn on the old chat; never revived for the new one.
    for (const chat of orphanedChats) if (chat.isDisposed?.()) orphanedChats.delete(chat)
    orphanedChats.add(parked)
    parked = null
  }
  // A remembered transcript of another Bot Chat is not shown for this one.
  let seed = seedFor(bot, key)
  if (seed && session && !canonicalIds(seed.canonical).includes(session)) {
    chatSeeds.delete(key)
    seed = null
  }
  if (parked && parked.revive()) {
    // Came back before its background turn finished: same chat, same stream.
    adopt(parked, key)
  } else {
    const next: any = createChatController(bot, chatDeps(), {
      // A roster click on a bot without a Bot Chat creates it, as Bot Mode's
      // click path does (openBotCanonicalChat -> createCanonicalChat, C3); a
      // chat tab restoring the remembered bot never mints one.
      createIfMissing: openWorkspace,
      // The transcript this bot showed last, on screen at once (T9).
      seed,
      onDispose: () => {
        // A chat that finished its turn in the background leaves its last state.
        if (retiring.get(key) === next) {
          retiring.delete(key)
          rememberChat(key, next)
        }
      }
    })
    adopt(next, key)
    void next.open()
  }
  void loadCron(bot)
  void loadScreen(bot)
}

export function currentController() {
  return controller
}

export function warmBot(bot: any) {
  try {
    // A row whose route is not known is never warmed by name on this machine.
    if (botRouteProblem(bot, activeConnectionId())) return
    const route = resolveBotConnectionRoute(bot).route
    host?.warmAgent?.(route ? route.connectionId : bot?.connectionId, route ? route.profile : bot?.name)
  } catch {
    /* hover warm is best-effort */
  }
}

// ── profile panel data ───────────────────────────────────────────────────

// The cron store shows ONE bot's jobs (`key`). Every load is numbered, and
// every result, refresh and busy flag is applied only while the store still
// belongs to the bot it was for: a toggle that finishes after the user moved
// to another bot never reloads, relabels or arms the other bot's panel
// (review r2 #1).
let cronGeneration = 0

export async function loadCron(bot: any) {
  const key = rowKey(bot)
  const mine = ++cronGeneration
  // Another bot's panel shows this bot's last known jobs while they load (T9).
  app.cron.set(s => ({ ...s, key, loading: true, error: null, ...(s.key === key ? {} : { jobs: cronSeeds.get(key) || [], busy: {} }) }))
  const current = () => mine === cronGeneration && app.cron.get().key === key
  try {
    const res = await requestForBot(bot, 'cron.manage', cronListParams(bot))
    if (!current()) return
    if (res?.error) throw new Error(res.error)
    const jobs = sortJobs(res?.jobs)
    remember(cronSeeds, key, jobs)
    app.cron.set(s => ({ ...s, loading: false, jobs }))
  } catch (error: any) {
    if (current()) app.cron.set(s => ({ ...s, loading: false, error: String(error?.message || error) }))
  }
}

/** Pause / resume one job (a user click). Same call Bot Mode's pane makes.
 *  Only a job the store lists for this very bot can be toggled on its route. */
export async function toggleCron(bot: any, job: any) {
  const id = String(job?.job_id || '')
  const key = rowKey(bot)
  const store = app.cron.get()
  if (!id || store.key !== key || !store.jobs.some((j: any) => String(j?.job_id || '') === id)) return
  const active = jobActive(job)
  app.cron.set(s => (s.key === key ? { ...s, busy: { ...s.busy, [id]: true } } : s))
  try {
    const res = await requestForBot(bot, 'cron.manage', cronToggleParams(bot, job))
    if (res?.error) throw new Error(res.error)
    if (app.cron.get().key === key) await loadCron(bot)
  } catch (error: any) {
    host?.notifyError?.(error, `Could not ${active ? 'pause' : 'resume'} ${job.name || id}`)
  } finally {
    app.cron.set(s => {
      if (s.key !== key || !(id in s.busy)) return s
      const busy = { ...s.busy }
      delete busy[id]
      return { ...s, busy }
    })
  }
}

export async function loadScreen(bot: any) {
  const key = rowKey(bot)
  // The last known status shows while it is re-read (T9).
  if (app.screen.get().key !== key) app.screen.set({ key, status: screenSeeds.get(key) ?? null })
  try {
    const status = await requestForBot(bot, 'display.status', { profile: String(bot.name) })
    if (status && !status.error) remember(screenSeeds, key, status)
    if (app.screen.get().key === key) app.screen.set({ key, status })
  } catch {
    if (app.screen.get().key === key) app.screen.set({ key, status: { error: true } })
  }
}

const COMPUTER_VIEWER_PANE_ID = 'computer-viewer:pane'

export function openComputerViewer() {
  try {
    host?.revealPane?.(COMPUTER_VIEWER_PANE_ID)
  } catch {
    /* not loaded */
  }
}

// ── fallbacks: Open in Hermes Bot Mode ───────────────────────────────────

/** Un-hide the stock Bots tab for this visit, front it, and (when the bot has
 *  a Bot Chat) open that exact chat in the stock surface with the options
 *  Bot Mode's own openStoredBotChat uses. Never creates a session, never sends. */
export async function openInBotMode(bot?: any, reason = ''): Promise<boolean> {
  const storedId = await openStoredChat(bot, reason)
  if (storedId && reason) host?.notify?.({ kind: 'info', title: 'Opened in Hermes Bot Mode', message: reason })
  return Boolean(storedId)
}

/** A deliberate hand-off to Hermes's own chat view (a roster menu's "New chat
 *  with this agent", the stock new-tab fallback): the stock Bots surface
 *  fronts in the sidebar too, so no half-override remains, and the main pane
 *  is not claimed back until the user returns to the override. */
export function beginStockHandoff() {
  stock?.startPeek()
  try {
    host?.revealPane?.(STOCK_PANE_ID)
  } catch {
    /* older desktop */
  }
}

/** The bot a fallback acts on, its Bot Chat row and the stored id to open. */
function chatTarget(bot?: any): { target: any; canonical: any; storedId: string } {
  const state = controller?.get?.()
  const target = freshBot(bot || state?.bot || findBot(app.selectedKey.get()))
  const canonical = target && state && rowKey(state.bot) === rowKey(target) ? state.canonical : target?.canonical_session
  return { target, canonical, storedId: canonical?.id ? openedSessionId(canonical) : '' }
}

/** Whether Hermes Bot Mode can be handed this bot from here: only with its
 *  exact connection route (or, for the active gateway's own profile, its
 *  name with the workspace kept). Null when it can, else why not. */
export function stockHandoffProblem(bot: any): null | string {
  if (!bot) return null
  const target = stockOpenTarget(bot, activeConnectionId())
  return target.ok ? null : target.reason
}

/** The shared part: reveal stock and open the chat. Resolves the stored id
 *  that was opened, or '' (no chat, older desktop, refused, failure).
 *
 *  host.openSession is only ever called with the bot's exact route, never a
 *  bare profile for a bot on another connection: Hermes would dial, stamp
 *  and scope the workspace to a same-named profile on THIS machine (the live
 *  "local/helper"). A bot whose route is not known is refused with a
 *  message, and stock is not even revealed. */
async function openStoredChat(bot: any, reason: string): Promise<string> {
  const { target, canonical, storedId } = chatTarget(bot)
  const open = target ? stockOpenTarget(target, activeConnectionId()) : null
  if (open && !open.ok) {
    host?.notify?.({ kind: 'error', title: 'Not opened in Hermes Bot Mode', message: `${open.reason}. Try again in a moment.` })
    return ''
  }
  stock?.startPeek()
  try {
    host?.revealPane?.(STOCK_PANE_ID)
  } catch {
    /* older desktop */
  }
  if (!target || !open || !canonical?.id || typeof host?.openSession !== 'function') {
    if (reason) host?.notify?.({ kind: 'info', title: 'Opened Hermes Bot Mode', message: reason })
    return ''
  }
  const ownerKey = botWorkspaceOwnerKey(target)
  try {
    const ids = canonicalIds(canonical)
    host.focusOpenWorkspaceSession?.(
      ownerKey,
      (tile: any) => tile?.workspaceTabTitle === CANONICAL_CHAT_TITLE && !ids.includes(String(tile?.storedSessionId)),
      []
    )
    await host.openSession(storedId, {
      ...(open.route ? { route: open.route } : {}),
      profile: open.profile,
      intent: 'in-place',
      awaitHydration: false,
      expectHistory: expectHistory(canonical),
      forceResume: true,
      hydrationTimeoutMs: CANONICAL_HYDRATION_TIMEOUT_MS,
      keepAllProfilesScope: true,
      workspaceMode: 'bots',
      workspaceOwnerKey: ownerKey,
      retryHydrationTimeoutOnce: true,
      tabTitle: CANONICAL_CHAT_TITLE
    })
    return storedId
  } catch (error: any) {
    host?.notifyError?.(error, 'Could not open the Bot Chat in Hermes Bot Mode')
    return ''
  }
}

export function botIsLocal(bot: any) {
  return isLocalBot(bot, activeConnectionId())
}

// ── panes ────────────────────────────────────────────────────────────────

type Renderers = { roster: () => any; workspace: () => any; tab?: (slot: ChatSlot) => any; room?: (slot: any) => any }
let renderers: Renderers | null = null

export function setRenderers(next: Renderers) {
  renderers = next
}

// ── more Bot Chats side by side (PARITY C26) ─────────────────────────────
// Stock opens a bot's chat in a new tab beside main (openRosterBot({intent:
// 'tab'}) -> host.openSession intent 'tab'). The override opens another of
// its own chat tabs docked to the right of the main one, with its own chat
// controller (own lease, own listener), so two Bot Chats run side by side;
// the same bot in two tabs is the same stored chat. Closing a tab retires its
// chat exactly like the main tab (a running turn finishes first, bounded).

export interface ChatSlot {
  id: string
  chat: Store<any>
  controller: () => any
  extra: boolean
}

export const mainSlot: ChatSlot = { id: 'main', chat: app.chat, controller: () => controller, extra: false }

const tabs = new Map<string, { controller: any; off: () => void; close: () => void }>()
let tabSeq = 0

export function openBotInNewTab(bot: any): boolean {
  if (!bot || !renderers?.tab || typeof host?.openWorkspace !== 'function') {
    host?.notify?.({ kind: 'error', title: 'Update Hermes Desktop', message: 'This Desktop build cannot open another chat tab.' })
    return false
  }
  const id = `${WORKSPACE_ID}-tab-${(tabSeq += 1)}`
  const chat = createStore<any>(null)
  const next = createChatController(bot, chatDeps(), { createIfMissing: true })
  const off = next.subscribe((state: any) => chat.set(state))
  chat.set(next.get())
  const slot: ChatSlot = { id, chat, controller: () => next, extra: true }
  const render = renderers.tab
  let closed = false
  const close = host.openWorkspace(id, {
    title: chatTabTitle(bot),
    minWidth: '22rem',
    dock: { pane: `plugin-workspace:${WORKSPACE_ID}`, pos: 'right' },
    render: () => render(slot),
    onClose: () => {
      if (closed) return
      closed = true
      off()
      next.retire()
      tabs.delete(id)
    }
  })
  tabs.set(id, { controller: next, off, close })
  void next.open()
  return true
}

// ── group chats (PARITY R14; core/rooms.js) ──────────────────────────────
// Rooms live on the active source, as Bot Mode lists them
// (canonical-group-registry.tsx useGatewayGroupRooms: host.state connection
// + profile, re-read every 10 s). Each opened room is its own chat tab.

let requestRoom: any = null
// Each room list is numbered: only the newest one started paints.
let roomSeq = 0
const roomTabs = new Map<string, { controller: any; close: () => void }>()

function activeRoomRoute() {
  let profile = ''
  try {
    profile = String(host?.state?.profile?.get?.() || '')
  } catch {
    profile = ''
  }
  return roomRoute(activeConnectionId() || 'local', profile || 'default')
}

/** The room list: `force` (a create or disband) reads now; otherwise it is a
 *  background poll on the active connection's lane (core/backgroundPolls.js). */
export async function refreshRooms(force = false) {
  if (force) {
    await listRoomsNow()
    return
  }
  await polls.run(activeLane(), 'rooms', ROOM_LIST_MS, live => listRoomsNow(live, true))
}

/** List the rooms now. A forced list (create, disband) is issued at once
 *  even while a background list is pending; whichever list started last
 *  paints, an older answer is dropped. */
async function listRoomsNow(live: () => boolean = () => true, background = false): Promise<boolean> {
  const route = activeRoomRoute()
  if (!route) return true
  const seq = ++roomSeq
  const epoch = pollEpoch
  const fresh = () => seq === roomSeq && epoch === pollEpoch && live()
  requestRoom ??= createRoomRequester(host)
  // A paged list starts no further page once it is stale (stopped, newer list,
  // past its deadline) or, in the background, once the window is hidden: the
  // list is dropped and the resume on visible lists again.
  let stopped = false
  const request = (...args: any[]) => {
    if (fresh() && (!background || isVisible())) return requestRoom(...args)
    stopped = true
    return Promise.reject(new Error('room list superseded'))
  }
  try {
    const rooms = await listRooms(request, route)
    if (fresh()) app.rooms.set({ route, rooms, error: null, loaded: true })
    return true
  } catch (error: any) {
    if (stopped) return true
    if (looksUnsupported(error)) {
      if (fresh()) app.rooms.set({ route, rooms: [], error: null, loaded: true })
      return true
    }
    if (fresh()) app.rooms.set(s => ({ ...s, route, error: String(error?.message || error), loaded: true }))
    return false
  }
}

// Room log observers (cross-branch hook: wiring.ts notes members' failed
// group turns on the roster's attention badge, R14 -> R15).
const roomStateHooks = new Set<(id: string, route: any, state: any) => void>()
export function onRoomState(fn: (id: string, route: any, state: any) => void) {
  roomStateHooks.add(fn)
  return () => {
    roomStateHooks.delete(fn)
  }
}
function emitRoomState(id: string, route: any, state: any) {
  for (const fn of roomStateHooks) {
    try {
      fn(id, route, state)
    } catch {
      /* an observer never breaks the room */
    }
  }
}

export function roomDeps() {
  requestRoom ??= createRoomRequester(host)
  return { requestRoom, onEvent, setTimer }
}

export function openRoom(route: any, room: any): boolean {
  if (!route || !room?.room_id || !renderers?.room || typeof host?.openWorkspace !== 'function') return false
  const id = `${WORKSPACE_ID}-room-${room.room_id}`
  if (roomTabs.has(id)) {
    try {
      host?.revealPane?.(`plugin-workspace:${id}`)
    } catch {
      /* fine */
    }
    return true
  }
  const next = createRoomController(route, room.room_id, roomDeps())
  const chat = createStore<any>(next.get())
  const off = next.subscribe((state: any) => {
    chat.set(state)
    emitRoomState(id, route, state)
  })
  const render = renderers.room
  let closed = false
  const close = host.openWorkspace(id, {
    title: String(room.name || 'Group'),
    minWidth: '24rem',
    dock: closeWorkspace ? { pane: `plugin-workspace:${WORKSPACE_ID}`, pos: 'center' } : { pane: 'workspace', pos: 'center' },
    render: () => render({ id, route, room, chat, controller: () => next }),
    onClose: () => {
      if (closed) return
      closed = true
      off()
      next.dispose()
      roomTabs.delete(id)
    }
  })
  roomTabs.set(id, { controller: next, close })
  void next.open()
  return true
}

export async function createGroupChat(name: string, bots: any[]) {
  const route = activeRoomRoute()
  if (!route) throw new Error('No active connection')
  requestRoom ??= createRoomRequester(host)
  const room = await createRoom(requestRoom, route, name, bots)
  await refreshRooms(true)
  if (room) openRoom(route, room)
  return room
}

export async function disbandGroupChat(id: string) {
  const tab = roomTabs.get(id)
  if (!tab) return
  await tab.controller.disband()
  try {
    tab.close()
  } catch {
    /* closed */
  }
  await refreshRooms(true)
}

function closeRoomTabs() {
  for (const [id, tab] of [...roomTabs.entries()]) {
    roomTabs.delete(id)
    tab.controller.dispose()
    try {
      tab.close()
    } catch {
      /* closed */
    }
  }
}

function closeTabs() {
  for (const [id, tab] of [...tabs.entries()]) {
    tabs.delete(id)
    tab.off()
    tab.controller.dispose()
    try {
      tab.close()
    } catch {
      /* already closed */
    }
  }
}

function registerRosterPane() {
  if (paneDispose || !app.ctx || !renderers) return
  paneDispose = app.ctx.register({
    id: 'roster',
    area: 'panes',
    title: 'Bots',
    data: {
      placement: 'left',
      minWidth: '220px',
      dock: { pane: STOCK_PANE_ID, pos: 'center', enforce: true }
    },
    render: renderers.roster
  })
  try {
    host?.undismissPane?.(OVERRIDE_ROSTER_PANE_ID)
  } catch {
    /* older desktop */
  }
}

/** The main chat tab's caption: the open bot's name, as its header pill
 *  shows it. */
export function chatTabTitle(bot: any) {
  return bot ? displayName(bot, metaFor(bot)) || 'Chat' : 'Chat'
}

let workspaceTitle = ''

function workspaceOptions(title: string) {
  return {
    title,
    minWidth: '26rem',
    dock: { pane: 'workspace', pos: 'center' },
    render: renderers!.workspace,
    onClose: () => {
      closeWorkspace = null
      workspaceTitle = ''
      if (!closingQuietly) {
        storageSet(CHAT_OPEN_KEY, false)
        // Hermes's own view is under the tab: take the pane back.
        scheduleClaim()
      }
      // The chat tab is gone: so is its chat (an explicitly sent turn may
      // finish in the background first; review r2 #5).
      disposeController()
    }
  }
}

/** Re-caption the open chat tab (a bot switch). host.openWorkspace on the
 *  same id refreshes the title in place; its closer replaces the old one. */
function retitleWorkspace(title: string) {
  if (!closeWorkspace || !renderers || title === workspaceTitle || typeof host?.openWorkspace !== 'function') return
  try {
    closeWorkspace = host.openWorkspace(WORKSPACE_ID, workspaceOptions(title))
    workspaceTitle = title
  } catch {
    /* keeps its previous caption */
  }
}

export function ensureWorkspace(title = 'Chat') {
  if (closeWorkspace || !renderers) {
    if (closeWorkspace) {
      if (title !== workspaceTitle) retitleWorkspace(title)
      else {
        try {
          host?.revealPane?.(`plugin-workspace:${WORKSPACE_ID}`)
        } catch {
          /* fine */
        }
      }
    }
    return
  }
  if (typeof host?.openWorkspace !== 'function') {
    host?.notify?.({ kind: 'error', title: 'Update Hermes Desktop', message: 'This Desktop build cannot open plugin workspaces.' })
    return
  }
  closeWorkspace = host.openWorkspace(WORKSPACE_ID, workspaceOptions(title))
  workspaceTitle = title
  storageSet(CHAT_OPEN_KEY, true)
}

// ── the main pane ────────────────────────────────────────────────────────
// While the override is on, Hermes's main pane is the override's chat tab,
// never Hermes's own session view beside the override's roster. Hermes puts
// its view back on its own: a cold start or View → Reload restores the last
// session tab after plugins register, leaving the first-run provider screen
// ("I'll choose a provider later" only lifts the overlay, store/onboarding.ts
// dismissFirstRunOnboarding) shows whatever the layout held, and closing the
// override's tab fronts the 'workspace' pane under it. Hermes's session
// views are the 'workspace' pane and 'session-tile:' / 'route-tile:' panes
// (store/layout.ts:798). So: on every such change, unless the user handed a
// chat to Hermes Bot Mode on purpose (a peek, which also swaps the sidebar to
// stock), the override's tab is opened again or fronted.
//
// Route, don't block (T3): once the start-up restore is over, a session the
// user opens through Hermes (session search, a notification, a cron run, ⌘N,
// an artifact link) is not undone. A roster bot's Bot Chat opens in the
// override (that bot is selected and its tab fronted); any other session, or
// a new draft, stays in Hermes's own view until the user comes back to the
// override's tab or roster.

export const MAIN_PANE_ID = `plugin-workspace:${WORKSPACE_ID}`
const STOCK_CHAT_PANES = /^(?:workspace|session-tile:.*|route-tile:.*)$/

function visible(paneId: string): boolean {
  try {
    return typeof host?.paneVisibility === 'function' ? host.paneVisibility(paneId)?.get?.() === true : false
  } catch {
    return false
  }
}

/** A Hermes session view on screen: the 'workspace' pane, or a selected
 *  session / route tile tab in the layout tree. */
function stockChatShown(): boolean {
  if (visible('workspace')) return true
  if (typeof document === 'undefined') return false
  for (const tab of document.querySelectorAll('[data-tree-tab][aria-selected="true"], [data-tree-tab][data-active="true"]')) {
    const id = String(tab.getAttribute('data-tree-tab') || '')
    if (STOCK_CHAT_PANES.test(id) && visible(id)) return true
  }
  return false
}

// How long after the override turns on a session focus is still Hermes's own
// restore (cold start, View → Reload) rather than the user's choice. The
// first pointer or key press ends it early.
export const STARTUP_GRACE_MS = 10_000
let startupGrace = false
let endGrace: null | (() => void) = null
// The session the user opened in Hermes's own view ('' = a new draft); null
// while the main pane is the override's to claim.
let hermesView: null | string = null
let lastFocused: unknown = undefined

function beginStartupGrace() {
  endGrace?.()
  startupGrace = true
  let stopTimer: null | (() => void) = null
  const end = () => {
    startupGrace = false
    stopTimer?.()
    stopTimer = null
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('pointerdown', end, true)
      document.removeEventListener('keydown', end, true)
    }
    endGrace = null
  }
  endGrace = end
  stopTimer = setTimer(end, STARTUP_GRACE_MS)
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('pointerdown', end, true)
    document.addEventListener('keydown', end, true)
  }
}

/** The roster bot whose Bot Chat this stored session is, or null. */
function botForFocus(value: unknown) {
  const state = controller?.get?.()
  return botForSession(app.roster.get().rows, String(value ?? ''), state ? { bot: state.bot, canonical: state.canonical } : null)
}

/** A Bot Chat opened through Hermes: shown in the override instead. */
function routeToBot(bot: any, storedId: string) {
  hermesView = null
  // The very Bot Chat that was opened: a controller on an older one is not
  // reused for it (review tighter-b r3 #1).
  selectBot(bot, { session: storedId })
  try {
    host?.revealPane?.(MAIN_PANE_ID)
  } catch {
    /* fronted by selectBot already */
  }
}

/** Hermes focused a stored session (or a new draft: null). A change after
 *  start-up routes at once; everything else is decided when the pane
 *  settles (settleMainPane), since the focused id need not change at all. */
function onSessionFocus(value: unknown) {
  const first = lastFocused === undefined
  const changed = !first && value !== lastFocused
  lastFocused = value
  if (first || !changed || startupGrace || !app.enabled.get() || isSecondaryWindow() || stock?.isPeeking?.()) {
    scheduleClaim()
    return
  }
  const bot = botForFocus(value)
  if (bot) return routeToBot(bot, String(value ?? ''))
  // Not a Bot Chat: Hermes's view stays, once it is the one on screen.
  if (!visible(MAIN_PANE_ID)) hermesView = String(value ?? '')
  else scheduleClaim()
}

/** After start-up, a Hermes session view on the main pane is the user's
 *  open (session search, a notification, a cron run, ⌘N, an artifact link,
 *  re-opening the same session tab): the session Hermes says is focused now
 *  decides, whether or not its id changed (review tighter-b r1 #3). A Bot
 *  Chat routes into the override; anything else stays in Hermes's view. A
 *  closed override tab is still reopened. */
function settleMainPane() {
  if (!app.enabled.get() || isSecondaryWindow() || closingQuietly || stock?.isPeeking?.()) return
  if (!closeWorkspace) {
    if (hermesView === null) claimMainPane()
    return
  }
  if (hermesView !== null || visible(MAIN_PANE_ID) || !stockChatShown()) return
  const focused = host?.state?.focusedStoredSessionId
  if (!focused || typeof focused.get !== 'function') {
    claimMainPane()
    return
  }
  const value = focused.get()
  const bot = botForFocus(value)
  if (bot) routeToBot(bot, String(value ?? ''))
  else hermesView = String(value ?? '')
}

/** Open or front the override's chat tab when Hermes's own session view has
 *  the main pane. Idempotent; never while off, in the HUD, during a
 *  deliberate hand-off to Hermes Bot Mode, or while the user is in a Hermes
 *  session view they opened (T3). */
export function claimMainPane(): boolean {
  if (!app.enabled.get() || isSecondaryWindow() || closingQuietly || stock?.isPeeking?.()) return false
  if (hermesView !== null) return false
  if (!closeWorkspace) {
    const bot = findBot(app.selectedKey.get())
    ensureWorkspace(bot ? chatTabTitle(bot) : 'Chat')
    return Boolean(closeWorkspace)
  }
  if (visible(MAIN_PANE_ID) || !stockChatShown()) return false
  try {
    host?.revealPane?.(MAIN_PANE_ID)
  } catch {
    return false
  }
  return true
}

// After start-up a pane change waits this long before it is claimed, so the
// session focus that comes with a user's open (T3) is seen first.
const CLAIM_SETTLE_MS = 300

function scheduleClaim() {
  if (claimQueued || !app.enabled.get()) return
  claimQueued = true
  const run = () => {
    claimQueued = false
    if (startupGrace) claimMainPane()
    else settleMainPane()
  }
  if (startupGrace) queueMicrotask(run)
  else setTimer(run, CLAIM_SETTLE_MS)
}

function watchMainPane() {
  if (unwatchMain.length) return
  const watch = (atom: any, fn: (value: any) => void) => {
    if (atom && typeof atom.subscribe === 'function') {
      try {
        const off = atom.subscribe(fn)
        if (typeof off === 'function') unwatchMain.push(off)
      } catch {
        /* older desktop */
      }
    }
  }
  const pane = (id: string) => (typeof host?.paneVisibility === 'function' ? host.paneVisibility(id) : null)
  watch(pane('workspace'), (shown: boolean) => shown && scheduleClaim())
  watch(pane(MAIN_PANE_ID), (shown: boolean) => {
    // Back on the override's tab: it owns the main pane again.
    if (shown) hermesView = null
    else scheduleClaim()
  })
  // A restored or opened session (a session tile fronted): routed (T3).
  const focused = host?.state?.focusedStoredSessionId
  lastFocused = undefined
  if (focused && typeof focused.subscribe === 'function') {
    watch(focused, onSessionFocus)
    // The runtime id moves with it; only the start-up restore claims on it.
    watch(host?.state?.activeSessionId, () => startupGrace && scheduleClaim())
  } else {
    // An older desktop without the stored-session atom: claim as before.
    watch(host?.state?.activeSessionId, () => scheduleClaim())
  }
}

// ── style + DOM watch ────────────────────────────────────────────────────

function injectStyle() {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    ;(document.head || document.documentElement).appendChild(el)
  }
  if (el.textContent !== CSS) el.textContent = CSS
}

function removeStyle() {
  try {
    document.getElementById(STYLE_ID)?.remove()
  } catch {
    /* gone */
  }
}

function scheduleSync() {
  if (typeof requestAnimationFrame !== 'function') {
    stock?.sync()
    return
  }
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    stock?.sync()
    if (closeWorkspace && !visible(MAIN_PANE_ID)) scheduleClaim()
    // On screen (the SDK's own read) means present; only a hidden pane needs
    // the layout tree's tab to say it exists (the SDK has no such read).
    const present = visible(COMPUTER_VIEWER_PANE_ID) || Boolean(document.querySelector(`[data-tree-tab="${COMPUTER_VIEWER_PANE_ID}"]`))
    if (present !== app.computerViewer.get().present) app.computerViewer.set(s => ({ ...s, present }))
  })
}

function startObserver() {
  if (observer || typeof MutationObserver !== 'function' || typeof document === 'undefined') return
  observer = new MutationObserver(scheduleSync)
  observer.observe(document.body || document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'data-tree-tab', 'data-narrow-overlay-tab', 'data-active']
  })
}

function watchVisibility() {
  const atom = typeof host?.paneVisibility === 'function' ? host.paneVisibility(OVERRIDE_ROSTER_PANE_ID) : null
  if (atom && typeof atom.subscribe === 'function') {
    unwatchPane = atom.subscribe((visible: boolean) => {
      stock?.overrideVisible(Boolean(visible))
      scheduleSync()
    })
  }
  const cv = typeof host?.paneVisibility === 'function' ? host.paneVisibility(COMPUTER_VIEWER_PANE_ID) : null
  if (cv && typeof cv.subscribe === 'function') {
    unwatchComputer = cv.subscribe((visible: boolean) =>
      app.computerViewer.set(s => (s.visible === Boolean(visible) && (!visible || s.present) ? s : { ...s, visible: Boolean(visible), present: s.present || Boolean(visible) }))
    )
  }
}

// The window coming back from hidden: one refresh pass at once, every
// background poll due once whatever its backoff (the full roster read keeps
// its 60 s minimum). The 3 s tick notices the change too (noteVisibility),
// so a missed event only delays the pass to the next tick. Hidden: no
// background poll starts (core/backgroundPolls.js checks isVisible).
let unwatchDocument: null | (() => void) = null

/** The visibilitychange handler (both directions). */
export function onDocumentVisible() {
  noteVisibility()
  if (!app.enabled.get() || !isVisible()) return
  refreshRoster()
}

function watchDocumentVisibility() {
  unwatchDocument?.()
  unwatchDocument = null
  const doc = typeof document === 'undefined' ? null : (document as any)
  if (typeof doc?.addEventListener !== 'function') return
  const listener = () => onDocumentVisible()
  doc.addEventListener('visibilitychange', listener)
  unwatchDocument = () => doc.removeEventListener?.('visibilitychange', listener)
}

// ── server avatars of remote bots ────────────────────────────────────────

/** Fetch the server avatar of every bot on another connection whose gateway
 *  has one (Bot Mode only does this for the active source), on each roster
 *  change; the loader caches per route for the session (core/remoteAvatars.js). */
function startRemoteAvatars() {
  stopRemoteAvatars()
  const loader = createRemoteAvatars({
    request: (bot: any, method: string, params: any, options: any) => {
      if (!requestForBot) return Promise.reject(new Error('not started'))
      return requestForBot(bot, method, params, options)
    },
    hasOwnImage: (bot: any) => {
      const image = metaFor(bot)?.image
      return typeof image === 'string' && image.length > 0
    },
    onChange: (images: Record<string, string>) => roster2.remoteAvatars.set(images),
    // The same list names the SSH bots (no request of its own).
    onProfiles: (connectionId: string, profiles: any[]) => noteGatewayProfiles(connectionId, profiles)
  })
  remoteAvatars = loader
  unwatchAvatars = app.roster.subscribe(() => loader.sync(app.roster.get().rows))
  loader.sync(app.roster.get().rows)
}

// A gateway-read name that changes while the bot's chat tab is open
// re-captions the tab (the roster, panel and chat re-render on their own).
let unwatchNames: null | (() => void) = null
function watchGatewayNames() {
  unwatchNames?.()
  unwatchNames = roster2.gatewayMeta.subscribe(() => {
    const bot = controller?.get?.()?.bot
    if (bot && closeWorkspace) retitleWorkspace(chatTabTitle(findBot(rowKey(bot)) || bot))
  })
}

function unwatchGatewayNames() {
  unwatchNames?.()
  unwatchNames = null
}

function stopRemoteAvatars() {
  unwatchAvatars?.()
  unwatchAvatars = null
  remoteAvatars?.stop()
  remoteAvatars = null
  roster2.remoteAvatars.set({})
}

// ── toggle ───────────────────────────────────────────────────────────────

function enable() {
  injectStyle()
  registerRosterPane()
  if (!stock) stock = createStockController({ document, host })
  stock.setOn(true)
  startObserver()
  watchVisibility()
  startRemoteAvatars()
  watchGatewayNames()
  refreshRoster()
  startRosterParity()
  watchDocumentVisibility()
  const tick = () => {
    rosterTimer = setTimer(() => {
      refreshRoster()
      tick()
    }, ROSTER_TICK_MS)
  }
  tick()
  try {
    host?.revealPane?.(OVERRIDE_ROSTER_PANE_ID)
  } catch {
    /* fine */
  }
  // The main pane is the override's from the first frame (a cold start, a
  // renderer reload, a plugin reload): the remembered bot's chat, or "Pick a
  // bot". Its chat (and route lease) opens when the tab shows it
  // (ChatWorkspace), never headless (review r2 #5).
  hermesView = null
  beginStartupGrace()
  watchMainPane()
  claimMainPane()
  scheduleSync()
}

function disable() {
  for (const off of unwatchMain.splice(0)) off()
  endGrace?.()
  hermesView = null
  rosterTimer?.()
  rosterTimer = null
  unwatchDocument?.()
  unwatchDocument = null
  // Background work started before this never applies a result or starts a
  // follow-up read (LR1-10); a foreground read in flight is dropped too.
  pollEpoch += 1
  polls.reset()
  idleRotation.reset()
  supersedeReads()
  lastLocal = null
  roomSeq += 1
  stopRemoteAvatars()
  unwatchGatewayNames()
  unwatchPane?.()
  unwatchPane = null
  unwatchComputer?.()
  unwatchComputer = null
  observer?.disconnect()
  observer = null
  if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
  raf = 0
  disposeController({ hard: true })
  closeTabs()
  closeRoomTabs()
  stopRosterParity()
  closingQuietly = true
  try {
    closeWorkspace?.()
  } catch {
    /* already closed */
  } finally {
    closingQuietly = false
  }
  closeWorkspace = null
  paneDispose?.()
  paneDispose = null
  stock?.setOn(false)
  removeStyle()
  try {
    host?.revealPane?.(STOCK_PANE_ID)
  } catch {
    /* fine */
  }
}

/** Hermes's HUD (`?win=hud`) is a second full renderer that loads every
 *  plugin, but it has no sidebar and boots against whatever profile it was
 *  handed. The override stays inert there: no roster loop, no stock-tab
 *  hiding, no room polling against the HUD's gateway. */
export function isSecondaryWindow() {
  try {
    return new URLSearchParams(String(globalThis.location?.search || '')).get('win') === 'hud'
  } catch {
    return false
  }
}

export function setEnabled(value: boolean) {
  const next = Boolean(value)
  storageSet('enabled', next)
  if (isSecondaryWindow()) return
  if (next === app.enabled.get()) return
  app.enabled.set(next)
  if (next) enable()
  else disable()
}

/** Load the work-rows setting; on the first run, copy Bubble Mode's old
 *  "toggle work rows" preference once (its storage is only read). */
function startShowWork() {
  const { value, write } = loadShowWork(
    storageGet<unknown>(SHOW_WORK_KEY, undefined),
    readPluginStorage<unknown>(LEGACY_SHOW_WORK_PLUGIN, LEGACY_SHOW_WORK_KEY, false)
  )
  app.showWork.set(value)
  if (write) storageSet(SHOW_WORK_KEY, value)
}

/** The palette's "show work rows": Thought and tool rows in the chat. */
export function setShowWork(value: boolean) {
  const next = Boolean(value)
  app.showWork.set(next)
  storageSet(SHOW_WORK_KEY, next)
}

// ── pinned bots ──────────────────────────────────────────────────────────

/** Is this bot one of the (at most four) pins shown at the top? */
export function isPinnedTop(bot: any): boolean {
  return pinState(app.pinnedBots.get(), app.roster.get().rows, rowKey).shown.some((row: any) => rowKey(row) === rowKey(bot))
}

/** Can another bot be pinned (fewer than four shown)? */
export function canPinMore(): boolean {
  return pinState(app.pinnedBots.get(), app.roster.get().rows, rowKey).canPin
}

/** Pin to top / Unpin. Display only: the list lives in this plugin's storage,
 *  keyed by the bot's exact route key. Returns false when the cap refused it. */
export function toggleTopPin(bot: any): boolean {
  if (!bot) return false
  const result = togglePin(app.pinnedBots.get(), rowKey(bot), app.roster.get().rows, rowKey)
  if (!result.changed) {
    try {
      host?.notify?.({ kind: 'info', message: 'Up to 4 bots can be pinned to the top. Unpin one first.' })
    } catch {
      /* fine */
    }
    return false
  }
  app.pinnedBots.set(result.pins)
  storageSet(PINS_KEY, result.pins)
  return true
}

export function start(ctx: any) {
  app.ctx = ctx
  app.pinnedBots.set(pinsFrom(storageGet(PINS_KEY, [])))
  startSections()
  startShowWork()
  requestForBot = createBotRequester(host, { activeConnectionId })
  app.selectedKey.set(String(storageGet('selected', '') || ''))
  app.panelOpen.set(storageGet('panelOpen', true) !== false)
  app.panelWidth.set(storedPanelWidth(storageGet(PANEL_WIDTH_KEY, null)))
  app.collapsed.set(Array.isArray(storageGet('collapsed', [])) ? storageGet('collapsed', []) : [])
  const on = storageGet('enabled', DEFAULT_ON) !== false && !isSecondaryWindow()
  app.enabled.set(on)
  if (on) enable()
}

export function stop() {
  disable()
  stock?.dispose()
  stock = null
  app.enabled.set(false)
}

/** Hermes's sidebar toggle (its ⌘B / titlebar action) through the plugin
 *  door, so the roster can be hidden and shown like the app's own sidebar.
 *  False on a host without `ctx.runAction`: the button is not drawn. */
export function canToggleSidebar(): boolean {
  return typeof app.ctx?.runAction === 'function'
}

export function toggleSidebar(): boolean {
  try {
    return app.ctx?.runAction?.('view.toggleSidebar')?.ok !== false
  } catch {
    return false
  }
}

// ── sidebar footer: the person and Hermes settings ───────────────────────

/** Hermes Settings through the plugin door (`ctx.runAction('nav.settings')`,
 *  the handler the app's ⌘, shortcut, palette entry and titlebar gear use).
 *  False on a host without the door or without that action: no button. */
export function canOpenSettings(): boolean {
  const ctx = app.ctx
  if (typeof ctx?.runAction !== 'function') return false
  try {
    const list = typeof ctx.listActions === 'function' ? ctx.listActions() : null
    return !Array.isArray(list) || list.some((action: any) => action?.id === 'nav.settings')
  } catch {
    return false
  }
}

export function openSettings(): boolean {
  try {
    return app.ctx?.runAction?.('nav.settings')?.ok !== false
  } catch {
    return false
  }
}

let userNameAsked = false

/** The person's name for the sidebar footer, read once: the only one the
 *  running app exposes to a plugin is the OS account name of this computer
 *  (`window.hermesDesktop.getMachineProfile().username`, the same value
 *  Hermes's first-run guide starts from). No SDK store holds a user or
 *  account display name. Nothing available: '' (the footer says "You"). */
export function loadUserName() {
  if (userNameAsked) return
  userNameAsked = true
  try {
    const read = (globalThis as any).window?.hermesDesktop?.getMachineProfile
    if (typeof read !== 'function') return
    Promise.resolve(read())
      .then((profile: any) => {
        const name = String(profile?.username ?? '').trim().slice(0, 80)
        if (name) app.userName.set(name)
      })
      .catch(() => undefined)
  } catch {
    /* older desktop */
  }
}

// ── the NEW line (core/newMarker.js) ─────────────────────────────────────

let seenLoaded = false

function markerState() {
  if (!seenLoaded && app.ctx) {
    seenLoaded = true
    const seen = seenFrom(storageGet(SEEN_KEY, {}))
    roster2.newLine.set(s => ({ ...s, seen: { ...seen, ...s.seen } }))
  }
  return roster2.newLine.get()
}

/** One transcript update: decide the open chat's NEW line, raise its seen
 *  watermark while the user is looking, store the watermark when it moved. */
export function noteTranscript(key: string, items: any[], ready: boolean, looking: boolean) {
  const state = markerState()
  const next = stepMarker(state, { key, items, ready, looking })
  if (next === state) return
  roster2.newLine.set(next)
  if (next.seen !== state.seen) storageSet(SEEN_KEY, next.seen)
}

/** The chat is opened (again): its NEW line is decided afresh. */
function resetNewLine(key: string) {
  const state = roster2.newLine.get()
  const next = resetMarker(state, key)
  if (next !== state) roster2.newLine.set(next)
}

export function setPanelOpen(open: boolean) {
  app.panelOpen.set(open)
  storageSet('panelOpen', open)
}

/** A drag on the chat | panel hairline: `move` resizes live (clamped against
 *  the workspace width), `end` stores the final width once. */
export function startPanelResize(startX: number, workspaceWidth: number) {
  const start = app.panelWidth.get()
  let last = start
  return {
    move(x: number) {
      last = dragPanelWidth(start, startX, x, workspaceWidth)
      if (last !== app.panelWidth.get()) app.panelWidth.set(last)
      return last
    },
    end() {
      if (last !== start) storageSet(PANEL_WIDTH_KEY, last)
      return last
    }
  }
}

/** Double-click on the hairline: back to the default width. */
export function resetPanelWidth() {
  app.panelWidth.set(PANEL_WIDTH.default)
  storageSet(PANEL_WIDTH_KEY, PANEL_WIDTH.default)
}

// ── the roster's own sections (core/sections.js) ─────────────────────────

function applySections(stored: unknown) {
  const { state, write } = loadSections({
    stored,
    readLegacy: (key: string, fallback: unknown) => readPluginStorage<unknown>(LEGACY_SECTIONS_PLUGIN, key, fallback),
    collapsedHere: storageGet<unknown>('collapsed', [])
  })
  app.sections.set(state)
  if (write) storageSet(SECTIONS_KEY, state)
}

/** Load the own sections; on the first run, copy the Bot Sections layout in
 *  once (its storage is only read). A storage that answers with a promise
 *  is waited for, so a slow read never looks like a first run. */
function startSections() {
  try {
    const stored = app.ctx?.storage?.get?.(SECTIONS_KEY, undefined)
    if (stored && typeof (stored as any).then === 'function') {
      ;(stored as Promise<unknown>).then(applySections, () => undefined)
      return
    }
    applySections(stored)
  } catch {
    /* holds the empty state for this window */
  }
}

function updateSections(fn: (state: SectionsState) => SectionsState) {
  const current = app.sections.get()
  const next = fn(current)
  if (next === current) return
  app.sections.set(next)
  storageSet(SECTIONS_KEY, next)
}

/** New section at the end; returns its id ('' for an empty name). */
export function createSection(name: string): string {
  let id = ''
  updateSections(state => {
    const result = addSection(state, name)
    id = result.id
    return result.state
  })
  return id
}

export function renameOwnSection(id: string, name: string) {
  updateSections(state => renameSection(state, id, name))
}

export function deleteOwnSection(id: string) {
  updateSections(state => deleteSection(state, id))
}

export function moveOwnSection(id: string, delta: number) {
  updateSections(state => moveSection(state, id, delta))
}

export function toggleOwnSection(id: string) {
  updateSections(state => toggleSectionCollapsed(state, id))
}

/** Move a bot to one of the own sections, or '' for Default. */
export function moveBotToSection(bot: any, id: string) {
  if (!bot) return
  updateSections(state => assignBot(state, rowKey(bot), id))
}

/** The own section a bot is in ('' = Default). */
export function botSectionId(bot: any): string {
  return ownSectionOf(bot, app.sections.get(), metaFor)
}

/** How many roster bots (hidden ones too) are in an own section. */
export function botsInSection(id: string): number {
  const state = app.sections.get()
  return app.roster.get().rows.filter((bot: any) => !bot?.ghost && ownSectionOf(bot, state, metaFor) === id).length
}

export function toggleSection(name: string) {
  app.collapsed.set(list => {
    const next = list.includes(name) ? list.filter(n => n !== name) : [...list, name]
    storageSet('collapsed', next)
    return next
  })
}

export function backToOverride() {
  stock?.endPeek()
  try {
    host?.revealPane?.(OVERRIDE_ROSTER_PANE_ID)
  } catch {
    /* fine */
  }
  scheduleClaim()
}

// ── read-only self-check ─────────────────────────────────────────────────

/** Exercises only reads: roster, one bot's canonical lookup and history
 *  tail, its cron list. Never resumes, sends, approves or toggles anything.
 *  Message text is never recorded, only counts and roles. */
export async function selfCheck({ notify = true } = {}) {
  const report: any = { at: new Date().toISOString(), plugin: PLUGIN_ID, steps: [] }
  const step = (name: string, ok: boolean, detail: any) => report.steps.push({ name, ok, ...detail })
  try {
    requestForBot ??= createBotRequester(host, { activeConnectionId })
    const cached = readStockRoster(queryClient(), activeConnectionId())
    step('stock-roster-cache', Boolean(cached), { rows: cached?.profiles?.length ?? 0, fresh: cached?.fresh ?? false })
    let rows = cached?.profiles || []
    if (!rows.length) {
      await fetchOwnRoster({ foreground: true })
      rows = app.roster.get().rows
    } else {
      app.roster.set(s => mergeRosterState(s, { ...readSideData(), rows: annotateSources(cached!.profiles, cached!.sources), origin: 'stock' }))
    }
    const secs = sections()
    step('roster', rows.length > 0, {
      rows: rows.length,
      origin: app.roster.get().origin,
      sections: secs.map(s => ({ name: s.name, bots: s.bots.length })),
      withCanonical: rows.filter((r: any) => r?.canonical_session?.id).length
    })
    // One bot on this device (with a known Bot Chat) and one on another
    // connection, so both the host.request and host.requestProfile paths and
    // both REST scopes are read.
    const local =
      rows.find((r: any) => r?.canonical_session?.id && botIsLocal(r) && r.name !== 'default') ||
      rows.find((r: any) => r?.canonical_session?.id) ||
      rows[0]
    const remotes = rows.filter((r: any) => !botIsLocal(r) && !sourceUnreachable(r) && !metaFor(r)?.hidden)
    if (!local) throw new Error('no bots in the roster')
    // A roster can list a remote profile its host no longer has (Bot Mode
    // shows the same error on click), or a Bot Chat with no messages yet: try
    // up to five, stop at the first that reads a non-empty history.
    let remoteOk = remotes.length === 0
    let remoteRead = false
    for (const target of [local, ...remotes.slice(0, 5)]) {
      if (target !== local && remoteOk) break
      const where = { bot: target.name, connection: target.connectionId || 'active' }
      try {
        const canonical = await findCanonicalChat(requestForBot, target)
        step('canonical-lookup', true, {
          ...where,
          found: Boolean(canonical),
          matchesRoster: Boolean(canonical && target.canonical_session && canonical.id === target.canonical_session.id),
          title: canonical?.title || canonical?.root_title || null,
          messageCount: canonical?.message_count ?? null,
          liveMessageCount: canonical?.live_message_count ?? null,
          lineageTip: Boolean(canonical?.resolved_id && canonical.resolved_id !== canonical.id)
        })
        if (canonical) {
          const page: any = await readHistory(target, openedSessionId(canonical), { limit: 20, offset: 0 })
          const msgs = Array.isArray(page?.messages) ? page.messages : []
          const items = historyToItems(msgs)
          if (target !== local && msgs.length) remoteRead = true
          step('history-read', true, {
            ...where,
            rows: msgs.length,
            roles: msgs.reduce((acc: any, m: any) => ((acc[m?.role] = (acc[m?.role] || 0) + 1), acc), {}),
            items: items.reduce((acc: any, i: any) => ((acc[i.kind] = (acc[i.kind] || 0) + 1), acc), {}),
            order: page?.pagination?.order ?? null
          })
        }
        const cron = await requestForBot(target, 'cron.manage', cronListParams(target))
        step('cron-list', !cron?.error, {
          ...where,
          jobs: Array.isArray(cron?.jobs) ? cron.jobs.length : 0,
          enabled: Array.isArray(cron?.jobs) ? cron.jobs.filter((j: any) => jobActive(j)).length : 0
        })
        if (target !== local) remoteOk = remoteRead || remoteOk
      } catch (error: any) {
        step('bot-reads', target !== local, { ...where, error: String(error?.message || error), ...(target !== local ? { note: 'remote candidate skipped' } : {}) })
      }
    }
    step('remote-bot', remoteOk || remoteRead, { candidates: remotes.length, readNonEmptyHistory: remoteRead })
    report.ok = report.steps.every((s: any) => s.ok)
  } catch (error: any) {
    report.ok = false
    report.error = String(error?.message || error)
  }
  try {
    await app.ctx?.files?.writeText?.('data', 'self-check.json', JSON.stringify(report, null, 2))
  } catch {
    /* data folder unavailable */
  }
  if (notify) {
    host?.notify?.({
      kind: report.ok ? 'success' : 'error',
      title: report.ok ? 'Grokbot Override self-check passed' : 'Grokbot Override self-check failed',
      message: report.ok ? `${report.steps.length} read-only checks passed` : report.error || 'See self-check.json'
    })
  }
  return report
}

export const PROBE: boolean = typeof __GBO_PROBE__ === 'boolean' ? __GBO_PROBE__ : false
