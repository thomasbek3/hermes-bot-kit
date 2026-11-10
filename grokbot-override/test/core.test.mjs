import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { findCanonicalChat, isCanonicalBotChatRow, openedSessionId, CANONICAL_CHAT_TITLE } from '../src/core/canonical.js'
import { chatUserBubbleColors, contrastRatio } from '../src/core/colors.js'
import { historyToItems, toMillis } from '../src/core/history.js'
import { botMeta, buildSections, displayName, mergeRoster, previewOf, readStockRoster, rowKey } from '../src/core/roster.js'
import { backendTargetProfile, botRestScope, botWorkspaceOwnerKey, createBotRequester, isLocalBot, resolveBotConnectionRoute } from '../src/core/routing.js'
import { shortAge, withDividers } from '../src/core/time.js'

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const REMOTE = {
  name: 'scholar',
  connectionId: 'home-server',
  connectionKind: 'ssh',
  remoteSource: true,
  sourceScoped: true,
  route: { connectionId: 'home-server', mode: 'remote', profile: 'scholar', targetProfile: 'scholar' }
}
const ACTIVE = { name: 'budget' }

// ── routing ───────────────────────────────────────────────────────────────

test('scoped rows ride their own route; active-gateway rows use host.request', async () => {
  const calls = []
  const host = {
    requestProfile: async (route, method, params, timeoutMs, options) => {
      calls.push({ via: 'profile', route, method, params, timeoutMs, options })
      return { ok: 1 }
    },
    request: async (method, params, timeoutMs) => {
      calls.push({ via: 'active', method, params, timeoutMs })
      return { ok: 2 }
    }
  }
  const request = createBotRequester(host)
  const alias = { ...REMOTE, route: { ...REMOTE.route, targetProfile: 'default' } }

  await request(alias, 'session.list', { profile: 'scholar', title: 'Bot Chat' }, { spawnPriority: 'foreground' })
  await request(ACTIVE, 'cron.manage', { action: 'list', profile: 'budget' })

  assert.equal(calls[0].via, 'profile')
  assert.equal(calls[0].params.profile, 'default', 'profile param is rewritten to the route target')
  assert.deepEqual(calls[0].options, { spawnPriority: 'foreground' })
  assert.equal(calls[1].via, 'active')
  assert.equal(calls[1].params.profile, 'budget')
})

test('a scoped row that lost its connection refuses instead of guessing', async () => {
  const request = createBotRequester({ request: async () => ({}) })
  await assert.rejects(request({ name: 'x', sourceScoped: true }, 'session.list', {}), /no connection owner/)
})

test('route helpers match Bot Mode: owner key, target profile, REST scope, locality', () => {
  assert.equal(botWorkspaceOwnerKey(REMOTE), 'bot:home-server::scholar')
  assert.equal(botWorkspaceOwnerKey(ACTIVE), 'bot:budget')
  assert.equal(backendTargetProfile(resolveBotConnectionRoute(REMOTE).route, 'x'), 'scholar')
  assert.deepEqual(botRestScope(REMOTE, 'local'), { connectionId: 'home-server', profile: 'scholar' })
  assert.deepEqual(botRestScope(ACTIVE, null), { profile: 'budget' })
  assert.equal(isLocalBot(REMOTE, 'local'), false)
  assert.equal(isLocalBot(ACTIVE, null), true)
})

// ── canonical lookup (cases from canonical-chat-registry.test.ts) ─────────

test('opens the lineage tip of the exact "Bot Chat" row', async () => {
  const seen = []
  const request = async (bot, method, params, options) => {
    seen.push({ method, params, options })
    return { sessions: [{ id: 'side', title: 'Side chat' }, { id: 'root', resolved_id: 'tip', message_count: 10, title: 'Bot Chat' }] }
  }
  const row = await findCanonicalChat(request, { name: 'ops' })
  assert.equal(row.id, 'root')
  assert.equal(openedSessionId(row), 'tip')
  assert.deepEqual(seen[0].params, { profile: 'ops', title: CANONICAL_CHAT_TITLE, limit: 200, include_hidden: true })
  assert.deepEqual(seen[0].options, { spawnPriority: 'foreground' })
})

test('root_title identifies a compressed Bot Chat; a retitled row does not', () => {
  assert.equal(isCanonicalBotChatRow({ id: 'root-1', root_title: 'Bot Chat', title: 'Bot Chat (2)' }), true)
  assert.equal(isCanonicalBotChatRow({ id: 'x', root_title: 'Other', title: 'Bot Chat' }), false)
  assert.equal(isCanonicalBotChatRow({ id: 'y', title: 'Bot Chat' }), true)
})

test('fails closed: a failed lookup or an empty answer for a known chat is never "no chat"', async () => {
  const failing = async () => {
    throw { message: 'gateway restarting' }
  }
  await assert.rejects(findCanonicalChat(failing, { name: 'ops' }), /Could not check ops's Bot Chat registry \(gateway restarting\)/)

  const empty = async () => ({ sessions: [] })
  await assert.rejects(findCanonicalChat(empty, { name: 'ops', canonical_session: { id: 'forever-chat' } }), /Could not confirm/)
  assert.equal(await findCanonicalChat(empty, { name: 'fresh' }), null)
})

test('the lookup never creates: only session.list is ever called', async () => {
  const methods = []
  await findCanonicalChat(async (bot, method) => {
    methods.push(method)
    return { sessions: [] }
  }, { name: 'fresh' })
  assert.deepEqual(methods, ['session.list'])
})

// ── history ───────────────────────────────────────────────────────────────

test('REST rows become bubbles, tool groups and notices; hidden and system rows are skipped', () => {
  const { rest } = fixture('history-rest.json')
  const items = historyToItems(rest)
  assert.deepEqual(
    items.map(i => i.kind),
    ['user', 'assistant', 'tools', 'assistant', 'user', 'notice']
  )
  assert.equal(items[2].tools.length, 1)
  assert.equal(items[2].tools[0].id, 'tc')
  assert.match(items[2].tools[0].label, /terminal: ls notes\//)
  assert.equal(items[3].text, 'The lake cabin sleeps four.')
  assert.equal(items[3].reasoning, 'Look it up.')
  assert.equal(items[4].text, 'how is it going?', 'display_content wins over raw content')
  assert.equal(items[5].text, 'Background task finished', 'a background card shows a short label')
  assert.equal(items[5].title, 'Background job finished', 'its line is the tooltip')
  assert.equal(items[0].at, 1762560000 * 1000)
})

test('the resume projection (text, name, context) normalises the same way', () => {
  const { resume } = fixture('history-rest.json')
  const items = historyToItems(resume)
  assert.deepEqual(items.map(i => i.kind), ['user', 'tools', 'assistant'])
  assert.equal(items[1].tools[0].label, 'web search: hermes desktop')
  assert.equal(toMillis(1762560000123), 1762560000123)
})

// ── roster ────────────────────────────────────────────────────────────────

test('merge: active rows keep rich fields and gain a route; other sources join as remote rows', () => {
  const local = { profiles: [{ name: 'default', canonical_session: { id: 'c0' } }, { name: 'budget', canonical_session: { id: 'c1', preview: 'hi' } }] }
  const union = {
    agents: [
      { connectionId: 'local', connectionKind: 'local', profile: 'budget', handle: 'budget' },
      { connectionId: 'home-server', connectionKind: 'ssh', connectionLabel: 'HOME-SERVER', profile: 'scholar', handle: 'scholar', profileMetadata: { display_name: 'Scholar' } }
    ]
  }
  const rows = mergeRoster(local, union, null)
  const budget = rows.find(r => r.name === 'budget')
  assert.equal(budget.canonical_session.id, 'c1')
  assert.deepEqual(budget.route, { connectionId: 'local', mode: 'local', profile: 'budget', targetProfile: 'budget' })
  const remote = rows.find(r => r.name === 'scholar')
  assert.equal(remote.remoteSource, true)
  assert.equal(remote.display_name, 'Scholar')
  assert.equal(rowKey(remote), 'home-server::scholar')
})

test("reads Bot Mode's own roster cache, preferring the active connection's fresh entry", () => {
  const now = 1_000_000
  const queries = [
    { queryKey: ['hermes-bots', 'roster', 'other'], state: { data: { profiles: [{ name: 'x' }] }, dataUpdatedAt: now - 100 } },
    { queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: [{ name: 'a' }, { name: 'b' }], sources: [] }, dataUpdatedAt: now - 5_000 } },
    { queryKey: ['hermes-bots', 'groups'], state: { data: { profiles: [] }, dataUpdatedAt: now } }
  ]
  const client = { getQueryCache: () => ({ findAll: () => queries }) }
  const snap = readStockRoster(client, null, now)
  assert.equal(snap.profiles.length, 2)
  assert.equal(snap.fresh, true)
  assert.equal(readStockRoster(client, null, now + 60_000).fresh, false)
  assert.equal(readStockRoster(null, null), null)
})

test('sections: the roster\'s own sections first, then Bot Mode user sections, then connections; hidden bots stay out', () => {
  const rows = [
    { name: 'helper' },
    { name: 'budget' },
    { name: 'secret' },
    { name: 'scholar', remoteSource: true, connectionLabel: 'HOME-SERVER', connectionId: 'home-server', connectionKind: 'ssh' }
  ]
  const meta = { helper: { sectionName: 'Ops' }, secret: { hidden: true }, budget: { pinned: true } }
  const metaFor = bot => meta[bot.name] || {}

  const own = { version: 1, sections: [{ id: 'm', name: 'Money', collapsed: false }], assign: { budget: 'm' } }
  const kit = buildSections(rows, { metaFor, sections: own })
  assert.deepEqual(kit.map(s => [s.name, s.bots.map(b => b.name)]), [['Money', ['budget']], ['Ops', ['helper']], ['Unassigned', ['scholar']]])
  assert.equal(kit[0].own, true)

  const user = buildSections(rows, { metaFor, sections: null })
  assert.deepEqual(user.map(s => s.name), ['Ops', 'Unassigned'])
  assert.deepEqual(user[1].bots.map(b => b.name), ['budget', 'scholar'], 'pinned first')

  const plain = buildSections(rows, { metaFor: () => ({}), sections: null, query: 'schol' })
  assert.deepEqual(plain.map(s => [s.name, s.bots.length]), [['HOME-SERVER', 1]])
})

test('meta, names and previews come from the same fields Bot Mode reads', () => {
  const bot = { ...REMOTE, ui_meta: { 'hermes-bots': { title: 'Server Title', color: '#ff0000' } }, canonical_session: { preview: 'last  line', last_active: 1762560000 } }
  const meta = botMeta(bot, { 'home-server::scholar': { title: 'Local Title' } })
  assert.equal(meta.title, 'Local Title')
  assert.equal(meta.color, '#ff0000')
  assert.equal(displayName(bot, meta), 'Local Title')
  assert.equal(displayName({ name: 'default' }, {}), 'Hermes')
  assert.deepEqual(previewOf(bot), { preview: 'last line', at: 1762560000 * 1000 })
})

// ── colours (adapted from rakazo packages/core/src/bot-avatar-colors.test.ts, Apache-2.0) ─

test('user bubbles in the bot colour reach AA contrast under white text', () => {
  for (const hex of ['#EF4444', '#FFD60A', '#34C759', '#5AC8FA', '#FF3B30', '#8b5cf6']) {
    const colors = chatUserBubbleColors(hex)
    assert.ok(colors, hex)
    assert.equal(colors.foreground, '#FFFFFF')
    assert.ok(contrastRatio(colors.background, '#FFFFFF') >= 4.5, `${hex} -> ${colors.background}`)
  }
  assert.equal(chatUserBubbleColors('#ffffff'), undefined)
  assert.equal(chatUserBubbleColors('not-a-colour'), undefined)
})

// ── time ──────────────────────────────────────────────────────────────────

test('dividers mark the first item, a new day, and gaps of an hour', () => {
  const day = new Date(2026, 10, 8, 9, 0).getTime()
  const items = [
    { id: 'a', at: day },
    { id: 'b', at: day + 5 * 60_000 },
    { id: 'c', at: day + 2 * 3_600_000 },
    { id: 'd', at: day + 26 * 3_600_000 }
  ]
  const out = withDividers(items, day + 27 * 3_600_000, 'en-US')
  assert.deepEqual(out.map(i => i.kind || i.id), ['divider', 'a', 'b', 'divider', 'c', 'divider', 'd'])
  assert.match(out[0].label, /^Yesterday /)
  assert.match(out[5].label, /^Today /)
  assert.equal(shortAge(day, day + 30_000), 'now')
  assert.equal(shortAge(day, day + 5 * 60_000), '5m')
})

// ── cron (same calls as Bot Mode's cron.tsx) ──────────────────────────────

test('cron: list is a read with include_disabled; toggle pauses active and resumes paused jobs', async () => {
  const { cronListParams, cronToggleParams, sortJobs } = await import('../src/core/cron.js')
  const bot = { name: 'security' }
  assert.deepEqual(cronListParams(bot), { action: 'list', include_disabled: true, profile: 'security' })
  assert.deepEqual(cronToggleParams(bot, { job_id: 'j1', enabled: true }), { action: 'pause', name: 'j1', profile: 'security' })
  assert.deepEqual(cronToggleParams(bot, { job_id: 'j2', state: 'paused' }), { action: 'resume', name: 'j2', profile: 'security' })
  assert.deepEqual(cronToggleParams(bot, { job_id: 'j3', enabled: false }).action, 'resume')
  const sorted = sortJobs([
    { job_id: 'p', name: 'Paused', enabled: false },
    { job_id: 'b', name: 'B', next_run_at: '2026-11-09T10:00:00Z' },
    { job_id: 'a', name: 'A', next_run_at: '2026-11-09T09:00:00Z' }
  ])
  assert.deepEqual(sorted.map(j => j.job_id), ['a', 'b', 'p'])
})
