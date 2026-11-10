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

// ── the choice card (clarify, drawn inline in the transcript) ─────────────

const RECOMMENDED = '(Recommended)'

/** A choice without its "(Recommended)" suffix: the value that is sent. */
export function bareChoice(choice) {
  const text = str(choice)
  return text.endsWith(RECOMMENDED) ? text.slice(0, -RECOMMENDED.length).trim() : text
}

/** The row badge for choice `index`: A, B, C… then numbers past Z. */
export function choiceLetter(index) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : String(index + 1)
}

/** True when `value` answers a question (a non-empty string or list). */
export function clarifyFilled(value) {
  return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0
}

/** The picks a clarify card shows: what the gateway already locked, then what
 *  was picked here and not sent yet. */
export function clarifyPicks(waiting) {
  return { ...(waiting?.locked || {}), ...(waiting?.picks || {}) }
}

/** True when the gateway already locked question `qid` (`waiting.locked`). */
export function clarifyLocked(waiting, qid) {
  const locked = waiting?.locked
  return Boolean(locked && typeof locked === 'object' && Object.prototype.hasOwnProperty.call(locked, qid))
}

/** The question indexes a card with several questions pages through: every
 *  question the gateway has not locked yet. */
export function clarifyOpenPages(waiting) {
  const questions = Array.isArray(waiting?.questions) ? waiting.questions : []
  return questions.map((q, i) => (clarifyLocked(waiting, q.qid) ? -1 : i)).filter(i => i >= 0)
}

/** The page (question index) a card with several questions shows: the
 *  controller's `waiting.page` when it is an open question, else the first
 *  open one (the last question when every one is locked). */
export function clarifyPage(waiting) {
  const questions = Array.isArray(waiting?.questions) ? waiting.questions : []
  const open = clarifyOpenPages(waiting)
  if (open.includes(waiting?.page)) return waiting.page
  return open.length ? open[0] : Math.max(0, questions.length - 1)
}

/** Typed text from the composer as the answer to an open clarify card (the
 *  free-text "Other" answer); a multi-select question adds it to its picks.
 *  One question: it answers it. Several (a paged card): it answers the
 *  question on screen (clarifyPage), then the card moves to the next open
 *  page, or is complete on the last one (questions left unanswered go as
 *  skipped). Returns `{ picks, complete, page? }`: send when `complete`,
 *  otherwise keep the picks, show `page` and wait for the rest. */
export function clarifyTextAnswer(waiting, text) {
  const questions = Array.isArray(waiting?.questions) ? waiting.questions : []
  const value = str(text).trim()
  const picks = clarifyPicks(waiting)
  if (!questions.length || !value) return { picks, complete: false }
  const page = clarifyPage(waiting)
  const target = questions[page]
  const current = picks[target.qid]
  picks[target.qid] = target.multiSelect ? [...(Array.isArray(current) ? current.filter(v => v !== value) : []), value] : value
  const next = clarifyOpenPages(waiting).find(i => i > page)
  return next === undefined ? { picks, complete: true } : { picks, complete: false, page: next }
}

/** The same clarify request seen again (a snapshot repair, a repeated
 *  frame): keep what was picked here and the page on screen. */
export function keepCardProgress(previous, next) {
  if (!next || next.kind !== 'clarify' || !previous || previous.kind !== 'clarify' || previous.id !== next.id) return next
  return {
    ...next,
    ...(previous.picks ? { picks: previous.picks } : {}),
    ...(previous.page !== undefined ? { page: previous.page } : {})
  }
}

/** The settled card left in the transcript once a clarify request was
 *  answered here: the questions and what was chosen, never clickable. */
export function clarifySettledItem(waiting, answer, status, at) {
  const questions = Array.isArray(waiting?.questions) ? waiting.questions : []
  const answers = {}
  for (const q of questions) answers[q.qid] = answer && Object.prototype.hasOwnProperty.call(answer, q.qid) ? answer[q.qid] ?? null : null
  const skipped = questions.every(q => !clarifyFilled(answers[q.qid]))
  return {
    kind: 'clarify',
    id: `clarify:${String(waiting?.id || '')}`,
    requestId: String(waiting?.id || ''),
    questions,
    answers,
    status: status === 'expired' ? 'expired' : skipped ? 'skipped' : 'answered',
    ...(Number.isFinite(at) ? { at } : {})
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
