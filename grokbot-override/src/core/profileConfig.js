// Profile config (P6) and the per-bot model picker (C21). Ports from
// apps/desktop/src/plugins/hermes-bots (Hermes Agent, MIT, (c) Nous Research):
//
//   - loadAdvanced (profiles.describe + mcp.catalog, foreground)  ← profile-config.tsx:139-180
//   - emptyAdvancedState, applyAdvancedConfig (dirty sections only,
//     `config unset model` via cli.exec, confirm_required resend
//     with confirm_expensive_model)                            ← profile-config.tsx:500-638
//   - model.options read (include_unconfigured, explicit_only:false,
//     20 s settle guard), provider/model lists                 ← model-picker.tsx:31-90,240
//   - skills hub search/install (skills.manage)                ← skills-hub.tsx
//
// Every call rides the bot's own route (requestForBot), so a remote bot's
// config is read and written on its own machine.

export const MODEL_OPTIONS_SETTLE_MS = 20_000

export function emptyAdvancedState() {
  return {
    loaded: false,
    provider: '',
    model: '',
    soul: '',
    skills: [],
    toolsets: [],
    mcp: [],
    dirtyModel: false,
    dirtySoul: false,
    dirtySkills: false,
    dirtyToolsets: false,
    dirtyMcp: false
  }
}

/** The describe + catalog read (profile-config.tsx:149). Rejects when the
 *  gateway has no profiles.describe (stock shows "use the full config"). */
export async function loadAdvanced(request, bot) {
  const opened = { spawnPriority: 'foreground' }
  const [res, cat] = await Promise.all([
    request(bot, 'profiles.describe', { name: bot.name }, opened),
    request(bot, 'mcp.catalog', { profile: bot.name }, opened).catch(() => null)
  ])
  const configured = res?.mcp_servers || []
  const have = new Set(configured.map(m => m.name))
  const catalog = ((cat && cat.servers) || []).filter(s => !have.has(s.name))
  return {
    ...emptyAdvancedState(),
    provider: res?.model?.provider || '',
    model: res?.model?.default || '',
    soul: res?.soul || '',
    skills: res?.skills || [],
    toolsets: res?.toolsets || [],
    mcp: [
      ...configured.map(m => ({ ...m, enabled: m.enabled !== false })),
      ...catalog.map(s => ({
        name: s.name,
        enabled: false,
        fromCatalog: true,
        installed: s.installed,
        auth: s.auth,
        requires: s.requires || [],
        description: s.description || ''
      }))
    ],
    loaded: true
  }
}

/** A catalog MCP server that needs credentials first (profile-config.tsx:420). */
export function mcpNeedsSetup(m) {
  return Boolean(m?.fromCatalog && !m.installed && ((m.requires || []).length > 0 || String(m.auth || '').toLowerCase() === 'oauth'))
}

export function toggleEntry(state, kind, name, enabled) {
  const dirtyKey = { skills: 'dirtySkills', toolsets: 'dirtyToolsets', mcp: 'dirtyMcp' }[kind]
  return { ...state, [dirtyKey]: true, [kind]: (state[kind] || []).map(x => (x.name === name ? { ...x, enabled } : x)) }
}

/** profile-config.tsx:518 — the configure body for the dirty sections, and
 *  the model clear that goes through cli.exec. `ensureSoul(text)` appends the
 *  messaging protocol when needed (soul.ts ensureMessagingProtocol). */
export function advancedPayload(bot, state, ensureSoul = text => text) {
  const payload = { name: bot.name }
  let clearModel = false
  let modelInvalid = false
  if (state.dirtySoul) payload.soul = ensureSoul(state.soul)
  if (state.dirtyModel) {
    const model = String(state.model || '').trim()
    const provider = String(state.provider || '').trim()
    if (model && provider) {
      payload.model = model
      payload.provider = provider
    } else if (!model && !provider) clearModel = true
    else modelInvalid = true
  }
  if (state.dirtySkills) payload.disabled_skills = state.skills.filter(s => !s.enabled).map(s => s.name)
  if (state.dirtyToolsets) {
    const all = state.toolsets.length
    const enabled = state.toolsets.filter(t => t.enabled)
    payload.enabled_toolsets = enabled.length === all || enabled.length === 0 ? [] : enabled.map(t => t.name)
  }
  if (state.dirtyMcp) payload.enabled_mcp_servers = (state.mcp || []).filter(m => m.enabled).map(m => m.name)
  return { payload, clearModel, modelInvalid }
}

/**
 * Persist only the dirty sections. `confirm(message)` resolves true when the
 * user accepts an expensive / data-policy model (#95293); the model section
 * is then re-sent alone with confirm_expensive_model.
 */
export async function applyAdvancedConfig(request, bot, state, { ensureSoul, confirm } = {}) {
  const { payload, clearModel, modelInvalid } = advancedPayload(bot, state, ensureSoul)
  const applied = {}
  if (modelInvalid) applied.model = false
  if (clearModel) {
    try {
      const result = await request(bot, 'cli.exec', { argv: ['--profile', bot.name, 'config', 'unset', 'model'] })
      applied.model = result?.blocked !== true && result?.code === 0
    } catch {
      applied.model = false
    }
  }
  if (Object.keys(payload).length === 1) return { ok: Object.values(applied).every(Boolean), applied }
  const result = await request(bot, 'profiles.configure', payload)
  const merged = { ...applied, ...(result?.applied || {}) }
  let confirmation = null
  if (result?.confirm_required && payload.model && payload.provider) {
    delete merged.model
    confirmation = { message: result.confirm_message || 'This model needs your confirmation.' }
    if (typeof confirm === 'function') {
      const yes = await confirm(confirmation.message)
      if (yes) {
        const again = await request(bot, 'profiles.configure', { name: bot.name, model: payload.model, provider: payload.provider, confirm_expensive_model: true })
        merged.model = again?.applied?.model !== false
        confirmation.accepted = true
      } else {
        confirmation.accepted = false
      }
    }
  }
  return { ...result, ok: Object.values(merged).every(Boolean), applied: merged, confirmation }
}

/** model-picker.tsx:31 — bound a model.options read so a wedged bot socket
 *  falls back to free text instead of spinning forever. */
export function boundedFetch(promise, settleMs = MODEL_OPTIONS_SETTLE_MS, timers = globalThis) {
  if (typeof timers?.setTimeout !== 'function') return promise
  let id = null
  const deadline = new Promise((_, reject) => {
    id = timers.setTimeout(() => reject(new Error(`model.options did not answer within ${Math.round(settleMs / 1000)}s`)), settleMs)
  })
  return Promise.race([promise, deadline]).finally(() => timers.clearTimeout(id))
}

export function modelOptionsParams() {
  return { include_unconfigured: true, explicit_only: false }
}

/** lib/model-options.ts:10 catalogProviderMatches: slug, name or alias. */
export function providerMatches(provider, value) {
  if (!value || !provider) return false
  return provider.slug === value || provider.name === value || (provider.aliases || []).includes(value)
}

export function providerModels(provider) {
  return (provider?.models || []).map(m => (typeof m === 'string' ? m : m?.id || m?.name || '')).filter(Boolean)
}

export function usableProviders(options) {
  return (options?.providers || []).filter(p => p && p.slug)
}

/** Skills hub (skills-hub.tsx:146): search is the shared hub, asked on the
 *  active gateway with no profile; install (skills-hub.tsx:170) rides the
 *  bot's own route with its profile. */
export function skillsSearchParams(query) {
  return { action: 'search', query: String(query || '').trim() }
}

export function skillsInstallParams(bot, name) {
  return { action: 'install', query: String(name || ''), profile: bot.name }
}
