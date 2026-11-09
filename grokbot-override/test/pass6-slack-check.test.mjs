// Pass 6 A: "Test connection" through the slack-check add-on
// (../slack-check/dashboard/plugin_api.py, GET /api/plugins/slack-check/test).

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runSlackCheck,
  slackCheckConnectionKey,
  slackCheckFresh,
  slackCheckMissing,
  slackCheckRequest,
  slackCheckVerdict,
  slackErrorText,
  slackLogLine,
  SLACK_CHECK_HINT,
  SLACK_CHECK_MISSING_TTL_MS,
  SLACK_CHECK_OK_TTL_MS
} from '../src/core/slack.js'

const REMOTE = { connectionId: 'home-server', profile: 'scholar' }
const LOCAL = { profile: 'security' }
const BOT_TOKEN = 'xoxb-' + '0000000000-0000000000000-fakefakefakefake'
const APP_TOKEN = 'xapp-' + '1-A0TEST0000-0000000000000-fakefakefakefakefake'

// run_check()'s answer for a working bot, as the add-on returns it.
const NOV9 = new Date(2026, 10, 9, 14, 0).getTime()
const OK = {
  ok: true,
  configured: true,
  bot: '@scholar',
  bot_id: 'B0TEST',
  team: 'Acme Studio',
  team_id: 'T0TEST',
  url: 'https://acme-studio.slack.com/',
  app_token_ok: true,
  last_log: { ts: '2026-11-09 13:40:02,113', text: '[Slack] Socket Mode connected' }
}

test('the request: GET on the bot’s own connection and profile, like every other Slack call', () => {
  assert.deepEqual(slackCheckRequest(REMOTE), { connectionId: 'home-server', profile: 'scholar', priority: 'foreground', path: '/api/plugins/slack-check/test', method: 'GET' })
  assert.deepEqual(slackCheckRequest(LOCAL), { profile: 'security', priority: 'foreground', path: '/api/plugins/slack-check/test', method: 'GET' })
  assert.equal(slackCheckConnectionKey(REMOTE), 'home-server')
  assert.equal(slackCheckConnectionKey(LOCAL), 'local')
})

test('success: Works · <bot> in <team>, App connection OK, the last log line', async () => {
  const seen = []
  const check = await runSlackCheck(async request => (seen.push(request), OK), REMOTE)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].path, '/api/plugins/slack-check/test')
  assert.equal(seen[0].profile, 'scholar')
  assert.equal(seen[0].connectionId, 'home-server')
  assert.deepEqual(slackCheckVerdict(check, NOV9), {
    tone: 'ok',
    message: 'Works · @scholar in Acme Studio',
    lines: ['App connection OK'],
    log: 'Last connected 13:40'
  })
  // The spec's {at, text} spelling reads the same.
  assert.equal(slackCheckVerdict({ kind: 'ok', result: { ...OK, last_log: { at: '2026-11-08 09:05:00', text: '[Slack] Authenticated as @scholar' } } }, NOV9).log, 'Last connected 2026-11-08 09:05')
  assert.deepEqual(slackCheckVerdict({ kind: 'ok', result: { ok: true, configured: true, bot: '@k' } }).lines, [], 'no app line without an app token')
  assert.deepEqual(slackCheckVerdict({ kind: 'ok', result: { ...OK, app_token_ok: false, app_token_error: 'invalid_auth' } }).lines, ['App connection failed: Slack does not accept this bot token'])
})

test('ok:false: the error in plain words', async () => {
  const verdict = async answer => slackCheckVerdict(await runSlackCheck(async () => answer, LOCAL))
  assert.deepEqual(await verdict({ ok: false, configured: true, error: 'invalid_auth' }), { tone: 'error', message: 'Slack does not accept this bot token', lines: [], log: '' })
  assert.equal((await verdict({ ok: false, configured: true, error: 'token_revoked' })).message, 'This bot token was revoked in Slack')
  assert.equal((await verdict({ ok: false, configured: false })).message, 'No Slack bot token is saved for this bot')
  assert.equal((await verdict({ ok: false, configured: true, error: 'http_503' })).message, 'Slack answered with HTTP 503')
  assert.equal((await verdict({ ok: false, configured: true, error: 'network: timed out' })).message, 'Could not reach Slack (timed out)')
  assert.equal((await verdict({ ok: false, configured: true, error: 'some_new_code' })).message, 'Slack said: some new code')
  assert.equal(slackErrorText(''), 'Slack did not say what went wrong')
})

test('404 or a missing route: not installed (the hint), never an error', async () => {
  const electron404 = new Error(`Error invoking remote method 'hermes:api': Error: 404: ${JSON.stringify({ detail: 'Not Found' })}`)
  assert.equal(slackCheckMissing(electron404), true)
  assert.equal(slackCheckMissing(Object.assign(new Error('nope'), { status: 404 })), true)
  assert.equal(slackCheckMissing(new Error('Not Found')), true)
  assert.equal(slackCheckMissing(new Error('500: boom')), false)
  const check = await runSlackCheck(async () => {
    throw electron404
  }, REMOTE)
  assert.deepEqual(check, { kind: 'missing' })
  assert.deepEqual(slackCheckVerdict(check), { tone: 'note', message: SLACK_CHECK_HINT, lines: [], log: '' })
  assert.equal(SLACK_CHECK_HINT, 'Install the Slack check add-on for a live test')
  // A route that answers with something else (an HTML fallback page) is not the add-on.
  assert.deepEqual(await runSlackCheck(async () => '<!doctype html>', REMOTE), { kind: 'missing' })
  // Any other failure is a failed check with a readable message.
  const failed = await runSlackCheck(async () => {
    throw new Error('500: {"detail":"boom"}')
  }, REMOTE)
  assert.equal(failed.kind, 'failed')
  assert.equal(slackCheckVerdict(failed).message, 'boom')
})

test('no token-like text is ever rendered', async () => {
  const answers = [
    { ok: false, configured: true, error: `network: refused ${BOT_TOKEN}` },
    { ok: true, configured: true, bot: `@x ${BOT_TOKEN}`, team: APP_TOKEN, app_token_ok: false, app_token_error: `bad ${APP_TOKEN}`, last_log: { ts: '', text: `[Slack] Authenticated as ${BOT_TOKEN}` } },
    { ok: false, configured: true, error: 'xoxp-1234-5678-abcdefabcdef xoxe-1-abcdefghijkl' }
  ]
  for (const answer of answers) {
    const verdict = slackCheckVerdict(await runSlackCheck(async () => answer, LOCAL))
    const text = JSON.stringify(verdict)
    assert.ok(!/xox[a-z]-|xapp-/.test(text), text)
  }
  const thrown = slackCheckVerdict(
    await runSlackCheck(async () => {
      throw new Error(`502: {"detail":"upstream said ${BOT_TOKEN}"}`)
    }, LOCAL)
  )
  assert.ok(!JSON.stringify(thrown).includes('xoxb-'))
})

test('the cache: ok for 5 minutes, not installed for 10, failures never', () => {
  const at = 1_000_000
  assert.ok(slackCheckFresh({ kind: 'ok', at }, at + SLACK_CHECK_OK_TTL_MS - 1))
  assert.equal(slackCheckFresh({ kind: 'ok', at }, at + SLACK_CHECK_OK_TTL_MS), null)
  assert.ok(slackCheckFresh({ kind: 'missing', at }, at + SLACK_CHECK_MISSING_TTL_MS - 1))
  assert.equal(slackCheckFresh({ kind: 'missing', at }, at + SLACK_CHECK_MISSING_TTL_MS), null)
  assert.equal(slackCheckFresh({ kind: 'failed', at }, at), null)
  assert.equal(slackCheckFresh(null, at), null)
  assert.equal(SLACK_CHECK_OK_TTL_MS, 5 * 60_000)
  assert.equal(SLACK_CHECK_MISSING_TTL_MS, 10 * 60_000)
})

test('the last log line only when it helps', () => {
  // The live case: an old warning it recovered from, then a test that works.
  const unhealthy = { ts: '2026-11-09 10:24:11,500', text: '[Slack] Socket Mode unhealthy (transport disconnected)' }
  assert.equal(slackCheckVerdict({ kind: 'ok', result: { ...OK, last_log: unhealthy } }, NOV9).log, '', 'hidden after a test that works')
  // The same warning after a failed test is the likely reason.
  assert.equal(
    slackCheckVerdict({ kind: 'failed', result: { ok: false, configured: true, error: 'invalid_auth', last_log: unhealthy } }, NOV9).log,
    'Likely reason: [Slack] Socket Mode unhealthy (transport disconnected) (10:24)'
  )
  // Connected / authenticated: when it last connected.
  assert.equal(slackLogLine({ ts: '2026-11-09 13:40:02,113', text: '[Slack] Socket Mode connected' }, true, NOV9), 'Last connected 13:40')
  assert.equal(slackLogLine({ ts: '2026-11-09 13:40:02,113', text: '[Slack] Authenticated as @k' }, false, NOV9), 'Last connected 13:40')
  assert.equal(slackLogLine(null, true, NOV9), '')
  assert.equal(slackLogLine({ ts: '', text: '[Slack] something else' }, false, NOV9), '')
})
