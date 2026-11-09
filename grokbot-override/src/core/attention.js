// Needs-attention badge (R15). Port of apps/desktop/src/plugins/hermes-bots/
// data.ts:55-166 (Hermes Agent, MIT, (c) Nous Research): the attention
// classes, the error-text classifier (transient failures never badge), the
// hints, and "latest failure wins; the next good turn clears it".
//
// Stock records attention in its own module atom from its own turns (group
// rounds, relay deliveries). That atom is not reachable from a plugin; the
// override records attention from the turns IT runs (the open Bot Chat) the
// same way: a failed turn notes, a completed reply clears.

const CLASSES = new Set(['agent_blocked', 'provider_auth_or_access', 'provider_quota_limit', 'missing_config'])

const HINTS = {
  provider_auth_or_access: 'Sign in again for this profile',
  provider_quota_limit: 'Quota or balance exhausted',
  missing_config: 'Provider not configured — run hermes model',
  agent_blocked: 'Bot is blocked — see its last message'
}

export function botAttentionHint(reason) {
  return HINTS[reason] || 'Needs attention'
}

/** data.ts:85 attentionReasonFromError */
export function attentionReasonFromError(errorTextOrReason) {
  const raw = String(errorTextOrReason || '').trim()
  if (!raw) return null
  if (CLASSES.has(raw)) return raw
  const text = raw.toLowerCase()
  if (/rate.?limit|too many requests|\b429\b|\b5\d\d\b|server error|overloaded|timed?.?out|timeout|temporar/.test(text)) return null
  if (/no llm provider|no access token|not configured|no api key|missing api key/.test(text)) return 'missing_config'
  if (/\b401\b|\b403\b|unauthorized|forbidden|authentication|invalid.?api.?key|credentials? (are )?(invalid|expired)/.test(text)) {
    return 'provider_auth_or_access'
  }
  if (/quota|out of funds|insufficient (credits?|funds|balance)|payment required|\b402\b|billing/.test(text)) return 'provider_quota_limit'
  if (/\bblocked\b/.test(text)) return 'agent_blocked'
  return null
}

/** data.ts:136 noteBotAttention, on a plain map. Returns the next map. */
export function noteAttention(map, key, errorTextOrReason, now = Date.now()) {
  const reason = attentionReasonFromError(errorTextOrReason)
  if (!key || !reason) return map
  return { ...map, [key]: { reason, at: now, message: String(errorTextOrReason || '').trim().slice(0, 200) } }
}

/** data.ts:156 clearBotAttention */
export function clearAttention(map, key) {
  if (!key || !map?.[key]) return map
  const next = { ...map }
  delete next[key]
  return next
}

/** What a gateway event means for the open bot's badge: 'fail' with the
 *  failure text, 'ok' for a completed reply, or null. The failure text is the
 *  #93091 reason code when the gateway sends one, else the error text
 *  (group-round-members.ts:273 `reason || error`). */
export function attentionFromEvent(event) {
  const type = String(event?.type || '')
  const payload = event?.payload || {}
  if (type === 'message.complete') {
    const failed = payload.status === 'error' || Boolean(payload.error)
    if (failed) return { kind: 'fail', text: payload.reason || payload.failure_reason || payload.error || 'error' }
    const text = String(payload.text ?? payload.content ?? payload.final ?? '').trim()
    return text || payload.status === 'complete' || payload.status === 'done' ? { kind: 'ok' } : null
  }
  if (type === 'error') return { kind: 'fail', text: payload.reason || payload.message || payload.error || '' }
  return null
}

/** What a group room's log event means for a member's badge (R14 → R15).
 *  Stock notes a member's failed group turn and clears the badge on its next
 *  real reply (group-round-members.ts:255 / :271, group-turns.ts:1422,
 *  `reason || error`). For gateway-owned rooms the log carries the same
 *  facts: `turn.failed` {member_id, reason_code | reason | error} and a
 *  member's message. Returns { kind: 'fail' | 'ok', profile, text? } or null;
 *  `members` is the room's member list (member_id → profile). */
export function attentionFromRoomEvent(event, members) {
  const kind = String(event?.kind || '')
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
  const profileOf = id => {
    const m = (Array.isArray(members) ? members : []).find(x => String(x?.member_id || '') === String(id || ''))
    return String(m?.profile || id || '').trim()
  }
  if (kind === 'turn.failed' && payload.member_id) {
    const text = payload.reason_code || payload.reason || payload.error || ''
    return { kind: 'fail', profile: profileOf(payload.member_id), text: String(text) }
  }
  if ((kind === 'message' || kind === 'message.member') && event?.actor?.kind === 'member' && event?.actor?.id) {
    const body = String(payload.text ?? payload.content ?? '').trim()
    return body ? { kind: 'ok', profile: profileOf(event.actor.id) } : null
  }
  return null
}
