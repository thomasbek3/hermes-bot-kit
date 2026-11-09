// Approval cards: one card per gateway approval queue entry, keyed by the
// queue's own `request_id` (canonical gateways name it `prompt_id`).
//
// Sources, all normalised by approvalFromPayload:
//  - `session.resume` snapshot `pending_approval`
//  - `approval.pending` (read-only RPC) `approvals[]`
//  - the canonical `approval.request` event payload
// The answer is `approval.respond { session_id, request_id, choice }`, the
// same call Bot Mode's group rooms make.

export const APPROVAL_RESPOND_TIMEOUT_MS = 300_000

export const CHOICE_LABELS = {
  once: 'Allow once',
  session: 'Allow this session',
  always: 'Always allow',
  deny: 'Deny'
}

export function approvalChoices(payload) {
  if (Array.isArray(payload?.choices)) {
    const choices = payload.choices.filter(choice => typeof choice === 'string' && choice)
    if (choices.length) return choices
  }
  const choices = ['once']
  if (!payload?.smart_denied && payload?.allow_session !== false) {
    choices.push('session')
    if (payload?.allow_permanent !== false) choices.push('always')
  }
  return [...choices, 'deny']
}

export function approvalFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  const requestId = String(payload.request_id || payload.prompt_id || '').trim()
  const command = typeof payload.command === 'string' ? payload.command : ''
  const description = typeof payload.description === 'string' ? payload.description : ''
  if (!requestId && !command && !description) return null
  return {
    requestId,
    command,
    description: description || 'dangerous command',
    choices: approvalChoices(payload),
    toolName: typeof payload.tool_name === 'string' ? payload.tool_name : ''
  }
}

const approvalItemId = approval => `approval:${approval.requestId || approval.command}`

/** Add a pending card, or refresh an existing one in place. Every caller is
 *  an authoritative "this request is waiting" source (event, snapshot, fresh
 *  queue read), so a card this screen only INFERRED was answered elsewhere
 *  ('resolved', from an earlier queue read) comes back to life. Cards this
 *  screen answered, is answering, or saw cancelled/settled stay as they are. */
export function upsertApproval(items, approval, now = Date.now()) {
  const id = approvalItemId(approval)
  const existing = items.find(item => item.id === id)
  if (existing) {
    if (existing.status === 'resolved' && !existing.settled) {
      return items.map(item => (item.id === id ? { ...item, ...approval, status: 'pending', error: undefined } : item))
    }
    if (existing.status !== 'pending') return items
    return items.map(item => (item.id === id ? { ...item, ...approval } : item))
  }
  return [...items, { kind: 'approval', id, at: now, status: 'pending', ...approval }]
}

export function setApprovalStatus(items, requestId, patch) {
  return items.map(item => (item.kind === 'approval' && item.requestId === requestId ? { ...item, ...patch } : item))
}

/** The gateway dropped these (interrupt, reap, teardown). */
export function cancelApprovals(items, requestIds, reason = 'cancelled') {
  const ids = new Set(requestIds)
  return items.map(item =>
    item.kind === 'approval' && item.status === 'pending' && (ids.size === 0 || ids.has(item.requestId))
      ? { ...item, status: 'cancelled', reason }
      : item
  )
}

/** Reconcile with an authoritative pending list: new entries become cards;
 *  pending cards the gateway no longer lists were answered elsewhere. */
export function reconcilePending(items, pendingPayloads, now = Date.now()) {
  const pending = (Array.isArray(pendingPayloads) ? pendingPayloads : []).map(approvalFromPayload).filter(Boolean)
  const live = new Set(pending.map(approval => approval.requestId))
  let next = items.map(item =>
    item.kind === 'approval' && item.status === 'pending' && item.requestId && !live.has(item.requestId)
      ? { ...item, status: 'resolved' }
      : item
  )
  for (const approval of pending) next = upsertApproval(next, approval, now)
  return next
}

/** The gateway settled these (canonical `approval.settled`): final. */
export function settleApprovals(items, requestIds) {
  const ids = new Set(requestIds.map(String))
  return items.map(item =>
    item.kind === 'approval' && item.status === 'pending' && ids.has(item.requestId) ? { ...item, status: 'resolved', settled: true } : item
  )
}

/** `approval.respond` answered without unblocking anything (`resolved: 0`, or
 *  a canonical `already_resolved`): the request had already ended. */
export function respondResolvedNothing(result) {
  if (!result || typeof result !== 'object') return false
  if (result.status === 'already_resolved') return true
  return typeof result.resolved === 'number' && result.resolved <= 0
}

export function hasPendingApproval(items) {
  return items.some(item => item.kind === 'approval' && item.status === 'pending')
}
