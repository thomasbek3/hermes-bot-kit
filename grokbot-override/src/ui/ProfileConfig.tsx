// Profile config (P6) and the per-bot model picker (C21), in the override's
// look. Behaviour ports stock profile-config.tsx / model-picker.tsx /
// skills-hub.tsx (see core/profileConfig.js for the citations).

import * as React from 'react'

import { catalogueKey, createCatalogue, effortChoices, modelCaps, speedChoices, UNSUPPORTED_HINT } from '../core/modelSheet.js'
import { boundedFetch, mcpNeedsSetup, modelOptionsParams, providerMatches, providerModels, toggleEntry, usableProviders } from '../core/profileConfig.js'
import { resolveBotConnectionRoute } from '../core/routing.js'
import { Check, Field, Select } from './kit'
import { installSkill, loadProfileConfig, request, searchSkills } from './rosterActions'
import { host, sdk } from './sdk'

/** The model catalogue (model.options) for the app session: one per
 *  connection, shared by every bot on it and every sheet that opens
 *  (core/modelSheet.js createCatalogue). A fresh copy is used as is; a stale
 *  one (over 2 min, stock's model-picker staleTime) is shown at once and
 *  refreshed in the background. */
export const modelCatalogue = createCatalogue()

function modelKey(bot: any) {
  let route = null
  try {
    route = bot ? resolveBotConnectionRoute(bot).route : null
  } catch {
    route = null
  }
  return catalogueKey(route)
}

/** Seed the model.options cache (a list read elsewhere; the smoke test). */
export function primeModelOptions(bot: any, value: any) {
  modelCatalogue.prime(modelKey(bot), value)
}

/** model.options on the bot's own route through the shared catalogue. The
 *  sheet passes `foreground` (a user gesture). Never blocks a render: the
 *  state says `loading` until the first copy for this connection arrives. */
export function useModelOptions(bot: any, { foreground = false }: { foreground?: boolean } = {}) {
  const key = modelKey(bot)
  const read = () => {
    const data = modelCatalogue.peek(key)
    return data ? { loading: false, error: null, data } : null
  }
  const [state, setState] = React.useState<{ loading: boolean; error: null | string; data: any }>(() => read() || { loading: true, error: null, data: null })
  React.useEffect(() => {
    let live = true
    const now = read()
    if (now) setState(now)
    const off = modelCatalogue.subscribe((changed: string) => {
      if (live && changed === key) setState(read() || { loading: true, error: null, data: null })
    })
    modelCatalogue
      .load(key, () => boundedFetch(request(bot, 'model.options', modelOptionsParams(), foreground ? { spawnPriority: 'foreground' } : {})))
      .then((data: any) => live && setState({ loading: false, error: null, data }))
      .catch((error: any) => live && !modelCatalogue.peek(key) && setState({ loading: false, error: String(error?.message || error), data: null }))
    return () => {
      live = false
      off()
    }
  }, [key])
  return state
}

const NONE = '__default__'
const CUSTOM = '__custom__'

/** Provider and Model. While the catalogue is still on its way the two
 *  selects already show the bot's current values (only those, plus Default),
 *  so the sheet is usable at once; the lists fill when it arrives. Extra
 *  fields (`children`) go in the same two-column grid. */
export function ModelPicker({
  bot,
  value,
  onChange,
  foreground,
  disabled,
  children
}: {
  bot: any
  value: { provider: string; model: string }
  onChange: (patch: { provider?: string; model?: string }) => void
  foreground?: boolean
  disabled?: boolean
  children?: React.ReactNode
}) {
  const { loading, error, data } = useModelOptions(bot, { foreground })
  const [manual, setManual] = React.useState<boolean | null>(null)
  const providers = usableProviders(data)
  const known = !value.provider || providers.some((p: any) => providerMatches(p, value.provider))
  const freeText = loading ? false : (manual ?? !known)
  const grid = children ? 'gbo-row2 gbo-model-grid' : 'gbo-row2'
  if (!loading && (error || !providers.length || freeText)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className={grid}>
          <Field label="Provider">
            <input className="gbo-input" value={value.provider} disabled={disabled} placeholder="nous / openrouter / …" onChange={e => onChange({ provider: e.target.value })} />
          </Field>
          <Field label="Model">
            <input className="gbo-input" value={value.model} disabled={disabled} placeholder="provider/model-name" onChange={e => onChange({ model: e.target.value })} />
          </Field>
          {children}
        </div>
        {providers.length ? (
          <button type="button" className="gbo-link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setManual(false)}>
            Back to the lists
          </button>
        ) : error ? (
          <span className="gbo-field-hint">The model list did not load ({error}); type them instead.</span>
        ) : null}
      </div>
    )
  }
  const active = providers.find((p: any) => providerMatches(p, value.provider)) || null
  const models = active ? providerModels(active) : []
  const providerOptions: Array<[string, string]> = loading
    ? [[NONE, 'Default (the profile’s own)'], ...(value.provider ? [[value.provider, value.provider] as [string, string]] : [])]
    : [[NONE, 'Default (the profile’s own)'], ...providers.map((p: any) => [p.slug, p.name || p.slug] as [string, string]), [CUSTOM, 'Custom…']]
  const modelOptions: Array<[string, string]> = (models.includes(value.model) || !value.model ? models : [value.model, ...models]).map((m: string) => [m, m] as [string, string])
  return (
    <div className={grid} aria-busy={loading || undefined}>
      <Field label="Provider">
        <Select
          label="Provider"
          value={loading ? value.provider || NONE : active ? active.slug : NONE}
          disabled={disabled}
          onChange={v => {
            if (v === NONE) onChange({ provider: '', model: '' })
            else if (v === CUSTOM) setManual(true)
            else if (!loading) {
              const prov = providers.find((p: any) => p.slug === v)
              onChange({ provider: v, model: providerModels(prov)[0] || '' })
            }
          }}
          options={providerOptions}
        />
      </Field>
      <Field label="Model">
        <Select label="Model" value={value.model} disabled={disabled || (!loading && !active)} onChange={v => onChange({ model: v })} options={modelOptions} />
      </Field>
      {children}
    </div>
  )
}

/** Effort and Speed for the model the sheet has picked, from the same
 *  catalogue row (capabilities[model]); before it arrives they show the
 *  bot's current values. A model without the dial gets the select disabled
 *  with a short hint, never hidden, so the grid keeps its shape. */
export function ModelExtraFields({
  bot,
  provider,
  model,
  effort,
  speed,
  disabled,
  onChange
}: {
  bot: any
  provider: string
  model: string
  effort: string
  speed: string
  disabled?: boolean
  onChange: (patch: { effort?: string; speed?: string }) => void
}) {
  // Mounted inside ModelPicker's grid, so its effect runs first: it starts
  // the (shared) catalogue read, foreground like the sheet's other reads.
  const { loading, data } = useModelOptions(bot, { foreground: true })
  const providers = usableProviders(data)
  const row = providers.find((p: any) => providerMatches(p, provider)) || null
  // Unknown until the catalogue arrives; afterwards a model it does not
  // describe (Default, custom) gets the unrestricted Hermes defaults.
  const caps = loading ? undefined : model ? modelCaps(row, model) : null
  const e = effortChoices({ provider: row?.slug || provider, model, caps, current: effort })
  const s = speedChoices({ caps, current: speed })
  const hint = (choice: any) => (choice.supported ? (choice.pending ? 'Loading options…' : '\u00a0') : UNSUPPORTED_HINT)
  return (
    <>
      <Field label="Effort" hint={hint(e)}>
        <Select label="Effort" value={effort} disabled={disabled || !e.supported} onChange={v => onChange({ effort: v })} options={e.options} />
      </Field>
      <Field label="Speed" hint={hint(s)}>
        <Select label="Speed" value={speed} disabled={disabled || !s.supported} onChange={v => onChange({ speed: v })} options={s.options} />
      </Field>
    </>
  )
}

function SkillsHub({ bot, onInstalled }: { bot: any; onInstalled: (name: string) => void }) {
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<null | any[]>(null)
  const [busy, setBusy] = React.useState<null | string>(null)
  const [error, setError] = React.useState<null | string>(null)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={async event => {
          event.preventDefault()
          if (!query.trim() || busy) return
          setBusy('search')
          setError(null)
          try {
            setResults(await searchSkills(query))
          } catch (err: any) {
            setResults([])
            setError(String(err?.message || err))
          } finally {
            setBusy(null)
          }
        }}
      >
        <input className="gbo-input" placeholder="Find skills in the hub" value={query} onChange={e => setQuery(e.target.value)} />
        <button type="submit" className="gbo-btn is-small" disabled={!query.trim() || Boolean(busy)}>
          {busy === 'search' ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error ? <div className="gbo-form-error">{error}</div> : null}
      {results && !results.length ? <span className="gbo-field-hint">No skills found.</span> : null}
      {(results || []).slice(0, 8).map((r: any) => (
        <div key={r.name} className="gbo-check" style={{ cursor: 'default' }}>
          <span className="gbo-check-text" title={r.description || r.name}>
            {r.name}
          </span>
          <button
            type="button"
            className="gbo-btn is-small"
            disabled={Boolean(busy)}
            onClick={async () => {
              setBusy(r.name)
              setError(null)
              try {
                await installSkill(bot, r.name)
                onInstalled(r.name)
              } catch (err: any) {
                setError(String(err?.message || err))
              } finally {
                setBusy(null)
              }
            }}
          >
            {busy === r.name ? 'Installing…' : 'Install'}
          </button>
        </div>
      ))}
    </div>
  )
}

/** routing.ts:187 botBackendProfileScope */
function backendScope(bot: any) {
  const route = resolveBotConnectionRoute(bot).route
  return route ? { connectionId: route.connectionId, profile: route.targetProfile || route.profile } : bot.name
}

/** Credentials for a catalog MCP server (stock mcp-setup.tsx): add the preset,
 *  set each required key, test; or OAuth through host.completeMcpOAuth. The
 *  calls ride the bot's own route (stock sends them to the active gateway,
 *  its own TODO says that is wrong for source-scoped bots).
 *
 *  Key values (review override-v2-r1 #5): read from the visible fields once,
 *  on submit, and cleared from the fields and from memory before the first
 *  request goes out; a failure or leaving the panel keeps nothing, so a retry
 *  starts from empty fields and can never send an earlier value nobody sees.
 *  Errors shown are scrubbed of every submitted value. A sign-in still
 *  running when the panel closes is cancelled (stock oauthEpoch).
 *
 *  Review override-v2-r2 M3: the values not yet sent live in `pending`, which
 *  the panel owns; closing it (or a newer attempt) wipes them, and the epoch is
 *  checked before every request, so no key write or server test starts after
 *  the panel is gone. A request already on the wire cannot be unsent. */
function McpSetup({ bot, entry, onDone }: { bot: any; entry: any; onDone: () => void }) {
  const [phase, setPhase] = React.useState<'idle' | 'keys' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = React.useState('')
  const fields = React.useRef<Record<string, HTMLInputElement | null>>({})
  const epoch = React.useRef(0)
  const pending = React.useRef<null | { entered: Array<[string, string]>; secrets: string[] }>(null)
  const wipePending = () => {
    const held = pending.current
    pending.current = null
    if (!held) return
    for (let i = 0; i < held.entered.length; i += 1) held.entered[i] = [held.entered[i][0], '']
    held.entered.length = 0
    held.secrets.length = 0
  }
  const isOAuth = String(entry.auth || '').toLowerCase() === 'oauth'
  const requires: string[] = entry.requires || []
  const clearFields = () => {
    for (const input of Object.values(fields.current)) if (input) input.value = ''
  }
  React.useEffect(
    () => () => {
      epoch.current += 1
      clearFields()
      wipePending()
    },
    []
  )
  const fail = (text: string) => {
    setPhase('error')
    setMessage(text)
  }
  const ensureAdded = async () => {
    if (entry.fromCatalog && !entry.installed) await request(bot, 'mcp.servers.add', { profile: bot.name, name: entry.name, preset: entry.name })
  }
  const begin = async () => {
    wipePending()
    const mine = ++epoch.current
    const current = () => epoch.current === mine
    setPhase('busy')
    setMessage('')
    try {
      await ensureAdded()
    } catch (err: any) {
      if (current()) fail(String(err?.message || err) || 'Could not add the server')
      return
    }
    if (!current()) return
    if (!isOAuth) return setPhase('keys')
    if (typeof host?.completeMcpOAuth !== 'function') return fail('This Hermes Desktop cannot run the sign-in; update it.')
    const route = resolveBotConnectionRoute(bot).route
    try {
      setMessage('Finish signing in in your browser…')
      await host.completeMcpOAuth({
        serverName: entry.name,
        profile: { connectionId: route?.connectionId ?? host?.state?.connectionId?.get?.() ?? null, profile: route?.targetProfile || bot.name },
        catalogPreset: entry.fromCatalog && !entry.installed ? entry.name : undefined,
        cancelled: () => !current()
      })
      if (!current()) return
      setPhase('done')
      onDone()
    } catch (err: any) {
      if (current()) fail(String(err?.message || err))
    }
  }
  const submitKeys = async () => {
    wipePending()
    const mine = ++epoch.current
    const current = () => epoch.current === mine
    // Read the visible fields once, then clear them before anything is sent.
    const entered: Array<[string, string]> = requires.map(k => [k, String(fields.current[k]?.value || '').trim()])
    clearFields()
    const secrets = entered.map(([, value]) => value).filter(Boolean)
    const held = { entered, secrets }
    pending.current = held
    const scrub = (text: string) => secrets.reduce((out, value) => out.split(value).join('••••'), text)
    setPhase('busy')
    try {
      for (let i = 0; i < entered.length; i += 1) {
        if (!current()) return
        const [k, value] = entered[i]
        entered[i] = [k, '']
        if (value) await request(bot, 'mcp.servers.set_api_key', { profile: bot.name, name: entry.name, env_var: k, value })
      }
      if (!current()) return
      const test: any = await request(bot, 'mcp.servers.test', { profile: bot.name, name: entry.name })
      if (!current()) return
      if (test && (test.ok || test.result?.ok)) {
        setPhase('done')
        onDone()
      } else fail(scrub(String(test?.error || test?.result?.error || 'The server did not pass its test')))
    } catch (err: any) {
      if (current()) fail(`${scrub(String(err?.message || err))} Enter the keys again to retry.`)
    } finally {
      if (pending.current === held) pending.current = null
      entered.length = 0
      secrets.length = 0
    }
  }
  if (phase === 'done') return <span className="gbo-field-hint">Configured</span>
  if (phase === 'keys') {
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
        {requires.map(k => (
          <input
            key={k}
            ref={el => {
              fields.current[k] = el
            }}
            className="gbo-input"
            type="password"
            autoComplete="off"
            placeholder={k}
            defaultValue=""
          />
        ))}
        <button type="button" className="gbo-btn is-small" onClick={() => void submitKeys()}>
          Save and test
        </button>
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <button type="button" className="gbo-btn is-small" disabled={phase === 'busy'} onClick={() => void begin()}>
        {phase === 'busy' ? 'Working…' : isOAuth ? 'Sign in' : 'Set up'}
      </button>
      {message ? <span className={phase === 'error' ? 'gbo-card-error' : 'gbo-field-hint'}>{message}</span> : null}
    </span>
  )
}

/** The advanced editor (skills, toolsets, MCP, model, SOUL). `state` is the
 *  staged edit (core/profileConfig.js emptyAdvancedState); only dirty
 *  sections are written on save. */
export function AdvancedConfig({ bot, state, setState }: { bot: any; state: any; setState: (fn: (s: any) => any) => void }) {
  const [unsupported, setUnsupported] = React.useState<null | string>(null)
  const [filter, setFilter] = React.useState('')
  const [toolsetOpen, setToolsetOpen] = React.useState('')
  const ToolsetPanel = (sdk as any).ToolsetConfigPanel
  const loadKey = `${bot?.connectionId || ''}::${bot?.name}`
  React.useEffect(() => {
    if (state.loaded) return
    let live = true
    loadProfileConfig(bot)
      .then((next: any) => live && setState(() => next))
      .catch((error: any) => live && setUnsupported(String(error?.message || error)))
    return () => {
      live = false
    }
  }, [loadKey])
  if (unsupported) return <div className="gbo-form-note">This bot’s Hermes cannot describe its profile here ({unsupported}). Use `hermes -p {bot.name} config` on its machine.</div>
  if (!state.loaded) return <div className="gbo-form-note">Loading the bot’s config…</div>
  const skills = filter.trim() ? state.skills.filter((s: any) => s.name.toLowerCase().includes(filter.trim().toLowerCase())) : state.skills
  const on = (list: any[]) => list.filter(x => x.enabled).length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ModelPicker bot={bot} value={{ provider: state.provider, model: state.model }} onChange={patch => setState(s => ({ ...s, dirtyModel: true, ...patch }))} />
      <Field label={`Skills · ${on(state.skills)} of ${state.skills.length} on`}>
        <input className="gbo-input" placeholder="Filter skills" value={filter} onChange={e => setFilter(e.target.value)} />
        <div className="gbo-check-list">
          {skills.map((s: any) => (
            <Check key={s.name} title={s.description || s.name} checked={Boolean(s.enabled)} onChange={v => setState(st => toggleEntry(st, 'skills', s.name, v))}>
              {s.name}
            </Check>
          ))}
        </div>
      </Field>
      <SkillsHub bot={bot} onInstalled={name => setState(s => (s.skills.some((x: any) => x.name === name) ? s : { ...s, skills: [...s.skills, { name, enabled: true }] }))} />
      <Field label={`Toolsets · ${on(state.toolsets)} of ${state.toolsets.length} on`}>
        <div className="gbo-check-list">
          {state.toolsets.map((t: any) => (
            <Check key={t.name} title={t.description || t.name} checked={Boolean(t.enabled)} meta={t.tool_count ? String(t.tool_count) : undefined} onChange={v => setState(st => toggleEntry(st, 'toolsets', t.name, v))}>
              {t.name}
            </Check>
          ))}
        </div>
      </Field>
      {ToolsetPanel && state.toolsets.length ? (
        // profile-config.tsx:404: the SDK's own per-toolset config (keys,
        // model, post-setup) scoped to this bot's backend, when exported.
        <details className="gbo-section-card">
          <summary className="gbo-field-hint" style={{ cursor: 'pointer' }}>
            Configure a toolset (keys and options)
          </summary>
          <Select label="Toolset" value={toolsetOpen || state.toolsets[0].name} onChange={setToolsetOpen} options={state.toolsets.map((t: any) => [t.name, t.name] as [string, string])} />
          <ToolsetPanel profile={backendScope(bot)} toolset={toolsetOpen || state.toolsets[0].name} />
        </details>
      ) : null}
      <Field label="MCP servers">
        {state.mcp.length ? (
          <div className="gbo-check-list is-one">
            {state.mcp.map((m: any) => {
              const setup = mcpNeedsSetup(m)
              return (
                <div key={m.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Check
                    title={m.description || m.name}
                    checked={Boolean(m.enabled)}
                    disabled={setup}
                    meta={setup ? `needs ${(m.requires || []).join(', ') || 'sign-in'}` : m.fromCatalog ? (m.installed ? 'catalog · installed' : 'catalog') : undefined}
                    onChange={v => setState(st => toggleEntry(st, 'mcp', m.name, v))}
                  >
                    {m.name}
                  </Check>
                  {setup ? (
                    <McpSetup
                      bot={bot}
                      entry={m}
                      onDone={() => setState(st => ({ ...toggleEntry(st, 'mcp', m.name, true), mcp: st.mcp.map((x: any) => (x.name === m.name ? { ...x, installed: true, enabled: true } : x)) }))}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <span className="gbo-field-hint">No MCP servers.</span>
        )}
      </Field>
      <Field label="SOUL (who the bot is)" hint="The agent-messaging section is kept or added on save, as Bot Mode does.">
        <textarea className="gbo-textarea is-mono" value={state.soul} onChange={e => setState(s => ({ ...s, dirtySoul: true, soul: e.target.value }))} />
      </Field>
    </div>
  )
}
