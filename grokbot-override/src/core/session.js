// One open Bot Chat: resolve the canonical row, read its history, attach to
// its runtime session, and fold live gateway events into chat items.
//
// Dependencies are injected so node:test can drive the whole lifecycle:
//   requestForBot(bot, method, params, options)   gateway JSON-RPC (routing.js)
//   readHistory(bot, sessionId, { limit, offset }) REST transcript page (read-only)
//   onEvent(type, listener) -> dispose             gateway event tap ('*')
//   retainRoute(bot, options) -> Promise<release>  optional: hold the bot's route
//                                                  open (routing.js retainBotRoute);
//                                                  rejects when it cannot be held
//   setTimer(fn, ms) -> cancel, now(), isVisible() optional
//
// Route lifetime: a bot on a secondary (pooled) connection is reached through
// host.requestProfile, and each call is its own lease. At zero leases the
// socket closes and the gateway reaps the runtime session it minted. So the
// controller takes ONE retainRoute lease before its first session.resume. A
// lease that cannot be had stops every session-scoped call (review r2 #4):
// the chat still shows history, sending fails as "not sent" and is retried
// with a fresh acquisition. The lease is held until the chat is disposed, or,
// after the user closed it (retire), until in-flight sends and the running
// turn have settled, bounded by `retireMaxMs` (review r2 #5).
//
// Event continuity (review r2 #2, #3): events that arrive while session.resume
// is in flight are buffered; once the runtime is known, id-keyed frames
// (approvals, clarify, tools, status) are applied, and any stream or terminal
// frame makes the window ambiguous, so the controller asks the gateway for the
// real state instead of guessing. Sequenced frames are applied once. While a
// turn runs, a watchdog asks session.active_list after a quiet spell (with
// backoff) and settles a turn the gateway reports idle; a runtime found gone
// is re-attached by itself (bounded). A prompt.submit receipt can never undo
// a completion that already arrived.
//
// Delivery rule (review r3 #1, #2): never send twice. A prompt is
// re-submitted automatically only when the gateway refused it because the
// runtime was not in memory (legacy 4001 "session not found": nothing ran).
// A failure is "not sent" only when Hermes's contract says the request was
// refused before anything was admitted (core/outcomes.js lists them); the
// payload is kept for the composer or an explicit Retry. Everything else
// (timeout, dropped socket, SESSION_OWNER_UNCONFIRMED, an unknown error) is
// "delivery unknown": it is never restored and never offered for a resend.
// The stored transcript is read to find it (automatically, on the idle
// refresh and on a read-only "Check again"); until it is found it stays
// unknown, and the way forward is Hermes Bot Mode.
//
// Staged images (review r3 #3): a legacy gateway keeps `image.attach_bytes`
// images on the runtime until the next prompt.submit takes them. The
// controller keeps each receipt until the send that carries it is accepted,
// a refusal says Hermes removed it, or it is detached; before every submit it
// detaches staged images the send does not carry, so an image the user removed
// from a restored draft never rides along with later text.
//
// Creating a Bot Chat (PARITY C3) follows stock's createCanonicalChat exactly
// (core/create-chat.js): registry first, adopt on conflict, eager title. It
// runs only on an explicit user open (`createIfMissing`, a roster click) or
// the "Start Bot Chat" button (`create()`); any other open of a bot without
// one ends in phase 'no-chat'. The route lease is taken before session.create
// so the runtime it mints is not reaped before the eager title lands.

import { canonicalIds, findCanonicalChat, openedSessionId } from './canonical.js'
import { createCanonicalChat } from './create-chat.js'
import { draftOwnerKey } from './drafts.js'
import {
  historyToItems,
  isPersistedItem,
  mergeOlderRows,
  mergeTailRows,
  rebuildItems,
  rowIdentity,
  rowsToItems,
  rowText
} from './history.js'
import { newSubmissionId } from './delivery.js'
import {
  classifySubmitFailure,
  isAdmittedConflict,
  isIdentityRefusal,
  isMethodNotServed,
  isRuntimeNotFoundRefusal,
  isSessionGoneError,
  looksUnsupported,
  rpcErrorParts,
  rewindFailure,
  slashExecFailure,
  steerFailure,
  submitDelivery,
  withoutRefusedParams
} from './outcomes.js'
import { applyEvent, emptyLive, finishTurn, initialChatState, inputRequestFrom, unshownTurnText } from './reducer.js'
import { resolveBotConnectionRoute } from './routing.js'
import {
  cutRewoundItems,
  cutRewoundRows,
  durableRowIdsForRebind,
  rebindItems,
  rebindRows,
  retryText,
  survivorRowIdsFrom,
  userTurnFromEnd
} from './rewind.js'
import { VALUE_KINDS, valueResult } from './prompts.js'
import { COMPRESS_TIMEOUT_MS, HELP_TEXT, parseCommandDispatch, parseSlash, renderRpcResult, slashSurface } from './slash.js'
import {
  APPROVAL_RESPOND_TIMEOUT_MS,
  cancelApprovals,
  hasPendingApproval,
  reconcilePending,
  respondResolvedNothing,
  setApprovalStatus,
  upsertApproval,
  approvalFromPayload
} from './approvals.js'

export const HISTORY_PAGE = 120
const RESUME_TIMEOUT_MS = 180_000
const APPROVAL_POLL_MS = 2_000
const IDLE_REFRESH_MS = 15_000
// Busy watchdog: first check after this much silence, doubling to the max.
const WATCH_FIRST_MS = 10_000
const WATCH_MAX_MS = 60_000
// Re-attach after a runtime was found gone: a few tries, then wait for the user.
const REATTACH_DELAYS_MS = [1_000, 5_000, 30_000]
// Not attached this long after a failed attach: the chat says "Reconnecting…".
export const RECONNECTING_NOTICE_MS = 10_000

// session.resume keys, as stock Bot Mode sends them (group-compress.ts:67
// {session_id, profile, omit_messages}). Each is in BOTH resume contracts of
// Hermes @2bd378ed1b: the TUI sidecar's SessionResumeParams and the session
// authority's CanonicalResumeParams (tui_gateway/contracts/sessions.py:182,
// canonical_sessions.py:58). The authority serves every chat it owns (a new
// bot's Bot Chat is born on the gateway's local platform) and refuses ANY
// key outside its closed set before the handler runs (gateway/
// session_controls.py:327: 4001 invalid_params, data.fields = the keys).
// `inline_images` is sidecar-only; sending it left every new bot's chat
// "paused (invalid_params)".
// `source: 'desktop'` is what stock Desktop sends on every resume
// (use-session-actions/resume-owner.ts primaryResumeParams): the gateway then
// builds the agent for the desktop chat surface (tui_gateway/agent_factory.py
// _resolve_session_source; agent/prompt_builder.py platform hints: rendered
// markdown, MEDIA:, ::preview widgets, cards) instead of the terminal UI it
// assumes when no source is sent. Both contracts take a free-form `source`.
export const RESUME_KEYS = Object.freeze(['session_id', 'profile', 'omit_messages', 'source'])
export const SESSION_SOURCE = 'desktop'

/** A refused session.resume, corrected once: the params without the keys an
 *  `invalid_params` refusal names (never session_id or profile), or, when the
 *  session was not found under the opened id, the Bot Chat's other id (its
 *  registry row vs its lineage tip). Null when there is nothing to correct. */
export function correctedResumeParams(error, params, canonical) {
  const { code, data, reason } = rpcErrorParts(error)
  if (reason === 'invalid_params' && Array.isArray(data?.fields)) {
    return withoutRefusedParams(error, params, ['session_id', 'profile'])
  }
  if (code === 4007 || reason === 'not_found' || (code === 4001 && !reason)) {
    const other = canonicalIds(canonical).find(id => id !== params.session_id)
    return other ? { ...params, session_id: other } : null
  }
  return null
}
// A closed chat keeps running an explicitly sent turn at most this long.
const RETIRE_MAX_MS = 30 * 60_000
const DELIVERY_CHECK_MS = 4_000
const DELIVERY_CHECK_TRIES = 3
const EVENT_BUFFER_MAX = 512

// Every error verdict comes from core/outcomes.js (review override-v2-r3).
export { isSessionGoneError, submitDelivery }

// Frames that are keyed by an id (or replace state outright), so applying one
// that the snapshot already reflects changes nothing.
const IDEMPOTENT_EVENTS = new Set([
  'approval.request',
  'approval.settled',
  'approval.cancelled',
  'clarify.request',
  'clarify.settled',
  'request.cancel',
  'connection.request',
  'connection.update',
  'tool.generating',
  'tool.start',
  'tool.complete',
  'status.update',
  'message.reaction'
])
const TURN_EVENTS = new Set(['message.start', 'message.complete', 'error'])
const TEXT_EVENTS = new Set(['message.delta', 'message.interim', 'reasoning.delta', 'thinking.delta', 'reasoning.available'])

export function createChatController(bot, deps, options = {}) {
  const attachOnOpen = options.attachOnOpen !== false
  const now = deps.now || (() => Date.now())
  const setTimer = deps.setTimer || ((fn, ms) => {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  })
  const visible = () => {
    try {
      return typeof deps.isVisible === 'function' ? deps.isVisible() !== false : true
    } catch {
      return true
    }
  }

  let disposed = false
  let retiring = false
  let state = {
    bot,
    phase: 'idle',
    error: null,
    canonical: null,
    storedId: '',
    runtimeId: '',
    attaching: false,
    attachError: null,
    // Still not attached RECONNECTING_NOTICE_MS after a failed attach: the
    // only attach state the chat shows (never the raw error).
    reconnecting: false,
    leaseError: null,
    sendBlocked: null,
    hasMore: false,
    loadingMore: false,
    loadedCount: 0,
    rows: [],
    receipt: null,
    stopError: null,
    chat: initialChatState()
  }
  const listeners = new Set()
  let attachFlight = null
  let pollCancel = null
  let idleCancel = null
  let generation = 0
  // Bumped by every approval event and runtime change: an approval.pending
  // reply that was requested before the bump is older than what is on screen
  // and is discarded (review r1 #3).
  let approvalEpoch = 0
  // Bumped by every turn transition (start, completion, error, settle): a
  // receipt or a reconciliation answer requested before the bump is older
  // than the screen and may not move busy (review r2 #3).
  let turnSeq = 0
  // Bumped by every text frame: a snapshot read during which text arrived
  // does not replace the live bubble's text.
  let textSeq = 0
  let eventCount = 0
  let lastSeq = 0
  let seqEpoch = ''
  let lease = null
  let leaseFlight = null
  let buffer = null
  let bufferOverflow = false
  let sendsInFlight = 0
  let watchCancel = null
  let watchToken = null
  let watchDelay = WATCH_FIRST_MS
  let reconcileFlight = null
  let reconcileAgain = false
  let reattachCancel = null
  let reconnectCancel = null
  // Keys a refusal named once: never sent again by this chat.
  const resumeDropped = new Set()
  let reattachTry = 0
  let retireCancel = null
  const deliveryChecks = new Map()
  // Failed sends keep what is needed to retry them: text, attachments and the
  // stored rows known when they were sent (for the delivery check).
  const payloads = new Map()
  // Attachments already staged on a runtime: `${runtimeId}|${id}` ->
  // { kind: 'file', ref } or { kind: 'image', path, mime }. Kept until the
  // send carrying them is accepted, Hermes says it removed them, or they are
  // detached (review r3 #3); a resend on the same runtime reuses them.
  const staged = new Map()
  // Attachment ids a send in flight is staging or submitting right now.
  const inFlightFiles = new Map()

  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener(state)
      } catch {
        /* a broken subscriber never breaks the chat */
      }
    }
  }
  const set = patch => {
    if (disposed) return
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    emit()
  }
  const setChat = update => set(s => ({ chat: update(s.chat) }))
  const route = (() => {
    try {
      return resolveBotConnectionRoute(bot).route
    } catch {
      return null
    }
  })()

  const offEvents = deps.onEvent('*', event => {
    if (disposed) return
    if (!state.runtimeId) {
      if (buffer) {
        // session.resume is in flight: keep the frame until its runtime is known.
        if (buffer.length < EVENT_BUFFER_MAX) buffer.push(event)
        else bufferOverflow = true
      }
      return
    }
    handleEvent(event)
  })

  function handleEvent(event) {
    const type = event?.type
    if (type === 'gateway.ready') {
      // The bot's socket (re)connected: make sure the turn on screen is real.
      const from = String(event?.connectionId || '')
      if (state.chat.busy && (!from || from === String(route?.connectionId || ''))) void reconcile()
      return
    }
    if (String(event?.session_id || '') !== state.runtimeId) {
      if (type === 'session.reclaimed' && matchesStored(event?.payload?.stored_session_id)) onReclaimed()
      return
    }
    if (type === 'session.reclaimed') return onReclaimed()
    if (type === 'session.replay_gap') {
      // The reconnect replay could not cover what was missed: ask for the truth.
      void reconcile({ snapshot: true })
      return
    }
    if (!admitSeq(event)) return
    eventCount += 1
    if (typeof type === 'string' && type.startsWith('approval.')) approvalEpoch += 1
    if (TURN_EVENTS.has(type)) turnSeq += 1
    if (TEXT_EVENTS.has(type)) textSeq += 1
    const wasBusy = state.chat.busy
    setChat(chat => applyEvent(chat, event, now()))
    if (!wasBusy && state.chat.busy) onTurnStarted()
    if (wasBusy && !state.chat.busy) onTurnSettled()
  }

  /** A sequenced frame is applied once (the host replays after a reconnect). */
  function admitSeq(event) {
    const seq = event?.seq
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return true
    const epoch = String(event?.replayEpoch || event?.replay_epoch || '')
    if (epoch && seqEpoch && epoch !== seqEpoch) lastSeq = 0 // the backend restarted its numbering
    if (epoch) seqEpoch = epoch
    if (seq <= lastSeq) return false
    lastSeq = seq
    return true
  }

  function matchesStored(id) {
    const value = String(id || '')
    return Boolean(value) && (value === state.storedId || value === String(state.canonical?.id || ''))
  }

  /** Forget the runtime (and everything tied to it). */
  function dropRuntime(patch = {}) {
    lastSeq = 0
    seqEpoch = ''
    approvalEpoch += 1
    for (const key of [...staged.keys()]) staged.delete(key)
    set({ runtimeId: '', ...patch })
  }

  function onReclaimed() {
    stopApprovalPoll()
    stopWatch()
    turnSeq += 1
    dropRuntime()
    setChat(chat => ({ ...chat, busy: false, status: null, live: emptyLive(), waiting: null }))
    maybeFinishRetire()
  }

  /** Close the turn on screen (the gateway says it is over). */
  function settleTurn(reason) {
    stopApprovalPoll()
    stopWatch()
    turnSeq += 1
    setChat(chat => {
      const done = finishTurn(chat)
      return { ...done, items: cancelApprovals(done.items.map(item => (item.streaming ? { ...item, streaming: false } : item)), [], reason) }
    })
  }

  /** The runtime this chat was attached to is gone (reaped, or its socket
   *  dropped) while a turn may have been running. Settle the screen, read
   *  the stored transcript and re-attach (bounded); never re-send anything. */
  function onRuntimeLost(reason = 'session ended') {
    settleTurn(reason)
    dropRuntime()
    void refresh()
    if (retiring) return maybeFinishRetire()
    scheduleReattach()
  }

  function scheduleReattach() {
    if (disposed || retiring || reattachCancel || reattachTry >= REATTACH_DELAYS_MS.length) return
    const delay = REATTACH_DELAYS_MS[reattachTry]
    reattachTry += 1
    reattachCancel = setTimer(async () => {
      reattachCancel = null
      if (disposed || retiring || state.runtimeId || !state.storedId) return
      try {
        await attach()
        reattachTry = 0
      } catch {
        scheduleReattach()
      }
    }, delay)
  }

  // ── route lease ──────────────────────────────────────────────────────────

  function ensureLease() {
    if (lease || disposed || typeof deps.retainRoute !== 'function') return Promise.resolve()
    if (leaseFlight) return leaseFlight
    leaseFlight = (async () => {
      let release
      try {
        release = await deps.retainRoute(bot, { spawnPriority: 'foreground' })
      } catch (error) {
        leaseFlight = null
        const message = String(error?.message || error)
        set({ leaseError: message, ...(error?.code === 'GBO_NO_RETENTION' ? { sendBlocked: message } : {}) })
        const failure = new Error(`Could not keep the connection to ${String(bot?.name || 'this bot')} open (${message})`)
        failure.code = error?.code
        throw failure
      }
      leaseFlight = null
      if (typeof release !== 'function') release = () => undefined
      let released = false
      const once = () => {
        if (released) return
        released = true
        try {
          release()
        } catch {
          /* already closed */
        }
      }
      if (disposed) once()
      else {
        lease = once
        if (state.leaseError || state.sendBlocked) set({ leaseError: null, sendBlocked: null })
      }
    })()
    return leaseFlight
  }

  async function readPage(offset) {
    const page = await deps.readHistory(bot, state.storedId, { limit: HISTORY_PAGE, offset })
    return Array.isArray(page?.messages) ? page.messages : []
  }

  /** Items a history rebuild keeps: anything live while a turn runs; when
   *  idle only what was never stored (an unsent bubble, a waiting card). */
  const keepLocal = item => item.failed || item.kind === 'command' || (item.kind === 'approval' && item.status === 'pending')
  const keepLive = item => !isPersistedItem(item)

  async function open() {
    const mine = ++generation
    set({ phase: 'resolving', error: null })
    let canonical
    try {
      canonical = await findCanonicalChat(deps.requestForBot, bot)
    } catch (error) {
      if (mine === generation) set({ phase: 'error', error: String(error?.message || error) })
      return state
    }
    if (mine !== generation || disposed) return state
    if (!canonical) {
      if (options.createIfMissing) return create()
      set({ phase: 'no-chat', canonical: null })
      return state
    }
    return load(canonical, mine)
  }

  let creating = null

  /** Create the bot's Bot Chat (a user action): stock's createCanonicalChat,
   *  then open it like any other. An existing chat found on the way (or one
   *  that won a race) is adopted. The intro turn runs only with `kickoff`:
   *  a bot the user just created (R13, create-dialog.tsx:715); a roster click
   *  never re-fires it. */
  function create({ kickoff = false } = {}) {
    if (creating) return creating
    const mine = ++generation
    creating = (async () => {
      set({ phase: 'creating', error: null })
      try {
        await ensureLease()
        if (disposed || mine !== generation) return state
        const result = await createCanonicalChat(deps.requestForBot, bot, { kickoff: Boolean(kickoff), wait: deps.wait })
        if (disposed || mine !== generation) return state
        if (!result?.row?.id) throw new Error('Hermes did not create the Bot Chat. Try again.')
        return await load(result.row, mine)
      } catch (error) {
        if (mine === generation && !disposed) set({ phase: 'error', error: String(error?.message || error) })
        return state
      } finally {
        creating = null
      }
    })()
    return creating
  }

  async function load(canonical, mine) {
    const storedId = openedSessionId(canonical)
    set({ phase: 'loading', canonical, storedId })

    let loaded = false
    try {
      const rows = await readPage(0)
      if (mine !== generation || disposed) return state
      set({
        phase: 'ready',
        rows,
        loadedCount: rows.length,
        hasMore: rows.length >= HISTORY_PAGE,
        chat: { ...initialChatState(rowsToItems(rows)) }
      })
      loaded = true
    } catch (error) {
      if (!attachOnOpen) {
        set({ phase: 'error', error: `Could not read the Bot Chat history (${String(error?.message || error)})` })
        return state
      }
    }

    if (attachOnOpen) {
      try {
        await attach({ withHistory: !loaded })
      } catch (error) {
        if (!loaded) set({ phase: 'error', error: String(error?.message || error) })
        else {
          // The history is on screen and the idle refresh keeps it current;
          // the attach is retried in the background (bounded), silently.
          set({ attachError: String(error?.message || error) })
          scheduleReattach()
        }
      }
    }
    if (state.phase === 'ready' && !retiring) scheduleIdleRefresh()
    return state
  }

  function resumeParams(withHistory) {
    const params = {
      session_id: state.storedId,
      profile: String(bot?.name || 'default'),
      omit_messages: !withHistory,
      source: SESSION_SOURCE
    }
    for (const key of resumeDropped) delete params[key]
    return params
  }

  function resume(params) {
    return deps.requestForBot(bot, 'session.resume', params, { spawnPriority: 'foreground', timeoutMs: RESUME_TIMEOUT_MS })
  }

  /** session.resume, and on a refusal we can correct (correctedResumeParams)
   *  one retry with the corrected params; the correction sticks. */
  async function resumeOnce(withHistory) {
    const params = resumeParams(withHistory)
    try {
      return await resume(params)
    } catch (error) {
      const corrected = disposed ? null : correctedResumeParams(error, params, state.canonical)
      if (!corrected) throw error
      for (const key of Object.keys(params)) if (!(key in corrected)) resumeDropped.add(key)
      const snapshot = await resume(corrected)
      if (corrected.session_id !== state.storedId && !disposed) set({ storedId: corrected.session_id })
      return snapshot
    }
  }

  function startReconnectNotice() {
    if (reconnectCancel || disposed || state.reconnecting) return
    reconnectCancel = setTimer(() => {
      reconnectCancel = null
      if (!disposed && !state.runtimeId) set({ reconnecting: true })
    }, RECONNECTING_NOTICE_MS)
  }

  function stopReconnectNotice() {
    reconnectCancel?.()
    reconnectCancel = null
  }

  /** Attach to the stored session's runtime (session.resume). Reuses the
   *  live runtime when the gateway already holds one; never creates. */
  function attach({ withHistory = false } = {}) {
    if (state.runtimeId) return Promise.resolve(state.runtimeId)
    if (attachFlight) return attachFlight
    if (!state.storedId) return Promise.reject(new Error('No Bot Chat to attach to'))
    set({ attaching: true, attachError: null })
    buffer = []
    bufferOverflow = false
    attachFlight = (async () => {
      try {
        await ensureLease()
        if (disposed) throw new Error('This chat was closed')
        const snapshot = await resumeOnce(withHistory)
        const runtimeId = String(snapshot?.session_id || '')
        if (!runtimeId) throw new Error('The gateway did not return a live session')
        if (disposed) return runtimeId
        const held = takeBuffer()
        approvalEpoch += 1
        turnSeq += 1
        lastSeq = 0
        seqEpoch = ''
        absorbSnapshot(snapshot, { withHistory, initial: true })
        stopReconnectNotice()
        set({ runtimeId, attaching: false, attachError: null, reconnecting: false })
        reattachTry = 0
        replayWindow(held, runtimeId, Boolean(snapshot?.running || snapshot?.info?.running))
        if (state.chat.busy) onTurnStarted()
        return runtimeId
      } catch (error) {
        takeBuffer()
        set({ attaching: false, attachError: String(error?.message || error) })
        startReconnectNotice()
        throw error
      } finally {
        attachFlight = null
      }
    })()
    return attachFlight
  }

  function takeBuffer() {
    const frames = buffer || []
    const overflow = bufferOverflow
    buffer = null
    bufferOverflow = false
    return { frames, overflow }
  }

  /** Frames that arrived while session.resume was in flight. The snapshot
   *  carries no event cursor, so a frame may be older or newer than it. */
  function replayWindow({ frames, overflow }, runtimeId, running) {
    let ambiguous = overflow
    for (const event of frames) {
      if (String(event?.session_id || '') !== runtimeId) continue
      const type = event?.type
      if (type === 'session.reclaimed') return onReclaimed()
      if (type === 'session.replay_gap') ambiguous = true
      else if (IDEMPOTENT_EVENTS.has(type)) {
        // An approval request older than a snapshot that no longer lists it
        // would revive an answered card: only while the turn runs, and the
        // approval read that follows reconciles it.
        if (type === 'approval.request' && !running) continue
        handleEvent(event)
      } else if (TURN_EVENTS.has(type) || TEXT_EVENTS.has(type)) ambiguous = true
    }
    if (ambiguous) void reconcile({ snapshot: true })
  }

  /** Fold a session.resume snapshot into the chat. `initial`: a fresh attach
   *  (the inflight reply becomes a new live bubble). Otherwise a re-read while
   *  attached: the snapshot's whole-turn text minus what earlier (closed)
   *  segments of this turn already show is the live segment; it replaces the
   *  live bubble's text, or becomes a new live bubble when none exists (the
   *  missed frames were the segment's first ones, review r3 #4), only when
   *  `replaceText` (no text frame arrived during the read). Never appends a
   *  second copy of the reply, never revives a closed segment, and leaves the
   *  text alone when the snapshot does not match what is shown. */
  function absorbSnapshot(snapshot, { withHistory = false, initial = false, replaceText = true } = {}) {
    setChat(chat => {
      let items = chat.items
      if (withHistory && Array.isArray(snapshot?.messages)) items = historyToItems(snapshot.messages, { idPrefix: 'r:' })
      const running = Boolean(snapshot?.running || snapshot?.info?.running)
      const inflight = snapshot?.inflight && typeof snapshot.inflight === 'object' ? snapshot.inflight : null
      // The resumed partial reply is the bubble later deltas extend. Its id is
      // taken when it is created, never as "the last item": a pending
      // approval appended after it must not receive the stream (review r1 #6).
      // The snapshot carries no turn/segment stamp (InflightTurn contract),
      // so the segment cursor starts fresh, as it does in the app.
      let bubbleId = !initial && chat.live.bubbleId && items.some(item => item.id === chat.live.bubbleId) ? chat.live.bubbleId : null
      const whole = inflight?.streaming && typeof inflight.assistant === 'string' ? inflight.assistant : ''
      if (whole && initial) {
        bubbleId = `inflight:${now()}`
        items = [...items, { kind: 'assistant', id: bubbleId, text: whole, at: now(), streaming: true }]
      } else if (whole && replaceText) {
        const text = unshownTurnText(whole, chat.live.sealed)
        if (text && bubbleId) {
          items = items.map(item => (item.id === bubbleId ? { ...item, text, streaming: true } : item))
        } else if (text) {
          bubbleId = `inflight:${now()}`
          items = [...items, { kind: 'assistant', id: bubbleId, text, at: now(), streaming: true }]
        }
      }
      if (initial && inflight?.status === 'error' && inflight.error && !running) {
        items = [...items, { kind: 'error', id: `inflight-error:${now()}`, text: String(inflight.error), at: now() }]
      }
      const pending = approvalFromPayload(snapshot?.pending_approval)
      if (pending) items = upsertApproval(items, pending, now())
      let waiting = null
      if (running) {
        for (const request of Array.isArray(snapshot?.open_requests) ? snapshot.open_requests : []) {
          waiting = inputRequestFrom(String(request?.method || ''), request?.params, request?.id)
          if (waiting) break
        }
        if (!waiting && snapshot?.pending_connection) waiting = inputRequestFrom('connection', snapshot.pending_connection)
      }
      const live = initial ? (bubbleId ? { ...emptyLive(), bubbleId } : emptyLive()) : { ...chat.live, bubbleId }
      return { ...chat, items, busy: running, live, waiting }
    })
    if (withHistory) set({ phase: 'ready', hasMore: false })
  }

  // ── reconciliation ───────────────────────────────────────────────────────

  /** Ask the gateway what the attached runtime is doing and correct the
   *  screen. Never infers completion from silence or a failed request, and
   *  never re-sends. `snapshot`: also re-read the live turn (session.resume)
   *  when it is still running, to repair text from an ambiguous window.
   *  Single-flight; a request for a snapshot during a flight runs after it. */
  function reconcile({ snapshot = false } = {}) {
    if (disposed) return Promise.resolve('closed')
    if (reconcileFlight) {
      reconcileAgain = reconcileAgain || snapshot
      return reconcileFlight
    }
    reconcileFlight = (async () => {
      try {
        return await reconcileOnce(snapshot)
      } finally {
        reconcileFlight = null
        if (reconcileAgain && !disposed) {
          reconcileAgain = false
          void reconcile({ snapshot: true })
        }
      }
    })()
    return reconcileFlight
  }

  async function reconcileOnce(snapshot) {
    const runtimeId = state.runtimeId
    if (!runtimeId) return 'detached'
    const turnBefore = turnSeq
    let status = null
    try {
      const res = await deps.requestForBot(bot, 'session.active_list', { profile: String(bot?.name || 'default'), current_session_id: runtimeId })
      if (!Array.isArray(res?.sessions)) return 'unknown'
      const item = res.sessions.find(entry => String(entry?.id || '') === runtimeId)
      status = item ? String(item.status || 'working') : 'absent'
    } catch (error) {
      if (!looksUnsupported(error)) return 'unknown' // a dropped socket is not a completion (read-only check)
      status = null // an older gateway: read the snapshot instead
    }
    if (disposed || runtimeId !== state.runtimeId) return 'stale'
    if (status === 'absent') {
      onRuntimeLost('session ended')
      return 'lost'
    }
    if (status === 'idle') {
      if (turnSeq !== turnBefore || sendsInFlight > 0) return 'stale'
      if (state.chat.busy) {
        settleTurn('turn ended')
        void refresh()
        maybeFinishRetire()
      }
      return 'idle'
    }
    // Blocked on a question this window never received (a legacy server
    // request is not delivered to plugins): the snapshot lists it (C11).
    if (status === null || snapshot || (status === 'waiting' && !state.chat.waiting)) return refreshSnapshot(runtimeId)
    return 'running'
  }

  async function refreshSnapshot(runtimeId) {
    const turnBefore = turnSeq
    const textBefore = textSeq
    let snap
    try {
      snap = await deps.requestForBot(bot, 'session.resume', resumeParams(false), { timeoutMs: RESUME_TIMEOUT_MS })
    } catch (error) {
      if (!disposed && runtimeId === state.runtimeId && isSessionGoneError(error)) {
        onRuntimeLost('session ended')
        return 'lost'
      }
      return 'unknown'
    }
    if (disposed || runtimeId !== state.runtimeId) return 'stale'
    const sid = String(snap?.session_id || '')
    if (!sid) return 'unknown'
    if (sid !== runtimeId) {
      // The old runtime is gone and the gateway handed out a new one: settle
      // what was on screen and adopt the new runtime's snapshot.
      settleTurn('session ended')
      dropRuntime()
      turnSeq += 1
      absorbSnapshot(snap, { initial: true })
      set({ runtimeId: sid })
      if (state.chat.busy) onTurnStarted()
      else void refresh()
      return 'reattached'
    }
    if (turnSeq !== turnBefore) return 'stale'
    const running = Boolean(snap?.running || snap?.info?.running)
    if (!running) {
      if (sendsInFlight > 0) return 'stale'
      if (state.chat.busy) {
        settleTurn('turn ended')
        void refresh()
        maybeFinishRetire()
      }
      return 'idle'
    }
    approvalEpoch += 1
    const wasBusy = state.chat.busy
    absorbSnapshot(snap, { replaceText: textSeq === textBefore })
    if (!wasBusy && state.chat.busy) onTurnStarted()
    return 'running'
  }

  // ── busy watchdog ────────────────────────────────────────────────────────

  function onTurnStarted() {
    startApprovalPoll()
    startWatch()
  }

  function startWatch() {
    if (watchCancel || disposed || !state.runtimeId || !state.chat.busy) return
    watchDelay = WATCH_FIRST_MS
    armWatch()
  }

  function armWatch() {
    const token = {}
    const seen = eventCount
    watchToken = token
    watchCancel = setTimer(async () => {
      if (watchToken !== token) return
      watchCancel = null
      if (disposed || !state.runtimeId || !state.chat.busy) return
      if (eventCount !== seen) {
        // The turn is talking: nothing to check yet.
        watchDelay = WATCH_FIRST_MS
        return armWatch()
      }
      await reconcile()
      if (disposed || watchCancel || !state.runtimeId || !state.chat.busy) return
      watchDelay = Math.min(watchDelay * 2, WATCH_MAX_MS)
      armWatch()
    }, visible() ? watchDelay : WATCH_MAX_MS)
  }

  function stopWatch() {
    watchCancel?.()
    watchCancel = null
    watchToken = null
  }

  // ── history ──────────────────────────────────────────────────────────────

  async function loadEarlier() {
    if (state.loadingMore || !state.hasMore || !state.storedId) return
    set({ loadingMore: true })
    try {
      const older = await readPage(state.rows.length)
      if (disposed) return
      set(s => {
        const rows = mergeOlderRows(older, s.rows)
        return {
          loadingMore: false,
          rows,
          loadedCount: rows.length,
          hasMore: older.length >= HISTORY_PAGE,
          chat: { ...s.chat, items: rebuildItems(s.chat.items, rowsToItems(rows), keepLive) }
        }
      })
    } catch (error) {
      set({ loadingMore: false, attachError: String(error?.message || error) })
    }
  }

  function mergeTail(tail, keep) {
    set(s => {
      const rows = mergeTailRows(s.rows, tail)
      const joined = rows.length > tail.length
      return {
        rows,
        loadedCount: rows.length,
        hasMore: joined ? s.hasMore : tail.length >= HISTORY_PAGE,
        chat: { ...s.chat, items: rebuildItems(s.chat.items, rowsToItems(rows), keep) }
      }
    })
  }

  /** Re-read the tail while idle (another surface or a cron delivery wrote
   *  to the chat). Read-only; skipped while a turn streams. The fresh page is
   *  merged into the loaded rows: earlier pages stay, the offset of the next
   *  "Show earlier messages" stays exact, and an unsent bubble or a waiting
   *  approval card stays where it was (review r1 #5). */
  async function refresh() {
    if (!state.storedId || state.chat.busy || state.phase !== 'ready' || state.loadingMore) return
    try {
      const tail = await readPage(0)
      if (disposed || state.chat.busy || state.loadingMore) return
      mergeTail(tail, keepLocal)
      resolveUnknownFrom(tail)
    } catch {
      /* the next tick retries */
    }
  }

  function scheduleIdleRefresh() {
    if (disposed || retiring) return
    idleCancel?.()
    idleCancel = setTimer(async () => {
      idleCancel = null
      if (disposed || retiring) return
      await refresh()
      scheduleIdleRefresh()
    }, options.idleRefreshMs ?? IDLE_REFRESH_MS)
  }

  function onTurnSettled() {
    stopApprovalPoll()
    stopWatch()
    set(s => ({ chat: { ...s.chat, items: cancelApprovals(s.chat.items, [], 'turn ended') } }))
    maybeFinishRetire()
  }

  // ── approvals ────────────────────────────────────────────────────────────
  // The server request reaches the app's own handler; the override learns of
  // pending entries by asking (approval.pending is a read) while a turn runs.

  function startApprovalPoll() {
    if (pollCancel || disposed || !state.runtimeId || !state.chat.busy) return
    const tick = async () => {
      pollCancel = null
      if (disposed || !state.runtimeId || !state.chat.busy) return
      await pollApprovals()
      if (!disposed && !pollCancel && state.runtimeId && state.chat.busy) pollCancel = setTimer(tick, APPROVAL_POLL_MS)
    }
    pollCancel = setTimer(tick, 0)
  }

  function stopApprovalPoll() {
    pollCancel?.()
    pollCancel = null
  }

  async function pollApprovals() {
    const epoch = approvalEpoch
    const runtimeId = state.runtimeId
    if (!runtimeId) return
    try {
      const res = await deps.requestForBot(bot, 'approval.pending', { session_id: runtimeId })
      // An event or a new runtime since the request went out makes this list
      // older than the screen: drop it, the next tick reads again.
      if (disposed || epoch !== approvalEpoch || runtimeId !== state.runtimeId) return
      const list = Array.isArray(res?.approvals) ? res.approvals : []
      setChat(chat => ({ ...chat, items: reconcilePending(chat.items, list, now()) }))
    } catch (error) {
      if (!disposed && runtimeId === state.runtimeId && isSessionGoneError(error)) onRuntimeLost()
      /* otherwise an older gateway or a transient: cards still arrive via events/resume */
    }
  }

  async function respondApproval(requestId, choice) {
    const card = state.chat.items.find(item => item.kind === 'approval' && item.requestId === requestId)
    if (!card || card.status !== 'pending') return false
    setChat(chat => ({ ...chat, items: setApprovalStatus(chat.items, requestId, { status: 'answering', answer: choice }) }))
    try {
      const result = await deps.requestForBot(
        bot,
        'approval.respond',
        { session_id: state.runtimeId || undefined, request_id: requestId, choice },
        { timeoutMs: APPROVAL_RESPOND_TIMEOUT_MS }
      )
      approvalEpoch += 1
      if (respondResolvedNothing(result)) {
        // The gateway had nothing waiting under this id: the request ended
        // (answered elsewhere, timed out, turn over). Nothing was approved.
        setChat(chat => ({ ...chat, items: setApprovalStatus(chat.items, requestId, { status: 'expired', answer: undefined }) }))
        return false
      }
      setChat(chat => ({ ...chat, items: setApprovalStatus(chat.items, requestId, { status: 'answered', answer: choice }) }))
      return true
    } catch (error) {
      setChat(chat => ({
        ...chat,
        items: setApprovalStatus(chat.items, requestId, { status: 'pending', answer: undefined, error: String(error?.message || error) })
      }))
      return false
    }
  }

  // ── blocking prompts (C11; core/prompts.js names the calls) ─────────────

  function patchWaiting(waiting, patch) {
    setChat(chat =>
      chat.waiting && chat.waiting.kind === waiting.kind && chat.waiting.id === waiting.id
        ? { ...chat, waiting: patch === null ? null : { ...chat.waiting, ...patch } }
        : chat
    )
  }

  /** Answer the clarify / sudo / secret / vault prompt on screen. `answer`:
   *  clarify `{ [qid]: string | string[] | null }` (null = skipped), value
   *  prompts the value ('' declines; vault-login `{identifier, password}`).
   *  The value goes straight into the request and nowhere else. */
  async function answerPrompt(answer) {
    const waiting = state.chat.waiting
    if (!waiting || waiting.answering || waiting.kind === 'connection') return { ok: false }
    patchWaiting(waiting, { answering: true, error: undefined, unsupported: undefined })
    try {
      let status = 'ok'
      if (waiting.kind === 'clarify') {
        for (const question of waiting.questions || []) {
          const value = answer && Object.prototype.hasOwnProperty.call(answer, question.qid) ? answer[question.qid] : null
          const res = await deps.requestForBot(bot, 'clarify.lock', { request_id: waiting.id, question_id: question.qid, answer: value ?? null })
          if (res?.status === 'expired') {
            status = 'expired'
            break
          }
        }
      } else if (VALUE_KINDS.has(waiting.kind)) {
        const res = await deps.requestForBot(bot, 'request.answer', { id: waiting.id, result: valueResult(waiting.kind, answer) })
        if (res?.status === 'expired') status = 'expired'
      } else {
        throw new Error('Unknown question')
      }
      patchWaiting(waiting, null)
      return { ok: true, status }
    } catch (error) {
      const unsupported = looksUnsupported(error) // UI only: the card says so, nothing is re-sent
      patchWaiting(waiting, {
        answering: false,
        unsupported: unsupported || undefined,
        error: unsupported ? 'This Hermes version cannot take this answer from here.' : String(error?.message || error)
      })
      return { ok: false, unsupported }
    }
  }

  /** Drive the connection card (`connection.respond`); the card follows the
   *  backend's `connection.update` frames, settlement removes it. */
  async function respondConnection(result) {
    const waiting = state.chat.waiting
    if (!waiting || waiting.kind !== 'connection' || waiting.answering || !state.runtimeId) return { ok: false }
    patchWaiting(waiting, { answering: true, error: undefined })
    try {
      const res = await deps.requestForBot(bot, 'connection.respond', {
        op_id: waiting.opId,
        owner: { session_id: state.runtimeId, type: 'session' },
        result
      })
      if (res?.settled) patchWaiting(waiting, null)
      else patchWaiting(waiting, { answering: false })
      return { ok: true }
    } catch (error) {
      const unsupported = looksUnsupported(error) // UI only: the card says so, nothing is re-sent
      patchWaiting(waiting, { answering: false, unsupported: unsupported || undefined, error: String(error?.message || error) })
      return { ok: false }
    }
  }

  // ── slash commands (C19; core/slash.js names the calls) ─────────────────

  /** A session-scoped call on the live runtime; a runtime that was reaped
   *  (nothing ran) is re-attached once, like stock withSessionNotFoundResume. */
  async function withRuntime(call) {
    let runtimeId = await attach()
    try {
      return await call(runtimeId)
    } catch (error) {
      if (!isRuntimeNotFoundRefusal(error)) throw error
      dropRuntime()
      runtimeId = await attach()
      return call(runtimeId)
    }
  }

  function commandItem(id, patch) {
    setChat(chat => {
      const exists = chat.items.some(item => item.id === id)
      const items = exists
        ? chat.items.map(item => (item.id === id ? { ...item, ...patch } : item))
        : [...chat.items, { kind: 'command', id, at: now(), ...patch }]
      return { ...chat, items }
    })
  }

  /** Compression rotates the lineage tip: follow the registry to the new tip
   *  and re-read its history (the runtime stays). */
  async function followLineageTip() {
    try {
      const canonical = await findCanonicalChat(deps.requestForBot, bot)
      if (!canonical || disposed) return
      const tip = openedSessionId(canonical)
      if (tip && tip !== state.storedId) set({ canonical, storedId: tip })
      const tail = await readPage(0)
      if (disposed) return
      set(s => ({
        rows: tail,
        loadedCount: tail.length,
        hasMore: tail.length >= HISTORY_PAGE,
        chat: { ...s.chat, items: rebuildItems(s.chat.items, rowsToItems(tail), keepLocal) }
      }))
    } catch {
      /* the idle refresh catches up */
    }
  }

  /**
   * Run a slash command typed in this chat. Resolves `{ ok, prefill? }`:
   * `prefill` is text a directive asks to put back in the composer. Output
   * shows as a command card in the transcript (local, never stored).
   */
  async function runSlash(text, depth = 0) {
    const parsed = parseSlash(text)
    if (!parsed) return { ok: false }
    const surface = slashSurface(parsed)
    const id = `cmd:${now()}:${Math.random().toString(36).slice(2, 7)}`
    const show = (output, extra = {}) => commandItem(id, { command: `/${parsed.command}`, output, running: false, ...extra })
    commandItem(id, { command: `/${parsed.command}`, output: '', running: true })
    try {
      switch (surface) {
        case 'new-guard':
        case 'compress': {
          const focus = surface === 'compress' ? parsed.arg : ''
          const lead = surface === 'new-guard' ? 'This Bot Chat never resets: compacting instead (same conversation, fresh working context).\n' : ''
          const res = await withRuntime(runtimeId =>
            deps.requestForBot(bot, 'session.compress', { session_id: runtimeId, ...(focus ? { focus_topic: focus } : {}) }, { timeoutMs: COMPRESS_TIMEOUT_MS })
          )
          if (res?.status === 'pending') show(`${lead}${res.message || 'Compression is still running in the background.'}`)
          else show(`${lead}${renderRpcResult(res) || 'Compressed.'}`, res?.status === 'aborted' ? { error: true } : {})
          await followLineageTip()
          return { ok: true }
        }
        case 'status': {
          const res = await withRuntime(runtimeId => deps.requestForBot(bot, 'session.status', { session_id: runtimeId }))
          show(renderRpcResult(res) || '/status: no output')
          return { ok: true }
        }
        case 'help':
          show(HELP_TEXT)
          return { ok: true }
        case 'title':
          show('This chat keeps its name: “Bot Chat” is how Hermes finds a bot’s one forever-chat, so it cannot be renamed.')
          return { ok: true }
        case 'model':
          show('Pick this bot’s model in the profile panel (Model).')
          return { ok: true }
        case 'desktop':
          show(`/${parsed.raw} is a command for the Hermes window itself (not this chat). Run it from any Hermes composer.`)
          return { ok: true }
        case 'steer': {
          if (!parsed.arg) {
            show('Usage: /steer <what to change>')
            return { ok: true }
          }
          if (state.chat.busy) {
            // Only the gateway's own refusal ('rejected': no running turn, or a
            // documented pre-delivery error, outcomes.js steerFailure) lets the
            // words go out again as the next turn
            // (stock slash-session-commands.ts:353-383 queues after any
            // failure). An accepted steer whose reply was lost has no identity
            // a queued prompt could be de-duplicated by, so an unanswered or
            // unrecognised outcome is shown, never re-delivered (review
            // override-v2-r1 #2).
            let outcome = 'uncertain'
            let detail = ''
            try {
              const res = await withRuntime(runtimeId => deps.requestForBot(bot, 'session.steer', { session_id: runtimeId, text: parsed.arg }))
              outcome = res?.status === 'queued' ? 'accepted' : res?.status === 'rejected' ? 'refused' : 'uncertain'
            } catch (error) {
              outcome = steerFailure(error)
              detail = String(error?.message || error)
            }
            if (outcome === 'accepted') {
              show(`Steered: “${parsed.arg}” reaches the reply after its next tool call.`)
              return { ok: true }
            }
            if (outcome === 'uncertain') {
              show(
                `Steer not confirmed${detail ? ` (${detail})` : ''}: “${parsed.arg}” may already have reached the reply, so it was not queued as well. The chat is re-read; send it again yourself only if it is missing.`,
                { error: true }
              )
              void refresh() // read-only recheck, never a second write
              return { ok: false, uncertain: true }
            }
          }
          // No running turn, or the gateway refused the steer: keep the words as the next turn.
          removeItem(id)
          const sent = await sendDraft(parsed.arg, [], { extra: { queued: true } })
          return { ok: sent.ok }
        }
        case 'undo':
        case 'retry':
          return await runRewindCommand(parsed, id, show, depth)
        case 'queue': {
          if (!parsed.arg) {
            show('Usage: /queue <message to send after the current reply>')
            return { ok: true }
          }
          removeItem(id)
          const sent = await sendDraft(parsed.arg, [], { extra: { queued: true } })
          return { ok: sent.ok }
        }
        default:
          return await execSlash(parsed, id, show, depth)
      }
    } catch (error) {
      show(`error: ${String(error?.message || error)}`, { error: true })
      return { ok: false }
    }
  }

  function removeItem(id) {
    setChat(chat => ({ ...chat, items: chat.items.filter(item => item.id !== id) }))
  }

  async function execSlash(parsed, id, show, depth) {
    let dispatch = null
    let execError = null
    try {
      const res = await withRuntime(runtimeId => deps.requestForBot(bot, 'slash.exec', { session_id: runtimeId, command: parsed.command }))
      dispatch = parseCommandDispatch(res)
      if (!dispatch) {
        const body = (typeof res?.output === 'string' && res.output) || `/${parsed.raw}: no output`
        show(res?.warning ? `warning: ${res.warning}\n${body}` : body)
        return { ok: true }
      }
    } catch (error) {
      execError = error
      // No answer is not "not run": on a legacy gateway slash.exec itself
      // routes /undo, /retry, /queue … to the very handler command.dispatch
      // would run again (tui_gateway _PENDING_INPUT_COMMANDS), so a lost reply
      // never falls back (stock slash.ts:546-551 falls back after any failure;
      // review override-v2-r1, same-class sweep).
      if (slashExecFailure(error) === 'uncertain') {
        show(
          `error: /${parsed.raw} not confirmed (${String(error?.message || error)}). It may have run, so it was not run again; the chat is re-read, check it before repeating the command.`,
          { error: true }
        )
        void refresh()
        return { ok: false, uncertain: true }
      }
    }
    if (!dispatch) {
      try {
        dispatch = parseCommandDispatch(
          await withRuntime(runtimeId => deps.requestForBot(bot, 'command.dispatch', { session_id: runtimeId, name: parsed.raw, arg: parsed.arg }))
        )
      } catch (error) {
        const message = String(error?.message || error)
        if (execError && /not a quick\/plugin\/(?:bundle\/)?skill command/i.test(message)) {
          show(`error: /${parsed.raw} failed: ${String(execError?.message || execError)}`, { error: true })
        } else show(`error: ${message}`, { error: true })
        return { ok: false }
      }
      if (!dispatch) {
        show('error: invalid response: command.dispatch', { error: true })
        return { ok: false }
      }
    }
    if (dispatch.type === 'exec' || dispatch.type === 'plugin') {
      show(dispatch.output || '(no output)')
      return { ok: true }
    }
    if (dispatch.type === 'alias') {
      removeItem(id)
      if (depth > 3) return { ok: false }
      return runSlash(`/${dispatch.target}${parsed.arg ? ` ${parsed.arg}` : ''}`, depth + 1)
    }
    if ((dispatch.type === 'send' || dispatch.type === 'prefill') && dispatch.notice) show(dispatch.notice)
    else removeItem(id)
    const message = (dispatch.message || '').trim()
    if (dispatch.type === 'prefill') return { ok: true, prefill: message }
    if (!message) {
      show(`/${parsed.raw}: ${dispatch.type === 'skill' ? 'skill payload missing message' : 'empty message'}`, { error: true })
      return { ok: false }
    }
    // The bubble shows the invocation (or the gateway's projection), never the
    // expanded skill body (slash.ts:470-480); a busy chat holds it for the
    // next turn (queueKickoffIfSessionBusy).
    const display = (dispatch.display || '').trim() || `/${parsed.command}`
    const sent = await sendDraft(display, [], { submitText: message, ...(state.chat.busy ? { extra: { queued: true } } : {}) })
    return { ok: sent.ok }
  }

  /** `complete.slash` completions for a `/` token (read-only). */
  async function completeSlash(text) {
    try {
      const params = state.runtimeId ? { text, session_id: state.runtimeId } : { text, profile: String(bot?.name || 'default') }
      const res = await deps.requestForBot(bot, 'complete.slash', params)
      return { items: Array.isArray(res?.items) ? res.items : [], replaceFrom: Number.isFinite(res?.replace_from) ? res.replace_from : 0 }
    } catch {
      return { items: [], replaceFrom: 0 }
    }
  }

  // ── edit / regenerate / rewind (C22) and reactions (C23) ────────────────

  /** prompt.submit truncation consent for cutting history before `target`
   *  (a stored user row), as stock's truncateSubmitParams
   *  (use-prompt-actions/rewind.ts:174-199) builds it from a durable row id:
   *  `confirm_truncate` always, `confirm_deep_truncate` when later user turns
   *  are archived too, `confirm_empty_truncate` when nothing stays
   *  (tui_gateway/methods_prompt.py:507-532). */
  function truncationFor(target) {
    const items = state.chat.items
    const at = items.findIndex(item => item.id === target.id)
    const later = items.slice(at + 1).some(item => item.kind === 'user' && isPersistedItem(item))
    const earlier = items.slice(0, at).some(item => isPersistedItem(item) && (item.kind === 'user' || item.kind === 'assistant'))
    // The legacy rewrite re-inserts the kept prefix as new rows: ask for the
    // old -> new ids of every row loaded here (stock submitRewindPrompt's
    // `rebind_survivor_row_ids`, rewind.ts:347-366; review override-v2-r1 #4).
    const rebind = durableRowIdsForRebind(state.rows, items)
    return {
      confirm_truncate: true,
      truncate_before_row_id: target.rowId,
      ...(later ? { confirm_deep_truncate: true } : {}),
      ...(!earlier && !state.hasMore ? { confirm_empty_truncate: true } : {}),
      ...(rebind.length ? { rebind_survivor_row_ids: rebind } : {})
    }
  }

  /** Follow a truncating submit's survivor ids (stock applySurvivorRowIds):
   *  chat items and the loaded rows behind them, so a reaction or another
   *  edit before the next refresh addresses the live row, and the next tail
   *  page joins the loaded rows instead of being taken for a gap. */
  function applySurvivors(receipt) {
    const survivors = survivorRowIdsFrom(receipt)
    if (!survivors) return
    set(s => {
      const { items, mapping } = rebindItems(s.chat.items, survivors)
      return { rows: rebindRows(s.rows, mapping), chat: { ...s.chat, items } }
    })
  }

  /** How many later user turns an edit/regenerate of `itemId` would remove. */
  function laterTurns(itemId) {
    const items = state.chat.items
    const at = items.findIndex(item => item.id === itemId)
    return at < 0 ? 0 : items.slice(at + 1).filter(item => item.kind === 'user' && isPersistedItem(item)).length
  }

  function cutFrom(itemId) {
    set(s => {
      const at = s.chat.items.findIndex(item => item.id === itemId)
      if (at < 0) return {}
      // The loaded rows lose the cut too, so no rebuild from them (an older
      // page loaded mid-turn) brings the cut turns back.
      const rowId = s.chat.items[at].rowId
      return { rows: cutRewoundRows(s.rows, rowId), chat: { ...s.chat, items: s.chat.items.slice(0, at) } }
    })
  }

  async function resubmitFrom(target, text, files = []) {
    if (!target?.rowId || target.kind !== 'user') return { ok: false, delivery: 'not-sent', error: 'This message is not saved yet' }
    if (state.chat.busy) return { ok: false, delivery: 'not-sent', error: 'Wait for the reply to finish' }
    const extra = truncationFor(target)
    cutFrom(target.id)
    const result = await sendDraft(text, files, { extra })
    if (!result.ok && result.delivery === 'not-sent') void refresh() // nothing was cut: show it again
    return result
  }

  /** Edit a stored user message: submit the new text, cutting history from
   *  that message (stock edit = truncating prompt.submit). */
  async function editMessage(itemId, text) {
    const target = state.chat.items.find(item => item.id === itemId)
    const clean = String(text || '').trim()
    if (!clean) return { ok: false, delivery: 'not-sent', error: 'Nothing to send' }
    return resubmitFrom(target, clean)
  }

  /** Regenerate an assistant reply: resend the user turn it answered, cutting
   *  history from that turn. */
  async function regenerate(itemId) {
    const items = state.chat.items
    const at = items.findIndex(item => item.id === itemId)
    let target = null
    for (let i = at; i >= 0; i -= 1) {
      if (items[i]?.kind === 'user') {
        target = items[i]
        break
      }
    }
    if (!target) return { ok: false, delivery: 'not-sent', error: 'No message to regenerate from' }
    return resubmitFrom(target, target.text)
  }

  /** The canonical rewind (review override-v2-r1 #3): `session.rewind`, which
   *  the host's canonical protocol sends as the revision-fenced `session.mutate
   *  rewind` and retains for an exact retry when its reply is lost
   *  (canonical-protocol.ts:363-386, 450). `rowId` names the target (a message
   *  action); without it the Nth newest user turn of the owner's snapshot is
   *  derived after the replay probe resolved any earlier lost rewind, as stock's
   *  typed /undo and /retry (slash-session-commands.ts:166-253).
   *  Resolves { served: false } only when the gateway answered the FIRST
   *  session.rewind with a structured -32601 (a legacy sidecar: unknown
   *  method, dispatch refused it, nothing ran; outcomes.js isMethodNotServed),
   *  else { served: true, ok, … }. A handler error, an unknown code or error
   *  prose is uncertain: never the legacy /undo on top (review v2-r3 H2). */
  async function canonicalRewind({ rowId, turnsBack = 1, intent = 'undo' }) {
    let answered = false
    const rewind = async params => {
      const res = await withRuntime(runtimeId => deps.requestForBot(bot, 'session.rewind', { session_id: runtimeId, ...params }))
      answered = true
      return res
    }
    let receipt
    let cutRow = rowId
    try {
      if (rowId) receipt = await rewind({ target_message_id: rowId })
      else {
        const replayed = await rewind({ derived_target: true, replay_only: true })
        if (Number(replayed?.rewound_count ?? 0) > 0) receipt = replayed
        else {
          const snapshot = await deps.requestForBot(bot, 'session.resume', resumeParams(true), { timeoutMs: RESUME_TIMEOUT_MS })
          const target = userTurnFromEnd(snapshot?.messages, turnsBack)
          if (!target) return { served: true, ok: false, nothing: true }
          if (intent === 'retry') {
            const text = retryText(target.content)
            if (text === null) return { served: true, ok: false, error: 'This turn carries media or annotations, so it cannot be retried from here.' }
            if (!text) return { served: true, ok: false, nothing: true }
          }
          receipt = await rewind({ target_message_id: target.row_id, derived_target: true })
          cutRow = target.row_id
        }
      }
    } catch (error) {
      if (!answered && isMethodNotServed(error)) return { served: false }
      return { served: true, ok: false, error: String(error?.message || error), uncertain: rewindFailure(error) === 'uncertain' }
    }
    const count = Number(receipt?.rewound_count ?? 0)
    if (receipt?.status === 'nothing' || !(count > 0)) return { served: true, ok: false, nothing: true }
    // The receipt names the row the owner rewound (a replayed receipt's row
    // is not this snapshot's): cut there.
    const receiptRow = receipt?.target_message?.id
    const at = Number.isSafeInteger(receiptRow) ? receiptRow : cutRow
    set(s => ({ rows: cutRewoundRows(s.rows, at), chat: { ...s.chat, items: cutRewoundItems(s.chat.items, at, turnsBack) } }))
    return { served: true, ok: true, count, content: receipt?.target_message?.content }
  }

  const rewoundText = content => (typeof content === 'string' ? content : retryText(content) ?? '')

  /** Typed /undo [N] and /retry: the canonical rewind, or the legacy slash
   *  worker on a gateway that does not serve it (stock runExec). */
  async function runRewindCommand(parsed, id, show, depth) {
    const intent = parsed.name
    if (intent === 'undo' && parsed.arg && !/^[1-9]\d*$/.test(parsed.arg)) {
      show('Usage: /undo [N] (back up N user turns, default 1)')
      return { ok: true }
    }
    const res = await canonicalRewind({ turnsBack: intent === 'undo' && parsed.arg ? Number(parsed.arg) : 1, intent })
    if (!res.served) return execSlash(parsed, id, show, depth)
    void refresh()
    if (!res.ok) {
      if (res.nothing) show(intent === 'retry' ? 'Nothing to retry.' : 'Nothing to undo.')
      else show(`error: ${res.error}${res.uncertain ? ' (not confirmed: the rewind may still have happened; the chat is re-read, nothing was repeated)' : ''}`, { error: true })
      return { ok: false }
    }
    if (intent === 'undo') {
      show(`↶ Undid ${res.count === 1 ? '1 message' : `${res.count} messages`}. Edit and resend, or send something new.`)
      const text = rewoundText(res.content)
      return { ok: true, ...(text.trim() ? { prefill: text } : {}) }
    }
    const text = retryText(res.content)
    if (!text) {
      show('Nothing to retry.')
      return { ok: false }
    }
    removeItem(id)
    const sent = await sendDraft(text, [])
    return { ok: sent.ok }
  }

  /** Rewind to before a user message, its text back in the composer once the
   *  rewind is confirmed (review override-v2-r1 #3). Canonical gateway: the
   *  selected durable row is the target. Legacy gateway: its own `/undo N`
   *  through the slash worker. A failed or unconfirmed rewind prefills
   *  nothing and the transcript is re-read. */
  async function rewindTo(itemId) {
    const items = state.chat.items
    const target = items.find(item => item.id === itemId)
    if (!target || target.kind !== 'user' || state.chat.busy) return { ok: false }
    if (!target.rowId) return { ok: false, error: 'This message is not saved yet' }
    const turns = laterTurns(itemId) + 1
    const id = `cmd:${now()}:${Math.random().toString(36).slice(2, 7)}`
    const show = (output, extra = {}) => commandItem(id, { command: 'Rewind', output, running: false, ...extra })
    commandItem(id, { command: 'Rewind', output: '', running: true })
    const res = await canonicalRewind({ rowId: target.rowId, turnsBack: turns, intent: 'undo' })
    if (res.served) {
      void refresh()
      if (!res.ok) {
        const why = res.nothing
          ? 'Nothing was rewound.'
          : `error: ${res.error}${res.uncertain ? ' (not confirmed: the rewind may still have happened; the chat is re-read, nothing was repeated)' : ''}`
        show(why, res.nothing ? {} : { error: true })
        return { ok: false, error: res.error || 'Nothing was rewound' }
      }
      show(`↶ Rewound ${res.count === 1 ? '1 message' : `${res.count} messages`}; the message is back in the composer.`)
      const text = rewoundText(res.content)
      return { ok: true, prefill: text.trim() ? text : target.text }
    }
    const result = await execSlash(parseSlash(`/undo ${turns}`), id, show, 0)
    void refresh()
    return result.ok ? { ok: true, ...(result.prefill ? { prefill: result.prefill } : {}) } : { ok: false }
  }

  /** Tapback: one reaction per author, the same emoji again retracts
   *  (store/reactions.ts applyReaction). */
  function applyReaction(reactions, emoji, author) {
    const current = Array.isArray(reactions) ? reactions : []
    const previous = current.find(r => r.author === author)
    const without = current.filter(r => r.author !== author)
    if (!emoji || previous?.emoji === emoji) return without
    return [...without, { emoji, author, at: now() / 1000 }]
  }

  function writeReactions(itemId, reactions, rowId) {
    setChat(chat => ({
      ...chat,
      items: chat.items.map(item => (item.id === itemId ? { ...item, reactions, ...(rowId ? { rowId } : {}) } : item))
    }))
  }

  /** React to a message: optimistic, then the gateway's list wins; a failed
   *  write rolls back (store/reactions.ts toggleMessageReaction). A live
   *  message without a row id names `newest_role` instead. */
  async function react(itemId, emoji) {
    const item = state.chat.items.find(entry => entry.id === itemId)
    if (!item || (item.kind !== 'user' && item.kind !== 'assistant')) return false
    const snapshot = item.reactions
    writeReactions(itemId, applyReaction(snapshot, emoji, 'user'))
    try {
      const res = await withRuntime(runtimeId =>
        deps.requestForBot(bot, 'message.react', {
          session_id: runtimeId,
          ...(item.rowId ? { row_id: item.rowId } : { newest_role: item.kind }),
          emoji,
          author: 'user'
        })
      )
      writeReactions(itemId, Array.isArray(res?.reactions) ? res.reactions : [], Number.isSafeInteger(res?.row_id) ? res.row_id : undefined)
      return true
    } catch (error) {
      writeReactions(itemId, snapshot || [])
      set({ stopError: null })
      setChat(chat => ({ ...chat, items: chat.items.map(entry => (entry.id === itemId ? { ...entry, reactionError: String(error?.message || error) } : entry)) }))
      return false
    }
  }

  // ── send / stop ──────────────────────────────────────────────────────────

  const stagedKey = (runtimeId, id) => `${runtimeId}|${id}`
  const stagedId = key => key.slice(key.indexOf('|') + 1)

  /** Stage each attachment once per runtime. Returns the `ref_text` lines for
   *  files and, for a staging-only (canonical) gateway, the image list
   *  prompt.submit must carry (gateway/session_images.py stages to disk only;
   *  stock sends `attachments: [{path, mime}]`). */
  async function stageAttachments(runtimeId, attachments) {
    const refs = []
    const images = []
    const use = entry => {
      if (entry.kind === 'file' && entry.ref) refs.push(entry.ref)
      if (entry.kind === 'image' && entry.mime && entry.path) images.push({ path: entry.path, mime: entry.mime })
    }
    for (const file of attachments) {
      const key = file?.id ? stagedKey(runtimeId, file.id) : ''
      if (key && staged.has(key)) {
        use(staged.get(key))
        continue
      }
      let entry
      if (file.kind === 'image') {
        const res = await deps.requestForBot(bot, 'image.attach_bytes', {
          session_id: runtimeId,
          content_base64: String(file.data || '').replace(/^data:[^,]*,/, ''),
          filename: file.name || 'image.png'
        })
        if (res && res.attached === false) throw new Error(res.message || `Could not attach ${file.name}`)
        entry = {
          kind: 'image',
          path: typeof res?.path === 'string' ? res.path : '',
          mime: typeof res?.mime === 'string' ? res.mime : ''
        }
      } else {
        const res = await deps.requestForBot(bot, 'file.attach', { session_id: runtimeId, data_url: file.data, name: file.name || 'attachment' })
        if (!res?.ref_text) throw new Error(res?.message || `Could not attach ${file.name}`)
        entry = { kind: 'file', ref: `${file.name || 'attachment'} → ${res.ref_text}` }
      }
      if (key) staged.set(key, entry)
      use(entry)
    }
    return { refs, images }
  }

  /** Images a legacy gateway still holds on this runtime that the send about
   *  to go out does not carry (a file removed from a restored draft, a send
   *  whose delivery is unknown): detach them first. A detach that fails stops
   *  the send; it never goes out with an image the user cannot see. */
  async function detachStrays(runtimeId, keepIds) {
    for (const [key, entry] of [...staged.entries()]) {
      if (!key.startsWith(`${runtimeId}|`)) continue
      const id = stagedId(key)
      if (keepIds.has(id) || inFlightFiles.has(id)) continue
      await detachEntry(runtimeId, key, entry, { strict: true })
    }
  }

  async function detachEntry(runtimeId, key, entry, { strict }) {
    // A file is only a ref line in the text, and a staging-only image is
    // never consumed unless prompt.submit names it: nothing to take back.
    if (entry.kind !== 'image' || entry.mime) {
      staged.delete(key)
      return
    }
    if (!entry.path) {
      if (!strict) return
      throw new Error('An image from an earlier attempt is still attached in Hermes and cannot be removed from here. Open the chat in Hermes Bot Mode.')
    }
    try {
      await deps.requestForBot(bot, 'image.detach', { session_id: runtimeId, path: entry.path })
      staged.delete(key)
    } catch (error) {
      if (isSessionGoneError(error)) {
        staged.delete(key) // the runtime, and what was staged on it, is gone
        return
      }
      if (strict) {
        throw new Error(`An image from an earlier attempt is still attached in Hermes and could not be removed (${String(error?.message || error)}). Nothing was sent.`)
      }
    }
  }

  /** The user removed these attachments from the draft: take staged images
   *  back now (the next send also checks). */
  async function discardStaged(ids = []) {
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(String))
    for (const [key, entry] of [...staged.entries()]) {
      if (!wanted.has(stagedId(key)) || inFlightFiles.has(stagedId(key))) continue
      const runtimeId = key.slice(0, key.indexOf('|'))
      if (runtimeId !== state.runtimeId) {
        staged.delete(key)
        continue
      }
      await detachEntry(runtimeId, key, entry, { strict: false })
    }
  }

  /** One prompt.submit. Every send carries its payload's `submission_id`
   *  (stock submit.ts:1084-1112); `exact` re-sends the very params of an
   *  earlier attempt under the same id (stock's retained-submission retry:
   *  `{ ...prepared.params, session_id: liveId }`, submit.ts:1158), which the
   *  canonical gateway answers with the original admission instead of a new
   *  turn. A legacy gateway that refuses the id key before admitting anything
   *  gets the same params once without it (submit.ts:1166-1186), and from then
   *  on the send is identityless: never retried automatically again. */
  async function submitOnce(runtimeId, text, attachments, mark, payload, { exact = false, extra = {} } = {}) {
    let params
    if (exact && payload.params) {
      params = { ...payload.params, session_id: runtimeId }
      mark('submit', payload.body)
    } else {
      mark('stage')
      await detachStrays(runtimeId, new Set(attachments.map(file => String(file?.id || ''))))
      const { refs, images } = attachments.length ? await stageAttachments(runtimeId, attachments) : { refs: [], images: [] }
      const body = refs.length ? `${text}${text ? '\n\n' : ''}${refs.join('\n')}` : text
      if (disposed) throw new Error('This chat was closed')
      params = {
        session_id: runtimeId,
        text: `${payload.submitText !== undefined ? payload.submitText : body}${payload.apiText || ''}`,
        ...(payload.legacy ? {} : { submission_id: payload.submissionId }),
        ...(images.length ? { attachments: images } : {}),
        ...(payload.extra || {}),
        ...extra
      }
      payload.params = params
      mark('submit', params.text)
    }
    try {
      return await deps.requestForBot(bot, 'prompt.submit', params)
    } catch (error) {
      // A retry whose payload no longer matches its admitted original is that
      // original: settled as the dedupe it is, no new turn (submit.ts:1160-1163).
      if (params.submission_id && isAdmittedConflict(error)) return { status: 'terminal', submission_id: params.submission_id }
      if (!params.submission_id || payload.legacy || !isIdentityRefusal(error)) throw error
      payload.legacy = true
      const { submission_id: _identity, ...legacy } = params
      payload.params = legacy
      const receipt = await deps.requestForBot(bot, 'prompt.submit', legacy)
      return { ...(receipt && typeof receipt === 'object' ? receipt : {}), legacyAccepted: true }
    }
  }

  /** Receipts the gateway has consumed (an accepted send). */
  const forgetStaged = attachments => {
    for (const file of attachments) {
      if (!file?.id) continue
      for (const key of [...staged.keys()]) if (stagedId(key) === String(file.id)) staged.delete(key)
    }
  }

  /** Hermes removed every image staged on this runtime (owner-FIFO refusal). */
  const forgetStagedImages = runtimeId => {
    for (const [key, entry] of [...staged.entries()]) if (key.startsWith(`${runtimeId}|`) && entry.kind === 'image') staged.delete(key)
  }

  const holdFiles = (files, delta) => {
    for (const file of files) {
      const id = String(file?.id || '')
      if (!id) continue
      const next = (inFlightFiles.get(id) || 0) + delta
      if (next > 0) inFlightFiles.set(id, next)
      else inFlightFiles.delete(id)
    }
  }

  /** Send a user turn. Optimistic bubble first; on a reaped runtime, re-resume
   *  by the stored id and submit exactly once more (Bot Mode's group rule).
   *  Resolves { ok, delivery: 'sent' | 'not-sent' | 'unknown', error, clientId }. */
  async function sendDraft(text, attachments = [], sendOptions = {}) {
    const clean = String(text || '').trim()
    const files = Array.isArray(attachments) ? attachments : []
    if ((!clean && !files.length) || !state.storedId) return { ok: false, delivery: 'not-sent', error: 'Nothing to send' }
    // A draft file stamped for another bot never reaches this bot's gateway
    // (review r1 #4). Unstamped files (older callers) are this chat's own.
    const owner = draftOwnerKey(bot)
    if (files.some(file => file?.owner && file.owner !== owner)) {
      return { ok: false, delivery: 'not-sent', error: 'These files were picked for another bot' }
    }
    const clientId = `local:${now()}:${Math.random().toString(36).slice(2, 8)}`
    setChat(chat => ({
      ...chat,
      items: [
        ...chat.items,
        {
          kind: 'user',
          id: clientId,
          text: clean,
          at: now(),
          pending: true,
          ...(files.length ? { attachments: files.map(a => ({ kind: a.kind, name: a.name })) } : {})
        }
      ]
    }))
    return deliver(clientId, clean, files, { sendOptions })
  }

  /** `exact`: an identity retry of an uncertain send (same params, same id).
   *  `sendOptions.apiText`: model-facing text appended to the submitted text
   *  only (the @mention note, stock plugin.tsx:886-897), never to the bubble.
   *  `sendOptions.extra`: further prompt.submit params (truncation, C22). */
  async function deliver(clientId, clean, files, { exact = false, sendOptions = {} } = {}) {
    let payload = payloads.get(clientId)
    if (!payload) {
      payload = {
        text: clean,
        attachments: files,
        body: clean,
        knownIds: new Set(state.rows.map(rowIdentity)),
        submissionId: newSubmissionId(),
        legacy: false,
        params: null,
        apiText: typeof sendOptions.apiText === 'string' ? sendOptions.apiText : '',
        // A skill / send directive: the bubble shows the invocation, the
        // gateway gets the expanded message (slash.ts:470-517).
        ...(typeof sendOptions.submitText === 'string' ? { submitText: sendOptions.submitText } : {}),
        extra: sendOptions.extra && typeof sendOptions.extra === 'object' ? sendOptions.extra : null
      }
      payloads.set(clientId, payload)
    } else if (!exact) {
      payload.params = null
    }
    const busyAtSubmit = state.chat.busy
    sendsInFlight += 1
    holdFiles(files, 1)
    let stage = 'prepare'
    let turnBefore = turnSeq
    let submittedOn = ''
    const mark = (next, body) => {
      stage = next
      if (next === 'submit') {
        payload.body = body
        turnBefore = turnSeq
        submittedOn = state.runtimeId
      }
    }
    try {
      let runtimeId = await attach()
      let receipt
      try {
        receipt = await submitOnce(runtimeId, clean, files, mark, payload, { exact })
      } catch (error) {
        if (!isRuntimeNotFoundRefusal(error)) throw error
        // Refused (staging or submit): the runtime was not in memory, nothing ran.
        dropRuntime()
        stage = 'prepare'
        runtimeId = await attach()
        receipt = await submitOnce(runtimeId, clean, files, mark, payload, { exact })
      }
      const status = String(receipt?.status || '')
      // A canonical admission receipt echoes the id (submit.ts:1233-1249):
      // `queued` is also the first receipt of an idle session's turn, so it is
      // a start there, not "queued after the current reply".
      const canonical = !receipt?.legacyAccepted && Boolean(receipt?.submission_id || receipt?.admission_id)
      if (status === 'terminal' || status === 'unknown') return settleReceipt(clientId, payload, status, files)
      const startsNow = canonical && status === 'queued' && !busyAtSubmit
      const accepted = status === 'streaming' || status === 'started' || !status || startsNow
      const label = startsNow ? '' : status
      // A completion (or any turn transition) that arrived while prompt.submit
      // was in flight is newer than this receipt: it decides busy.
      const fresh = turnSeq === turnBefore
      set(s => ({
        receipt: label && label !== 'streaming' && label !== 'started' ? label : null,
        chat: {
          ...s.chat,
          busy: s.chat.busy || (fresh && accepted),
          items: s.chat.items.map(item =>
            item.id === clientId
              ? { ...item, pending: false, failed: undefined, delivery: undefined, checked: undefined, idempotent: undefined, ...(label ? { receipt: label } : {}) }
              : item
          )
        }
      }))
      if (payload.params?.confirm_truncate) applySurvivors(receipt)
      payloads.delete(clientId)
      forgetStaged(files)
      if (state.chat.busy) onTurnStarted()
      return { ok: true, delivery: 'sent', clientId }
    } catch (error) {
      const verdict = stage === 'submit' ? classifySubmitFailure(error) : { delivery: 'not-sent', imagesUnstaged: false }
      const delivery = verdict.delivery
      if (verdict.imagesUnstaged && submittedOn) forgetStagedImages(submittedOn)
      const message = String(error?.message || error)
      // An uncertain send that carried its identity can be retried under the
      // same id: the gateway replays the original admission (C6).
      const idempotent = delivery === 'unknown' && Boolean(payload.params?.submission_id) && !payload.legacy
      setChat(chat => ({
        ...chat,
        items: chat.items.map(item =>
          item.id === clientId ? { ...item, pending: false, failed: message, delivery, checked: false, idempotent: idempotent || undefined } : item
        )
      }))
      if (delivery === 'unknown') scheduleDeliveryCheck(clientId, 0)
      return { ok: false, delivery, error: message, clientId }
    } finally {
      holdFiles(files, -1)
      sendsInFlight -= 1
      maybeFinishRetire()
    }
  }

  /** A canonical receipt that starts no turn: `terminal` (this id was
   *  already admitted and finished: a dedupe) or `unknown` (admitted, then
   *  lost by its owner; it will not run). Stock submit.ts:1251-1281. */
  function settleReceipt(clientId, payload, status, files) {
    payloads.delete(clientId)
    forgetStaged(files)
    setChat(chat => ({
      ...chat,
      items: chat.items.map(item =>
        item.id === clientId
          ? { ...item, pending: false, failed: undefined, delivery: undefined, checked: undefined, idempotent: undefined, receipt: status }
          : item
      )
    }))
    void refresh()
    return { ok: true, delivery: 'sent', clientId, receipt: status }
  }

  async function send(text, attachments = []) {
    return (await sendDraft(text, attachments)).ok
  }

  /** A stored user row newer than what was loaded when the message was sent,
   *  with the same text: positive evidence that it arrived. */
  function foundIn(tail, payload) {
    return tail.some((row, index) => row?.role === 'user' && !payload.knownIds.has(rowIdentity(row, index)) && rowText(row).trim() === payload.body.trim())
  }

  function markDelivered(clientId, tail) {
    const payload = payloads.get(clientId)
    payloads.delete(clientId)
    if (payload) forgetStaged(payload.attachments)
    deliveryChecks.get(clientId)?.()
    deliveryChecks.delete(clientId)
    setChat(chat => ({ ...chat, items: chat.items.filter(item => item.id !== clientId) }))
    mergeTail(tail, state.chat.busy ? keepLive : keepLocal)
  }

  const unknownIds = () => state.chat.items.filter(item => item.kind === 'user' && item.failed && item.delivery === 'unknown').map(item => item.id)

  /** Resolve "delivery unknown" sends a fresh tail shows (idle refresh). */
  function resolveUnknownFrom(tail) {
    for (const clientId of unknownIds()) {
      const payload = payloads.get(clientId)
      if (payload && foundIn(tail, payload)) markDelivered(clientId, tail)
    }
  }

  /** "Delivery unknown": read the stored transcript for the message. Found:
   *  it is the stored row. Not found, or the read failed: it stays unknown
   *  (a queued or not-yet-written prompt is absent too). Read-only. */
  async function checkDelivery(clientId, attempt) {
    const payload = payloads.get(clientId)
    if (disposed || !payload) return
    let tail
    try {
      tail = await readPage(0)
    } catch {
      if (attempt + 1 < DELIVERY_CHECK_TRIES) return scheduleDeliveryCheck(clientId, attempt + 1)
      tail = null
    }
    if (disposed || !payloads.has(clientId)) return
    if (tail && foundIn(tail, payload)) return markDelivered(clientId, tail)
    setChat(chat => ({
      ...chat,
      items: chat.items.map(item => (item.id === clientId ? { ...item, checked: true, checkFailed: tail ? undefined : true } : item))
    }))
  }

  function scheduleDeliveryCheck(clientId, attempt) {
    if (disposed || deliveryChecks.has(clientId)) return
    const cancel = setTimer(async () => {
      deliveryChecks.delete(clientId)
      await checkDelivery(clientId, attempt)
    }, DELIVERY_CHECK_MS)
    deliveryChecks.set(clientId, cancel)
  }

  /** "Check again" on a delivery-unknown message: one read, now. */
  async function recheck(clientId) {
    const item = state.chat.items.find(entry => entry.id === clientId)
    if (!item || item.delivery !== 'unknown' || !payloads.has(clientId)) return false
    deliveryChecks.get(clientId)?.()
    deliveryChecks.delete(clientId)
    setChat(chat => ({ ...chat, items: chat.items.map(entry => (entry.id === clientId ? { ...entry, checked: false, checkFailed: undefined } : entry)) }))
    await checkDelivery(clientId, DELIVERY_CHECK_TRIES - 1)
    return !payloads.has(clientId)
  }

  /** Re-send a failed message (a user click). A definite refusal goes out
   *  again with its original text and attachments. A "delivery unknown" send
   *  is re-sent only when it carried a submission id the gateway accepted:
   *  the exact same params under the same id, so the gateway answers with the
   *  original admission if it had one (stock's explicit retry, C6). An
   *  identityless unknown send is never re-sent from here. */
  async function retry(clientId) {
    const item = state.chat.items.find(entry => entry.id === clientId)
    const payload = payloads.get(clientId)
    if (!item || !payload || !item.failed) return { ok: false, delivery: item?.delivery || 'not-sent', error: 'Nothing to retry', clientId }
    const exact = item.delivery === 'unknown'
    if (exact && !(payload.params?.submission_id && !payload.legacy)) {
      return { ok: false, delivery: 'unknown', error: 'It may already have arrived, so it is not sent again from here', clientId }
    }
    deliveryChecks.get(clientId)?.()
    deliveryChecks.delete(clientId)
    setChat(chat => ({
      ...chat,
      items: chat.items.map(entry =>
        entry.id === clientId
          ? { ...entry, pending: true, failed: undefined, delivery: undefined, checked: undefined, checkFailed: undefined, idempotent: undefined }
          : entry
      )
    }))
    return deliver(clientId, payload.text, payload.attachments, { exact })
  }

  /** A refused message went back into the composer: drop its bubble. The
   *  staging receipts stay (the restored draft carries the same attachments;
   *  a removed one is detached by discardStaged or before the next send). A
   *  "delivery unknown" bubble is never handed back. */
  function dropFailed(clientId) {
    const item = state.chat.items.find(entry => entry.id === clientId)
    if (!item || !item.failed || item.delivery !== 'not-sent') return false
    payloads.delete(clientId)
    deliveryChecks.get(clientId)?.()
    deliveryChecks.delete(clientId)
    setChat(chat => ({ ...chat, items: chat.items.filter(entry => entry.id !== clientId) }))
    return true
  }

  async function interrupt() {
    if (!state.runtimeId) return false
    const runtimeId = state.runtimeId
    set({ stopError: null })
    try {
      await deps.requestForBot(bot, 'session.interrupt', { session_id: runtimeId })
      return true
    } catch (error) {
      if (isSessionGoneError(error)) {
        // Nothing is running on a reaped runtime: the turn is already over.
        if (runtimeId === state.runtimeId) onRuntimeLost('stopped')
        return true
      }
      set({ stopError: String(error?.message || error) })
      return false
    }
  }

  // ── lifetime ─────────────────────────────────────────────────────────────

  const stillNeeded = () => sendsInFlight > 0 || state.chat.busy

  function maybeFinishRetire() {
    if (retiring && !disposed && !stillNeeded()) dispose()
  }

  /** The user closed the chat. An idle chat is disposed now; one with a send
   *  in flight or a running turn stays attached (no UI, no idle refresh)
   *  until those settle, at most `retireMaxMs`. Returns whether it is still
   *  alive. */
  function retire({ maxMs } = {}) {
    if (disposed) return false
    retiring = true
    idleCancel?.()
    idleCancel = null
    reattachCancel?.()
    reattachCancel = null
    listeners.clear()
    if (!stillNeeded()) {
      dispose()
      return false
    }
    retireCancel?.()
    retireCancel = setTimer(() => {
      retireCancel = null
      if (retiring) dispose()
    }, maxMs ?? options.retireMaxMs ?? RETIRE_MAX_MS)
    return true
  }

  /** Re-open a retiring chat (the user came back before it finished). */
  function revive() {
    if (disposed) return false
    if (!retiring) return true
    retiring = false
    retireCancel?.()
    retireCancel = null
    if (state.phase === 'ready') scheduleIdleRefresh()
    return true
  }

  function dispose() {
    if (disposed) return
    disposed = true
    retiring = false
    generation += 1
    stopApprovalPoll()
    stopWatch()
    idleCancel?.()
    idleCancel = null
    reattachCancel?.()
    reattachCancel = null
    stopReconnectNotice()
    retireCancel?.()
    retireCancel = null
    for (const cancel of deliveryChecks.values()) cancel()
    deliveryChecks.clear()
    payloads.clear()
    // Images still staged on the runtime (a refused send nobody resent, an
    // unknown one) must not ride along with a later send from another
    // surface: take them back, best effort, then let the route go.
    const runtimeId = state.runtimeId
    const strays = runtimeId
      ? [...staged.entries()].filter(([key, entry]) => key.startsWith(`${runtimeId}|`) && entry.kind === 'image' && !entry.mime && entry.path)
      : []
    staged.clear()
    const release = lease
    lease = null
    if (strays.length && release) {
      void Promise.allSettled(
        strays.map(([, entry]) => Promise.resolve().then(() => deps.requestForBot(bot, 'image.detach', { session_id: runtimeId, path: entry.path })))
      ).then(() => release())
    } else {
      release?.()
    }
    try {
      offEvents?.()
    } catch {
      /* already gone */
    }
    listeners.clear()
    try {
      options.onDispose?.()
    } catch {
      /* owner gone */
    }
  }

  return {
    get: () => state,
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open,
    create,
    attach,
    loadEarlier,
    refresh,
    reconcile,
    send,
    sendDraft,
    retry,
    recheck,
    dropFailed,
    discardStaged,
    interrupt,
    respondApproval,
    editMessage,
    regenerate,
    rewindTo,
    laterTurns,
    react,
    runSlash,
    completeSlash,
    answerPrompt,
    respondConnection,
    pollApprovals,
    hasPendingApproval: () => hasPendingApproval(state.chat.items),
    retire,
    revive,
    isRetiring: () => retiring,
    isDisposed: () => disposed,
    dispose
  }
}
