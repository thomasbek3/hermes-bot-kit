// The per-bot model sheet: provider, model, reasoning effort and speed, all
// written to the bot's own Hermes profile. Ports small pieces of Hermes Agent
// (MIT, (c) Nous Research):
//
//   - the effort levels a (provider, model) route accepts      ← agent/reasoning_effort.py
//     route_supported_efforts / codex_supported_efforts (OPENAI_COMPAT_WIRE_EFFORTS,
//     CODEX_GPT56_EFFORTS, CODEX_LEGACY_EFFORTS, CODEX_ASTRA_EFFORTS). `ultra` is
//     Hermes-internal ("no wire accepts it"), so it is never offered.
//   - per-model gates from model.options `capabilities[model]` ← hermes_cli/inventory.py
//     _apply_capabilities: `reasoning` (false = no effort dial), `can_disable_reasoning`
//     (false = no Off), `fast` (Priority / Anthropic fast), `ultrafast` (OpenAI Ultrafast).
//   - the config keys: `agent.reasoning_effort` (hermes_constants.parse_reasoning_effort:
//     none | minimal | low | medium | high | xhigh | max) and `agent.service_tier`
//     (agent/fast_mode.py: "" / normal = Standard, fast, ultrafast, auto, cold), written
//     with `config.set` keys `reasoning` / `fast` (tui_gateway/methods_config_set.py), read
//     from `config.get full` (the user config without defaults, so a missing key is unset).
//
// "Default" in either select means the key is not in the profile's config:
// saving it runs `config unset <key>` (the same cli.exec the model clear uses).

export const EFFORT_KEY = 'agent.reasoning_effort'
export const SPEED_KEY = 'agent.service_tier'
export const DEFAULT = ''

export const OPENAI_COMPAT_WIRE_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const CODEX_GPT56_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
export const CODEX_LEGACY_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']
export const CODEX_ASTRA_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const ASTRA_MODEL_IDS = new Set(['gpt-6-astra', 'gpt-6-astra-900k'])
const GPT6_TIER_PREFIXES = ['gpt-6-sol', 'gpt-6-luna']
const NO_DISABLE_TIER_PREFIXES = ['gpt-6.1-sol']
const DAYBREAK_MODEL_IDS = new Set(['gpt-daybreak-blue-latest', 'gpt-daybreak-blue-latest-900k'])

export const EFFORT_LABELS = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

/** agent.service_tier words (fast_mode.SERVICE_TIER_WORDS / config.set fast)
 *  in plain words. auto and cold are only shown when a profile already has them. */
export const SPEED_LABELS = {
  normal: 'Standard',
  fast: 'Fast',
  ultrafast: 'Ultrafast',
  auto: 'Fast for the first minute of a turn',
  cold: 'Fast on the first turn only'
}

export const UNSUPPORTED_HINT = 'Not supported by this model'

const bare = model =>
  String(model || '')
    .trim()
    .toLowerCase()
    .split('/')
    .pop()

/** reasoning_effort.py codex_supported_efforts */
export function codexSupportedEfforts(model) {
  const id = bare(model)
  if (ASTRA_MODEL_IDS.has(id) || NO_DISABLE_TIER_PREFIXES.some(p => id.startsWith(p))) return CODEX_ASTRA_EFFORTS
  return id.includes('gpt-5.6') || GPT6_TIER_PREFIXES.some(p => id.startsWith(p)) || DAYBREAK_MODEL_IDS.has(id) ? CODEX_GPT56_EFFORTS : CODEX_LEGACY_EFFORTS
}

/** reasoning_effort.py route_supported_efforts (Responses runtime; the
 *  codex app-server's extra `ultra` is not a wire level and is left out). */
export function routeSupportedEfforts(provider, model) {
  return String(provider || '')
    .trim()
    .toLowerCase() === 'openai-codex'
    ? codexSupportedEfforts(model)
    : OPENAI_COMPAT_WIRE_EFFORTS
}

/** The stored effort word as the select shows it ('' = not set). YAML
 *  `reasoning_effort: false` / "disabled" mean Off (parse_reasoning_effort). */
export function normalizeEffort(raw) {
  if (raw === false) return 'none'
  if (raw && typeof raw === 'object') {
    if (raw.enabled === false) return 'none'
    return normalizeEffort(raw.effort)
  }
  const word = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!word) return DEFAULT
  if (word === 'false' || word === 'disabled') return 'none'
  return word
}

/** The stored speed word ('' = not set). Synonyms fold to the word
 *  config.set fast writes (fast_mode.SERVICE_TIER_WORDS / _FAST_WORDS). */
export function normalizeSpeed(raw) {
  const word = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!word) return DEFAULT
  if (['normal', 'default', 'standard', 'off', 'none'].includes(word)) return 'normal'
  if (['fast', 'priority', 'on'].includes(word)) return 'fast'
  if (word === 'ultra') return 'ultrafast'
  return word
}

/** `config.get {key: 'full'}` → the two values; everything else in the
 *  config is dropped here and never kept. */
export function settingsFromConfig(result) {
  const agent = result?.config?.agent
  const a = agent && typeof agent === 'object' ? agent : {}
  return { effort: normalizeEffort(a.reasoning_effort), speed: normalizeSpeed(a.service_tier) }
}

/** capabilities[model] for a provider row, or null when not known. */
export function modelCaps(providerRow, model) {
  const caps = providerRow?.capabilities
  if (!caps || !model) return null
  return caps[model] || null
}

const keepCurrent = (options, current, labels) => {
  if (!current || options.some(([id]) => id === current)) return options
  return [...options, [current, `${labels[current] || current} (current)`]]
}

/**
 * The Effort select for a model. `caps` undefined = the catalogue has not
 * arrived (only Default and the current value are offered, still enabled);
 * caps.reasoning === false = the model has no effort dial (disabled, hint).
 * A current value the model does not list stays visible as "(current)" so
 * opening and saving never changes it silently.
 */
export function effortChoices({ provider, model, caps, current = DEFAULT }) {
  if (caps === undefined) {
    return { supported: true, pending: true, options: keepCurrent([[DEFAULT, 'Default']], current, EFFORT_LABELS) }
  }
  if (caps && caps.reasoning === false) {
    return { supported: false, pending: false, options: keepCurrent([[DEFAULT, 'Default']], current, EFFORT_LABELS) }
  }
  let levels = routeSupportedEfforts(provider, model)
  if (caps && caps.can_disable_reasoning === false) levels = levels.filter(l => l !== 'none')
  const options = [[DEFAULT, 'Default'], ...levels.map(l => [l, EFFORT_LABELS[l] || l])]
  return { supported: true, pending: false, options: keepCurrent(options, current, EFFORT_LABELS) }
}

/** The Speed select: Standard plus Fast and Ultrafast where the model has
 *  them (capabilities.fast / .ultrafast); neither = disabled with the hint. */
export function speedChoices({ caps, current = DEFAULT }) {
  if (caps === undefined) {
    return { supported: true, pending: true, options: keepCurrent([[DEFAULT, 'Default']], current, SPEED_LABELS) }
  }
  const fast = Boolean(caps?.fast)
  const ultrafast = Boolean(caps?.ultrafast)
  if (!fast && !ultrafast) {
    return { supported: false, pending: false, options: keepCurrent([[DEFAULT, 'Default']], current, SPEED_LABELS) }
  }
  const options = [[DEFAULT, 'Default'], ['normal', SPEED_LABELS.normal]]
  if (fast) options.push(['fast', SPEED_LABELS.fast])
  if (ultrafast) options.push(['ultrafast', SPEED_LABELS.ultrafast])
  return { supported: true, pending: false, options: keepCurrent(options, current, SPEED_LABELS) }
}

/**
 * What one Save sends, in order: the model first (profiles.configure, or the
 * `config unset model` clear), then effort, then speed, because Hermes checks
 * a Fast pick against the profile's model. Only changed values are written;
 * Default on a value that was set is an unset; Default on an unset value is
 * nothing.
 */
export function sheetSavePlan(bot, before, next) {
  const steps = []
  const modelChanged = String(before?.provider || '') !== String(next.provider || '') || String(before?.model || '') !== String(next.model || '')
  if (modelChanged) steps.push({ field: 'model' })
  for (const [field, key, rpcKey] of [
    ['effort', EFFORT_KEY, 'reasoning'],
    ['speed', SPEED_KEY, 'fast']
  ]) {
    const was = String(before?.[field] ?? DEFAULT)
    const now = String(next[field] ?? DEFAULT)
    if (was === now) continue
    if (now === DEFAULT) {
      steps.push({ field, method: 'cli.exec', params: { argv: ['--profile', bot.name, 'config', 'unset', key] } })
    } else {
      // No session_id: config.set writes the profile's config.yaml (scope global).
      steps.push({ field, method: 'config.set', params: { key: rpcKey, value: now, profile: bot.name, scope: 'global' } })
    }
  }
  return steps
}

/** cli.exec / config.set answer → saved or not. `config unset` on a key that
 *  is already gone exits non-zero with "not set": the key is gone, so ok. */
export function stepSucceeded(step, result) {
  if (step.method === 'cli.exec') {
    if (result?.blocked === true) return false
    if (result?.code === 0) return true
    const text = `${result?.stdout || ''} ${result?.stderr || ''} ${result?.output || ''}`
    return /not set/i.test(text)
  }
  if (result?.error) return false
  return result != null
}

// ── the model catalogue (model.options), shared by every sheet ─────────────

export const CATALOGUE_STALE_MS = 120_000

/** One catalogue per connection (the gateway that answers model.options), so
 *  every bot on that machine and every sheet reuses it. */
export function catalogueKey(route) {
  return route ? `route:${route.connectionId}` : 'active'
}

/**
 * The app-session catalogue cache. `peek(key)` answers synchronously (the
 * sheet renders from it on first paint); `load(key, fetch)` shares one
 * request per key while it is in flight, returns the cached copy at once when
 * fresh, and when stale returns the cached copy too while one background
 * refresh replaces it. Each provider row is kept by slug, so
 * `provider(key, slug)` is one lookup.
 */
export function createCatalogue({ now = () => Date.now(), staleMs = CATALOGUE_STALE_MS } = {}) {
  const entries = new Map()
  const inflight = new Map()
  const listeners = new Set()
  const emit = key => listeners.forEach(fn => fn(key))
  const put = (key, value) => {
    const bySlug = new Map()
    for (const row of value?.providers || []) if (row && row.slug) bySlug.set(row.slug, row)
    entries.set(key, { at: now(), value, bySlug })
    emit(key)
  }
  const fetchInto = (key, fetch) => {
    if (inflight.has(key)) return inflight.get(key)
    let started
    try {
      started = Promise.resolve(fetch())
    } catch (error) {
      started = Promise.reject(error)
    }
    const run = started
      .then(value => {
        put(key, value)
        return value
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, run)
    return run
  }
  return {
    peek(key) {
      return entries.get(key)?.value ?? null
    },
    fresh(key) {
      const hit = entries.get(key)
      return Boolean(hit) && now() - hit.at < staleMs
    },
    provider(key, slug) {
      return entries.get(key)?.bySlug.get(slug) ?? null
    },
    prime(key, value) {
      put(key, value)
    },
    load(key, fetch) {
      const hit = entries.get(key)
      if (hit) {
        if (now() - hit.at >= staleMs) fetchInto(key, fetch).catch(() => undefined)
        return Promise.resolve(hit.value)
      }
      return fetchInto(key, fetch)
    },
    inflight(key) {
      return inflight.has(key)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    clear() {
      entries.clear()
      inflight.clear()
    }
  }
}
