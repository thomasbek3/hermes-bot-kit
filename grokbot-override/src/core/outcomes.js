// Outcome classifiers: the ONE place that decides what a failed gateway call
// proves (review override-v2-r3 H1/H2).
//
// The rule is "never send twice". A failure authorizes a fallback or a second
// write (a re-send, a /steer queued as the next turn, the command.dispatch
// fallback, the legacy /undo, a kickoff prompt, a restored draft the user can
// resend) ONLY when Hermes's own source documents it as a definitive refusal
// raised before anything was admitted or run, for THAT operation. Everything
// else is uncertain: an unknown numeric code, an unknown structured reason, a
// handler error (-32000), a timeout, a dropped socket, error prose. Uncertain
// means: no second write, a clear "not confirmed" state, and a read-only
// recheck (a history refresh / delivery check) instead.
//
// Message text is evidence only where the HOST raised the error itself before
// writing the frame (code-less and data-less, see HOST_PRE_SEND), or where one
// server site emits one exact string under one known code (slash.exec 4018 /
// 5030, anchored). Read-only availability checks (`looksUnsupported`) may use
// prose: they only change what the UI offers, never what is written.
//
// Every call site is listed in test/review-v2-r3.test.mjs (classifier table);
// a new caller must be added there.
//
// Sources (Hermes Agent, commit 2bd378ed1b):
//
// Dispatch level, every legacy method (tui_gateway/rpc_dispatch.py,
// server.py _normalize_request): -32600 / -32602 malformed request, -32601
// unknown method, 4000 params contract, 5035 backend retiring. All are
// answered before the handler runs. Canonical gateway (gateway/
// session_controls.py:355-360): -32601 with data.reason 'unknown_method'.
// 4064 (ProfileUnavailableError) is raised from INSIDE a handler: uncertain.
//
// prompt.submit (classifySubmitFailure): see the table below.
// session.steer: legacy methods_session_interrupt.py _correction_method:
//   4002 "text is required", 4001 (no reason) _sess_nowait, 4010 "agent does
//   not support steer" — all before agent.steer(); 5000 "steer failed" is
//   raised BY agent.steer (uncertain). Canonical gateway/session_busy_controls.py
//   correct(): stock's UNDELIVERED_CORRECTION_REASONS (apps/shared/src/
//   json-rpc-channel.ts:80 execution_not_ready, stale_generation,
//   unsupported_control) plus the checks correct() runs before the agent:
//   invalid_params, profile_mismatch, permission_denied (authorize), not_found.
// slash.exec: legacy methods_tools.py slash.exec: 4001 (no reason), 4004
//   "empty command", 4018 "skill command: use command.dispatch for /…" and
//   "snapshot restore mutates live config/state; use command.dispatch …"
//   (the routing refusals, raised before any command ran), 5030 "slash worker
//   start failed: …" (the worker never started). Any other 4018 can come from
//   command.dispatch AFTER a quick command ran ("quick command failed with
//   exit code"), any other 5030 is the worker failing mid-command: uncertain.
//   Canonical gateway/session_commands.py execute_command refuses before
//   running with invalid_params, profile_mismatch, permission_denied,
//   not_found, unsupported_command, session_read_only, runtime_draining.
// session.rewind (label only; a failed rewind is never repeated): canonical
//   session.mutate refuses with invalid_params, profile_mismatch,
//   permission_denied, not_found, runtime_draining before the mutation.
//   Whether the legacy slash route may run instead is decided by
//   isMethodNotServed, never by message text.
// session.title (create-chat kickoff fallback): legacy methods_session.py
//   session.title: 4001 (no reason), 4006 "session_id required", 4021 "title
//   required"; "already in use" is the uniqueness refusal (adopt the winner).
//   5007 (storage) and 4022 otherwise can follow the write: uncertain.
// groups.send: only `data.admitted === false` (gateway/session_group_controls.py
//   _refusal, stock canonical-group-workspace.tsx admittedNothing).
//
// Host pre-send failures (thrown before the frame is written, no code, no
// data): apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts:1302 /
// dial-readiness.ts:9 "Hermes gateway is not connected", lib/oneshot.ts:43
// "Gateway not connected", api/canonical-protocol.ts:340-430 "Session
// revision unavailable", "Session execution identity unavailable", "No
// retained rewind to replay", "… is not available on the shared gateway yet".

/** The JSON-RPC parts of an error, wherever a wrapper put them: the error
 *  itself (the host's JsonRpcGatewayError), its `cause` (routing.js asError),
 *  or a raw `{ error: { code, message, data } }` frame, up to five levels. */
export function rpcErrorParts(error) {
  let code
  let data
  let node = error
  for (let depth = 0; node && typeof node === 'object' && depth < 5; depth += 1) {
    if (code === undefined && typeof node.code === 'number') code = node.code
    if (data === undefined && node.data && typeof node.data === 'object') data = node.data
    if (code !== undefined && data !== undefined) break
    node = node.cause ?? (node.error && typeof node.error === 'object' ? node.error : null)
  }
  const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : ''
  const reason = typeof data?.reason === 'string' ? data.reason : ''
  return { code, data, reason, message }
}

const HOST_PRE_SEND = /\bnot connected\b|execution identity unavailable|^Session revision unavailable|^No retained rewind to replay|is not available on the shared gateway yet/i

/** Thrown by the host (or this plugin's own routing) before any frame was
 *  written: no JSON-RPC code or data anywhere in the chain. */
export function isHostPreSendFailure(error) {
  const { code, data, message } = rpcErrorParts(error)
  return code === undefined && data === undefined && HOST_PRE_SEND.test(message)
}

const DISPATCH_REFUSED_CODES = new Set([-32600, -32602, -32601, 4000, 5035])

/** Refused before any handler ran, for every method: explicit admitted:false,
 *  a host pre-send failure, or a dispatch-level legacy code (a structured
 *  reason makes the code operation-specific, except canonical unknown_method). */
function isDispatchRefusal(parts) {
  const { code, data, reason, message } = parts
  if (data && data.admitted === false) return true
  if (code === undefined) return data === undefined && HOST_PRE_SEND.test(message)
  if (code === -32601) return !reason || reason === 'unknown_method'
  return !reason && DISPATCH_REFUSED_CODES.has(code)
}

// ── prompt.submit (review r3 #1) ────────────────────────────────────────────
//
// Legacy sidecar (`tui_gateway`, errors carry a numeric code, sometimes
// `data.reason`):
//   -32600 / -32602   rpc_dispatch._normalize_request: rejected before dispatch.
//   -32601            unknown method: nothing ran.
//   4000              rpc_dispatch: params contract check, before the handler.
//   4001 (no reason)  session_registry._sess_nowait "session not found": the
//                     runtime is not in memory, nothing ran.
//   4004              methods_prompt._lock_in_submit_turn: truncation consent,
//                     before `running` is set.
//   4007              session_lifecycle._reattach_refusal: stale runtime.
//   4009              "session busy" (truncation), "subagent still running",
//                     "session disconnect interrupt settling": all before the
//                     turn is admitted.
//   4090 + reason     methods_prompt._slot_refusal / _submit_to_ledger_owner:
//       SESSION_OWNER_BUSY       "Nothing was sent" (and any staged image was
//                                removed: _unstage_refused_images; a forwardable
//                                prompt never has staged images).
//       SESSION_NOT_OWNED, MAX_CONCURRENT_SESSIONS,
//       SESSION_COORDINATION_UNAVAILABLE
//                                active-slot refusal "before the busy queue, db
//                                row and agent build".
//       SESSION_OWNER_UNCONFIRMED  "It may already be queued there": UNKNOWN.
//   5035              backend retiring: refused at admission.
//   5070 / 5071 / 5072  _persist_session_row_for_submit: "this message was not
//                     saved", and the turn is rolled back.
//   -32000 (handler error), 5000-class and anything else: UNKNOWN.
//
// Canonical gateway authority (`gateway/session_controls.py`, code 4001 with
// `data.reason`): only the reasons tui_gateway/owner_forward.py lists as
// raised before the durable write (`_REFUSED_BEFORE_COMMIT`), or an explicit
// `data.admitted === false`, prove nothing will run. `admission_conflict` is
// left out on purpose (it can mean "the original was admitted");
// `storage_unavailable` (5001) can follow the commit: UNKNOWN.

const LEGACY_REFUSED_CODES = new Set([-32600, -32602, -32601, 4000, 4004, 4007, 4009, 5035, 5070, 5071, 5072])

const LEGACY_4090_REFUSED = new Set([
  'SESSION_OWNER_BUSY',
  'SESSION_NOT_OWNED',
  'MAX_CONCURRENT_SESSIONS',
  'SESSION_COORDINATION_UNAVAILABLE'
])

const CANONICAL_REFUSED_BEFORE_COMMIT = new Set([
  'invalid_params',
  'runtime_draining',
  'runtime_retired',
  'profile_mismatch',
  'permission_denied',
  'not_found',
  'stale_epoch',
  'queue_full'
])

/** Classify a failed prompt.submit.
 *  Returns { delivery: 'not-sent' | 'unknown', reason, imagesUnstaged }. */
export function classifySubmitFailure(error) {
  const { code, data, reason, message } = rpcErrorParts(error)
  const refused = (why, extra = {}) => ({ delivery: 'not-sent', reason: why, imagesUnstaged: false, ...extra })
  const unknown = why => ({ delivery: 'unknown', reason: why, imagesUnstaged: false })

  if (data && data.admitted === false) return refused(reason || 'not admitted')
  if (code === undefined) {
    if (data === undefined && /\bnot connected\b/i.test(message)) return refused('not connected')
    return unknown(message ? 'no answer' : 'unknown failure')
  }
  if (code === 4090) {
    if (reason === 'SESSION_OWNER_BUSY') return refused(reason, { imagesUnstaged: true })
    if (LEGACY_4090_REFUSED.has(reason)) return refused(reason)
    return unknown(reason || 'owner refusal without a reason')
  }
  if (code === 4001) {
    if (!reason) return refused('session not found')
    return CANONICAL_REFUSED_BEFORE_COMMIT.has(reason) ? refused(reason) : unknown(reason)
  }
  if (code === -32601) return !reason || reason === 'unknown_method' ? refused('unknown method') : unknown(reason)
  // A structured reason this table does not know: never assume a refusal.
  if (reason) return unknown(reason)
  return LEGACY_REFUSED_CODES.has(code) ? refused(`code ${code}`) : unknown(`code ${code}`)
}

/** 'not-sent' | 'unknown' for a failed prompt.submit (see classifySubmitFailure). */
export function submitDelivery(error) {
  return classifySubmitFailure(error).delivery
}

/** The legacy "runtime not in memory" refusal (4001, no structured reason):
 *  nothing was accepted, so one re-resume and re-submit is safe. */
export function isRuntimeNotFoundRefusal(error) {
  const { code, reason } = rpcErrorParts(error)
  return code === 4001 && !reason
}

/** submit.ts `isPreAdmissionRefusal`: the gateway refused the identity key
 *  itself before admitting anything (4094, or a legacy 4000 naming it). */
export function isIdentityRefusal(error) {
  const { code, message } = rpcErrorParts(error)
  return code === 4094 || (code === 4000 && /submission_id/.test(message))
}

/** utils.ts `isAdmittedSubmissionConflict`: a retry whose payload differs
 *  from its admitted original IS that original (a dedupe, no new turn). */
export function isAdmittedConflict(error) {
  const { data } = rpcErrorParts(error)
  return data?.reason === 'admission_conflict' && data?.field === 'request_id'
}

// ── controls and commands (review override-v2-r3 H1) ────────────────────────
// session.steer, slash.exec and session.rewind have no submission identity a
// resend could be de-duplicated by. Each operation names its own documented
// pre-admission refusals; anything else is 'uncertain'.

const CANONICAL_PRE_RUN = ['invalid_params', 'profile_mismatch', 'permission_denied', 'not_found']

const CONTROL_CONTRACTS = {
  'session.steer': {
    codes: new Set([4001, 4002, 4010]),
    reasons: new Set([...CANONICAL_PRE_RUN, 'execution_not_ready', 'stale_generation', 'unsupported_control']),
    exact: []
  },
  'slash.exec': {
    codes: new Set([4001, 4004]),
    reasons: new Set([...CANONICAL_PRE_RUN, 'unsupported_command', 'session_read_only', 'runtime_draining']),
    exact: [
      [4018, /^skill command: use command\.dispatch for \//],
      [4018, /^snapshot restore mutates live config\/state; use command\.dispatch/],
      [5030, /^slash worker start failed: /]
    ]
  },
  'session.rewind': {
    codes: new Set([4001]),
    reasons: new Set([...CANONICAL_PRE_RUN, 'runtime_draining']),
    exact: []
  },
  'session.title': {
    codes: new Set([4001, 4006, 4021]),
    reasons: new Set(CANONICAL_PRE_RUN),
    exact: []
  }
}

/** 'refused' | 'uncertain' for a failed control or command call.
 *  `operation` selects that call's documented refusals; without one only the
 *  dispatch-level refusals every method shares count. */
export function controlFailure(error, operation) {
  const parts = rpcErrorParts(error)
  if (isDispatchRefusal(parts)) return 'refused'
  const contract = CONTROL_CONTRACTS[operation]
  const { code, reason, message } = parts
  if (!contract || code === undefined) return 'uncertain'
  if (reason) return code === 4001 && contract.reasons.has(reason) ? 'refused' : 'uncertain'
  if (contract.codes.has(code)) return 'refused'
  return contract.exact.some(([c, re]) => c === code && re.test(message)) ? 'refused' : 'uncertain'
}

export const steerFailure = error => controlFailure(error, 'session.steer')
export const slashExecFailure = error => controlFailure(error, 'slash.exec')
export const rewindFailure = error => controlFailure(error, 'session.rewind')

/** The eager `session.title` of a new Bot Chat failed. 'conflict': another
 *  writer holds the title (adopt it); 'refused': nothing was titled, so the
 *  compat kickoff may persist the row; 'uncertain': no kickoff. */
export function titleFailure(error) {
  if (/already in use/i.test(rpcErrorParts(error).message)) return 'conflict'
  return controlFailure(error, 'session.title')
}

/** The gateway does not serve this method at all (review override-v2-r3 H2):
 *  structured only. JSON-RPC -32601 (legacy dispatch, or the canonical
 *  gateway's `reason: 'unknown_method'`), unwrapped through cause/error. A
 *  handler error, an unknown code or any prose is NOT proof that nothing ran,
 *  so it can never route a mutation to a legacy fallback. */
export function isMethodNotServed(error) {
  const { code, reason } = rpcErrorParts(error)
  return code === -32601 && (!reason || reason === 'unknown_method')
}

/** Read-only availability (UI only: a card, a list, a screen tab says "not
 *  available here"). May use prose; must never decide a write. */
export function looksUnsupported(error) {
  if (isMethodNotServed(error)) return true
  return /unknown method|method not found|method-not-found|no handler for|unexpected session\.active_list/i.test(rpcErrorParts(error).message)
}

/** The runtime session is gone: legacy 4001 "session not found" (4007 = never
 *  existed), or a canonical refusal whose reason is `not_found`. A canonical
 *  4001 with any other reason is a refusal, not a reaped runtime. Prose counts
 *  only for a code-less (host-raised) error: a coded handler error that
 *  happens to say "session not found" is not proof (review v2-r3 inventory). */
export function isSessionGoneError(error) {
  if (!error) return false
  const { code, reason, message } = rpcErrorParts(error)
  if (code === 4001) return !reason || reason === 'not_found'
  if (code !== undefined) return false
  return message.includes('not in memory') || /session not found/i.test(message)
}

/** groups.send: 'refused' only on an explicit admitted:false (stock
 *  canonical-group-workspace.tsx admittedNothing); else 'uncertain' (retry
 *  under the same event id only). */
export function roomPostFailure(error) {
  return rpcErrorParts(error).data?.admitted === false ? 'refused' : 'uncertain'
}
