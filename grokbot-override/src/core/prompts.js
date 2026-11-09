// Questions a running turn is blocked on (PARITY C11): clarify, sudo, secret,
// vault prompts and connection cards, normalised for the override's cards,
// plus the exact gateway calls that answer them.
//
// The app answers these as JSON-RPC RESPONSES on the socket the request came
// in on (apps/desktop/src/store/server-requests.ts); a plugin never receives
// that request, so it answers through the gateway's own proxies, as stock Bot
// Mode's room windows do for prompts mirrored from a resume snapshot:
//
//  - clarify: `clarify.lock {request_id, question_id, answer}` per question,
//    sequentially; the LAST lock resolves the blocked request
//    (hermes-bots/group-turns.ts:815-852 `answerGroupClarify`; served by the
//    sidecar, tui_gateway/methods_prompt.py, and by the canonical owner,
//    tui_gateway/contracts/canonical.py:372-376). `null` = skipped.
//  - sudo / secret / vault.*: `request.answer {id, result: {value}}`, the
//    proxy "for a client that did not receive it" (methods_prompt.py:1296-1310,
//    contracts/prompt_voice.py:291-302) with the app's own result shape
//    (`ValueResult`, contracts/server_requests.py; prompt-overlays.tsx sends
//    `{ value }`, '' = declined; vault.save_login's value is JSON
//    {identifier, password}). A gateway without it answers -32601: the card
//    then says so and offers Hermes Bot Mode (the one error-state link).
//  - connection: `connection.respond {op_id, owner: {session_id, type:
//    'session'}, result}` (store/connection-request.ts:496-519,
//    contracts/connectors_operation.py:262-299).
//
// Secret values are never stored here, never put into chat state and never
// logged: the card holds them in its own input until the click sends them.

const INPUT_KINDS = {
  clarify: 'clarify',
  sudo: 'sudo',
  secret: 'secret',
  'vault.unlock_prompt': 'vault-unlock',
  'vault.save_login': 'vault-login',
  'vault.code': 'vault-code'
}

/** The kinds answered with `request.answer {id, result: {value}}`. */
export const VALUE_KINDS = new Set(['sudo', 'secret', 'vault-unlock', 'vault-login', 'vault-code'])

const str = value => (typeof value === 'string' ? value : '')

/** clarify.ts `normalizeQuestions`: the batch form, or the single-question
 *  form (`canonicalPromptParams`, api/canonical-protocol.ts:41-47). */
export function clarifyQuestions(params, fallbackId = '') {
  const p = params && typeof params === 'object' ? params : {}
  const raw = Array.isArray(p.questions) && p.questions.length
    ? p.questions
    : str(p.question)
      ? [{ qid: str(p.prompt_id) || str(p.request_id) || fallbackId, question: p.question, choices: p.choices, multi_select: p.multi_select }]
      : []
  const out = []
  for (const entry of raw) {
    const qid = str(entry?.qid).trim()
    const question = str(entry?.question).trim()
    if (!qid || !question) continue
    const choices = Array.isArray(entry.choices) ? entry.choices.filter(c => typeof c === 'string' && c.trim()) : []
    out.push({ qid, question, choices: choices.length ? choices : null, multiSelect: entry.multi_select === true && choices.length > 0 })
  }
  return out
}

/** A blocking prompt as the card draws it, or null. `method` is the server
 *  request method, the event kind ('clarify', 'connection'), or `connection`
 *  for a `pending_connection` snapshot / `connection.request` event. */
export function inputRequestFrom(method, params, id = '') {
  const p = params && typeof params === 'object' ? params : {}
  if (method === 'connection') {
    const opId = str(p.op_id)
    if (!opId) return null
    return {
      kind: 'connection',
      id: opId,
      opId,
      seq: Number.isFinite(p.seq) ? p.seq : 0,
      targets: Array.isArray(p.targets) ? p.targets : [],
      display: p.display && typeof p.display === 'object' ? p.display : null,
      settled: Boolean(p.settled),
      deadlineAt: Number.isFinite(p.deadline_at) ? p.deadline_at : 0,
      text: (Array.isArray(p.targets) ? p.targets.map(t => str(t?.display) || str(t?.name)).filter(Boolean).join(', ') : '') || 'a connection'
    }
  }
  const kind = INPUT_KINDS[method]
  if (!kind) return null
  const requestId = String(id || p.prompt_id || p.request_id || '')
  const base = { kind, id: requestId }
  switch (kind) {
    case 'clarify': {
      const questions = clarifyQuestions(p, requestId)
      const locked = p.answers && typeof p.answers === 'object' ? p.answers : null
      return { ...base, questions, ...(locked ? { locked } : {}), text: questions[0]?.question || '' }
    }
    case 'sudo':
      // The command is shown (what sudo will run); the password never is.
      return { ...base, text: str(p.command) }
    case 'secret':
      return { ...base, envVar: str(p.env_var), text: str(p.prompt) }
    case 'vault-unlock':
      return { ...base, backend: str(p.backend), text: str(p.display_name) || str(p.backend) }
    case 'vault-login':
      return { ...base, origin: str(p.origin), text: str(p.site) || str(p.origin) }
    case 'vault-code':
      return { ...base, hint: str(p.hint), text: str(p.site) }
    default:
      return null
  }
}

/** Apply a `connection.update` frame (a newer full snapshot) to the card. */
export function applyConnectionUpdate(waiting, payload) {
  if (!waiting || waiting.kind !== 'connection' || str(payload?.op_id) !== waiting.opId) return waiting
  const seq = Number.isFinite(payload?.seq) ? payload.seq : 0
  if (seq && waiting.seq && seq <= waiting.seq) return waiting
  if (payload?.settled) return null
  return {
    ...waiting,
    seq: seq || waiting.seq,
    targets: Array.isArray(payload?.targets) ? payload.targets : waiting.targets,
    deadlineAt: Number.isFinite(payload?.deadline_at) ? payload.deadline_at : waiting.deadlineAt
  }
}

/** The value `request.answer` carries for a value prompt. */
export function valueResult(kind, input) {
  if (kind === 'vault-login') {
    const identifier = str(input?.identifier).trim()
    const password = str(input?.password)
    return { value: identifier || password ? JSON.stringify({ identifier, password }) : '' }
  }
  return { value: str(typeof input === 'string' ? input : input?.value) }
}
