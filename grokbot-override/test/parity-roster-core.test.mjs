// Roster-side parity (R6 R9 R11 R12 R13 R15 P3 P4 P6 C21 C25): the plain core
// modules against fakes shaped from the stock Bot Mode source and its tests
// (apps/desktop/src/plugins/hermes-bots/*.test.ts at Hermes 2bd378ed1b).

import assert from 'node:assert/strict'
import test from 'node:test'

import { attentionFromEvent, attentionReasonFromError, botAttentionHint, clearAttention, noteAttention } from '../src/core/attention.js'
import { BOT_META_WRITE_FENCE_MS, botGroups, effectiveMeta, groupMembershipPatch, knownGroups, overlayEntry, pruneOverlay, saveBotMetaPatch } from '../src/core/botMeta.js'
import {
  composeSchedule,
  cronAddParams,
  cronEditUpdates,
  cronRemoveParams,
  isLegacyDelegatedRoutine,
  routineDetailIssue,
  routineDetailRows,
  routinePrompt,
  routineTitle,
  scheduleStateFrom,
  SAFE_ROUTINE_MARKER
} from '../src/core/cronOps.js'
import { advancedPayload, applyAdvancedConfig, boundedFetch, loadAdvanced, mcpNeedsSetup, providerMatches, skillsInstallParams, skillsSearchParams } from '../src/core/profileConfig.js'
import {
  botProfileIdentity,
  capabilityPayload,
  composeSoul,
  createProfileParams,
  deleteBotProfile,
  duplicateLook,
  duplicateName,
  editedLook,
  ensureMessagingProtocol,
  newBotChat,
  requestOnTarget,
  slugifyProfileName,
  slugTaken
} from '../src/core/profileOps.js'
import { botActiveNow, botSourceStatus, deriveRosterView, rosterActivityMatches, rosterGatewayOptions, unreachableSources } from '../src/core/rosterView.js'
import { createScreenStore, displayRequest, handBackParams, isEventForBotScreen, leaseHeldBy, nextEviction, resolveScreenWsUrl, screenPhase, viewerHash } from '../src/core/screen.js'
import { costLabel, mergeUsage, usageContextLabel, usageFromEvent } from '../src/core/usage.js'

const NOW = 1_762_560_000_000
const remote = (name, extra = {}) => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId: 'mini',
  connectionKind: 'ssh',
  route: { connectionId: 'mini', mode: 'remote', profile: name, targetProfile: name },
  ...extra
})

// ── R11 metadata ─────────────────────────────────────────────────────────

test('R11 effective meta: server ui_meta beats the local snapshot, local image survives, title from the backend', () => {
  const bot = remote('alpha', { ui_meta: { 'hermes-bots': { pinned: true, title: 'Alpha' } } })
  const local = { 'mini::alpha': { pinned: false, hidden: true, image: 'data:x', title: 'Stale', chat: 'dead' } }
  const meta = effectiveMeta(bot, local, {}, NOW)
  assert.equal(meta.pinned, true)
  assert.equal(meta.hidden, true, 'local-only field kept')
  assert.equal(meta.image, 'data:x')
  assert.equal(meta.title, 'Alpha')
  assert.ok(!('chat' in meta), 'dead canonical pointer dropped')
  // a CAS-era row with no title reports '' → the local title is removed
  const untitled = effectiveMeta(remote('b', { ui_meta: { 'hermes-bots': { pinned: false } }, ui_meta_revisions: {} }), { 'mini::b': { title: 'Old' } }, {}, NOW)
  assert.ok(!('title' in untitled))
  // an unreachable row cannot correct anything
  const stale = effectiveMeta(remote('c', { sourceReachable: false, ui_meta: { 'hermes-bots': { pinned: true } } }), { 'mini::c': { pinned: false } }, {}, NOW)
  assert.equal(stale.pinned, false)
})

test('R11 the override\'s own write wins for the fence, sticky (older gateway) writes stay', () => {
  const bot = remote('alpha', { ui_meta: { 'hermes-bots': { pinned: false } } })
  const writes = { 'mini::alpha': overlayEntry({ pinned: true }, 'persisted', NOW) }
  assert.equal(effectiveMeta(bot, {}, writes, NOW + 1000).pinned, true)
  assert.equal(effectiveMeta(bot, {}, writes, NOW + BOT_META_WRITE_FENCE_MS + 1).pinned, false, 'after the fence the server decides')
  const sticky = { 'mini::alpha': overlayEntry({ hidden: true }, 'unsupported', NOW) }
  assert.equal(effectiveMeta(bot, {}, sticky, NOW + 10 * BOT_META_WRITE_FENCE_MS).hidden, true)
  assert.deepEqual(Object.keys(pruneOverlay({ ...writes, x: sticky['mini::alpha'] }, NOW + BOT_META_WRITE_FENCE_MS + 1)), ['x'])
})

test('R11 save: CAS read-modify-write of the bot\'s own hermes-bots namespace (data.ts persistBotMetaPatch)', async () => {
  const calls = []
  let revision = 4
  const request = async (bot, method, params, options) => {
    calls.push({ method, params, options })
    if (method === 'profiles.list') return { profiles: [{ name: 'alpha', ui_meta: { 'hermes-bots': { title: 'A', chat: 'x', groups: ['g'] } }, ui_meta_revisions: { 'hermes-bots': revision } }] }
    if (method === 'profiles.configure') {
      if (params.ui_meta_expected_revisions['hermes-bots'] !== 5) {
        revision = 5
        return { applied: { ui_meta: false, ui_meta_conflicts: { 'hermes-bots': 5 } } }
      }
      return { applied: { ui_meta: true } }
    }
    throw new Error(method)
  }
  const out = await saveBotMetaPatch(request, remote('alpha'), { pinned: true, image: 'data:y' }, { prevImage: 'data:y' })
  assert.equal(out.serverOutcome, 'persisted')
  const configures = calls.filter(c => c.method === 'profiles.configure')
  assert.equal(configures.length, 2, 'one CAS retry after a conflict')
  assert.deepEqual(configures[1].params, {
    name: 'alpha',
    ui_meta: { 'hermes-bots': { title: 'A', groups: ['g'], pinned: true } },
    ui_meta_expected_revisions: { 'hermes-bots': 5 }
  })
  assert.deepEqual(calls[0].params, { include_sessions: false })
  assert.deepEqual(calls[0].options, { spawnPriority: 'foreground' })
  assert.ok(!calls.some(c => c.method === 'profiles.set_asset'), 'unchanged image is not pushed')
})

test('R11 save outcomes: unsupported (no contract / missing method), failed, unreachable', async () => {
  const noContract = async (b, m) => (m === 'profiles.list' ? { profiles: [{ name: 'alpha' }] } : {})
  assert.equal((await saveBotMetaPatch(noContract, remote('alpha'), { hidden: true })).serverOutcome, 'unsupported')
  const refused = async (b, m) => (m === 'profiles.list' ? { profiles: [{ name: 'alpha' }] } : { applied: { ui_meta: false } })
  assert.equal((await saveBotMetaPatch(refused, remote('alpha'), { hidden: true })).serverOutcome, 'failed')
  const offline = async () => {
    throw new Error('socket closed')
  }
  assert.equal((await saveBotMetaPatch(offline, remote('alpha'), { hidden: true })).serverOutcome, 'unreachable')
  const local = async () => {
    throw Object.assign(new Error('nope'), { code: -32601 })
  }
  assert.equal((await saveBotMetaPatch(local, { name: 'alpha' }, { hidden: true })).serverOutcome, 'unsupported')
})

test('R12 groups: membership patch, known groups (group-membership.ts)', () => {
  assert.deepEqual(botGroups({ group: 'Solo' }), ['Solo'])
  assert.deepEqual(groupMembershipPatch({ groups: ['A'] }, 'B', true), { groups: ['A', 'B'], group: 'A' })
  assert.deepEqual(groupMembershipPatch({ groups: ['A'] }, 'A', false), { groups: [], group: null })
  assert.deepEqual(knownGroups([{ groups: ['b', 'A'] }, { group: 'c' }]), ['A', 'b', 'c'])
})

// ── R6 R9 roster view ────────────────────────────────────────────────────

test('R6 filters: kind, activity (active / recent / older), gateway; hidden section rules', () => {
  const nowS = NOW / 1000
  const rows = [
    remote('fresh', { canonical_session: { last_active: nowS - 30 } }),
    remote('week', { canonical_session: { last_active: nowS - 3 * 86400 } }),
    { name: 'old', connectionId: 'local', last_session: { last_active: nowS - 30 * 86400 } },
    { name: 'gone', connectionId: 'local', hidden: true }
  ]
  const metaFor = bot => ({ hidden: Boolean(bot.hidden) })
  const keyOf = bot => bot.name
  const view = f => deriveRosterView(rows, { metaFor, keyOf, filters: f, now: NOW })
  assert.deepEqual(view({}).rows.map(b => b.name), ['fresh', 'week', 'old'])
  assert.deepEqual(view({ activity: 'active' }).rows.map(b => b.name), ['fresh'])
  assert.deepEqual(view({ activity: 'recent' }).rows.map(b => b.name), ['fresh', 'week'])
  assert.deepEqual(view({ activity: 'older' }).rows.map(b => b.name), ['old'])
  assert.deepEqual(view({ gateway: 'mini' }).rows.map(b => b.name), ['fresh', 'week'])
  assert.deepEqual(view({ kind: 'groups' }).rows, [])
  const v = view({})
  assert.equal(v.hiddenCount, 1)
  assert.ok(v.showHiddenSection && !v.showHiddenRows, 'collapsed Hidden section')
  assert.equal(view({ activity: 'active' }).showHiddenSection, false, 'a filter that matches no hidden row hides the section')
  assert.equal(view({ gateway: 'mini', activity: 'older' }).activeFilterCount, 2)
  assert.equal(view({ gateway: 'nope' }).gateway, 'all', 'a gateway that disappeared resets to all')
  assert.ok(view({}).showFilters, 'more than one gateway shows the filter button')
  // a working open chat counts as active now
  assert.ok(botActiveNow(rows[2], { working: true, now: NOW }))
  assert.ok(rosterActivityMatches({ activity: NOW - 1000 }, 'recent', NOW))
})

test('R6 everything hidden → the all-hidden notice; a query searches hidden rows too', () => {
  const rows = [{ name: 'a' }, { name: 'b' }]
  const metaFor = () => ({ hidden: true })
  const v = deriveRosterView(rows, { metaFor, keyOf: b => b.name, now: NOW })
  assert.ok(v.allHidden)
  const q = deriveRosterView(rows, { metaFor, keyOf: b => b.name, query: 'b', now: NOW })
  assert.deepEqual(q.hidden.map(b => b.name), ['b'])
  assert.ok(q.showHiddenRows, 'a constraint expands the hidden rows')
})

test('R9 source status and the unreachable list a Retry re-reads', () => {
  assert.equal(botSourceStatus({ sourceError: 'connect-on-demand' }).key, 'on-demand')
  assert.equal(botSourceStatus({ sourceReachable: false }).available, false)
  assert.equal(botSourceStatus({ sourceMissing: true }).key, 'missing')
  const options = rosterGatewayOptions([{ connectionId: 'a', label: 'A', reachable: false }, { connectionId: 'b', label: 'B', reachable: true }], [])
  assert.deepEqual(unreachableSources(options).map(o => o.connectionId), ['a'])
})

// ── R15 attention ────────────────────────────────────────────────────────

test('R15 attention: classes from error text, transient never badges, next good turn clears', () => {
  assert.equal(attentionReasonFromError('401 Unauthorized'), 'provider_auth_or_access')
  assert.equal(attentionReasonFromError('No LLM provider configured'), 'missing_config')
  assert.equal(attentionReasonFromError('insufficient credits'), 'provider_quota_limit')
  assert.equal(attentionReasonFromError('429 rate limit'), null)
  assert.equal(attentionReasonFromError('upstream timed out'), null)
  assert.equal(attentionReasonFromError('agent_blocked'), 'agent_blocked')
  let map = noteAttention({}, 'k', 'Invalid API key', NOW)
  assert.equal(map.k.reason, 'provider_auth_or_access')
  assert.equal(botAttentionHint(map.k.reason), 'Sign in again for this profile')
  assert.equal(noteAttention(map, 'k', 'server error 503'), map, 'transient leaves the map alone')
  map = clearAttention(map, 'k')
  assert.deepEqual(map, {})
  assert.deepEqual(attentionFromEvent({ type: 'message.complete', payload: { status: 'error', error: '403 forbidden' } }), { kind: 'fail', text: '403 forbidden' })
  assert.deepEqual(attentionFromEvent({ type: 'message.complete', payload: { text: 'hi' } }), { kind: 'ok' })
})

// ── R12 R13 profile ops ──────────────────────────────────────────────────

test('R12 duplicate: first free "-N" on the bot\'s own connection, look copied with "(copy)"', () => {
  const roster = [remote('alpha'), remote('alpha-2'), { name: 'alpha-3' }]
  assert.equal(duplicateName(remote('alpha'), roster), 'alpha-3', 'a local alpha-3 does not block the remote slot')
  assert.equal(duplicateName({ name: 'alpha' }, roster), 'alpha-4')
  assert.deepEqual(duplicateLook({ title: 'A', chat: 'x', created: 1, color: '#f00' }), { title: 'A (copy)', color: '#f00' })
  const long = 'x'.repeat(64)
  assert.equal(duplicateName({ name: long }, []).length, 64)
})

test('R12 delete: host.deleteProfile with the route; default refused; cli.exec only for unrouted rows', async () => {
  const seen = []
  await deleteBotProfile({ deleteProfile: async target => seen.push(target) }, remote('alpha'))
  assert.equal(seen[0].connectionId, 'mini')
  await assert.rejects(deleteBotProfile({ deleteProfile: async () => undefined }, { name: 'default' }), /default profile/)
  await assert.rejects(deleteBotProfile({}, remote('alpha')), /requires host.deleteProfile/)
  const calls = []
  await deleteBotProfile({ request: async (m, p) => (calls.push([m, p]), { code: 0 }) }, { name: 'beta' })
  assert.deepEqual(calls[0], ['cli.exec', { argv: ['profile', 'delete', 'beta', '--yes'] }])
})

test('R12 new chat with this agent: host.newChat on the bot route in Bot Mode\'s workspace; refused without a route', () => {
  const opened = []
  const host = { newChat: (route, opts) => opened.push([route, opts]) }
  assert.equal(newBotChat(host, remote('alpha'), 'bot:mini::alpha'), true)
  assert.deepEqual(opened[0][1], { workspaceMode: 'bots', workspaceOwnerKey: 'bot:mini::alpha' })
  assert.equal(newBotChat(host, { name: 'local' }, 'bot:local'), false)
})

test('R12 edit: only changed look fields are sent', () => {
  const opened = { shape: 'circle', color: null, image: null, title: 'A' }
  assert.equal(editedLook(opened, { ...opened }), null)
  assert.deepEqual(editedLook(opened, { ...opened, color: '#fff' }), { color: '#fff', custom: true })
  assert.deepEqual(editedLook(opened, { ...opened, title: ' B ' }), { title: 'B' })
})

test('R13 create: slug, title, taken check, profiles.create body, SOUL with the messaging protocol', () => {
  assert.equal(slugifyProfileName('Résumé Bot'), 'resume-bot')
  assert.equal(slugifyProfileName('小助手'), 'u5c0f-u52a9-u624b')
  assert.deepEqual(botProfileIdentity('小助手', ''), { slug: 'u5c0f-u52a9-u624b', title: '小助手' })
  assert.ok(slugTaken([{ name: 'a' }], 'a', ''))
  assert.ok(!slugTaken([{ name: 'a' }], 'a', 'mini'), 'a local name does not block a remote target')
  const soul = composeSoul({ name: 'scout', title: 'Scout', description: 'Find things', roster: [{ name: 'other', description: 'helps' }] })
  assert.match(soul, /^# Scout/)
  assert.match(soul, /## Messaging other agents/)
  assert.match(soul, /- `other` — helps/)
  assert.ok(!composeSoul({ name: 'scout', injected: true }).includes('## Messaging'), 'backend injects the protocol')
  assert.equal(ensureMessagingProtocol(soul, 'scout', []), soul, 'idempotent')
  assert.deepEqual(createProfileParams({ slug: 'scout', descriptionText: 'Scout — x', cloneFrom: 'helper', remoteTarget: true, soul: 'S', model: 'm', provider: 'p' }), {
    name: 'scout',
    description: 'Scout — x',
    clone_from: 'default',
    no_skills: false,
    share_auth: true,
    soul: 'S',
    model: 'm',
    provider: 'p'
  })
  assert.deepEqual(capabilityPayload({ skills: [{ name: 'a', enabled: false }], toolsets: [{ name: 't', enabled: true }], mcp: [] }, { skills: true, toolsets: true }), {
    disabled_skills: ['a'],
    enabled_toolsets: []
  })
})

test('R13 a remote create target rides the connection\'s default backend (create-dialog.tsx requestOnTarget)', async () => {
  const seen = []
  const host = { requestProfile: async (route, m) => seen.push([route, m]), request: async m => seen.push(['active', m]) }
  await requestOnTarget(host, 'mini', 'profiles.create', {})
  await requestOnTarget(host, '', 'profiles.create', {})
  assert.deepEqual(seen[0][0], { connectionId: 'mini', mode: 'remote', profile: 'default', targetProfile: 'default' })
  assert.equal(seen[1][0], 'active')
})

// ── P3 cron ──────────────────────────────────────────────────────────────

test('P3 schedule picker strings (cron.tsx composeSchedule) and round trip for edit', () => {
  const base = { time: '9:30', weekday: '3', monthday: '15', intervalN: '2', intervalUnit: 'h', onceN: '45', onceUnit: 'm', repeatN: '', raw: 'every 1d' }
  assert.equal(composeSchedule({ ...base, freq: 'once' }), '45m')
  assert.equal(composeSchedule({ ...base, freq: 'hourly' }), 'every 1h')
  assert.equal(composeSchedule({ ...base, freq: 'daily' }), '30 9 * * *')
  assert.equal(composeSchedule({ ...base, freq: 'weekdays' }), '30 9 * * 1-5')
  assert.equal(composeSchedule({ ...base, freq: 'weekly' }), '30 9 * * 3')
  assert.equal(composeSchedule({ ...base, freq: 'monthly' }), '30 9 15 * *')
  assert.equal(composeSchedule({ ...base, freq: 'interval' }), 'every 2h')
  assert.equal(composeSchedule({ ...base, freq: 'advanced' }), 'every 1d')
  for (const s of ['30 9 * * *', '0 7 * * 1-5', '30 9 * * 3', '0 6 2 * *', 'every 3h', 'every 1h']) assert.equal(composeSchedule(scheduleStateFrom(s)), s)
  assert.equal(scheduleStateFrom('*/5 * * * *').freq, 'advanced')
})

test('P3 create: the cron.manage add body stock sends; remove; detail rows', () => {
  const sched = { freq: 'weekly', time: '8:0', weekday: '1', repeatN: '3' }
  const add = cronAddParams({ profile: 'scout', title: 'Digest', instruction: 'Summarise', sched, continuity: true, target: 'bot-chat', activeProfile: 'scout' })
  assert.deepEqual(add, { action: 'add', name: '[bot:scout] Digest', schedule: '0 8 * * 1', prompt: 'Summarise', profile: 'scout', repeat: 3, continuity: true, deliver: 'bot-chat' })
  const wrapped = routinePrompt('scout', 'Digest', 'Go', 'default')
  assert.ok(wrapped.startsWith(SAFE_ROUTINE_MARKER) && wrapped.includes("hermes -p 'scout' chat"))
  assert.deepEqual(cronRemoveParams({ name: 'scout' }, { job_id: 'j1' }), { action: 'remove', name: 'j1', profile: 'scout' })
  const job = { name: '[bot:scout] Digest', schedule: 'every 1440m', enabled: true, last_status: 'delivery_failed', deliver: 'bot-chat', last_delivery_error: 'no target' }
  assert.equal(routineTitle(job), 'Digest')
  const rows = routineDetailRows(job)
  assert.deepEqual(rows.find(r => r.label === 'Schedule'), { label: 'Schedule', value: 'Daily' })
  assert.deepEqual(rows.find(r => r.label === 'Last result'), { label: 'Last result', value: 'Ran, but delivery failed' })
  assert.ok(!rows.some(r => r.label === 'Model'), 'absent fields drop')
  assert.equal(routineDetailIssue(job), 'no target')
  assert.ok(isLegacyDelegatedRoutine({ name: '[bot:x] y', prompt_preview: 'You are running the scheduled routine "y"' }))
})

test('P3 edit: the app Cron page\'s update body, tag kept; the model pin is only written when passed (review v2-r2 M1)', () => {
  const job = { job_id: 'j1', name: '[bot:scout] Digest', prompt: 'old', deliver: 'local' }
  assert.deepEqual(cronEditUpdates({ profile: 'scout', job, title: 'Daily digest', prompt: ' new ', sched: { freq: 'hourly' } }), {
    deliver: 'local',
    name: '[bot:scout] Daily digest',
    schedule: 'every 1h',
    prompt: 'new'
  })
  assert.deepEqual(cronEditUpdates({ profile: 'scout', job, title: 'Daily digest', prompt: 'new', sched: { freq: 'hourly' }, model: '', provider: '' }).model, null, 'an explicit default clears it (stock)')
  const script = cronEditUpdates({ profile: 'scout', job: { name: 'x', script: 'a.sh' }, title: 'x', prompt: '', sched: { freq: 'hourly' } })
  assert.ok(!('prompt' in script) && !('model' in script), 'a script-only job keeps its stored prompt and model')
})

// ── P6 C21 profile config + model ────────────────────────────────────────

test('P6 load: describe + catalog on the bot route (foreground), catalog servers after configured ones', async () => {
  const calls = []
  const request = async (bot, method, params, options) => {
    calls.push({ method, params, options })
    if (method === 'profiles.describe') return { model: { provider: 'p', default: 'm' }, soul: 'S', skills: [{ name: 'a', enabled: true }], toolsets: [], mcp_servers: [{ name: 'fs', enabled: false }] }
    return { servers: [{ name: 'fs' }, { name: 'gh', requires: ['TOKEN'] }] }
  }
  const state = await loadAdvanced(request, { name: 'scout' })
  assert.deepEqual(calls.map(c => [c.method, c.params, c.options]), [
    ['profiles.describe', { name: 'scout' }, { spawnPriority: 'foreground' }],
    ['mcp.catalog', { profile: 'scout' }, { spawnPriority: 'foreground' }]
  ])
  assert.deepEqual(state.mcp.map(m => [m.name, m.enabled, Boolean(m.fromCatalog)]), [['fs', false, false], ['gh', false, true]])
  assert.ok(mcpNeedsSetup(state.mcp[1]))
  assert.equal(state.model, 'm')
})

test('P6 apply: only dirty sections; all-or-none toolsets clear the pin; empty model unsets via cli.exec', async () => {
  const state = {
    provider: '',
    model: '',
    soul: 'me',
    skills: [{ name: 'a', enabled: false }, { name: 'b', enabled: true }],
    toolsets: [{ name: 't1', enabled: true }, { name: 't2', enabled: false }],
    mcp: [{ name: 'fs', enabled: true }],
    dirtyModel: true,
    dirtySoul: true,
    dirtySkills: true,
    dirtyToolsets: true,
    dirtyMcp: false
  }
  const { payload, clearModel } = advancedPayload({ name: 'scout' }, state, s => `${s}+P`)
  assert.deepEqual(payload, { name: 'scout', soul: 'me+P', disabled_skills: ['a'], enabled_toolsets: ['t1'] })
  assert.ok(clearModel)
  const calls = []
  const res = await applyAdvancedConfig(async (b, m, p) => (calls.push([m, p]), m === 'cli.exec' ? { code: 0 } : { applied: { soul: true, skills: true, toolsets: true } }), { name: 'scout' }, state, { ensureSoul: s => s })
  assert.deepEqual(calls[0], ['cli.exec', { argv: ['--profile', 'scout', 'config', 'unset', 'model'] }])
  assert.ok(res.ok)
})

test('C21 model switch needing confirmation re-sends only the model with confirm_expensive_model', async () => {
  const calls = []
  const request = async (b, m, p) => {
    calls.push(p)
    return p.confirm_expensive_model ? { applied: { model: true } } : { applied: {}, confirm_required: true, confirm_message: 'Costly' }
  }
  const state = { ...{ provider: 'p', model: 'big' }, soul: '', skills: [], toolsets: [], mcp: [], dirtyModel: true }
  const asked = []
  const res = await applyAdvancedConfig(request, { name: 'scout' }, state, { confirm: async msg => (asked.push(msg), true) })
  assert.deepEqual(asked, ['Costly'])
  assert.deepEqual(calls[1], { name: 'scout', model: 'big', provider: 'p', confirm_expensive_model: true })
  assert.ok(res.ok)
  const declined = await applyAdvancedConfig(request, { name: 'scout' }, state, { confirm: async () => false })
  assert.equal(declined.confirmation.accepted, false)
  assert.ok(providerMatches({ slug: 'nous', aliases: ['n'] }, 'n'))
  await assert.rejects(boundedFetch(new Promise(() => undefined), 5), /did not answer/)
  assert.deepEqual(skillsSearchParams(' web '), { action: 'search', query: 'web' })
  assert.deepEqual(skillsInstallParams({ name: 'scout' }, 'x/y'), { action: 'install', query: 'x/y', profile: 'scout' })
})

// ── P4 screen ────────────────────────────────────────────────────────────

test('P4 display.* rides the bot route with the route\'s profile; events must match connection + profile key', async () => {
  const seen = []
  const host = { requestProfile: async (route, method, params) => (seen.push([route, method, params]), {}) }
  await displayRequest(host, remote('alpha', { route: { connectionId: 'mini', mode: 'remote', profile: 'alpha', targetProfile: 'default' } }), 'display.status', { profile: 'evil' })
  assert.equal(seen[0][2].profile, 'default', 'a caller param never overrides the route')
  await displayRequest(host, { name: 'loc' }, 'display.start')
  assert.equal(seen[1][0], 'loc')
  await assert.rejects(displayRequest(host, { name: 'x', sourceScoped: true, route: {} }, 'display.status'), /no connection owner/)
  const bot = remote('alpha')
  assert.ok(isEventForBotScreen(bot, { connectionId: 'mini', payload: { profile_key: 'k' } }, 'k'))
  assert.ok(!isEventForBotScreen(bot, { connectionId: 'other', payload: { profile_key: 'k' } }, 'k'))
  assert.ok(!isEventForBotScreen(bot, { connectionId: 'mini', payload: { profile_key: 'k2' } }, 'k'))
})

test('P4 lease: viewer hash identity, older epochs and superseded replies dropped, eviction budget', async () => {
  const hash = await viewerHash('viewer-1')
  assert.match(hash, /^[0-9a-f]{12}$/)
  assert.ok(leaseHeldBy({ holder: 'human', viewer_hash: hash }, { id: 'viewer-1', hash }))
  assert.ok(!leaseHeldBy({ holder: 'agent', viewer_hash: hash }, { id: 'viewer-1', hash }))
  const store = createScreenStore()
  const r1 = store.beginRequest()
  store.setStatus({ running: true, supported: true, installed: true, lease: { holder: 'agent', epoch: 2 } }) // pushed event
  assert.equal(store.setStatus({ running: false, lease: { holder: 'agent', epoch: 1 } }, r1), false, 'superseded reply dropped')
  assert.equal(screenPhase(store.get()), 'running')
  assert.equal(store.setLease({ holder: 'human', epoch: 1 }), false, 'older epoch dropped')
  assert.ok(store.setLease({ holder: 'human', epoch: 3 }))
  assert.deepEqual(handBackParams({ id: 'v' }), { viewer_id: 'v' })
  assert.deepEqual(handBackParams({ id: 'v' }, true), { force: true })
  let e = { count: 0 }
  for (let i = 0; i < 4; i += 1) e = nextEviction(e.count, NOW, NOW + 100)
  assert.ok(e.giveUp)
  assert.equal(nextEviction(5, NOW, NOW + 20_000).count, 1)
  assert.equal(screenPhase({ status: { supported: true, installed: false } }), 'not-installed')
  const url = await resolveScreenWsUrl(async (scope, path) => `wss://h/api/ws?token=x&p=${scope.profile}`.replace('/api/ws', path), bot0(), 'T')
  assert.equal(url, 'wss://h/api/display/ws?token=x&p=alpha&display_ticket=T')
})

function bot0() {
  return remote('alpha')
}

// ── C25 usage ────────────────────────────────────────────────────────────

test('C25 usage: events for the open runtime only, merged, labelled like the status bar', () => {
  assert.equal(usageFromEvent({ type: 'session.usage', session_id: 'other', payload: { usage: {} } }, 'rt'), null)
  const u = usageFromEvent({ type: 'session.usage', session_id: 'rt', payload: { usage: { context_used: 12_400, context_max: 200_000, context_percent: 6 } } }, 'rt')
  const merged = mergeUsage({ cost_usd: 0.5, model: 'm' }, u)
  assert.equal(usageContextLabel(merged), '12k/200k')
  assert.equal(costLabel(merged), '$0.50')
  assert.equal(usageContextLabel({ total: 1500 }), '1.5k tok')
  assert.equal(costLabel({}), '')
})
