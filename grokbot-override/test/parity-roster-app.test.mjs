// Roster-side parity in the app layer (src/ui/rosterActions.ts and friends):
// the real modules bundled with the fake SDK (dev/bundle.mjs), driven against
// a fake gateway shaped from the stock Bot Mode calls each action ports.
// Needs the dev dependencies; skipped without them.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}

const remote = (name, extra = {}) => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId: 'mini',
  connectionKind: 'ssh',
  route: { connectionId: 'mini', mode: 'remote', profile: name, targetProfile: name },
  canonical_session: { id: `${name}-root`, resolved_id: `${name}-tip` },
  ...extra
})

let shared = null
async function load(t) {
  if (!shared) {
    const { bundlePreview } = await import('../dev/bundle.mjs')
    const file = await bundlePreview()
    const mod = await import(pathToFileURL(file).href)
    const stored = {}
    const ctx = {
      storage: { get: (k, f) => (k === 'enabled' ? false : k in stored ? stored[k] : f), set: (k, v) => (stored[k] = v) },
      onEvent: () => () => undefined,
      setTimeout: () => () => undefined
    }
    mod.appApi.start(ctx)
    shared = { ...mod, file, stored, host: mod.fakeSdk.host }
    process.on('exit', () => rmSync(dirname(file), { recursive: true, force: true }))
  }
  const { host, rosterStoresApi, appApi } = shared
  // a fresh fake gateway per test
  const calls = []
  const handlers = {}
  const answer = async (method, params, route) => {
    calls.push({ method, params, route })
    const h = handlers[method]
    if (h) return h(params, route)
    return {}
  }
  host.request = (method, params) => answer(method, params, null)
  host.requestProfile = (route, method, params) => answer(method, params, route)
  host.agents = async () => ({ agents: [], sources: [] })
  rosterStoresApi.roster2.metaWrites.set({})
  rosterStoresApi.roster2.attention.set({})
  rosterStoresApi.roster2.dialog.set(null)
  appApi.app.roster.set(s => ({ ...s, rows: [], localMeta: {}, origin: 'own', updatedAt: Date.now() }))
  t.after(() => {
    for (const key of ['deleteProfile', 'newChat', 'openSession', 'dropLeftoverProfilePrefs']) delete host[key]
    delete globalThis.window
  })
  return { ...shared, calls, handlers }
}

test('R11 pin: the bot\'s own route gets the CAS ui_meta write; the row reads pinned at once and after the fence from the server', { skip }, async t => {
  const { rosterApi, appApi, calls, handlers } = await load(t)
  const bot = remote('alpha', { ui_meta: { 'hermes-bots': { title: 'Alpha' } } })
  appApi.app.roster.set(s => ({ ...s, rows: [bot] }))
  handlers['profiles.list'] = () => ({ profiles: [{ name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } }, ui_meta_revisions: { 'hermes-bots': 2 } }] })
  handlers['profiles.configure'] = () => ({ applied: { ui_meta: true } })
  await rosterApi.togglePinned(bot)
  const configure = calls.find(c => c.method === 'profiles.configure')
  assert.equal(configure.route.connectionId, 'mini', 'written on the bot\'s own connection')
  assert.deepEqual(configure.params, { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', pinned: true } }, ui_meta_expected_revisions: { 'hermes-bots': 2 } })
  assert.equal(appApi.metaFor(bot).pinned, true)
  assert.ok(!calls.some(c => c.method.startsWith('session.') || c.method === 'prompt.submit'), 'no session or send call')
})

test('R11 hide on a gateway with no ui_meta contract stays hidden on this desktop (sticky overlay, persisted)', { skip }, async t => {
  const { rosterApi, appApi, handlers, stored } = await load(t)
  const bot = { name: 'beta' }
  handlers['profiles.list'] = () => ({ profiles: [{ name: 'beta' }] })
  handlers['profiles.configure'] = () => ({})
  await rosterApi.toggleHidden(bot)
  assert.equal(appApi.metaFor(bot).hidden, true)
  assert.ok(stored.metaWrites?.beta?.sticky, 'kept across restarts')
})

test('R12 delete: host.deleteProfile with the route, state cleared; default refused', { skip }, async t => {
  const { rosterApi, rosterStoresApi, host } = await load(t)
  const seen = []
  host.deleteProfile = async target => seen.push(target)
  const bot = remote('gamma')
  rosterStoresApi.roster2.attention.set({ 'mini::gamma': { reason: 'agent_blocked' } })
  await rosterApi.deleteBot(bot)
  assert.equal(seen[0].profile, 'gamma')
  assert.deepEqual(rosterStoresApi.roster2.attention.get(), {})
  await assert.rejects(rosterApi.deleteBot({ name: 'default' }), /default profile/)
})

test('R12 duplicate: profiles.create clone_from on the bot route, then the look under the new name', { skip }, async t => {
  const { rosterApi, appApi, calls, handlers } = await load(t)
  const bot = remote('alpha', { ui_meta: { 'hermes-bots': { title: 'Alpha', color: '#f00', created: 1 } } })
  appApi.app.roster.set(s => ({ ...s, rows: [bot, remote('alpha-2')] }))
  handlers['profiles.list'] = (p, route) => ({ profiles: [{ name: route?.targetProfile || 'alpha', description: 'desc' }] })
  handlers['profiles.configure'] = () => ({ applied: { ui_meta: true } })
  const name = await rosterApi.duplicateBot(bot)
  assert.equal(name, 'alpha-3')
  const create = calls.find(c => c.method === 'profiles.create')
  assert.deepEqual(create.params, { name: 'alpha-3', clone_from: 'alpha', description: 'desc' })
  assert.equal(create.route.connectionId, 'mini')
  const look = calls.find(c => c.method === 'profiles.configure')
  assert.equal(look.params.name, 'alpha-3')
  assert.deepEqual(look.params.ui_meta['hermes-bots'], { title: 'Alpha (copy)', color: '#f00' })
})

test('R12 new chat with this agent and open in new tab use stock\'s host calls; nothing reveals stock Bot Mode', { skip }, async t => {
  const { rosterApi, host, calls } = await load(t)
  const opened = []
  host.newChat = (route, opts) => opened.push(['newChat', route, opts])
  host.openSession = async (id, opts) => opened.push(['openSession', id, opts])
  const bot = remote('alpha')
  rosterApi.newChatWith(bot)
  await rosterApi.openInNewTab(bot)
  assert.equal(opened[0][1].connectionId, 'mini')
  assert.deepEqual(opened[0][2], { workspaceMode: 'bots', workspaceOwnerKey: 'bot:mini::alpha' })
  assert.equal(opened[1][1], 'alpha-tip')
  assert.equal(opened[1][2].intent, 'tab')
  assert.ok(!calls.some(c => c.method === 'session.create'))
  const fromC26 = []
  rosterApi.setNewTabOpener(b => (fromC26.push(b.name), true))
  await rosterApi.openInNewTab(bot)
  rosterApi.setNewTabOpener(null)
  assert.deepEqual(fromC26, ['alpha'], 'a side-by-side override chat wins when registered')
})

test('R13 create: protocol flag, profiles.create body, look, runtime check, then the Bot Chat creator with kickoff', { skip }, async t => {
  const { rosterApi, appApi, calls, handlers } = await load(t)
  handlers['profiles.list'] = () => ({ bot_mode_protocol: true, profiles: [{ name: 'scout' }] })
  handlers['profiles.configure'] = () => ({ applied: { ui_meta: true } })
  handlers['setup.runtime_check'] = () => ({ ok: true })
  appApi.app.roster.set(s => ({ ...s, rows: [{ name: 'scout' }] }))
  const created = []
  rosterApi.setBotChatCreator(async (bot, opts) => created.push([bot.name, opts]))
  const out = await rosterApi.createBot({
    name: 'scout',
    slug: 'scout',
    title: 'Scout',
    description: 'Finds things',
    target: '',
    cloneFrom: 'default',
    noSkills: false,
    shareAuth: true,
    customSoul: '',
    model: '',
    provider: '',
    look: { shape: 'blobatar', color: null, image: null },
    caps: { skills: [{ name: 'web', enabled: false }], toolsets: [], mcp: [] },
    dirtyCaps: { skills: true }
  })
  const create = calls.find(c => c.method === 'profiles.create')
  assert.equal(create.route, null, 'created on the active gateway')
  assert.equal(create.params.clone_from, 'default')
  assert.ok(!create.params.soul.includes('## Messaging'), 'the backend injects the protocol')
  assert.deepEqual(calls.find(c => c.method === 'profiles.configure' && c.params.disabled_skills).params, { name: 'scout', disabled_skills: ['web'] })
  assert.ok(calls.some(c => c.method === 'profiles.configure' && c.params.ui_meta?.['hermes-bots']?.title === 'Scout'))
  assert.deepEqual(created, [['scout', { kickoff: true }]])
  assert.equal(out.kickedOff, true)
  rosterApi.setBotChatCreator(null)
})

test('R13 a bot with no usable model is created without the intro turn; a remote target never starts a chat here', { skip }, async t => {
  const { rosterApi, appApi, calls, handlers } = await load(t)
  handlers['profiles.list'] = () => ({ profiles: [{ name: 'scout' }] })
  handlers['setup.runtime_check'] = () => ({ ok: false, error: 'No LLM provider' })
  appApi.app.roster.set(s => ({ ...s, rows: [{ name: 'scout' }] }))
  const created = []
  rosterApi.setBotChatCreator(async (bot, opts) => created.push(opts))
  const base = { name: 'scout', slug: 'scout', title: '', description: '', cloneFrom: 'default', noSkills: false, shareAuth: true, customSoul: '', model: '', provider: '', look: { shape: 'blobatar', color: null, image: null }, caps: null, dirtyCaps: {} }
  const local = await rosterApi.createBot({ ...base, target: '' })
  assert.deepEqual(created, [{ kickoff: false }])
  assert.equal(local.needsModel, true)
  created.length = 0
  await rosterApi.createBot({ ...base, slug: 'far', name: 'far', target: 'mini' })
  const remoteCreate = calls.filter(c => c.method === 'profiles.create').pop()
  assert.deepEqual(remoteCreate.route, { connectionId: 'mini', mode: 'remote', profile: 'default', targetProfile: 'default' })
  assert.equal(remoteCreate.params.clone_from, 'default')
  assert.deepEqual(created, [], 'no chat birth for a remote target (stock)')
  rosterApi.setBotChatCreator(null)
})

test('P3 jobs: add via cron.manage, remove only a listed job, edit and run through the Cron REST API on the bot scope', { skip }, async t => {
  const { rosterApi, rosterStoresApi, appApi, calls, handlers } = await load(t)
  const bot = remote('scout')
  handlers['cron.manage'] = p => (p.action === 'list' ? { jobs: [{ job_id: 'j1', name: '[bot:scout] Digest' }] } : { ok: true })
  await appApi.loadCron(bot)
  await rosterApi.createJob(bot, { title: 'Digest', instruction: 'Go', sched: { freq: 'hourly' }, continuity: false, target: 'history' })
  const add = calls.find(c => c.params?.action === 'add')
  assert.equal(add.params.name, '[bot:scout] Digest')
  assert.equal(add.params.schedule, 'every 1h')
  assert.equal(add.route.connectionId, 'mini')
  await assert.rejects(rosterApi.removeJob(bot, { job_id: 'nope' }), /not listed/)
  await rosterApi.removeJob(bot, { job_id: 'j1' })
  assert.deepEqual(calls.find(c => c.params?.action === 'remove').params, { action: 'remove', name: 'j1', profile: 'scout' })

  const rest = []
  globalThis.window = { hermesDesktop: { api: async req => (rest.push(req), {}) } }
  await rosterApi.editJob(bot, { job_id: 'j1', name: '[bot:scout] Digest', prompt_preview: 'Go' }, { title: 'Digest 2', prompt: 'Go now', sched: { freq: 'daily', time: '9:0' } })
  assert.deepEqual(rest[0], {
    connectionId: 'mini',
    profile: 'scout',
    priority: 'foreground',
    path: '/api/cron/jobs/j1',
    method: 'PUT',
    body: { updates: { deliver: 'local', name: '[bot:scout] Digest 2', schedule: '0 9 * * *', prompt: 'Go now' } }
  })
  const run = rosterApi.runJob(bot, { job_id: 'j1', name: 'Digest' })
  assert.equal(rosterStoresApi.roster2.running.get().j1, true)
  await run
  assert.equal(rest[1].path, '/api/cron/jobs/j1/trigger')
  assert.equal(rest[1].method, 'POST')
  assert.equal(rest[1].timeoutMs, 24 * 60 * 60 * 1000)
  assert.deepEqual(rosterStoresApi.roster2.running.get(), {})
})

test('R15 + C25: the open chat\'s failed turn badges its row, a good reply clears it; usage events merge; other runtimes ignored', { skip }, async t => {
  const { rosterApi, rosterStoresApi, appApi } = await load(t)
  const bot = remote('scout')
  appApi.app.chat.set({ bot, runtimeId: 'rt-1', chat: { items: [], busy: true } })
  rosterStoresApi.roster2.usage.set({ key: 'mini::scout', runtimeId: 'rt-1', usage: null, error: null })
  rosterApi._onGatewayEvent({ type: 'message.complete', session_id: 'rt-1', payload: { status: 'error', error: 'HTTP 401 Unauthorized' } })
  assert.equal(rosterApi.attentionFor(bot).reason, 'provider_auth_or_access')
  rosterApi._onGatewayEvent({ type: 'message.complete', session_id: 'other', payload: { text: 'hi' } })
  assert.ok(rosterApi.attentionFor(bot), 'another runtime\'s reply does not clear it')
  rosterApi._onGatewayEvent({ type: 'session.usage', session_id: 'rt-1', payload: { usage: { context_used: 10, context_max: 100 } } })
  assert.deepEqual(rosterStoresApi.roster2.usage.get().usage, { context_used: 10, context_max: 100 })
  rosterApi._onGatewayEvent({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'done' } })
  assert.equal(rosterApi.attentionFor(bot), null)
  await settle()
  appApi.app.chat.set(null)
})

test('C21 a model needing confirmation asks in the override, then re-sends only the model', { skip }, async t => {
  const { rosterApi, calls, handlers } = await load(t)
  const bot = remote('scout')
  handlers['profiles.configure'] = p => (p.confirm_expensive_model ? { applied: { model: true } } : { applied: {}, confirm_required: true, confirm_message: 'Costs more' })
  const asked = []
  rosterApi.setConfirmAsker(async message => (asked.push(message), true))
  const res = await rosterApi.saveAdvanced(bot, { provider: 'p', model: 'big', soul: '', skills: [], toolsets: [], mcp: [], dirtyModel: true, loaded: true })
  rosterApi.setConfirmAsker(null)
  assert.deepEqual(asked, ['Costs more'])
  assert.deepEqual(calls.filter(c => c.method === 'profiles.configure').pop().params, { name: 'scout', model: 'big', provider: 'p', confirm_expensive_model: true })
  assert.ok(res.ok)
})

test('R9 Retry re-reads the roster at once (profiles.list + host.agents), bypassing the poll interval', { skip }, async t => {
  const { rosterApi, calls, host, handlers } = await load(t)
  let agents = 0
  host.agents = async () => (agents++, { agents: [], sources: [] })
  handlers['profiles.list'] = () => ({ profiles: [{ name: 'default' }] })
  await rosterApi.retrySources()
  await settle()
  assert.ok(calls.some(c => c.method === 'profiles.list'))
  assert.equal(agents, 1)
})

test('R12 groups: a group with a stock room is refused here (its seats live in Bot Mode\'s room record)', { skip }, async t => {
  const { rosterApi } = await load(t)
  const prev = globalThis.localStorage
  globalThis.localStorage = { getItem: key => (key === 'hermes.plugin.hermes-bots.group-chats' ? JSON.stringify({ Research: { members: [] } }) : null) }
  t.after(() => (globalThis.localStorage = prev))
  assert.equal(rosterApi.groupHasRoom('Research'), true)
  assert.equal(rosterApi.groupHasRoom('Solo'), false)
})
