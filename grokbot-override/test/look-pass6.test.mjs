// Look pass 6: flat bot bubbles, a pinned tile with no box when selected, a
// rounded neutral highlight on the open bot's row, and the profile panel's
// Model row (the usage block is gone) that opens the model picker and saves
// the model the way the config screen does. The real modules bundled with
// the fake SDK (dev/bundle.mjs); needs the dev dependencies.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}

const S = ':where([data-gbo-root], [data-gbo-root] *)'

const remote = name => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId: 'mini',
  connectionKind: 'ssh',
  route: { connectionId: 'mini', mode: 'remote', profile: name, targetProfile: name },
  canonical_session: { id: `${name}-root` }
})

let shared = null
async function load(t) {
  if (!shared) {
    const { bundlePreview } = await import('../dev/bundle.mjs')
    const file = await bundlePreview()
    const mod = await import(pathToFileURL(file).href)
    mod.appApi.start({ storage: { get: (k, f) => (k === 'enabled' ? false : f), set: () => undefined }, onEvent: () => () => undefined, setTimeout: () => () => undefined })
    shared = { ...mod, host: mod.fakeSdk.host }
    process.on('exit', () => rmSync(dirname(file), { recursive: true, force: true }))
  }
  const calls = []
  const handlers = {}
  const answer = async (method, params, route) => {
    calls.push({ method, params, route })
    const h = handlers[method]
    return h ? h(params, route) : {}
  }
  shared.host.request = (method, params) => answer(method, params, null)
  shared.host.requestProfile = (route, method, params) => answer(method, params, route)
  shared.rosterStoresApi.roster2.models.set({})
  shared.rosterStoresApi.roster2.dialog.set(null)
  return { ...shared, calls, handlers }
}

const bodyOf = html => html.slice(html.indexOf('<body>'))

// ── CSS ──────────────────────────────────────────────────────────────────

test('bot bubbles are one flat fill (no sheen, ring or shadow) in both themes; user bubbles keep theirs', { skip }, async t => {
  const { CSS } = await load(t)
  assert.ok(CSS.includes(`.bubble.is-agent${S} { background: var(--g-color-bubble-agent-flat); box-shadow: none; border: 0; }`), 'the flat rule')
  assert.match(CSS, /\[data-gbo-root\] \{[^}]*--g-color-bubble-agent-flat: #F0F0F0;/, 'light: a flat light grey')
  assert.match(CSS, /\.dark \[data-gbo-root\], \[data-gbo-root\]\[data-gbo-theme="dark"\] \{[^}]*--g-color-bubble-agent-flat: #242424;/, 'dark: a dark neutral close to the target')
  // The flat rule comes after the reference's gradient rule, so it wins.
  assert.ok(CSS.lastIndexOf('.bubble.is-agent' + S + ' { background: var(--g-color-bubble-agent-flat)') > CSS.indexOf('.bubble.is-agent' + S + ' { background: linear-gradient'))
  assert.ok(CSS.includes(`.bubble.is-user${S} { background: linear-gradient(180deg, #FFFFFF0F 0%, #FFFFFF00 100%), var(--gbo-tint-bg`), 'user bubbles unchanged')
})

test('selected pin: no box (border, outline, shadow), at most a faint neutral fill; keyboard focus keeps a neutral ring', { skip }, async t => {
  const { CSS } = await load(t)
  assert.ok(CSS.includes(`.pinned__tile${S} { color: inherit; max-width: 100%; border: 0; outline: none; box-shadow: none; }`))
  assert.ok(CSS.includes(`.pinned__tile:hover${S}, .pinned__tile.is-selected${S} { background: var(--g-color-pin-selected); }`))
  assert.match(CSS, /--g-color-pin-selected: #00000008;/)
  assert.match(CSS, /--g-color-pin-selected: #FFFFFF0A;/)
  assert.ok(CSS.includes(`.pinned__tile:focus-visible${S}, .bot-row:focus-visible${S} { outline: none; box-shadow: inset 0 0 0 1.67px var(--g-color-border-primary); }`), 'a neutral keyboard ring (1.5px at Hermes\'s zoom), never the blue outline')
  assert.ok(CSS.includes(`.gbo-roster[data-gbo-pointer]${S} .pinned__tile:focus-visible, .gbo-roster[data-gbo-pointer]${S} .bot-row:focus-visible { box-shadow: none; }`), 'no ring while the mouse drives the roster')
})

test('the open bot\'s row: a rounded neutral highlight (dark 7% white, light 5% black); hover is lighter', { skip }, async t => {
  const { CSS, render } = await load(t)
  assert.ok(CSS.includes(`.bot-row:hover${S} { background: var(--g-color-row-hover); }`))
  assert.ok(CSS.includes(`.bot-row.is-selected${S} { background: var(--g-color-row-selected); }`))
  assert.match(CSS, /--g-color-row-selected: #0000000D;\s*--g-color-row-hover: #00000008;/)
  assert.match(CSS, /--g-color-row-selected: #FFFFFF12;\s*--g-color-row-hover: #FFFFFF0A;/)
  // The selected rule is after the hover rule, so a hovered open row stays selected.
  assert.ok(CSS.indexOf(`.bot-row.is-selected${S} { background: var(--g-color-row-selected)`) > CSS.indexOf(`.bot-row:hover${S} { background: var(--g-color-row-hover)`))
  const html = bodyOf(render({ theme: 'dark', botIndex: 4, pins: ['scholar'] }))
  assert.match(html, /class="bot-row gbo-row is-selected" aria-current="true" title="Recipes/)
})

// ── panel ────────────────────────────────────────────────────────────────

test('panel: no Context block; one Model card (label, model name, chevron) between Computer and Profile', { skip }, async t => {
  const { render, renderElement, ProfilePanel, rosterApi } = await load(t)
  const html = bodyOf(render({ theme: 'light', botIndex: 1 }))
  for (const gone of ['>Context<', 'Input tokens', 'Output tokens', 'API calls', 'Cache hits', 'gbo-meter', 'Shown once the chat is attached']) assert.ok(!html.includes(gone), `gone: ${gone}`)
  const row = html.match(/<button type="button" class="panel-row panel-row--setting gbo-model-row"[^>]*>([\s\S]*?)<\/button>/)
  assert.ok(row, 'the Model row')
  assert.match(row[1], /<span class="panel-row__title">Model<\/span>/)
  assert.match(row[1], /<span class="gbo-model-name">demo-large<\/span>/)
  assert.match(row[1], /<path d="m6 9 6 6 6-6"/, 'a chevron')
  assert.ok(html.indexOf('gbo-model-row') > html.indexOf('Bot’s computer') && html.indexOf('gbo-model-row') < html.indexOf('>Profile<'), 'in the old Context spot')
  // A profile with no model of its own reads Default; not read yet, an ellipsis.
  const bot = remote('plain')
  assert.match(renderElement(ProfilePanel, { bot }), /gbo-model-name">…</)
  rosterApi.primeBotModel(bot, { provider: '', model: '' })
  assert.match(renderElement(ProfilePanel, { bot }), /gbo-model-name">Default</)
})

test('Model row: reads profiles.describe once on the bot\'s route; an error reads Unavailable', { skip }, async t => {
  const { rosterApi, rosterStoresApi, renderElement, ProfilePanel, calls, handlers } = await load(t)
  const bot = remote('scout')
  handlers['profiles.describe'] = () => ({ model: { provider: 'example', default: 'demo-small' } })
  await rosterApi.loadBotModel(bot)
  await rosterApi.loadBotModel(bot)
  const reads = calls.filter(c => c.method === 'profiles.describe')
  assert.equal(reads.length, 1, 'read once')
  assert.deepEqual(reads[0].params, { name: 'scout' })
  assert.equal(reads[0].route?.connectionId, 'mini', 'on the bot\'s own route')
  assert.deepEqual({ ...rosterStoresApi.roster2.models.get()['mini::scout'] }, { loading: false, loaded: true, provider: 'example', model: 'demo-small', error: null })
  assert.match(renderElement(ProfilePanel, { bot }), /gbo-model-name">demo-small</)
  const down = remote('down')
  handlers['profiles.describe'] = () => {
    throw new Error('socket closed')
  }
  await rosterApi.loadBotModel(down)
  assert.match(renderElement(ProfilePanel, { bot: down }), /gbo-model-name">Unavailable</)
})

test('Model row click opens the model dialog for that bot', { skip }, async t => {
  const { rosterStoresApi } = await load(t)
  const src = readFileSync(new URL('../src/ui/Profile.tsx', import.meta.url), 'utf8')
  assert.match(src, /gbo-model-row"[^>]*onClick=\{\(\) => openDialog\(\{ kind: 'model', bot \}\)\}/)
  const dialogs = readFileSync(new URL('../src/ui/BotDialogs.tsx', import.meta.url), 'utf8')
  assert.match(dialogs, /dialog\?\.kind === 'model' \? <ModelDialog bot=\{dialog\.bot\} onClose=\{close\} \/>/)
  assert.match(dialogs, /<ModelPicker\s+bot=\{bot\}/, 'the existing picker')
  assert.equal(rosterStoresApi.roster2.dialog.get(), null)
})

test('Model save: the model section alone through profiles.configure, as the config screen saves it; the row follows', { skip }, async t => {
  const { rosterApi, rosterStoresApi, calls, handlers } = await load(t)
  const bot = remote('scout')
  rosterApi.primeBotModel(bot, { provider: 'example', model: 'demo-small' })
  handlers['profiles.configure'] = () => ({ applied: { model: true } })
  const res = await rosterApi.saveBotModel(bot, { provider: 'example', model: 'demo-large' })
  assert.equal(res.ok, true)
  const writes = calls.filter(c => c.method === 'profiles.configure')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].params, { name: 'scout', model: 'demo-large', provider: 'example' }, 'no skills, toolsets, MCP or SOUL')
  assert.equal(writes[0].route?.connectionId, 'mini')
  assert.equal(rosterStoresApi.roster2.models.get()['mini::scout'].model, 'demo-large')

  // Default (both emptied): the same `config unset model` as the config screen.
  calls.length = 0
  handlers['cli.exec'] = () => ({ code: 0 })
  const cleared = await rosterApi.saveBotModel(bot, { provider: '', model: '' })
  assert.equal(cleared.ok, true)
  const sent = calls.filter(c => c.method !== 'profiles.list') // the roster re-read after any save
  assert.deepEqual(sent.map(c => c.method), ['cli.exec'])
  assert.deepEqual(sent[0].params.argv, ['--profile', 'scout', 'config', 'unset', 'model'])
  assert.equal(rosterStoresApi.roster2.models.get()['mini::scout'].model, '')

  // A failed write re-reads the row instead of guessing.
  calls.length = 0
  handlers['profiles.configure'] = () => ({ applied: { model: false } })
  handlers['profiles.describe'] = () => ({ model: { provider: 'example', default: 'demo-small' } })
  await rosterApi.saveBotModel(bot, { provider: 'example', model: 'demo-large' })
  await settle()
  assert.ok(calls.some(c => c.method === 'profiles.describe'))
  assert.equal(rosterStoresApi.roster2.models.get()['mini::scout'].model, 'demo-small')
})

test('the config screen\'s model save updates the panel row too', { skip }, async t => {
  const { rosterApi, rosterStoresApi, handlers } = await load(t)
  const bot = remote('scout')
  rosterApi.primeBotModel(bot, { provider: 'example', model: 'demo-small' })
  handlers['profiles.configure'] = () => ({ applied: { model: true, skills: true } })
  await rosterApi.saveAdvanced(bot, { loaded: true, provider: 'example', model: 'demo-large', skills: [{ name: 'web', enabled: false }], toolsets: [], mcp: [], soul: '', dirtyModel: true, dirtySkills: true })
  assert.equal(rosterStoresApi.roster2.models.get()['mini::scout'].model, 'demo-large')
})

test('the usage block is gone from the code; the status-bar chip stays', () => {
  const meter = readFileSync(new URL('../src/ui/UsageMeter.tsx', import.meta.url), 'utf8')
  assert.ok(!meter.includes('UsageBlock'))
  assert.ok(meter.includes('export function UsageStatusChip'))
  assert.ok(!readFileSync(new URL('../src/core/usage.js', import.meta.url), 'utf8').includes('usageDetailRows'))
  assert.ok(!readFileSync(new URL('../src/ui/Profile.tsx', import.meta.url), 'utf8').includes('UsageMeter'))
})

test('the roster marks pointer use (data-gbo-pointer) and Tab / arrows clear it', () => {
  const src = readFileSync(new URL('../src/ui/Roster.tsx', import.meta.url), 'utf8')
  assert.match(src, /addEventListener\('pointerdown', onPointer, true\)/)
  assert.match(src, /NAV_KEYS = new Set\(\['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'\]\)/)
  assert.match(src, /usePointerMode\(rootRef\)/)
})
