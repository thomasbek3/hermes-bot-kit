// Context / cost meter for the open Bot Chat (C25).
//
// Stock shows the focused session's usage in the status bar
// (apps/desktop/src/app/shell/hooks/use-statusbar-items.tsx:237-365,
// lib/statusbar.tsx:44-60). Its sources, for a session the override has
// attached (Hermes Agent, MIT, (c) Nous Research):
//   - `session.usage` RPC (read) on the runtime id
//     (use-session-actions/index.ts:1507; contract tui_gateway/contracts/sessions.py:503)
//   - `session.usage` event: payload.usage, the status-bar view
//     (gateway-event/session-info.ts:537; contracts/events.py:318)
//   - `session.info` / `message.complete` payload.usage
//     (gateway-event/session-info.ts:509)
// Fields: contracts/common.py:28 Usage (+ cost_usd, cost_status).

export function compactNumber(n) {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(v))
}

/** Merge a usage reading over the last one; absent fields keep their value. */
export function mergeUsage(current, next) {
  if (!next || typeof next !== 'object') return current
  const out = { ...(current || {}) }
  for (const [key, value] of Object.entries(next)) if (value !== null && value !== undefined) out[key] = value
  return out
}

/** The usage carried by a gateway event for `runtimeId`, or null. */
export function usageFromEvent(event, runtimeId) {
  if (!runtimeId || String(event?.session_id || '') !== runtimeId) return null
  const type = String(event?.type || '')
  if (type !== 'session.usage' && type !== 'session.info' && type !== 'message.complete') return null
  const usage = event?.payload?.usage
  return usage && typeof usage === 'object' ? usage : null
}

/** lib/statusbar.tsx:44 usageContextLabel */
export function usageContextLabel(usage) {
  if (!usage) return ''
  if (usage.context_max) return `${usage.context_estimated ? '~' : ''}${compactNumber(usage.context_used ?? 0)}/${compactNumber(usage.context_max)}`
  return Number(usage.total) > 0 ? `${compactNumber(usage.total)} tok` : ''
}

export function contextPercent(usage) {
  if (!usage?.context_max) return null
  return Math.max(0, Math.min(100, Math.round(Number(usage.context_percent ?? (100 * (usage.context_used || 0)) / usage.context_max))))
}

/** `$0.0123` when the backend reported a cost; '' otherwise. */
export function costLabel(usage) {
  const cost = Number(usage?.cost_usd)
  if (!Number.isFinite(cost) || usage?.cost_usd == null) return ''
  return `${usage?.cost_status === 'estimated' ? '~' : ''}$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`
}

export function usageDetailRows(usage) {
  if (!usage) return []
  return [
    ['Context', usageContextLabel(usage)],
    ['Used', usage.context_max ? `${contextPercent(usage)}%` : ''],
    ['Model', usage.model || ''],
    ['Input tokens', usage.input ? compactNumber(usage.input) : ''],
    ['Output tokens', usage.output ? compactNumber(usage.output) : ''],
    ['API calls', usage.calls ? String(usage.calls) : ''],
    ['Compressions', usage.compressions ? String(usage.compressions) : ''],
    ['Cache hits', typeof usage.cache_hit_pct === 'number' ? `${Math.round(usage.cache_hit_pct)}%` : ''],
    ['Cost', costLabel(usage)]
  ]
    .filter(([, v]) => v)
    .map(([label, value]) => ({ label, value }))
}
