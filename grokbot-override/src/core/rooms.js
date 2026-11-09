// Group chats (PARITY R14): Hermes's gateway-owned rooms. The gateway runs
// the rounds, the relay between members and their approvals; a client lists
// rooms, reads the room log and state, posts, stops, continues, answers a
// member's pending action, creates, renames and disbands. Port of
// apps/desktop/src/plugins/hermes-bots/canonical-groups.ts,
// canonical-group-send.ts, canonical-group-approval.ts,
// canonical-group-registry.tsx and canonical-group-workspace.tsx (Hermes
// Agent, MIT, (c) Nous Research, 2bd378ed1b), on the same `groups.*` calls
// (tui_gateway/contracts/groups_bot_relay.py).
//
// Never twice: a post carries a fresh `event_id`; the room log de-duplicates
// on it, so an uncertain post is retried under the same id. A refusal is "not
// posted" only when the gateway says `data.admitted === false` (both groups.send
// dispatchers stamp it on a refusal raised before the event committed;
// canonical-group-workspace.tsx `admittedNothing`).

import { looksUnsupported, roomPostFailure } from './outcomes.js'

const uuid = () => {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `gbo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const ROOM_POLL_MS = 2_500
export const ROOM_LIST_MS = 10_000
const LOG_PAGE = 200

/** The authority a room lives on: an explicit connection and profile. */
export function roomRoute(connectionId, profile) {
  const c = String(connectionId || '').trim()
  const p = String(profile || '').trim()
  if (!c || !p) return null
  return { connectionId: c, profile: p }
}

export const roomKey = (route, roomId) => `${route.connectionId}::${route.profile}::${roomId}`

/** canonicalGroupRequest: the descriptor overload of host.requestProfile,
 *  never the foreground gateway; `profile` always the authority's. */
export function createRoomRequester(host) {
  return async function requestRoom(route, method, params = {}) {
    if (!route?.connectionId || !route?.profile) throw new Error('A group chat needs an explicit connection and profile')
    if (typeof host?.requestProfile !== 'function') throw new Error('This Hermes build cannot reach group chats from a plugin')
    return host.requestProfile(
      { connectionId: route.connectionId, profile: route.profile, targetProfile: route.profile, mode: route.connectionId === 'local' ? 'local' : 'remote' },
      method,
      { ...params, profile: route.profile }
    )
  }
}

/** Read-only availability of the room list (outcomes.js looksUnsupported). */
export const isMethodMissing = looksUnsupported

/** listCanonicalRooms: every live room, all pages. */
export async function listRooms(requestRoom, route) {
  const rooms = []
  let offset = 0
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await requestRoom(route, 'groups.list', { limit: 100, offset })
    rooms.push(...(Array.isArray(page?.rooms) ? page.rooms : []))
    if (page?.next_offset === null || page?.next_offset === undefined) break
    if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset) throw new Error('Invalid group pagination cursor')
    offset = page.next_offset
  }
  return rooms.filter(room => !room?.disbanded_at).sort((a, b) => Number(b?.updated_at || 0) - Number(a?.updated_at || 0))
}

/** canonicalGroupRoster: two to six unique members, all on the room's own
 *  connection. Returns { roster } or { problem }. */
export function roomRoster(route, bots) {
  const list = Array.isArray(bots) ? bots : []
  if (list.length < 2 || list.length > 6) return { problem: 'Pick two to six bots.' }
  const profiles = new Set()
  const handles = new Set(['all', 'everyone'])
  const roster = []
  for (const bot of list) {
    const connectionId = bot?.route?.connectionId ?? bot?.connectionId
    if ((connectionId !== undefined && connectionId !== route.connectionId) || (connectionId === undefined && bot?.remoteSource)) {
      return { problem: 'Every member must run on the same connection as the group.' }
    }
    const profile = String(bot?.route?.targetProfile ?? bot?.targetProfile ?? bot?.name ?? '')
    const handle = String(bot?.handle ?? profile)
    if (!profile.trim() || !handle.trim() || profiles.has(profile.toLowerCase()) || handles.has(handle.toLowerCase())) {
      return { problem: 'Two members share a name.' }
    }
    profiles.add(profile.toLowerCase())
    handles.add(handle.toLowerCase())
    roster.push({
      member_id: profile,
      profile,
      handle,
      target: { kind: 'local', profile },
      ...(bot?.display_name ? { display_name: String(bot.display_name) } : {})
    })
  }
  return { roster }
}

/** canonicalApprovalPreview: Allow once only for the exact request and only
 *  when it shows a real command (or a labelled tool with its description). */
export function approvalPreview(action) {
  const approval = action?.approval
  const t = v => (typeof v === 'string' ? v.trim() : '')
  const command = t(approval?.command)
  const description = t(approval?.description)
  const labelled = /^<[^>]+> \(/.test(command)
  const actualCommand = labelled ? '' : command
  const matching = Boolean(t(action?.request_id)) && (!approval?.request_id || approval.request_id === action.request_id) && (!approval?.prompt_id || approval.prompt_id === action.request_id)
  return { actualCommand, description, reviewable: matching && Boolean(actualCommand || (labelled && description)) }
}

/** actCanonicalGroup: the params for a member's pending action. */
export function actionParams(roomId, action, choice) {
  const methods = { retry: 'groups.retry', discard: 'groups.discard', approval: 'groups.approve' }
  const method = methods[action?.kind]
  if (!method || !roomId || !action.member_id || !action.task_id || !Number.isSafeInteger(action.execution_generation) || action.execution_generation < 1) {
    throw new Error('Invalid pending action')
  }
  const params = { room_id: roomId, member_id: action.member_id, task_id: action.task_id, execution_generation: action.execution_generation }
  if (action.kind === 'approval') {
    if (!action.request_id || (choice !== 'once' && choice !== 'deny') || !Array.isArray(action.approval?.choices) || !action.approval.choices.includes(choice)) {
      throw new Error('Approval needs its exact request and a choice the gateway offered')
    }
    if (choice === 'once' && !approvalPreview(action).reviewable) throw new Error('Allow once needs a reviewable command')
    params.request_id = action.request_id
    params.choice = choice
  }
  return { method, params }
}

const MESSAGE_KINDS = new Set(['message', 'message.user', 'message.member'])
const NOTICE_KINDS = {
  'turn.failed': 'could not answer',
  'turn.cancelled': 'was stopped',
  'room.stop_requested': 'Stop requested',
  'room.disbanded': 'The group was disbanded',
  'room.continued': 'The discussion continues',
  'room.renamed': 'Renamed'
}

/** Room log events → transcript rows. */
export function roomItems(events, members) {
  const roster = new Map((Array.isArray(members) ? members : []).map(m => [String(m?.member_id || ''), m]))
  const nameOf = id => {
    const m = roster.get(String(id || ''))
    return String(m?.display_name || m?.handle || id || '')
  }
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
    const at = Number.isFinite(event?.created_at) ? Math.round(event.created_at * 1000) : undefined
    const id = `room:${event?.seq ?? event?.event_id}`
    if (MESSAGE_KINDS.has(event?.kind)) {
      const member = event?.actor?.kind === 'member'
      const text = String(payload.text || payload.content || '')
      const own = !member && event?.actor?.id === 'desktop' && !event?.actor?.display_name
      const scheduled = !member && /^cron(-notice)?:/.test(String(event?.actor?.id || ''))
      out.push({
        kind: member ? 'room-member' : 'room-user',
        id,
        seq: event.seq,
        eventId: event.event_id,
        at,
        text,
        author: member ? String(event?.actor?.display_name || nameOf(event?.actor?.id)) : own ? 'You' : String(event?.actor?.display_name || event?.actor?.id || 'Someone'),
        memberId: member ? String(event?.actor?.id || '') : '',
        profile: member ? String(roster.get(String(event?.actor?.id || ''))?.profile || event?.actor?.id || '') : '',
        scheduled,
        attachments: Array.isArray(payload.attachments) ? payload.attachments.map(a => ({ name: String(a?.name || a?.filename || 'file'), kind: String(a?.kind || 'file') })) : []
      })
      continue
    }
    if (event?.kind === 'room.activity' && payload.status === 'bounded') {
      out.push({ kind: 'room-paused', id, seq: event.seq, at, discussionEventId: String(payload.discussion_event_id || ''), text: 'The discussion reached its round limit.' })
      continue
    }
    const notice = NOTICE_KINDS[event?.kind]
    if (notice) {
      const who = payload.member_id ? `${nameOf(payload.member_id)} ` : ''
      const detail = payload.error || payload.reason || payload.reason_code
      out.push({ kind: 'notice', id, seq: event.seq, at, text: `${who}${notice}${detail ? `: ${detail}` : ''}` })
    }
  }
  return out
}

/** Merge a log page into the events held (append-only, by seq). */
export function mergeLog(events, page) {
  const known = new Set((events || []).map(e => e.seq))
  const fresh = (Array.isArray(page) ? page : []).filter(e => Number.isSafeInteger(e?.seq) && !known.has(e.seq))
  if (!fresh.length) return events
  return [...events, ...fresh].sort((a, b) => a.seq - b.seq)
}

/**
 * One open room. deps: { requestRoom, onEvent, setTimer?, now? }.
 * State: { phase, error, room, context, driver, events, items, posts, busy }.
 */
export function createRoomController(route, roomId, deps) {
  const setTimer = deps.setTimer || ((fn, ms) => {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  })
  let disposed = false
  let pollCancel = null
  let cursor = 0
  let reading = null
  let state = { phase: 'loading', error: null, room: null, context: null, driver: null, methods: [], events: [], items: [], posts: [], acting: {} }
  const listeners = new Set()
  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn(state)
      } catch {
        /* isolated */
      }
    }
  }
  const set = patch => {
    if (disposed) return
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    emit()
  }
  const req = (method, params) => deps.requestRoom(route, method, params)

  const offEvents =
    typeof deps.onEvent === 'function'
      ? deps.onEvent('*', event => {
          if (disposed) return
          const type = String(event?.type || '')
          const forRoom = String(event?.payload?.room_id || event?.room_id || '') === roomId
          if (forRoom && (type.startsWith('room.') || type.startsWith('group'))) void read()
        })
      : () => undefined

  async function readState() {
    const res = await req('groups.state', { room_id: roomId })
    set({ room: res?.room || state.room, context: res?.context ?? state.context, driver: res?.driver_status ?? null })
  }

  async function readLog() {
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await req('groups.log', { room_id: roomId, since_seq: cursor, limit: LOG_PAGE })
      const events = mergeLog(state.events, page?.events)
      cursor = Number.isSafeInteger(page?.cursor) ? Math.max(cursor, page.cursor) : cursor
      if (events !== state.events) set({ events, items: roomItems(events, state.room?.members) })
      if (!page?.has_more) break
    }
    // A post the log now shows is no longer pending (event ids are unique).
    const ids = new Set(state.events.map(e => e.event_id).filter(Boolean))
    if (state.posts.some(p => ids.has(p.eventId))) set(s => ({ posts: s.posts.filter(p => !ids.has(p.eventId)) }))
  }

  function read() {
    if (reading) return reading
    reading = (async () => {
      try {
        await readState()
        await readLog()
        if (state.phase !== 'ready') set({ phase: 'ready', error: null, items: roomItems(state.events, state.room?.members) })
      } catch (error) {
        if (state.phase !== 'ready') set({ phase: 'error', error: String(error?.message || error) })
      } finally {
        reading = null
      }
    })()
    return reading
  }

  async function open() {
    try {
      const caps = await req('groups.capabilities', {})
      set({ methods: Array.isArray(caps?.methods) ? caps.methods : [], canDrive: caps?.driver === true })
    } catch {
      set({ canDrive: true })
    }
    await read()
    schedule()
    return state
  }

  function schedule() {
    if (disposed) return
    pollCancel = setTimer(async () => {
      pollCancel = null
      await read()
      schedule()
    }, ROOM_POLL_MS)
  }

  /** Post to the room. Resolves { ok, posted: 'yes' | 'no' | 'unknown' }. */
  async function post(text, { thread } = {}) {
    const clean = String(text || '').trim()
    if (!clean) return { ok: false, posted: 'no' }
    const eventId = uuid()
    const entry = { eventId, text: clean, params: { room_id: roomId, event_id: eventId, payload: { text: clean, thread_id: thread || eventId } }, status: 'sending', at: Date.now() }
    set(s => ({ posts: [...s.posts, entry] }))
    return attempt(entry)
  }

  async function attempt(entry) {
    set(s => ({ posts: s.posts.map(p => (p.eventId === entry.eventId ? { ...p, status: 'sending', error: undefined } : p)) }))
    try {
      await req('groups.send', entry.params)
      set(s => ({ posts: s.posts.map(p => (p.eventId === entry.eventId ? { ...p, status: 'sent' } : p)) }))
      void read()
      return { ok: true, posted: 'yes' }
    } catch (error) {
      const refused = roomPostFailure(error) === 'refused'
      const message = String(error?.message || error)
      if (refused) {
        set(s => ({ posts: s.posts.filter(p => p.eventId !== entry.eventId) }))
        return { ok: false, posted: 'no', error: message, text: entry.text }
      }
      set(s => ({ posts: s.posts.map(p => (p.eventId === entry.eventId ? { ...p, status: 'unknown', error: message } : p)) }))
      return { ok: false, posted: 'unknown', error: message }
    }
  }

  /** An uncertain post goes again under its own event id (the log de-duplicates). */
  function retryPost(eventId) {
    const entry = state.posts.find(p => p.eventId === eventId)
    return entry && entry.status === 'unknown' ? attempt(entry) : Promise.resolve({ ok: false, posted: 'no' })
  }

  async function act(action, choice) {
    const key = `${action.member_id}:${action.task_id}`
    const { method, params } = actionParams(roomId, action, choice)
    set(s => ({ acting: { ...s.acting, [key]: true } }))
    try {
      await req(method, params)
      await read()
      return true
    } finally {
      set(s => {
        const acting = { ...s.acting }
        delete acting[key]
        return { acting }
      })
    }
  }

  async function stop() {
    await req('groups.stop', { room_id: roomId, cancel_id: uuid() })
    void read()
  }

  async function continueDiscussion(discussionEventId) {
    await req('groups.continue', { room_id: roomId, discussion_event_id: discussionEventId })
    void read()
  }

  async function rename(name) {
    const clean = String(name || '').trim()
    if (!clean) return false
    const res = await req('groups.rename', { room_id: roomId, event_id: uuid(), name: clean })
    if (res?.room) set({ room: res.room })
    return true
  }

  async function disband() {
    await req('groups.disband', { room_id: roomId, cancel_id: uuid() })
    dispose()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    pollCancel?.()
    pollCancel = null
    try {
      offEvents()
    } catch {
      /* gone */
    }
    listeners.clear()
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    open,
    read,
    post,
    retryPost,
    act,
    stop,
    continueDiscussion,
    rename,
    disband,
    dispose
  }
}

/** groups.create with a fresh room id. */
export async function createRoom(requestRoom, route, name, bots) {
  const clean = String(name || '').trim()
  if (!clean) throw new Error('Give the group a name.')
  const checked = roomRoster(route, bots)
  if (checked.problem) throw new Error(checked.problem)
  const res = await requestRoom(route, 'groups.create', { room_id: uuid(), name: clean, members: checked.roster })
  return res?.room
}
