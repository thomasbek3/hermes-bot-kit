// Native OS notifications for the open override chat (T7).
//
// Hermes fires its own native notifications (turn done, approval, input
// needed) from its message stream, which never owns the override's runtime,
// so a reply or a blocking prompt in an override chat made no OS
// notification while Hermes was in the background. The override sends them
// through the public plugin door `ctx.os.notify` (contrib/plugin.ts PluginOs;
// Hermes Desktop itself also gates it on its "Plugin notifications" setting,
// on the user being away, and throttles it per plugin).
//
// Pure: chat-state transition in, notifications out. Guards:
//  - only while the Hermes window is not focused (`focused` false); what
//    arrives while it is focused is marked seen, never notified later;
//  - at most once per item (the `seen` tracker, keyed by kind and item id),
//    and a turn's reply counts only when it is not the ITEM that was already
//    there when the turn started: the same id, or the stored row that
//    replaced that live item (a live id, then a stored id with the same text).
//    A new item with the same text as an older reply (a background turn that
//    says "Done." again) still notifies (review C-R1-03);
//  - a new chat (another bot or runtime) is a baseline: what it already
//    holds is marked seen, nothing fires;
//  - every open chat counts, the main tab and each side tab (`slot`), with
//    its own previous state; the `seen` tracker is shared, so an approval or
//    a question shown in two tabs notifies once, and a reply shown by the
//    same bot in two tabs (two controllers, two live ids) notifies once: a
//    reply with the same bot, runtime and text from ANOTHER slot within
//    15 s is the same reply (review C-R2-02);
//  - never for a silent reply ([SILENT], NO_REPLY, …) or a failed turn;
//  - bodies are generic lines: never the reply, the approval command, a
//    question or any secret / sudo / vault prompt text.

import { isSilenceReply } from './silence.js'

/** The generic body for each blocking prompt kind (prompts.js kinds). */
const INPUT_BODY = {
  clarify: 'Has a question for you.',
  connection: 'Needs a connection approved.'
}
const INPUT_DEFAULT = 'Needs your input.'
export const BODIES = Object.freeze({ done: 'Replied.', approval: 'Needs your approval.', input: INPUT_DEFAULT })

const SEEN_CAP = 500

/** A fresh dedupe tracker for one app session: notified / seen ids, the
 *  reply each chat slot showed when its current turn started, and recent
 *  reply notifications (for the same reply seen by two slots). */
export function createSeen() {
  return { ids: new Set(), base: new Map(), recent: new Map() }
}

export const CROSS_SLOT_MS = 15_000

function remember(seen, id) {
  if (seen.ids.has(id)) return false
  seen.ids.add(id)
  if (seen.ids.size > SEEN_CAP) seen.ids.delete(seen.ids.values().next().value)
  return true
}

const chatOf = state => (state && state.chat && typeof state.chat === 'object' ? state.chat : null)
const itemsOf = state => (Array.isArray(chatOf(state)?.items) ? chatOf(state).items : [])

/** Which chat a state belongs to: a change is a baseline, not news. */
export function chatIdentity(state, keyOf = bot => String(bot?.name || '')) {
  if (!state?.bot) return ''
  return `${keyOf(state.bot)}\u0000${String(state.runtimeId || '')}`
}

/** The finished reply of the newest turn, or null: the last assistant item
 *  after the last user item, when that turn holds no error card and the reply
 *  is not a silence marker. */
export function finishedReply(items) {
  let lastUser = -1
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === 'user') {
      lastUser = i
      break
    }
  }
  const turn = items.slice(lastUser + 1)
  if (turn.some(item => item?.kind === 'error' || item?.kind === 'turn-error' || item?.failedTurn)) return null
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const item = turn[i]
    if (item?.kind !== 'assistant') continue
    if (item.streaming) return null
    const text = String(item.text || '').trim()
    if (!text || isSilenceReply(text)) return null
    return item
  }
  return null
}

const isLiveId = id => String(id || '').startsWith('live:')

/** Is `reply` the item `base` recorded at turn start: the same id, or the
 *  stored row that replaced that live item (same text, live id → stored id)? */
function sameReply(base, reply) {
  if (!base || !reply) return false
  const id = String(reply.id || '')
  if (base.id === id) return true
  return isLiveId(base.id) && !isLiveId(id) && base.text === String(reply.text || '').trim()
}

const pendingApprovals = items => items.filter(item => item?.kind === 'approval' && item.status === 'pending')

function inputKey(waiting) {
  if (!waiting || typeof waiting !== 'object') return ''
  return `input:${String(waiting.kind || '')}:${String(waiting.id || waiting.opId || '')}`
}

/** Mark everything a state already shows as seen (no notification). */
export function markSeen(state, seen) {
  const items = itemsOf(state)
  for (const item of pendingApprovals(items)) remember(seen, `approval:${item.id}`)
  const reply = finishedReply(items)
  if (reply) remember(seen, `done:${reply.id}`)
  const key = inputKey(chatOf(state)?.waiting)
  if (key) remember(seen, key)
}

/**
 * The notifications for the transition prev → next. Returns a list of
 * `{ id, kind: 'done'|'approval'|'input', title, body }`; `seen` is updated.
 * `name` is the bot's display name (the title).
 */
export function nativeNotifications(prev, next, { focused, seen, name = '', keyOf, slot = 'main', now = Date.now() } = {}) {
  if (!seen || !next?.bot || !chatOf(next)) return []
  const same = prev && chatIdentity(prev, keyOf) === chatIdentity(next, keyOf)
  if (!same || focused) {
    markSeen(next, seen)
    return []
  }
  const title = String(name || next.bot?.name || 'Bot').trim() || 'Bot'
  const out = []
  const items = itemsOf(next)
  const identity = chatIdentity(next, keyOf)
  const baseKey = `${slot}\u0000${identity}`
  // A turn starts: remember the reply already on screen.
  if (!chatOf(prev)?.busy && chatOf(next).busy) {
    const before = finishedReply(itemsOf(prev))
    seen.base.set(baseKey, before ? { id: String(before.id || ''), text: String(before.text || '').trim() } : null)
    if (seen.base.size > 50) seen.base.delete(seen.base.keys().next().value)
  }
  // Turn done: busy → idle with a finished, non-silent, new reply.
  if (chatOf(prev)?.busy && !chatOf(next).busy) {
    const reply = finishedReply(items)
    const base = seen.base.get(baseKey)
    seen.base.delete(baseKey)
    const fresh = reply && !sameReply(base, reply)
    if (fresh && remember(seen, `done:${reply.id}`)) {
      const sameKey = `${identity}\u0000${String(reply.text || '').trim()}`
      const last = seen.recent.get(sameKey)
      if (!(last && last.slot !== slot && now - last.at < CROSS_SLOT_MS)) {
        out.push({ id: `done:${reply.id}`, kind: 'done', title, body: BODIES.done })
        seen.recent.delete(sameKey)
        seen.recent.set(sameKey, { slot, at: now })
        if (seen.recent.size > 50) seen.recent.delete(seen.recent.keys().next().value)
      }
    } else if (reply) remember(seen, `done:${reply.id}`)
  }
  // A new pending approval card (one notification per transition).
  let approvals = 0
  for (const item of pendingApprovals(items)) {
    const id = `approval:${item.id}`
    if (remember(seen, id) && approvals === 0) {
      approvals += 1
      out.push({ id, kind: 'approval', title, body: BODIES.approval })
    }
  }
  // A blocking prompt (clarify, sudo, secret, vault, connection).
  const waiting = chatOf(next).waiting
  const key = inputKey(waiting)
  if (key && remember(seen, key)) out.push({ id: key, kind: 'input', title, body: INPUT_BODY[waiting.kind] || INPUT_DEFAULT })
  return out
}
