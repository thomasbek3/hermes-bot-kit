// The per-bot model sheet: opens at once with the bot's provider, model,
// effort and speed; the model catalogue (model.options) loads behind it, once
// per connection for the app session, and fills the lists when it arrives.
// Effort and Speed only offer what Hermes and the picked model support
// (route_supported_efforts, capabilities.reasoning / can_disable_reasoning /
// fast / ultrafast); one Save writes all four to the bot's own profile, and
// Default removes the key. Core rules are unit-tested; the sheet itself runs
// in jsdom from the real modules (dev bundle, fake SDK).

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  CODEX_ASTRA_EFFORTS,
  CODEX_GPT56_EFFORTS,
  CODEX_LEGACY_EFFORTS,
  OPENAI_COMPAT_WIRE_EFFORTS,
  catalogueKey,
  createCatalogue,
  effortChoices,
  normalizeEffort,
  normalizeSpeed,
  routeSupportedEfforts,
  settingsFromConfig,
  sheetSavePlan,
  speedChoices,
  stepSucceeded
} from '../src/core/modelSheet.js'
import { createBotRequester } from '../src/core/routing.js'

const ready =
  existsSync(new URL('../node_modules/esbuild', import.meta.url)) &&
  existsSync(new URL('../node_modules/react-dom', import.meta.url)) &&
  existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await flush()
}
/** React 19 commits a createRoot render on its scheduler, a few ticks later. */
const painted = async (selector = 'select[aria-label="Speed"]') => {
  for (let i = 0; i < 50 && !document.querySelector(selector); i += 1) await flush()
  // ...and its effects (the reads) run just after.
  await settle()
}
const ids = options => options.map(([id]) => id)

// ── core: effort and speed per model ─────────────────────────────────────

test('effort levels are Hermes\'s route_supported_efforts: Codex per model generation, the OpenAI-compatible wire otherwise; never ultra', () => {
  assert.deepEqual(routeSupportedEfforts('openrouter', 'some/model'), OPENAI_COMPAT_WIRE_EFFORTS)
  assert.deepEqual(routeSupportedEfforts('openai-codex', 'gpt-5.5'), CODEX_LEGACY_EFFORTS)
  assert.deepEqual(routeSupportedEfforts('openai-codex', 'gpt-5.6'), CODEX_GPT56_EFFORTS)
  assert.deepEqual(routeSupportedEfforts('openai-codex', 'gpt-6-sol'), CODEX_GPT56_EFFORTS)
  assert.deepEqual(routeSupportedEfforts('openai-codex', 'gpt-6.1-sol'), CODEX_ASTRA_EFFORTS, 'no Off on 6.1 Sol')
  assert.deepEqual(routeSupportedEfforts('openai-codex', 'openai/gpt-6-astra'), CODEX_ASTRA_EFFORTS)
  for (const list of [OPENAI_COMPAT_WIRE_EFFORTS, CODEX_GPT56_EFFORTS, CODEX_LEGACY_EFFORTS, CODEX_ASTRA_EFFORTS]) assert.ok(!list.includes('ultra'))
})

test('effort choices: Default first, plain labels; unsupported model → disabled with the hint; no Off when reasoning cannot be disabled', () => {
  const open = effortChoices({ provider: 'openrouter', model: 'm', caps: { reasoning: true, fast: false } })
  assert.equal(open.supported, true)
  assert.deepEqual(open.options[0], ['', 'Default'])
  assert.deepEqual(open.options.slice(1).map(([, label]) => label), ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'])
  const mandatory = effortChoices({ provider: 'openrouter', model: 'm', caps: { reasoning: true, can_disable_reasoning: false } })
  assert.ok(!ids(mandatory.options).includes('none'))
  const none = effortChoices({ provider: 'openrouter', model: 'm', caps: { reasoning: false, fast: false } })
  assert.equal(none.supported, false)
  assert.deepEqual(ids(none.options), [''])
  // Before the catalogue: Default and the bot's current value, still enabled.
  const pending = effortChoices({ provider: 'openrouter', model: 'm', caps: undefined, current: 'high' })
  assert.deepEqual(pending, { supported: true, pending: true, options: [['', 'Default'], ['high', 'High (current)']] })
  // A stored level the model does not list stays visible, never silently changed.
  const kept = effortChoices({ provider: 'openai-codex', model: 'gpt-6.1-sol', caps: { reasoning: true }, current: 'minimal' })
  assert.deepEqual(kept.options.at(-1), ['minimal', 'Minimal (current)'])
})

test('speed choices: Standard plus Fast / Ultrafast only where the model has them; neither → disabled with the hint', () => {
  assert.deepEqual(speedChoices({ caps: { fast: true, reasoning: true } }).options, [['', 'Default'], ['normal', 'Standard'], ['fast', 'Fast']])
  assert.deepEqual(ids(speedChoices({ caps: { fast: true, ultrafast: true, reasoning: true } }).options), ['', 'normal', 'fast', 'ultrafast'])
  const slow = speedChoices({ caps: { fast: false, reasoning: true }, current: 'fast' })
  assert.equal(slow.supported, false)
  assert.deepEqual(slow.options, [['', 'Default'], ['fast', 'Fast (current)']])
  assert.equal(speedChoices({ caps: null }).supported, false, 'a model the catalogue does not describe')
  assert.equal(speedChoices({ caps: undefined }).pending, true)
  assert.deepEqual(speedChoices({ caps: { fast: true }, current: 'auto' }).options.at(-1), ['auto', 'Fast for the first minute of a turn (current)'])
})

test('stored values: config.get full\'s agent.reasoning_effort / agent.service_tier, missing = Default, Hermes\'s synonyms folded', () => {
  assert.deepEqual(settingsFromConfig({ config: { agent: { reasoning_effort: 'High', service_tier: 'priority' }, secret_like: 'x' } }), { effort: 'high', speed: 'fast' })
  assert.deepEqual(settingsFromConfig({ config: {} }), { effort: '', speed: '' })
  assert.deepEqual(settingsFromConfig(null), { effort: '', speed: '' })
  assert.equal(normalizeEffort(false), 'none')
  assert.equal(normalizeEffort('disabled'), 'none')
  assert.equal(normalizeEffort({ enabled: true, effort: 'low' }), 'low')
  assert.equal(normalizeSpeed('standard'), 'normal')
  assert.equal(normalizeSpeed('ultra'), 'ultrafast')
  assert.equal(normalizeSpeed('cold'), 'cold')
})

// ── core: save plan ──────────────────────────────────────────────────────

test('save plan: model first, then effort and speed; config.set for a value, config unset for Default; unchanged values send nothing', () => {
  const bot = { name: 'scout' }
  const before = { provider: 'example', model: 'demo-small', effort: 'high', speed: '' }
  assert.deepEqual(sheetSavePlan(bot, before, { ...before }), [])
  const plan = sheetSavePlan(bot, before, { provider: 'example', model: 'demo-large', effort: '', speed: 'fast' })
  assert.deepEqual(plan, [
    { field: 'model' },
    { field: 'effort', method: 'cli.exec', params: { argv: ['--profile', 'scout', 'config', 'unset', 'agent.reasoning_effort'] } },
    { field: 'speed', method: 'config.set', params: { key: 'fast', value: 'fast', profile: 'scout', scope: 'global' } }
  ])
  const effortOnly = sheetSavePlan(bot, { ...before, effort: '' }, { ...before, effort: 'xhigh' })
  assert.deepEqual(effortOnly, [{ field: 'effort', method: 'config.set', params: { key: 'reasoning', value: 'xhigh', profile: 'scout', scope: 'global' } }])
  const speedDefault = sheetSavePlan(bot, { ...before, speed: 'fast' }, { ...before, speed: '' })
  assert.deepEqual(speedDefault[0].params.argv, ['--profile', 'scout', 'config', 'unset', 'agent.service_tier'])
  // An unset that finds the key already gone still means "removed".
  assert.equal(stepSucceeded(speedDefault[0], { code: 0, blocked: false, output: '✓ Unset agent.service_tier' }), true)
  assert.equal(stepSucceeded(speedDefault[0], { code: 1, blocked: false, output: 'Config key not set: agent.service_tier' }), true)
  assert.equal(stepSucceeded(speedDefault[0], { code: 1, blocked: true, output: 'blocked' }), false)
  assert.equal(stepSucceeded(effortOnly[0], { key: 'reasoning', value: 'xhigh' }), true)
})

// ── core: catalogue cache ────────────────────────────────────────────────

test('catalogue: one request per connection however many bots and sheets ask; reused across sheets; per-provider lookup; stale → shown at once and refreshed once', async () => {
  let clock = 0
  const cat = createCatalogue({ now: () => clock, staleMs: 1000 })
  let fetches = 0
  let release
  const fetch = () => {
    fetches += 1
    return new Promise(resolve => (release = () => resolve({ providers: [{ slug: 'example', models: ['a', 'b'] }, { slug: 'other', models: ['c'] }] })))
  }
  const key = catalogueKey({ connectionId: 'mini' })
  assert.equal(key, 'route:mini')
  assert.equal(catalogueKey(null), 'active')
  assert.equal(cat.peek(key), null)
  // Two bots on the same machine open their sheets while the first read is out.
  const one = cat.load(key, fetch)
  const two = cat.load(key, fetch)
  assert.equal(fetches, 1, 'in-flight read shared')
  release()
  assert.equal(await one, await two)
  assert.deepEqual(cat.provider(key, 'other').models, ['c'])
  // A later sheet answers synchronously from the cache, no request.
  assert.ok(cat.peek(key))
  await cat.load(key, fetch)
  assert.equal(fetches, 1)
  // Stale: the cached copy comes back at once, one background refresh runs.
  clock = 5000
  const stale = await cat.load(key, fetch)
  assert.deepEqual(stale.providers[0].models, ['a', 'b'])
  assert.equal(fetches, 2)
  cat.load(key, fetch)
  assert.equal(fetches, 2, 'one refresh at a time')
  release = release || (() => undefined)
})

test('a failed catalogue read is not cached; the next sheet tries again', async () => {
  const cat = createCatalogue()
  await assert.rejects(cat.load('active', () => Promise.reject(new Error('socket closed'))), /socket closed/)
  assert.equal(cat.inflight('active'), false)
  assert.deepEqual(await cat.load('active', async () => ({ providers: [] })), { providers: [] })
})

// ── routing: user-action priority ────────────────────────────────────────

test('profile writes dial foreground (stock PROFILE_WRITE_METHODS); other reads keep the caller\'s choice', async () => {
  const seen = []
  const host = { requestProfile: async (route, method, params, timeoutMs, opts) => (seen.push({ method, opts }), {}) }
  const request = createBotRequester(host)
  const bot = { name: 'scout', sourceScoped: true, route: { connectionId: 'mini', mode: 'remote', profile: 'scout', targetProfile: 'scout' } }
  await request(bot, 'profiles.configure', { name: 'scout' })
  await request(bot, 'profiles.describe', { name: 'scout' })
  await request(bot, 'model.options', {}, { spawnPriority: 'foreground' })
  assert.deepEqual(seen.map(s => [s.method, s.opts?.spawnPriority]), [
    ['profiles.configure', 'foreground'],
    ['profiles.describe', undefined],
    ['model.options', 'foreground']
  ])
})

// ── the sheet (jsdom, real modules) ──────────────────────────────────────

const remote = (name, connectionId = 'mini') => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId,
  connectionKind: 'ssh',
  route: { connectionId, mode: 'remote', profile: name, targetProfile: name },
  canonical_session: { id: `${name}-root` }
})

const CATALOGUE = {
  providers: [
    {
      slug: 'example',
      name: 'Example',
      authenticated: true,
      models: ['demo-large', 'demo-small', 'demo-plain'],
      capabilities: {
        'demo-large': { reasoning: true, fast: true, ultrafast: false },
        'demo-small': { reasoning: true, can_disable_reasoning: false, fast: false },
        'demo-plain': { reasoning: false, fast: false }
      }
    },
    { slug: 'openai-codex', name: 'OpenAI Codex', authenticated: true, models: ['gpt-6.1-sol'], capabilities: { 'gpt-6.1-sol': { reasoning: true, fast: true, ultrafast: true } } }
  ]
}

let env = null
async function setup(t) {
  if (env) return env
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
    set(key, key === 'getComputedStyle' ? w.getComputedStyle.bind(w) : w[key])
  }
  set('IS_REACT_ACT_ENVIRONMENT', false)
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  const m = await import(pathToFileURL(file).href)
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  m.appApi.start({ storage: { get: (k, f) => (k === 'enabled' ? false : f), set: () => undefined }, onEvent: () => () => undefined, setTimeout: () => () => undefined })
  t.after(() => {
    rmSync(dirname(file), { recursive: true, force: true })
    dom.window.close()
  })
  env = { m, React, createRoot, host: m.fakeSdk.host }
  return env
}

/** A host whose model.options waits until the test releases it. */
function wire(e) {
  const calls = []
  const handlers = {}
  const pending = []
  const answer = async (method, params, route, opts) => {
    calls.push({ method, params, route, opts })
    if (method === 'model.options') return new Promise(resolve => pending.push(() => resolve(handlers['model.options'] ? handlers['model.options']() : CATALOGUE)))
    const h = handlers[method]
    return h ? h(params, route) : {}
  }
  e.host.request = (method, params, timeoutMs, opts) => answer(method, params, null, opts)
  e.host.requestProfile = (route, method, params, timeoutMs, opts) => answer(method, params, route, opts)
  e.m.rosterStoresApi.roster2.models.set({})
  e.m.rosterStoresApi.roster2.modelSettings.set({})
  e.m.modelCatalogue.clear()
  return { calls, handlers, releaseCatalogue: () => pending.splice(0).forEach(fn => fn()) }
}

function mount({ m, React, createRoot }, bot) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let closed = 0
  root.render(React.createElement(m.ModelDialog, { bot, onClose: () => (closed += 1) }))
  const select = label => document.querySelector(`select[aria-label="${label}"]`)
  const field = label => select(label)?.closest('label')
  return {
    select,
    hint: label => field(label)?.querySelector('.gbo-field-hint')?.textContent,
    options: label => [...(select(label)?.options || [])].map(o => o.value),
    choose: (label, value) => {
      const el = select(label)
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new window.Event('change', { bubbles: true }))
    },
    save: () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save' || b.textContent === 'Saving…'),
    closed: () => closed,
    unmount: () => (root.unmount(), container.remove())
  }
}

test('(a) the sheet draws at once with the bot\'s provider, model, effort and speed while the catalogue is still loading', { skip }, async t => {
  const e = await setup(t)
  const { calls, releaseCatalogue } = wire(e)
  const bot = remote('scout')
  // The panel's Model row already read these (profiles.describe, config.get).
  e.m.rosterApi.primeBotModel(bot, { provider: 'example', model: 'demo-large' })
  e.m.rosterApi.primeBotModelSettings(bot, { effort: 'high', speed: 'fast' })
  const started = performance.now()
  const sheet = mount(e, bot)
  await painted()
  const drawnMs = performance.now() - started
  assert.ok(sheet.select('Provider') && sheet.select('Model') && sheet.select('Effort') && sheet.select('Speed'), 'all four fields')
  assert.equal(sheet.select('Provider').value, 'example')
  assert.equal(sheet.select('Model').value, 'demo-large')
  assert.equal(sheet.select('Effort').value, 'high')
  assert.equal(sheet.select('Speed').value, 'fast')
  assert.ok(!document.body.textContent.includes('Loading models'), 'no blocking loader')
  assert.ok(!document.body.textContent.includes('Loading the bot’s model'))
  assert.equal(sheet.hint('Effort'), 'Loading options…')
  // One 2x2 grid: Provider | Model, Effort | Speed.
  const grid = sheet.select('Provider').closest('.gbo-row2')
  assert.ok(grid.classList.contains('gbo-model-grid'))
  assert.deepEqual([...grid.querySelectorAll(':scope > label > span:first-child')].map(s => s.textContent), ['Provider', 'Model', 'Effort', 'Speed'])
  assert.equal(sheet.select('Effort').className, sheet.select('Provider').className, 'the same select component')
  // The catalogue was asked for, foreground, on the bot's own route, and is still out.
  const reads = calls.filter(c => c.method === 'model.options')
  assert.equal(reads.length, 1)
  assert.equal(reads[0].route?.connectionId, 'mini')
  assert.equal(reads[0].opts?.spawnPriority, 'foreground')
  // It arrives: the lists fill in place.
  releaseCatalogue()
  await settle()
  assert.deepEqual(sheet.options('Provider'), ['__default__', 'example', 'openai-codex', '__custom__'])
  assert.deepEqual(sheet.options('Model'), ['demo-large', 'demo-small', 'demo-plain'])
  assert.deepEqual(sheet.options('Speed'), ['', 'normal', 'fast'])
  assert.equal(sheet.select('Effort').value, 'high', 'values kept')
  assert.equal(sheet.save().disabled, true, 'nothing changed yet')
  t.diagnostic(`fields drawn after ${drawnMs.toFixed(1)} ms, before the catalogue answered`)
  sheet.unmount()
})

test('(a) with nothing read yet the fields still draw at once (disabled) and fill when profiles.describe answers', { skip }, async t => {
  const e = await setup(t)
  const { handlers, releaseCatalogue } = wire(e)
  let answerDescribe
  handlers['profiles.describe'] = () => new Promise(resolve => (answerDescribe = () => resolve({ model: { provider: 'example', default: 'demo-small' } })))
  handlers['config.get'] = () => ({ config: { agent: { reasoning_effort: 'low' } } })
  const bot = remote('cold')
  const sheet = mount(e, bot)
  await painted()
  assert.ok(sheet.select('Provider').disabled && sheet.select('Model').disabled, 'drawn, waiting for the bot\'s model')
  answerDescribe()
  await settle()
  assert.equal(sheet.select('Model').value, 'demo-small')
  assert.equal(sheet.select('Effort').value, 'low')
  assert.equal(sheet.select('Speed').value, '')
  releaseCatalogue()
  await settle()
  sheet.unmount()
})

test('(b) a second sheet (another bot on the same machine) reuses the catalogue: no second model.options, lists ready on first paint', { skip }, async t => {
  const e = await setup(t)
  const { calls, releaseCatalogue } = wire(e)
  const first = remote('scout')
  e.m.rosterApi.primeBotModel(first, { provider: 'example', model: 'demo-large' })
  e.m.rosterApi.primeBotModelSettings(first, { effort: '', speed: '' })
  const a = mount(e, first)
  await painted()
  releaseCatalogue()
  await settle()
  a.unmount()
  const second = remote('helper')
  e.m.rosterApi.primeBotModel(second, { provider: 'openai-codex', model: 'gpt-6.1-sol' })
  e.m.rosterApi.primeBotModelSettings(second, { effort: 'max', speed: 'ultrafast' })
  const b = mount(e, second)
  await painted()
  assert.deepEqual(b.options('Speed'), ['', 'normal', 'fast', 'ultrafast'], 'filled from the cache on first paint')
  assert.equal(b.select('Speed').value, 'ultrafast')
  assert.equal(calls.filter(c => c.method === 'model.options').length, 1, 'one catalogue read for both bots')
  b.unmount()
  // A bot on another machine has its own catalogue.
  const far = remote('far', 'cloud')
  e.m.rosterApi.primeBotModel(far, { provider: 'example', model: 'demo-large' })
  e.m.rosterApi.primeBotModelSettings(far, { effort: '', speed: '' })
  const c = mount(e, far)
  await painted()
  assert.equal(calls.filter(c => c.method === 'model.options').length, 2)
  releaseCatalogue()
  await settle()
  c.unmount()
})

test('(c) Effort and Speed follow the picked model: real levels only; a model without them → disabled with "Not supported by this model", never hidden', { skip }, async t => {
  const e = await setup(t)
  const { releaseCatalogue } = wire(e)
  const bot = remote('scout')
  e.m.rosterApi.primeBotModel(bot, { provider: 'example', model: 'demo-large' })
  e.m.rosterApi.primeBotModelSettings(bot, { effort: '', speed: '' })
  const sheet = mount(e, bot)
  await painted()
  releaseCatalogue()
  await settle()
  assert.deepEqual(sheet.options('Effort'), ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(sheet.select('Speed').disabled, false)
  // demo-small: reasoning cannot be switched off; no fast tier.
  sheet.choose('Model', 'demo-small')
  await settle()
  assert.ok(!sheet.options('Effort').includes('none'), 'no Off')
  assert.equal(sheet.select('Speed').disabled, true)
  assert.equal(sheet.hint('Speed'), 'Not supported by this model')
  // demo-plain: no reasoning dial either. Both still drawn.
  sheet.choose('Model', 'demo-plain')
  await settle()
  assert.equal(sheet.select('Effort').disabled, true)
  assert.equal(sheet.hint('Effort'), 'Not supported by this model')
  assert.ok(sheet.select('Speed'), 'still in the grid')
  // A Codex model: the Responses ladder for its generation, plus Ultrafast.
  sheet.choose('Provider', 'openai-codex')
  await settle()
  assert.equal(sheet.select('Model').value, 'gpt-6.1-sol')
  assert.deepEqual(sheet.options('Effort'), ['', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(sheet.options('Speed'), ['', 'normal', 'fast', 'ultrafast'])
  assert.equal(sheet.hint('Speed').trim(), '', 'no hint when supported (the line stays reserved)')
  sheet.unmount()
})

test('(d) Save writes all four in one go: model, then effort and speed via config.set; Default removes the key; then closes', { skip }, async t => {
  const e = await setup(t)
  const { calls, handlers, releaseCatalogue } = wire(e)
  handlers['profiles.configure'] = () => ({ applied: { model: true } })
  handlers['config.set'] = params => ({ key: params.key, value: params.value })
  handlers['cli.exec'] = () => ({ code: 0, blocked: false, output: '✓ Unset' })
  const bot = remote('scout')
  e.m.rosterApi.primeBotModel(bot, { provider: 'example', model: 'demo-small' })
  e.m.rosterApi.primeBotModelSettings(bot, { effort: 'high', speed: '' })
  const sheet = mount(e, bot)
  await painted()
  releaseCatalogue()
  await settle()
  sheet.choose('Model', 'demo-large')
  sheet.choose('Effort', '')
  sheet.choose('Speed', 'fast')
  await settle()
  assert.equal(sheet.save().disabled, false)
  calls.length = 0
  sheet.save().click()
  await settle(30)
  const writes = calls.filter(c => ['profiles.configure', 'config.set', 'cli.exec'].includes(c.method))
  assert.deepEqual(
    writes.map(c => [c.method, c.params]),
    [
      ['profiles.configure', { name: 'scout', model: 'demo-large', provider: 'example' }],
      ['cli.exec', { argv: ['--profile', 'scout', 'config', 'unset', 'agent.reasoning_effort'] }],
      ['config.set', { key: 'fast', value: 'fast', profile: 'scout', scope: 'global' }]
    ]
  )
  for (const w of writes) assert.equal(w.route?.connectionId, 'mini', `${w.method} on the bot's own route`)
  for (const w of writes) assert.equal(w.opts?.spawnPriority, 'foreground', `${w.method} dials foreground`)
  assert.equal(sheet.closed(), 1, 'closed after a full save')
  const stores = e.m.rosterStoresApi.roster2
  assert.equal(stores.models.get()['mini::scout'].model, 'demo-large')
  assert.deepEqual({ effort: stores.modelSettings.get()['mini::scout'].effort, speed: stores.modelSettings.get()['mini::scout'].speed }, { effort: '', speed: 'fast' })
  sheet.unmount()
})

test('(d) only what changed is written; a refused speed is reported and the sheet stays open with that edit', { skip }, async t => {
  const e = await setup(t)
  const { calls, handlers, releaseCatalogue } = wire(e)
  handlers['config.set'] = params => {
    if (params.key === 'fast') throw new Error('fast mode is not available for this model')
    return { key: params.key, value: params.value }
  }
  handlers['config.get'] = () => ({ config: { agent: { reasoning_effort: 'low' } } })
  const bot = remote('scout')
  e.m.rosterApi.primeBotModel(bot, { provider: 'example', model: 'demo-large' })
  e.m.rosterApi.primeBotModelSettings(bot, { effort: '', speed: '' })
  const sheet = mount(e, bot)
  await painted()
  releaseCatalogue()
  await settle()
  sheet.choose('Effort', 'low')
  sheet.choose('Speed', 'fast')
  await settle()
  calls.length = 0
  sheet.save().click()
  await settle(30)
  const writes = calls.filter(c => ['profiles.configure', 'config.set', 'cli.exec'].includes(c.method))
  assert.deepEqual(writes.map(c => c.params.key), ['reasoning', 'fast'], 'no model write: it did not change')
  assert.equal(sheet.closed(), 0)
  assert.match(document.body.textContent, /Not saved: speed \(fast mode is not available for this model\)/)
  assert.equal(sheet.select('Effort').value, 'low', 'the saved effort is the bot\'s value now')
  assert.equal(sheet.select('Speed').value, 'fast', 'the refused edit is kept to retry or change')
  sheet.unmount()
})
