// "Add to Slack" for one bot: the app manifest, the token checks, the REST
// requests and the reading of their answers. Pure; ui/slackActions.ts makes
// the calls on the bot's own connection and profile (routing.js botRestScope).
//
// Facts from Hermes Agent (MIT, (c) Nous Research) @ 2bd378ed1b:
//   - manifest: hermes_cli/slack_cli.py _build_full_manifest with
//     messaging_experience="agent" (the experience new Slack apps must use),
//     rebuilt here without slash_commands.
//   - GET  /api/messaging/platforms            {platforms:[{id, configured, enabled, state, env_vars}]}
//   - PUT  /api/messaging/platforms/slack      {env, enabled} -> {ok, platform, hot_served}; 409 = multiplex conflict
//   - POST /api/messaging/platforms/slack/test -> {ok, state, message}
//     (hermes_cli/web_routers/messaging.py:974,1033,1239)
//   - GET  /api/pairing                        {approved, pending:[{platform, request_id, user_id, user_name}]}
//   - POST /api/pairing/approve                {platform, request_id, profile}
//     (apps/desktop/src/api/messaging.ts:153-175)
//   - POST /api/gateway/restart                -> {ok, pid, name}: `hermes gateway restart
//     --interrupt` for the scoped profile (web_routers/actions.py:160;
//     apps/desktop/src/api/system.ts:148 restartGateway). It cuts off any reply
//     in progress, so it is only ever sent from the user's Restart now click.
// The profile rides in the request scope, as the Desktop's own messaging calls
// do (api/client.ts profileScoped); Electron's hermes:api adds `?profile=`
// where the backend needs it (connection-config.ts pathForRegistryBackendRequest).
// Token values are only ever placed in the PUT body: never logged, stored or
// put in an error message.

export const SLACK_PLATFORM = 'slack'
export const SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN'
export const SLACK_APP_TOKEN = 'SLACK_APP_TOKEN'
export const SLACK_HIDDEN_KEY = 'slackCardHidden'
export const SLACK_PAIRING_POLL_MS = 3_000
export const SLACK_PAIRING_POLL_MAX_MS = 2 * 60_000
export const SLACK_RESTART_POLL_MS = 2_000
export const SLACK_RESTART_POLL_MAX_MS = 60_000
export const SLACK_NEW_APP_URL = 'https://api.slack.com/apps'

/** The manifest's bot scopes: Hermes's agent-view set (slack_cli.py
 *  _build_full_manifest) plus the extras the owner's existing Slack bots were
 *  granted (canvases:write, groups:write*, usergroups:*). Sorted, unique. */
export const SLACK_BOT_SCOPES = Object.freeze([
  'app_mentions:read',
  'assistant:write',
  'canvases:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'commands',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'groups:write',
  'groups:write.invites',
  'groups:write.topic',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'usergroups:read',
  'usergroups:write',
  'users:read'
])

const BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'reaction_added',
  'reaction_removed',
  // agent experience
  'app_context_changed',
  'app_home_opened'
]

/** Python's `s[:n]`: cut by code points, not UTF-16 units. */
function cut(text, n) {
  return Array.from(String(text)).slice(0, n).join('')
}

// Python's sorted() on ASCII strings is the same as a code-unit sort.
const sorted = list => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** The Slack app manifest for a bot (agent view, socket mode, no slash commands). */
export function slackManifest(botName) {
  const name = String(botName || '').trim() || 'Hermes'
  const description = `${name}, your Hermes bot`
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: cut(name, 35),
      description: cut(description, 140),
      background_color: '#1a1a2e'
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: cut(name, 80), always_online: true },
      agent_view: { agent_description: 'Chat with Hermes in Slack Messages.' }
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: sorted(BOT_EVENTS) },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false
    }
  }
}

/** The "create an app from this manifest" link. */
export function slackCreateAppUrl(botName) {
  return `${SLACK_NEW_APP_URL}?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(botName)))}`
}

const TOKEN_RULES = {
  app: { prefix: 'xapp-', label: 'App-level token' },
  bot: { prefix: 'xoxb-', label: 'Bot token' }
}

/** Why a pasted token is not usable, or null. `kind` is 'app' or 'bot'.
 *  The message never contains the value. */
export function slackTokenError(kind, value) {
  const rule = TOKEN_RULES[kind]
  if (!rule) return 'Unknown token'
  const text = String(value ?? '').trim()
  if (!text) return `Paste the ${rule.label.toLowerCase()}`
  if (!text.startsWith(rule.prefix)) return `The ${rule.label.toLowerCase()} starts with ${rule.prefix}`
  if (/\s/.test(text) || text.length <= rule.prefix.length + 8) return `That does not look like a whole ${rule.label.toLowerCase()}`
  return null
}

/** The Slack entry of a GET /api/messaging/platforms answer, or null. */
export function slackPlatformFrom(response) {
  const list = Array.isArray(response?.platforms) ? response.platforms : []
  const entry = list.find(p => p && typeof p === 'object' && String(p.id || '') === SLACK_PLATFORM)
  return entry || null
}

/** Whether the profile already has Slack set up (any token saved counts:
 *  the card must never offer to overwrite one). */
export function slackAlreadySet(entry) {
  if (!entry) return false
  if (entry.configured === true) return true
  const vars = Array.isArray(entry.env_vars) ? entry.env_vars : []
  return vars.some(v => (v?.key === SLACK_BOT_TOKEN || v?.key === SLACK_APP_TOKEN) && v?.is_set === true)
}

/** The stored list of route keys whose card is hidden. */
export function hiddenKeysFrom(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(v => typeof v === 'string' && v))]
}

/** Which Slack card the panel draws for this bot: 'suggested' (Add to Slack,
 *  unless hidden) while the profile has no Slack, 'status' (Slack · <status>)
 *  once it has, null otherwise. Never both. Only for a loaded answer about
 *  this very bot that lists Slack. */
export function slackPanelCard(state, key, hidden) {
  if (!key || !state || state.key !== key || state.error || !state.loaded || !state.platform) return null
  if (slackAlreadySet(state.platform)) return 'status'
  return hiddenKeysFrom(hidden).includes(key) ? null : 'suggested'
}

export function slackCardVisible(state, key, hidden) {
  return slackPanelCard(state, key, hidden) === 'suggested'
}

function short(text, max = 48) {
  const line = String(text || '').split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

// ── live status ──────────────────────────────────────────────────────────
// What Hermes @2bd378ed1b exposes, and why the payload's `state` alone is
// wrong for multiplexed bots:
//  - One multiplexed gateway serves named profiles ("served secondaries").
//    On a successful connect it logs "✓ slack connected (profile: x)" but
//    writes NO `x:slack` row (gateway/run_adapters.py:1316-1341); only
//    failures (`x:slack` fatal / retrying, :1191, run_adapters_recovery.py:49)
//    and disabled (:1211, :1222) are written. The messaging router then finds
//    no row and reports `pending_restart` for a working adapter.
//  - Rows outlive their writer (a stale bare `slack` row from a migration
//    stays in gateway_state.json), and `writer_pid` is stripped from every
//    public payload (web_routers/status.py:207 _PRIVATE_PLATFORM_ENTRY_KEYS),
//    so a client cannot compare it with the live gateway pid. The live
//    gateway only ever writes connected / connecting / retrying / fatal /
//    paused / disabled; `disconnected` and `stopped` are dead rows (Hermes's
//    own readers: web_server_gateway.py:78, gateway_multiplex_served.py:89),
//    so those are treated as no live row and their error text is never shown.
//  - GET /api/status?profile=<p> (web_routers/status.py:530) gives
//    gateway_running, gateway_state and gateway_shared_with: the served
//    profiles of the multiplexer that carries <p>, non-null only for a
//    profile it serves (status.py:376-380).

/** GET /api/status for the bot's own profile (liveness + served list). */
export function gatewayStatusRequest(scope) {
  return scoped(scope, { path: `/api/status?profile=${encodeURIComponent(scope.profile)}`, method: 'GET' })
}

/** Rows the live gateway writes; anything else is a dead row. */
const LIVE_ROW_STATES = new Set(['connected', 'connecting', 'retrying', 'fatal', 'paused', 'disabled'])
const DEAD_ROW_STATES = new Set(['disconnected', 'stopped'])

/** Whether `profile` is a secondary the live multiplexer serves: named in
 *  /api/status gateway_shared_with while the gateway runs; or, without a
 *  status answer, the default listener's /p/<profile> mirror in the platforms
 *  answer (gateway/status.py shared_listener_mirror_platforms). */
export function slackServed({ status, response, profile } = {}) {
  const name = String(profile || '').trim()
  if (!name || name === 'default') return false
  if (status && typeof status === 'object' && 'gateway_running' in status) {
    return status.gateway_running === true && Array.isArray(status.gateway_shared_with) && status.gateway_shared_with.map(String).includes(name)
  }
  const list = Array.isArray(response?.platforms) ? response.platforms : []
  const marker = `/p/${name}`
  return list.some(p => {
    const url = typeof p?.ingress_url === 'string' ? p.ingress_url : ''
    if (!url || p?.gateway_running !== true) return false
    try {
      const path = new URL(url).pathname
      return path === marker || path.startsWith(`${marker}/`)
    } catch {
      return false
    }
  })
}

/** The Slack card's status. `entry` = the platforms payload's Slack entry;
 *  `gateway` = /api/status for the profile (may be null); `served` =
 *  slackServed(). Returns {tone: ok | off | warn | error, label, unreported}
 *  (`unreported`: Connected inferred because Hermes records no live row). */
export function slackStatus(entry, { served = false, gateway = null } = {}) {
  if (!entry) return null
  const rawState = String(entry.state || '')
  const deadRow = DEAD_ROW_STATES.has(rawState)
  const state = deadRow ? '' : rawState
  const message = deadRow ? '' : short(entry.error_message)
  const running = typeof gateway?.gateway_running === 'boolean' ? gateway.gateway_running : entry.gateway_running
  if (entry.enabled === false || state === 'disabled') return { tone: 'off', label: 'Off', unreported: false }
  if (entry.configured === false || state === 'not_configured') return { tone: 'warn', label: 'Setup incomplete', unreported: false }
  if (running === false || state === 'gateway_stopped') return { tone: 'error', label: 'Gateway stopped', unreported: false }
  if (state === 'startup_failed') return { tone: 'error', label: `Error: ${message || 'startup failed'}`, unreported: false }
  if (LIVE_ROW_STATES.has(state)) {
    switch (state) {
      case 'connected':
        return { tone: 'ok', label: 'Connected', unreported: false }
      case 'connecting':
        return { tone: 'warn', label: 'Connecting…', unreported: false }
      case 'paused':
        return { tone: 'warn', label: message ? `Paused: ${message}` : 'Paused', unreported: false }
      case 'retrying':
        return message ? { tone: 'error', label: `Error: ${message}`, unreported: false } : { tone: 'warn', label: 'Reconnecting…', unreported: false }
      default:
        return { tone: 'error', label: `Error: ${message || short(entry.error_code || 'adapter failed')}`, unreported: false }
    }
  }
  // No live row (pending_restart, a dead row, or nothing).
  if (served) return { tone: 'ok', label: 'Connected', unreported: true }
  return { tone: 'error', label: 'Not running', unreported: false }
}

/** A row's error text, only when the row is one the live gateway writes
 *  (never a dead row's leftover message). */
export function slackRowMessage(entry) {
  const state = String(entry?.state || '')
  if (!entry || DEAD_ROW_STATES.has(state)) return ''
  return String(entry.error_message || '').trim()
}

/** Whether the payload's Slack entry is a row the live gateway writes for
 *  this profile. Only then can Hermes's test (which re-reads the recorded
 *  status, messaging.py:1239) give a real answer, so the status sheet offers
 *  Test connection only for such a row. */
export function slackHasLiveRow(entry) {
  return Boolean(entry) && LIVE_ROW_STATES.has(String(entry.state || ''))
}

/** What a test POST result says. The endpoint (messaging.py:1239) does not
 *  contact Slack: it re-reads the same recorded status. For a served bot
 *  without a live row it answers ok:false / pending_restart with "Restart
 *  the gateway" (messaging.py:1280), which is wrong advice there; that case
 *  is shown plainly as unconfirmed, never as a restart prompt.
 *  Returns {tone: ok | note | error, message}. */
export function slackTestVerdict(test, { served = false } = {}) {
  if (!test) return null
  const state = test.state ? String(test.state) : ''
  if (test.ok) return { tone: 'ok', message: `Works · ${String(test.message || 'Slack is connected.')}` }
  if (served && (state === 'pending_restart' || DEAD_ROW_STATES.has(state))) {
    return { tone: 'note', message: `Not confirmed (state: ${state}). Hermes’s test reads the recorded status and does not contact Slack; nothing is recorded for bots on a shared gateway unless they fail.` }
  }
  return { tone: 'error', message: String(test.message || 'Slack is not connected.') }
}

/** The sheet's rows: only facts the payload carries. The platforms payload
 *  has no Slack bot or team name today; they show if a later one adds them. */
export function slackStatusRows(entry, { served = false, gateway = null } = {}) {
  if (!entry) return []
  const status = slackStatus(entry, { served, gateway })
  const running = typeof gateway?.gateway_running === 'boolean' ? gateway.gateway_running : entry.gateway_running
  const home = entry.home_channel && typeof entry.home_channel === 'object' ? entry.home_channel : null
  const updated = typeof entry.updated_at === 'string' || typeof entry.updated_at === 'number' ? new Date(entry.updated_at) : null
  return [
    ['Status', status?.label],
    ['Gateway', typeof running === 'boolean' ? (running ? 'Running' : 'Stopped') : null],
    ['Mode', entry.connection_mode === 'http' || entry.mode === 'http' ? 'Events API (HTTPS)' : null],
    ['Bot', entry.bot_name || entry.bot_username || entry.bot_user],
    ['Home channel', home ? String(home.name || home.chat_name || home.chat_id || home.id || '') : null],
    ['Last update', updated && !Number.isNaN(updated.getTime()) ? updated.toLocaleString() : null]
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([label, value]) => ({ label, value: value.trim() }))
}

/** The Slack workspace name, if a payload ever carries one (today's
 *  messaging.py payload has none). */
export function slackWorkspaceName(entry) {
  const name = entry?.team_name || entry?.team || entry?.workspace_name || entry?.workspace
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

export const SLACK_OPEN_URL = 'https://app.slack.com/client'

function scoped(scope, request) {
  return { ...(scope?.connectionId ? { connectionId: scope.connectionId } : {}), profile: scope.profile, priority: 'foreground', ...request }
}

export function slackPlatformsRequest(scope) {
  return scoped(scope, { path: '/api/messaging/platforms', method: 'GET' })
}

/** The PUT that saves both tokens and turns Slack on: exactly two env keys. */
export function slackSaveRequest(scope, { appToken, botToken }) {
  return scoped(scope, {
    path: `/api/messaging/platforms/${SLACK_PLATFORM}`,
    method: 'PUT',
    body: { env: { [SLACK_BOT_TOKEN]: String(botToken).trim(), [SLACK_APP_TOKEN]: String(appToken).trim() }, enabled: true }
  })
}

export function slackTestRequest(scope) {
  return scoped(scope, { path: `/api/messaging/platforms/${SLACK_PLATFORM}/test`, method: 'POST' })
}

export function pairingRequest(scope) {
  return scoped(scope, { path: '/api/pairing', method: 'GET' })
}

/** messaging.ts approvePairing: the profile goes in the body too, which is
 *  where the endpoint reads it. */
export function pairingApproveRequest(scope, requestId) {
  return scoped(scope, {
    path: '/api/pairing/approve',
    method: 'POST',
    body: { platform: SLACK_PLATFORM, request_id: String(requestId), profile: scope.profile }
  })
}

/** Pending first-DM requests from Slack users that can be approved. */
export function pendingSlackPairings(response) {
  const pending = Array.isArray(response?.pending) ? response.pending : []
  return pending.filter(p => p && String(p.platform || '').toLowerCase() === SLACK_PLATFORM && typeof p.request_id === 'string' && p.request_id)
}

/** The HTTP status and server `detail` an api() rejection carries. Electron's
 *  transport rejects with "<status>: <body>" (api-transport.ts
 *  httpStatusError), possibly behind an IPC prefix. */
export function restFailure(error) {
  const message = String(error?.message ?? error ?? '')
  const statusProp = Number(error?.statusCode ?? error?.status)
  const m = /(?:^|\D)([1-5]\d\d): ([\s\S]*)$/.exec(message)
  const status = Number.isInteger(statusProp) && statusProp >= 100 ? statusProp : m ? Number(m[1]) : NaN
  let detail = m ? m[2].trim() : message.trim()
  if (m) {
    try {
      const parsed = JSON.parse(detail)
      if (typeof parsed?.detail === 'string') detail = parsed.detail
      else if (Array.isArray(parsed?.detail)) detail = parsed.detail.map(d => String(d?.msg || d)).join('; ')
    } catch {
      /* plain text body */
    }
  }
  return { status, detail: detail || 'Request failed' }
}

// Slack token shapes (xoxb-/xoxp-/xoxa-/xoxe-…, xapp-…), as the slack-check
// add-on scrubs them (plugin_api.py _TOKEN_RE).
const TOKEN_LIKE = /\b(?:xoxe[.-]|xox[a-z]-|xapp-)[A-Za-z0-9.-]+/g

/** Take every pasted value out of a text before it is shown anywhere. */
export function withoutSecrets(text, secrets) {
  let out = String(text ?? '')
  for (const secret of secrets || []) {
    const s = String(secret ?? '').trim()
    if (s.length >= 4) out = out.split(s).join('[token]')
  }
  return out.replace(TOKEN_LIKE, '[token]')
}

/** POST /api/gateway/restart on the bot's own connection and profile. */
export function gatewayRestartRequest(scope) {
  return scoped(scope, { path: '/api/gateway/restart', method: 'POST' })
}

/** Whether the platforms answer shows Slack live on the bot's gateway. */
export function slackIsConnected(entry) {
  return String(entry?.state || '') === 'connected'
}

/** A failed REST call as an Error a person can read, with every pasted
 *  value taken out. A 409 is the multiplex conflict: its detail as is. */
export function slackError(error, fallback, secrets = []) {
  const { status, detail } = restFailure(error)
  const text = status === 409 ? detail : detail || fallback
  return new Error(withoutSecrets(text || fallback, secrets))
}

/** Save both tokens (PUT). Resolves {hotServed}; rejects with a readable
 *  Error (409: the server's detail). `call` is the bot's REST helper. */
export async function saveSlackTokens(call, scope, tokens) {
  const appError = slackTokenError('app', tokens?.appToken)
  const botError = slackTokenError('bot', tokens?.botToken)
  if (appError || botError) throw new Error(appError || botError)
  let result
  try {
    result = await call(slackSaveRequest(scope, tokens))
  } catch (error) {
    throw slackError(error, 'Could not save the Slack tokens', [tokens.appToken, tokens.botToken])
  }
  if (result && result.ok === false) throw new Error('Hermes did not save the Slack tokens')
  return { hotServed: result?.hot_served === true }
}

/** The token check (POST .../test) as {ok, message}; never rejects. */
export async function testSlack(call, scope) {
  try {
    const result = await call(slackTestRequest(scope))
    return {
      ok: result?.ok === true,
      state: typeof result?.state === 'string' ? result.state : null,
      message: String(result?.message || (result?.ok ? 'Slack is connected.' : 'Slack is not connected yet.'))
    }
  } catch (error) {
    return { ok: false, state: null, message: slackError(error, 'Could not check the Slack tokens').message }
  }
}

/** After a restart: read the platforms every `pollMs` until Slack shows
 *  connected or `maxMs` has passed. Resolves 'connected' | 'timeout' |
 *  'cancelled'. A failed read (the gateway is coming back) just waits. */
export async function waitForSlackConnected(call, scope, { sleep, pollMs = SLACK_RESTART_POLL_MS, maxMs = SLACK_RESTART_POLL_MAX_MS, cancelled = () => false } = {}) {
  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  for (let waited = 0; waited < maxMs; ) {
    await wait(pollMs)
    waited += pollMs
    if (cancelled()) return 'cancelled'
    try {
      if (slackIsConnected(slackPlatformFrom(await call(slackPlatformsRequest(scope))))) return 'connected'
    } catch {
      /* still restarting */
    }
    if (cancelled()) return 'cancelled'
  }
  return 'timeout'
}

/** What the dialog says after the save. */
export function slackConnectedText(botName, result) {
  if (result?.hotServed) return `Connected. DM ${botName} in Slack.`
  return `Almost done: ${botName}’s connection needs a quick restart to pick up Slack`
}

export function slackRestartWarning(botName) {
  return `Any reply ${botName} is writing right now will be cut off.`
}

export const SLACK_RESTART_TIMEOUT_TEXT = 'Still restarting. Check back in a minute'

// ── live test through the slack-check add-on ─────────────────────────────
// Hermes's own POST .../slack/test only re-reads the recorded status. The
// slack-check dashboard plugin (../slack-check, plugin_api.py) asks Slack
// itself from the backend, where the profile's tokens live:
//   GET /api/plugins/slack-check/test (scoped to the profile like every other
//   REST call here) -> {ok, configured, bot, bot_id, team, team_id, url,
//   app_token_ok?, app_token_error?, error?, last_log?: {ts|at, text}}
// Tokens never come back; any token-shaped text is scrubbed again here.
// A 404 (or an answer that is not the add-on's) means it is not installed.

export const SLACK_CHECK_PATH = '/api/plugins/slack-check/test'
export const SLACK_CHECK_OK_TTL_MS = 5 * 60_000
export const SLACK_CHECK_MISSING_TTL_MS = 10 * 60_000
export const SLACK_CHECK_HINT = 'Install the Slack check add-on for a live test'

export function slackCheckRequest(scope) {
  return scoped(scope, { path: SLACK_CHECK_PATH, method: 'GET' })
}

/** The connection a "not installed" answer is cached for (the add-on is
 *  installed per Hermes backend, not per profile). */
export function slackCheckConnectionKey(scope) {
  return String(scope?.connectionId || 'local')
}

const SLACK_ERRORS = {
  invalid_auth: 'Slack does not accept this bot token',
  not_authed: 'No bot token reached Slack',
  account_inactive: 'This Slack app or its workspace is no longer active',
  token_revoked: 'This bot token was revoked in Slack',
  token_expired: 'This bot token has expired',
  no_permission: 'The Slack app is missing a permission',
  missing_scope: 'The Slack app is missing a permission',
  ratelimited: 'Slack is rate-limiting requests; try again in a minute',
  team_access_not_granted: 'The Slack app is not installed in this workspace',
  not_allowed_token_type: 'That token is not a Slack bot token',
  invalid_token: 'That token is not a valid Slack token',
  bad_response: 'Slack sent an answer that could not be read'
}

/** A Slack error code (or the add-on's transport text) in plain words. */
export function slackErrorText(code) {
  const raw = withoutSecrets(String(code ?? '').trim(), [])
  if (!raw) return 'Slack did not say what went wrong'
  if (SLACK_ERRORS[raw]) return SLACK_ERRORS[raw]
  const http = /^http_(\d{3})$/.exec(raw)
  if (http) return `Slack answered with HTTP ${http[1]}`
  if (/^network:/i.test(raw)) return `Could not reach Slack (${raw.replace(/^network:\s*/i, '')})`
  if (/^[a-z_]+$/.test(raw)) return `Slack said: ${raw.replace(/_/g, ' ')}`
  return raw
}

/** Is this answer the add-on's own shape? */
function isCheckAnswer(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.ok === 'boolean'
}

/** A failed call that means "the add-on is not installed": a 404, or a
 *  missing route reported as such. */
export function slackCheckMissing(error) {
  const { status, detail } = restFailure(error)
  if (status === 404) return true
  return !Number.isFinite(status) && /\b404\b|not found|no such route|unknown plugin/i.test(detail)
}

/** Run the add-on's test. Never rejects. Resolves
 *  {kind: 'ok' | 'failed' | 'missing', result?, message?}. */
export async function runSlackCheck(call, scope) {
  let answer
  try {
    answer = await call(slackCheckRequest(scope))
  } catch (error) {
    if (slackCheckMissing(error)) return { kind: 'missing' }
    return { kind: 'failed', message: slackError(error, 'Could not run the Slack check').message }
  }
  if (!isCheckAnswer(answer)) return { kind: 'missing' }
  return { kind: answer.ok ? 'ok' : 'failed', result: answer }
}

/** "13:40" for a log stamp from today, else "2026-11-09 13:40". */
function logClock(stamp, now) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(String(stamp || ''))
  if (!m) return ''
  const today = new Date(now)
  const pad = n => String(n).padStart(2, '0')
  const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  return m[1] === day ? `${m[2]}:${m[3]}` : `${m[1]} ${m[2]}:${m[3]}`
}

/** The add-on's newest log line (plugin_api.py last_log_line matches only
 *  "[Slack] Socket Mode connected", "[Slack] Authenticated as …" and
 *  "[Slack] … unhealthy …"), shown only when it helps:
 *   - connected / authenticated -> "Last connected <time>";
 *   - unhealthy after a failed test -> the likely reason;
 *   - unhealthy after a test that works -> nothing (a warning it recovered
 *     from). */
export function slackLogLine(lastLog, testOk, now = Date.now()) {
  if (!lastLog || typeof lastLog !== 'object') return ''
  const text = withoutSecrets(String(lastLog.text ?? ''), []).trim()
  if (!text) return ''
  const at = logClock(lastLog.at || lastLog.ts, now)
  if (/^\[Slack\] (?:Socket Mode connected|HTTP Events mode ready|Authenticated as)/.test(text)) return at ? `Last connected ${at}` : 'Connected before'
  if (/unhealthy/.test(text)) return testOk ? '' : `Likely reason: ${at ? `${text} (${at})` : text}`
  return ''
}

/** What the sheet shows for a check. {tone: ok | error | note, message,
 *  lines: [], log}. Every string is scrubbed of token-shaped text. */
export function slackCheckVerdict(check, now = Date.now()) {
  if (!check) return null
  const clean = text => withoutSecrets(String(text ?? ''), []).trim()
  if (check.kind === 'missing') return { tone: 'note', message: SLACK_CHECK_HINT, lines: [], log: '' }
  const result = check.result && typeof check.result === 'object' ? check.result : null
  const log = slackLogLine(result?.last_log, check.kind === 'ok', now)
  if (check.kind === 'ok' && result) {
    const bot = clean(result.bot) || 'The bot'
    const team = clean(result.team)
    const lines = []
    if (result.app_token_ok === true) lines.push('App connection OK')
    else if (result.app_token_ok === false) lines.push(`App connection failed: ${slackErrorText(result.app_token_error)}`)
    return { tone: 'ok', message: `Works · ${bot}${team ? ` in ${team}` : ''}`, lines, log }
  }
  if (result) {
    const message = result.configured === false ? 'No Slack bot token is saved for this bot' : slackErrorText(result.error)
    return { tone: 'error', message, lines: [], log }
  }
  return { tone: 'error', message: clean(check.message) || 'Could not run the Slack check', lines: [], log: '' }
}

/** A cached check still fresh at `now`: an ok result for 5 minutes, a
 *  "not installed" for 10. Failures are never cached. */
export function slackCheckFresh(entry, now) {
  if (!entry || typeof entry.at !== 'number') return null
  const ttl = entry.kind === 'ok' ? SLACK_CHECK_OK_TTL_MS : entry.kind === 'missing' ? SLACK_CHECK_MISSING_TTL_MS : 0
  return ttl && now - entry.at < ttl && now >= entry.at ? entry : null
}

/** The Status row while a successful check is cached. */
export function slackCheckedLabel(at) {
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return 'Connected'
  return `Connected · checked ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}
