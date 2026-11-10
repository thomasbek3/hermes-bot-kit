// Email draft cards (the kit's `email-drafts` agent plugin, ui/EmailDraft.tsx).
//
// A bot never sends email itself: its `email_draft_create` tool stores a
// draft on the bot's own machine and returns `{ email_draft: { id, … } }`.
// The chat finds that tool result in the transcript (stored rows and live
// tool.complete frames both land in a `tools` item) and draws one card per
// draft id where it was created, even with work rows hidden. Later
// `email_draft_update` / `email_draft_status` results only refresh it.
//
// The card reads and writes the draft through the bot's OWN gateway, on the
// chat's attached runtime and the bot's route (core/session.js
// pluginRequest), so a remote bot's draft is sent by the remote machine:
//   1. `plugin.email-drafts.api {op, …}` (plugin RPC, newer gateways);
//   2. when that method is not served at all (a structured refusal: nothing
//      ran), `/email-drafts api <op> <json>` through `slash.exec`, which
//      every supported gateway runs as a plugin slash command.
// Never send twice: the card holds one action in flight at a time
// (createSingleFlight), a failed or unanswered send is never repeated by the
// card on its own (a lost reply leaves the button to the user, and the
// plugin's own `sending` claim refuses a second send of the same draft).

import { isMethodNotServed } from './outcomes.js'

export const DRAFT_PLUGIN = 'email-drafts'
export const DRAFT_RPC = `plugin.${DRAFT_PLUGIN}.api`
export const CREATE_TOOL = 'email_draft_create'
export const DRAFT_TOOLS = new Set([CREATE_TOOL, 'email_draft_update', 'email_draft_status'])
export const DRAFT_ID_RE = /^ed_[0-9a-f]{16}$/
export const SEND_TIMEOUT_MS = 120_000
export const READ_TIMEOUT_MS = 30_000

/** The draft summary a draft tool returned, or null. Tolerates a result
 *  that Hermes clipped (the id is still found). */
export function draftFromToolResult(text) {
  const raw = typeof text === 'string' ? text : text && typeof text === 'object' ? JSON.stringify(text) : ''
  if (!raw.includes('email_draft')) return null
  try {
    const parsed = JSON.parse(raw)
    const draft = parsed?.email_draft
    if (draft && typeof draft === 'object' && DRAFT_ID_RE.test(String(draft.id || ''))) return { ...draft }
    return null
  } catch {
    const match = raw.match(/"email_draft"\s*:\s*\{[^{}]*?"id"\s*:\s*"(ed_[0-9a-f]{16})"/)
    if (!match) return null
    const status = raw.match(/"status"\s*:\s*"([a-z]+)"/)
    return { id: match[1], ...(status ? { status: status[1] } : {}) }
  }
}

/** The transcript with an `email-draft` item after each tool group that
 *  created a draft (one per draft id, at its creation). The latest summary
 *  any draft tool returned for that id rides along as `hint`, so the card
 *  re-reads when the bot changed the draft. Returns `items` itself when
 *  there is no draft. */
export function withEmailDrafts(items) {
  const list = Array.isArray(items) ? items : []
  const latest = new Map()
  const created = new Map()
  for (const item of list) {
    if (item?.kind !== 'tools' || !Array.isArray(item.tools)) continue
    for (const tool of item.tools) {
      if (!DRAFT_TOOLS.has(String(tool?.name || '')) || tool.status === 'running' || !tool.result) continue
      const draft = draftFromToolResult(tool.result)
      if (!draft) continue
      latest.set(draft.id, draft)
      if (tool.name === CREATE_TOOL && !created.has(draft.id)) created.set(draft.id, item.id)
    }
  }
  if (!created.size) return list
  const out = []
  const placed = new Set()
  for (const item of list) {
    out.push(item)
    if (item?.kind !== 'tools') continue
    for (const [draftId, groupId] of created) {
      if (groupId !== item.id || placed.has(draftId)) continue
      placed.add(draftId)
      out.push({ kind: 'email-draft', id: `email-draft:${draftId}`, draftId, at: item.at, hint: latest.get(draftId) })
    }
  }
  return out
}

/** One call to the bot's email-drafts plugin. `request(method, params,
 *  options)` is the chat controller's pluginRequest. Resolves the plugin's
 *  answer (`{ ok, draft?, rules?, error? }`); throws when the bot cannot be
 *  reached or has no such plugin. */
export async function callDrafts(request, op, params = {}, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  if (typeof request !== 'function') throw new Error('Open this bot’s chat to use its email drafts')
  const options = { timeoutMs }
  try {
    return asAnswer(await request(DRAFT_RPC, { op, ...params }, options))
  } catch (error) {
    if (!isMethodNotServed(error)) throw error
  }
  const res = await request('slash.exec', { command: `/${DRAFT_PLUGIN} api ${op} ${JSON.stringify(params)}` }, options)
  return asAnswer(parseSlashOutput(res?.output))
}

function asAnswer(value) {
  if (value && typeof value === 'object' && typeof value.ok === 'boolean') return value
  throw new Error('The email-drafts plugin is not enabled for this bot')
}

/** The JSON a `/email-drafts api` call printed, or null (the plugin is not
 *  installed there, so the gateway printed something else). */
export function parseSlashOutput(output) {
  const text = String(output || '').trim()
  if (!text.startsWith('{')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** One action at a time: a second call while one runs is dropped (returns
 *  null), synchronously, before any await, so a double click never sends
 *  twice. */
export function createSingleFlight() {
  let running = false
  return {
    get busy() {
      return running
    },
    async run(fn) {
      if (running) return null
      running = true
      try {
        return await fn()
      } finally {
        running = false
      }
    }
  }
}

const EMAIL = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/

/** Addresses typed in To / Cc: split on commas, semicolons or spaces.
 *  `{ list, bad }`: the valid addresses (deduplicated, case-blind), and the
 *  pieces that are not addresses. */
export function parseAddresses(text) {
  const list = []
  const bad = []
  const seen = new Set()
  for (const piece of String(text || '').split(/[,;\s]+/)) {
    const value = piece.trim().replace(/^<|>$/g, '')
    if (!value) continue
    if (!EMAIL.test(value)) {
      bad.push(value)
      continue
    }
    if (seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    list.push(value)
  }
  return { list, bad }
}

export const addressText = list => (Array.isArray(list) ? list.join(', ') : '')

/** The rules menu's trigger label and entries, by mode. */
export const MODE_LABELS = { approval: 'Needs approval', allow: 'Allow recipient', disabled: 'Drafts off' }
export const modeLabel = mode => MODE_LABELS[mode] || MODE_LABELS.approval

/** "“Subject” from Name <addr>" for the In reply to row, or ''. */
export function inReplyText(reply) {
  if (!reply || typeof reply !== 'object') return ''
  const subject = String(reply.subject || '').trim()
  const from = String(reply.from || '').trim()
  if (subject && from) return `“${subject}” from ${from}`
  if (subject) return `“${subject}”`
  return from ? `from ${from}` : String(reply.message_id || '')
}

const toMs = seconds => (Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Math.round(Number(seconds) * 1000) : 0)

/** The footer's state line and what the card offers, from the draft.
 *  `clock(ms)` formats a time. */
export function draftState(draft, clock = ms => new Date(ms).toLocaleTimeString()) {
  const status = String(draft?.status || 'pending')
  if (status === 'sent') {
    const at = toMs(draft.sent_at)
    const when = at ? clock(at) : ''
    if (draft.sent_by === 'allow-rule') return { status, line: `Sent automatically${when ? ` · ${when}` : ''} · allowed recipient`, editable: false, actions: [] }
    return { status, line: `Sent${when ? ` · ${when}` : ''}`, editable: false, actions: [] }
  }
  if (status === 'discarded') return { status, line: 'Discarded', editable: false, actions: [] }
  if (status === 'sending') {
    if (draft.delivery_unknown) return { status, line: 'Delivery unknown: check your Sent folder', editable: false, actions: [] }
    return { status, line: 'Sending…', editable: false, actions: [] }
  }
  if (status === 'failed') {
    if (draft.delivery_unknown) return { status, line: draft.error || 'Delivery unknown: check your Sent folder', editable: false, actions: ['discard'] }
    return { status, line: draft.error ? `Not sent: ${draft.error}` : 'Not sent', editable: true, actions: ['discard', 'retry'] }
  }
  return { status: 'pending', line: '', editable: true, actions: ['discard', 'send'] }
}

/** The fields the card edits, as the plugin takes them. */
export function editsFrom(fields) {
  return {
    to: parseAddresses(fields.to).list,
    cc: parseAddresses(fields.cc).list,
    subject: String(fields.subject || ''),
    body: String(fields.body || '')
  }
}

/** Whether the typed fields differ from the stored draft. */
export function isDirty(fields, draft) {
  if (!draft) return false
  const edits = editsFrom(fields)
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || [])
  return !same(edits.to, draft.to) || !same(edits.cc, draft.cc) || edits.subject !== String(draft.subject || '') || edits.body !== String(draft.body || '')
}
