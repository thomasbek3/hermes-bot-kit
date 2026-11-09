// Delivery helpers. Every error classifier lives in core/outcomes.js (review
// override-v2-r3 H1/H2: one module, one rule); they are re-exported here for
// the modules and tests that import them from delivery.js.

export {
  classifySubmitFailure,
  controlFailure,
  isAdmittedConflict,
  isIdentityRefusal,
  isRuntimeNotFoundRefusal,
  rpcErrorParts,
  submitDelivery
} from './outcomes.js'

// ── submission identity (PARITY C6) ─────────────────────────────────────────
// Stock sends every prompt.submit with a `submission_id` and retries an
// uncertain send under the SAME id, which the canonical gateway de-duplicates
// (apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts:1087,
// gateway/session_controls.py:823-834 requires it). A legacy `tui_gateway`
// rejects the unknown key with 4000 before any handler ran (contracts/base.py:
// Params are extra="forbid"; rpc_dispatch.py:28-30), and 4094 is an explicit
// pre-admission capability refusal: both are safe to resend once without the
// id (submit.ts:206-214 `isPreAdmissionRefusal`, 1166-1186). Once a send went
// out without an id, it can never be retried automatically again.

/** A fresh submission identity (randomUuid in stock). */
export function newSubmissionId() {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `gbo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
}
