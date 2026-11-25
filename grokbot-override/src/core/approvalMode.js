// A bot's approval mode (Manual / Smart / Off): the control stock Hermes puts
// in the bottom status bar, which the override hides. Ports small pieces of
// Hermes Agent (MIT, (c) Nous Research), v0.23.3:
//
//   - the modes and their normalisation (anything else reads as 'manual')
//                                                   ← apps/desktop/src/store/approval-mode.ts:3-41
//   - the labels and one-line descriptions          ← apps/desktop/src/i18n/en.ts:4132-4141
//   - the RPCs: `config.get {key: 'approvals.mode', profile}` and
//     `config.set {key: 'approvals.mode', value, profile}`, both @_profile_scoped
//     with the profile named (a blank name is the launch profile, so the param
//     is left out), no session and no scope    ← store/approval-mode.ts:16-26, 62-113;
//                                                 tui_gateway/methods_config.py:274,288-299;
//                                                 tui_gateway/methods_config_set.py:426-427,589-608
//
// The gateway stores the mode in that profile's config.yaml
// (`_write_config_key("approvals.mode", ...)`), so it is per profile: the
// override writes only the bot's own profile, on the bot's own route.

import { isUnknownConfigKey, looksUnsupported } from './outcomes.js'

export const APPROVAL_KEY = 'approvals.mode'
export const APPROVAL_MODES = ['manual', 'smart', 'off']

export const APPROVAL_TITLE = 'Approval mode'
export const APPROVAL_LABELS = { manual: 'Manual', smart: 'Smart', off: 'Off' }
export const APPROVAL_DESCRIPTIONS = {
  manual: 'Ask before actions that require approval',
  smart: 'Automatically assess actions and ask when needed',
  off: 'Run without approval prompts'
}

/** store/approval-mode.ts normalizeApprovalMode: unknown values read as 'manual'. */
export function normalizeApprovalMode(value) {
  const mode = String(value ?? '')
    .trim()
    .toLowerCase()
  return APPROVAL_MODES.includes(mode) ? mode : 'manual'
}

/** store/approval-mode.ts scopeToProfile: the profile named, or left out when blank. */
export function approvalParams(profile, extra = {}) {
  const name = String(profile ?? '').trim()
  const params = { key: APPROVAL_KEY, ...extra }
  return name ? { ...params, profile: name } : params
}

/** A gateway that does not have the key or the RPC (an older Hermes): the
 *  control hides there (core/outcomes.js: an unknown config key, or a method
 *  the gateway does not serve). Read-only availability only. */
export function approvalUnsupported(error) {
  if (!error) return false
  return isUnknownConfigKey(error) || looksUnsupported(error)
}

/**
 * One bot's mode, read and written the way stock's store does: a revision per
 * bot so a slower, older answer never overwrites a newer one, and a failed
 * write falls back to the last confirmed value. `request(method, params)` is
 * the bot's own route; `profile` its backend profile name.
 * States: { status: 'loading' | 'ready' | 'unsupported' | 'error', mode, error }.
 */
export function createApprovalModes({ onChange = () => undefined } = {}) {
  const states = new Map()
  const revisions = new Map()
  const confirmed = new Map()
  const bump = key => {
    const next = (revisions.get(key) || 0) + 1
    revisions.set(key, next)
    return next
  }
  const put = (key, patch) => {
    states.set(key, { status: 'loading', mode: null, error: null, ...states.get(key), ...patch })
    onChange(key)
  }
  return {
    get(key) {
      return states.get(key) || null
    },
    async read(key, request, profile) {
      const revision = bump(key)
      if (!states.has(key)) put(key, { status: 'loading' })
      try {
        const result = await request('config.get', approvalParams(profile))
        if (revisions.get(key) !== revision) return states.get(key)
        if (result && typeof result === 'object' && result.error) throw result.error
        const mode = normalizeApprovalMode(result?.value)
        confirmed.set(key, mode)
        put(key, { status: 'ready', mode, error: null })
      } catch (error) {
        if (revisions.get(key) !== revision) return states.get(key)
        if (approvalUnsupported(error)) put(key, { status: 'unsupported', mode: null, error: null })
        else put(key, { status: confirmed.has(key) ? 'ready' : 'error', mode: confirmed.get(key) ?? null, error: String(error?.message || error) })
      }
      return states.get(key)
    },
    async write(key, request, profile, mode) {
      const next = normalizeApprovalMode(mode)
      const revision = bump(key)
      put(key, { status: 'ready', mode: next, error: null })
      try {
        const result = await request('config.set', approvalParams(profile, { value: next }))
        if (result && typeof result === 'object' && result.error) throw result.error
        const authoritative = normalizeApprovalMode(result?.value ?? next)
        if (revisions.get(key) === revision) {
          confirmed.set(key, authoritative)
          put(key, { status: 'ready', mode: authoritative })
        }
        return authoritative
      } catch (error) {
        if (revisions.get(key) === revision) put(key, { status: 'ready', mode: confirmed.get(key) ?? null })
        throw error
      }
    },
    clear() {
      states.clear()
      revisions.clear()
      confirmed.clear()
    }
  }
}
