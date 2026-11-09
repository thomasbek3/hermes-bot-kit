// Add to Slack, pure half (core/slack.js): the manifest, token checks, card
// visibility, the REST bodies and the save / test / restart / pairing flow,
// against fakes shaped from Hermes's messaging, pairing and actions routers
// (web_routers/messaging.py:974,1033,1239; actions.py:160;
// apps/desktop/src/api/messaging.ts:153-175). The card and dialog through the
// built plugin: slack-loader*.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  gatewayRestartRequest,
  gatewayStatusRequest,
  hiddenKeysFrom,
  pairingApproveRequest,
  pendingSlackPairings,
  restFailure,
  saveSlackTokens,
  slackAlreadySet,
  slackCardVisible,
  slackConnectedText,
  slackCreateAppUrl,
  slackHasLiveRow,
  slackManifest,
  SLACK_BOT_SCOPES,
  slackPanelCard,
  slackPlatformFrom,
  slackRowMessage,
  slackServed,
  slackStatus,
  slackStatusRows,
  slackSaveRequest,
  slackTestVerdict,
  slackTokenError,
  testSlack,
  waitForSlackConnected,
  withoutSecrets
} from '../src/core/slack.js'
// Look-alike values only: right prefix, never a real token.
import { APP, BOT, slackEntry } from './slack-fakes.mjs'

const SCOPE = { connectionId: 'home-server', profile: 'scholar' }

test('manifest: agent view, the agent scopes and events, socket mode, no slash commands', () => {
  const m = slackManifest('Scholar')
  assert.deepEqual(m._metadata, { major_version: 1, minor_version: 1 })
  assert.equal(m.display_information.name, 'Scholar')
  assert.equal(m.display_information.description, 'Scholar, your Hermes bot')
  assert.equal(m.display_information.background_color, '#1a1a2e')
  assert.deepEqual(m.features.bot_user, { display_name: 'Scholar', always_online: true })
  assert.deepEqual(m.features.app_home, { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false })
  assert.deepEqual(m.features.agent_view, { agent_description: 'Chat with Hermes in Slack Messages.' })
  assert.ok(!('slash_commands' in m.features), 'slash commands omitted')
  assert.ok(!('assistant_view' in m.features), 'not the assistant experience')
  assert.deepEqual(m.oauth_config.scopes.bot, [...SLACK_BOT_SCOPES])
  assert.deepEqual(m.settings.event_subscriptions.bot_events, [
    'app_context_changed', 'app_home_opened', 'app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim', 'reaction_added', 'reaction_removed'
  ])
  assert.equal(m.settings.socket_mode_enabled, true)
  assert.equal(m.settings.interactivity.is_enabled, true)
  assert.equal(m.settings.org_deploy_enabled, false)
  assert.equal(m.settings.token_rotation_enabled, false)
})

test('manifest scopes: Hermes’s agent-view set plus the owner’s fleet extras, exactly, sorted and unique', () => {
  const want = [
    'app_mentions:read', 'assistant:write', 'canvases:write', 'channels:history', 'channels:read', 'chat:write', 'commands', 'files:read',
    'files:write', 'groups:history', 'groups:read', 'groups:write', 'groups:write.invites', 'groups:write.topic', 'im:history', 'im:read',
    'im:write', 'mpim:history', 'mpim:read', 'reactions:read', 'usergroups:read', 'usergroups:write', 'users:read'
  ]
  assert.deepEqual([...SLACK_BOT_SCOPES], want)
  assert.deepEqual([...SLACK_BOT_SCOPES].sort(), want, 'sorted')
  assert.equal(new Set(SLACK_BOT_SCOPES).size, want.length, 'unique')
  // Hermes's agent-view set (slack_cli.py) is all in there.
  for (const scope of ['app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'commands', 'files:read', 'files:write', 'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write', 'mpim:history', 'mpim:read', 'reactions:read', 'users:read', 'assistant:write']) {
    assert.ok(SLACK_BOT_SCOPES.includes(scope), scope)
  }
  assert.ok(Object.isFrozen(SLACK_BOT_SCOPES))
})

test('manifest: app name cut to 35, display name to 80, description to 140 (code points)', () => {
  const long = 'B'.repeat(200)
  const m = slackManifest(long)
  assert.equal(m.display_information.name, 'B'.repeat(35))
  assert.equal(m.features.bot_user.display_name, 'B'.repeat(80))
  assert.equal(m.display_information.description.length, 140)
  const emoji = '🤖'.repeat(40)
  const e = slackManifest(emoji)
  assert.equal(Array.from(e.display_information.name).length, 35, 'a surrogate pair counts once, as in Python')
  assert.equal(Array.from(e.features.bot_user.display_name).length, 40)
  assert.equal(slackManifest('').display_information.name, 'Hermes')
})

test('create-app link carries the url-encoded manifest', () => {
  const url = slackCreateAppUrl('Scholar')
  const prefix = 'https://api.slack.com/apps?new_app=1&manifest_json='
  assert.ok(url.startsWith(prefix))
  assert.deepEqual(JSON.parse(decodeURIComponent(url.slice(prefix.length))), slackManifest('Scholar'))
  assert.equal(new URL(url).searchParams.get('new_app'), '1')
})

test('token prefixes are checked client side, and messages never echo the value', () => {
  assert.equal(slackTokenError('app', APP), null)
  assert.equal(slackTokenError('bot', BOT), null)
  assert.equal(slackTokenError('bot', `  ${BOT}  `), null, 'surrounding spaces are trimmed')
  assert.match(slackTokenError('app', ''), /paste/i)
  assert.match(slackTokenError('app', BOT), /xapp-/)
  assert.match(slackTokenError('bot', APP), /xoxb-/)
  assert.match(slackTokenError('bot', 'xoxp-' + '0000000000-0000000000-fake'), /xoxb-/, 'a user token is refused')
  assert.match(slackTokenError('bot', 'xoxb-12'), /whole/)
  assert.match(slackTokenError('app', 'xapp-1 A0TEST 0000 fakefake'), /whole/)
  for (const kind of ['app', 'bot']) for (const v of [APP, BOT, 'xoxb-short']) assert.ok(!String(slackTokenError(kind, v) || '').includes(v))
})

test('card: shows only for a loaded answer listing Slack as not set up, and not when hidden', () => {
  const key = 'home-server::scholar'
  const loaded = platform => ({ key, loading: false, loaded: true, error: null, platform })
  assert.equal(slackCardVisible(loaded(slackEntry()), key, []), true)
  assert.equal(slackCardVisible(loaded(slackEntry()), key, [key]), false, 'Hide')
  assert.equal(slackCardVisible(loaded(slackEntry()), key, ['local::scholar']), true, 'hidden per route key, not per name')
  assert.equal(slackCardVisible(loaded(slackEntry({ configured: true, enabled: true, state: 'connected' })), key, []), false)
  assert.equal(slackCardVisible(loaded(slackEntry({ configured: true, enabled: false, state: 'disabled' })), key, []), false)
  const partial = slackEntry()
  partial.env_vars[1] = { ...partial.env_vars[1], is_set: true }
  assert.equal(slackAlreadySet(partial), true, 'one saved token is never overwritten from the card')
  assert.equal(slackCardVisible(loaded(partial), key, []), false)
  assert.equal(slackCardVisible(loaded(null), key, []), false, 'no Slack in the catalog')
  assert.equal(slackCardVisible({ key, loading: true, loaded: false, error: null, platform: null }, key, []), false)
  assert.equal(slackCardVisible({ key, loading: false, loaded: false, error: 'boom', platform: null }, key, []), false)
  assert.equal(slackCardVisible(loaded(slackEntry()), 'local::security', []), false, 'another bot’s answer')
  assert.equal(slackPlatformFrom({ platforms: [{ id: 'telegram' }, slackEntry()] }).id, 'slack')
  assert.equal(slackPlatformFrom({}), null)
  assert.deepEqual(hiddenKeysFrom(['a', 'a', '', 3, 'b']), ['a', 'b'])
  assert.deepEqual(hiddenKeysFrom('a'), [])
})

test('PUT body: exactly the two env keys plus enabled, on the route-scoped profile', () => {
  const req = slackSaveRequest(SCOPE, { appToken: ` ${APP} `, botToken: BOT })
  assert.equal(req.method, 'PUT')
  assert.equal(req.path, '/api/messaging/platforms/slack')
  assert.equal(req.connectionId, 'home-server')
  assert.equal(req.profile, 'scholar')
  assert.deepEqual(Object.keys(req.body).sort(), ['enabled', 'env'])
  assert.deepEqual(req.body, { env: { SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP }, enabled: true })
  const local = slackSaveRequest({ profile: 'security' }, { appToken: APP, botToken: BOT })
  assert.ok(!('connectionId' in local))
})

test('save: 409 shows the conflict detail; hot_served false/true; bad tokens never reach the server', async () => {
  const detail = "Cannot enable 'slack' on profile 'scholar': gateway.multiplex_profiles is on"
  const calls = []
  const conflict = async req => {
    calls.push(req)
    throw new Error(`Error invoking remote method 'hermes:api': Error: 409: ${JSON.stringify({ detail })}`)
  }
  await assert.rejects(saveSlackTokens(conflict, SCOPE, { appToken: APP, botToken: BOT }), err => err.message === detail)
  assert.equal(calls.length, 1)

  assert.deepEqual(await saveSlackTokens(async () => ({ ok: true, platform: 'slack', hot_served: true }), SCOPE, { appToken: APP, botToken: BOT }), { hotServed: true })
  assert.deepEqual(await saveSlackTokens(async () => ({ ok: true, platform: 'slack', hot_served: false }), SCOPE, { appToken: APP, botToken: BOT }), { hotServed: false })
  assert.deepEqual(await saveSlackTokens(async () => ({ ok: true, platform: 'slack' }), SCOPE, { appToken: APP, botToken: BOT }), { hotServed: false })

  let reached = false
  await assert.rejects(saveSlackTokens(async () => (reached = true), SCOPE, { appToken: BOT, botToken: BOT }), /xapp-/)
  assert.equal(reached, false)

  // A server error that would echo a value never surfaces it.
  const echo = async () => {
    throw new Error(`400: ${JSON.stringify({ detail: `bad value ${BOT}` })}`)
  }
  await assert.rejects(saveSlackTokens(echo, SCOPE, { appToken: APP, botToken: BOT }), err => !err.message.includes(BOT) && err.message.includes('[token]'))
  assert.equal(restFailure(new Error('500: Internal Server Error')).status, 500)
  assert.equal(withoutSecrets('x xoxb-anything-123 y', []), 'x [token] y')
})

test('test POST: a failed check is reported, not thrown', async () => {
  assert.deepEqual(await testSlack(async () => ({ ok: true, state: 'connected', message: 'Slack is connected.' }), SCOPE), { ok: true, state: 'connected', message: 'Slack is connected.' })
  assert.deepEqual(await testSlack(async () => ({ ok: false, state: 'startup_failed', message: 'invalid_auth' }), SCOPE), { ok: false, state: 'startup_failed', message: 'invalid_auth' })
  const thrown = await testSlack(async () => {
    throw new Error('502: {"detail":"Bad gateway"}')
  }, SCOPE)
  assert.deepEqual(thrown, { ok: false, state: null, message: 'Bad gateway' })
  assert.equal(slackConnectedText('Scholar', { hotServed: true }), 'Connected. DM Scholar in Slack.')
  assert.match(slackConnectedText('Scholar', { hotServed: false }), /^Almost done: Scholar’s connection needs a quick restart/)
})

test('restart: POST /api/gateway/restart on the scope; polls every 2 s until connected; times out after 60 s', async () => {
  const req = gatewayRestartRequest(SCOPE)
  assert.deepEqual(req, { connectionId: 'home-server', profile: 'scholar', priority: 'foreground', path: '/api/gateway/restart', method: 'POST' })

  const slept = []
  const sleep = async ms => void slept.push(ms)
  let reads = 0
  const states = ['pending_restart', null, 'connecting', 'connected']
  const call = async request => {
    assert.equal(request.path, '/api/messaging/platforms')
    assert.equal(request.profile, 'scholar')
    assert.equal(request.connectionId, 'home-server')
    const state = states[reads++]
    if (state === null) throw new Error('503: gateway restarting')
    return { platforms: [slackEntry({ configured: true, enabled: true, state })] }
  }
  assert.equal(await waitForSlackConnected(call, SCOPE, { sleep }), 'connected')
  assert.equal(reads, 4)
  assert.deepEqual(slept, [2000, 2000, 2000, 2000])

  slept.length = 0
  reads = 0
  const never = async () => (reads++, { platforms: [slackEntry({ configured: true, enabled: true, state: 'pending_restart' })] })
  assert.equal(await waitForSlackConnected(never, SCOPE, { sleep }), 'timeout')
  assert.equal(reads, 30, '60 s at one read per 2 s')
  assert.equal(slept.reduce((a, b) => a + b, 0), 60_000)

  let n = 0
  assert.equal(await waitForSlackConnected(never, SCOPE, { sleep, cancelled: () => ++n > 2 }), 'cancelled')
})

test('pairing: pending Slack rows only; approve sends platform, request id and the scoped profile', () => {
  const rows = pendingSlackPairings({
    approved: [],
    pending: [
      { platform: 'slack', request_id: 'r1', user_id: 'U1', user_name: 'Alex' },
      { platform: 'telegram', request_id: 'r2', user_id: '9' },
      { platform: 'slack', user_id: 'U3' }
    ]
  })
  assert.deepEqual(rows.map(r => r.request_id), ['r1'])
  assert.deepEqual(pairingApproveRequest(SCOPE, 'r1'), {
    connectionId: 'home-server',
    profile: 'scholar',
    priority: 'foreground',
    path: '/api/pairing/approve',
    method: 'POST',
    body: { platform: 'slack', request_id: 'r1', profile: 'scholar' }
  })
})

// Shapes from home-server (Hermes 2bd378ed1b), read-only, 2026-11-09: one
// multiplexed gateway; its record's platforms are a2a, api_server, buzz,
// feishu, budget:buzz, slack, telegram. The bare `slack` row is a stale
// September row ("disconnected", "stale row from prior gateway pid ...") and
// there is no `intake:slack` row although Intake's Slack is connected. The
// messaging router therefore answers, for profile=intake:
const SERVED = ['default', 'budget', 'helper', 'intake', 'notes', 'planner', 'recipes', 'scholar', 'sunny', 'travel']
const INTAKE_NO_ROW = slackEntry({
  enabled: true, configured: true, gateway_running: true, state: 'pending_restart', error_code: null, error_message: null, updated_at: null,
  home_channel: { platform: 'slack', chat_id: 'C0123456789', name: 'bots' },
  env_vars: [{ key: 'SLACK_BOT_TOKEN', required: true, is_set: true }, { key: 'SLACK_APP_TOKEN', required: true, is_set: true }]
})
const STALE_BARE_ROW = { ...INTAKE_NO_ROW, state: 'disconnected', error_message: 'stale row from prior gateway pid; platform disabled after a host migration', updated_at: '2026-09-06T00:49:03.536975+00:00' }
const MINI_STATUS = { gateway_running: true, gateway_state: 'running', gateway_shared_with: SERVED }
const MINI_PLATFORMS = {
  platforms: [
    { id: 'api_server', enabled: true, configured: true, gateway_running: true, state: 'connected', ingress_url: 'http://192.0.2.10:8642/p/intake/v1' },
    INTAKE_NO_ROW
  ]
}

test('served detection: /api/status gateway_shared_with, else the /p/<profile> mirror', () => {
  assert.equal(slackServed({ status: MINI_STATUS, profile: 'intake' }), true)
  assert.equal(slackServed({ status: MINI_STATUS, profile: 'bouncer' }), false, 'not in the served list')
  assert.equal(slackServed({ status: MINI_STATUS, profile: 'default' }), false, 'the host is not a served secondary')
  assert.equal(slackServed({ status: { ...MINI_STATUS, gateway_running: false }, profile: 'intake' }), false, 'gateway down')
  assert.equal(slackServed({ status: { gateway_running: true, gateway_state: 'running', gateway_shared_with: null }, profile: 'security' }), false, 'standalone gateway')
  assert.equal(slackServed({ status: null, response: MINI_PLATFORMS, profile: 'intake' }), true, 'mirror fallback')
  assert.equal(slackServed({ status: null, response: MINI_PLATFORMS, profile: 'int' }), false, 'exact profile segment')
  assert.equal(slackServed({ status: null, response: { platforms: [INTAKE_NO_ROW] }, profile: 'intake' }), false)
  assert.deepEqual(gatewayStatusRequest({ connectionId: 'home-server', profile: 'intake' }), { connectionId: 'home-server', profile: 'intake', priority: 'foreground', path: '/api/status?profile=intake', method: 'GET' })
})

test('status: a working multiplexed Slack with no per-profile row is Connected (unreported)', () => {
  const opts = { served: true, gateway: MINI_STATUS }
  assert.deepEqual(slackStatus(INTAKE_NO_ROW, opts), { tone: 'ok', label: 'Connected', unreported: true })
  // A stale row (dead state) is ignored, and its message never shown.
  assert.deepEqual(slackStatus(STALE_BARE_ROW, opts), { tone: 'ok', label: 'Connected', unreported: true })
  assert.equal(slackRowMessage(STALE_BARE_ROW), '')
  assert.ok(!slackStatusRows(STALE_BARE_ROW, opts).some(r => r.value.includes('stale')))
  assert.deepEqual(slackStatusRows(INTAKE_NO_ROW, opts).map(r => [r.label, r.value]), [['Status', 'Connected'], ['Gateway', 'Running'], ['Home channel', 'bots']])
})

test('status: a live per-profile row is the truth when it exists', () => {
  const opts = { served: true, gateway: MINI_STATUS }
  const row = over => ({ ...INTAKE_NO_ROW, error_message: null, error_code: null, ...over })
  assert.deepEqual(slackStatus(row({ state: 'connected' }), opts), { tone: 'ok', label: 'Connected', unreported: false })
  assert.deepEqual(slackStatus(row({ state: 'fatal', error_code: 'invalid_auth', error_message: 'invalid_auth' }), opts), { tone: 'error', label: 'Error: invalid_auth', unreported: false })
  assert.equal(slackRowMessage(row({ state: 'fatal', error_message: 'invalid_auth' })), 'invalid_auth')
  assert.deepEqual(slackStatus(row({ state: 'retrying', error_message: 'socket closed' }), opts), { tone: 'error', label: 'Error: socket closed', unreported: false })
  assert.deepEqual(slackStatus(row({ state: 'retrying' }), opts), { tone: 'warn', label: 'Reconnecting…', unreported: false })
  assert.deepEqual(slackStatus(row({ state: 'connecting' }), opts), { tone: 'warn', label: 'Connecting…', unreported: false })
  assert.deepEqual(slackStatus(row({ state: 'paused', error_message: 'rate limited' }), opts), { tone: 'warn', label: 'Paused: rate limited', unreported: false })
  assert.deepEqual(slackStatus(row({ state: 'disabled', error_code: 'multiplex_shared_ingress' }), opts), { tone: 'off', label: 'Off', unreported: false })
  const long = slackStatus(row({ state: 'fatal', error_message: `${'x'.repeat(80)}\nsecond line` }), opts).label
  assert.ok(long.startsWith('Error: ') && long.endsWith('…') && !long.includes('second'))
})

test('status: not served or gateway down is never Connected', () => {
  const standalone = { gateway_running: true, gateway_state: 'running', gateway_shared_with: null }
  assert.deepEqual(slackStatus(INTAKE_NO_ROW, { served: false, gateway: standalone }), { tone: 'error', label: 'Not running', unreported: false })
  assert.deepEqual(slackStatus(STALE_BARE_ROW, { served: false, gateway: standalone }), { tone: 'error', label: 'Not running', unreported: false })
  const down = { gateway_running: false, gateway_state: 'stopped', gateway_shared_with: null }
  assert.deepEqual(slackStatus({ ...INTAKE_NO_ROW, gateway_running: false, state: 'gateway_stopped' }, { served: false, gateway: down }), { tone: 'error', label: 'Gateway stopped', unreported: false })
  assert.deepEqual(slackStatus(INTAKE_NO_ROW, { served: true, gateway: down }), { tone: 'error', label: 'Gateway stopped', unreported: false }, 'the status answer outranks a stale served flag')
  assert.deepEqual(slackStatus({ ...INTAKE_NO_ROW, state: 'startup_failed', gateway_running: false }, {}), { tone: 'error', label: 'Gateway stopped', unreported: false })
  assert.deepEqual(slackStatus({ ...INTAKE_NO_ROW, enabled: false, state: 'disabled' }, { served: true }), { tone: 'off', label: 'Off', unreported: false })
  assert.equal(slackStatus(null), null)
})

test('Test connection only with a live per-profile row', () => {
  assert.equal(slackHasLiveRow(INTAKE_NO_ROW), false, 'served, no row')
  assert.equal(slackHasLiveRow(STALE_BARE_ROW), false, 'a dead row')
  assert.equal(slackHasLiveRow(slackEntry({ state: 'connected' })), true)
  assert.equal(slackHasLiveRow(slackEntry({ state: 'fatal' })), true)
  assert.equal(slackHasLiveRow(null), false)
})

test('test verdict: the endpoint re-reads the recorded status; a served bot without a row is "not confirmed", never "restart"', () => {
  // messaging.py:1280 for a served bot with no row:
  const raw = { ok: false, state: 'pending_restart', message: 'Setup looks complete, but the gateway has not reported a connection yet. Restart the gateway.' }
  const served = slackTestVerdict(raw, { served: true })
  assert.equal(served.tone, 'note')
  assert.match(served.message, /Not confirmed \(state: pending_restart\)/)
  assert.doesNotMatch(served.message, /restart (the|this|now)|needs? a restart/i, 'no restart advice')
  assert.deepEqual(slackTestVerdict(raw, { served: false }), { tone: 'error', message: raw.message }, 'own gateway: the server’s advice stands')
  assert.deepEqual(slackTestVerdict({ ok: true, state: 'connected', message: 'Slack is connected.' }), { tone: 'ok', message: 'Works · Slack is connected.' })
  assert.deepEqual(slackTestVerdict({ ok: false, state: 'fatal', message: 'invalid_auth' }, { served: true }), { tone: 'error', message: 'invalid_auth' })
})

test('one of two: Add to Slack while not set up (unless hidden), the status card once set up, never both', () => {
  const key = 'home-server::scholar'
  const loaded = platform => ({ key, loading: false, loaded: true, error: null, platform })
  const none = slackEntry()
  const connected = slackEntry({ configured: true, enabled: true, state: 'connected' })
  const off = slackEntry({ configured: true, enabled: false, state: 'disabled' })
  assert.equal(slackPanelCard(loaded(none), key, []), 'suggested')
  assert.equal(slackPanelCard(loaded(none), key, [key]), null, 'hidden: neither')
  assert.equal(slackPanelCard(loaded(connected), key, []), 'status')
  assert.equal(slackPanelCard(loaded(connected), key, [key]), 'status', 'Hide only hides the suggestion')
  assert.equal(slackPanelCard(loaded(off), key, []), 'status')
  for (const entry of [none, connected, off]) {
    const card = slackPanelCard(loaded(entry), key, [])
    assert.equal(slackCardVisible(loaded(entry), key, []), card === 'suggested')
  }
  assert.equal(slackPanelCard({ ...loaded(connected), loading: true }, key, []), 'status', 'a re-read keeps the card')
  assert.equal(slackPanelCard({ key, loading: false, loaded: false, error: 'boom', platform: null }, key, []), null)
  assert.equal(slackPanelCard(loaded(connected), 'local::security', []), null, 'another bot’s answer')
  assert.equal(slackPanelCard(loaded(null), key, []), null)
})
