// "Add to Slack": the per-bot Slack state behind the Suggested card, its Hide
// link, and the calls the setup dialog makes. Every call goes through the
// bot's own REST scope (rosterActions botScope / botRest), so a bot on another
// machine is set up on that machine's profile. Pure logic: core/slack.js.
// Token values are passed straight from the dialog into the PUT body; nothing
// here logs, stores or keeps them.

import {
  gatewayRestartRequest,
  gatewayStatusRequest,
  hiddenKeysFrom,
  pairingApproveRequest,
  pairingRequest,
  pendingSlackPairings,
  runSlackCheck,
  saveSlackTokens,
  slackCheckConnectionKey,
  slackCheckFresh,
  slackCreateAppUrl,
  slackError,
  slackPlatformFrom,
  slackPlatformsRequest,
  slackServed,
  SLACK_HIDDEN_KEY,
  testSlack,
  waitForSlackConnected
} from '../core/slack.js'
import { bootstrapSlackConnect, connectRequest, probeSlackConnect } from '../core/slackConnect.js'
import { displayName, rowKey } from '../core/roster.js'
import { app, metaFor } from './app'
import { botRest, botScope } from './rosterActions'
import { createStore } from './store'

export interface SlackState {
  key: string
  loading: boolean
  loaded: boolean
  error: null | string
  platform: any | null
  /** GET /api/status for the profile (liveness, served list); null if unread. */
  gateway?: any | null
  /** The profile is a secondary the live multiplexer serves (slackServed). */
  served?: boolean
  connectStatus?: any | null
}

export interface SlackCheckEntry {
  kind: 'ok' | 'missing'
  at: number
  result?: any
}

export const slack = {
  state: createStore<SlackState>({ key: '', loading: false, loaded: false, error: null, platform: null, gateway: null, served: false }),
  /** Route keys whose Suggested card the user hid (plugin storage). */
  hidden: createStore<string[]>([]),
  /** slack-check results this window keeps (core/slack.js slackCheckFresh):
   *  `bot:<route key>` for a successful test (5 min), `conn:<connection>`
   *  for "the add-on is not installed" there (10 min). Never tokens. */
  checks: createStore<Record<string, SlackCheckEntry>>({})
}

const okKey = (bot: any) => `bot:${rowKey(bot)}`
const missingKey = (bot: any) => `conn:${slackCheckConnectionKey(botScope(bot))}`

function cached(key: string, now = Date.now()) {
  return slackCheckFresh(slack.checks.get()[key], now) as SlackCheckEntry | null
}

/** The fresh cached state of the add-on test for this bot. */
export function slackCheckCache(bot: any, now = Date.now()): { missing: boolean; ok: SlackCheckEntry | null } {
  let missing = false
  let ok: SlackCheckEntry | null = null
  try {
    missing = Boolean(cached(missingKey(bot), now))
    ok = cached(okKey(bot), now)
  } catch {
    /* route not known: nothing cached */
  }
  return { missing, ok }
}

/** Test connection: the slack-check add-on on the bot's own route and
 *  profile. Caches ok (per bot) and "not installed" (per connection). */
export async function checkSlackLive(bot: any) {
  const check = await runSlackCheck(botRest, botScope(bot))
  const at = Date.now()
  const key = check.kind === 'missing' ? missingKey(bot) : okKey(bot)
  slack.checks.set(all => {
    const next = { ...all }
    if (check.kind === 'missing') next[key] = { kind: 'missing', at }
    else if (check.kind === 'ok') next[key] = { kind: 'ok', at, result: check.result }
    else delete next[key]
    return next
  })
  return check
}

let generation = 0

/** Read the bot's Slack entry (GET /api/messaging/platforms on its scope). */
export async function loadSlackState(bot: any) {
  const key = rowKey(bot)
  const mine = ++generation
  slack.state.set(s =>
    s.key === key
      ? { ...s, loading: true, error: null }
      : { key, loading: true, loaded: false, error: null, platform: null, gateway: null, served: false }
  )
  const current = () => mine === generation && slack.state.get().key === key
  try {
    const scope = botScope(bot)
    // The platforms answer is required; /api/status only sharpens the
    // status (a failed read leaves the served check to the platforms answer).
    const [response, gateway, connect] = await Promise.all([botRest(slackPlatformsRequest(scope)), botRest(gatewayStatusRequest(scope)).catch(() => null), probeSlackConnect(botRest, scope)])
    if (!current()) return
    const status = gateway && typeof gateway === 'object' && 'gateway_running' in gateway ? gateway : null
    slack.state.set({
      key,
      loading: false,
      loaded: true,
      error: null,
      platform: slackPlatformFrom(response),
      gateway: status,
      served: slackServed({ status, response, profile: scope.profile }),
      connectStatus: connect.kind === 'available' && connect.status?.mode === 'http' ? connect.status : null
    })
  } catch (error: any) {
    if (current()) slack.state.set({ key, loading: false, loaded: false, error: String(error?.message || error), platform: null, gateway: null, served: false })
  }
}

export function loadSlackHidden() {
  try {
    slack.hidden.set(hiddenKeysFrom(app.ctx?.storage?.get?.(SLACK_HIDDEN_KEY, [])))
  } catch {
    slack.hidden.set([])
  }
}

/** Hide this bot's Suggested card (kept per route key in plugin storage). */
export function hideSlackCard(bot: any) {
  const key = rowKey(bot)
  const next = hiddenKeysFrom([...slack.hidden.get(), key])
  slack.hidden.set(next)
  try {
    app.ctx?.storage?.set?.(SLACK_HIDDEN_KEY, next)
  } catch {
    /* this window only */
  }
}

/** Open a link in the user's browser: the host's helper when it has one. */
export function openExternalLink(url: string) {
  const desktop = (globalThis as any).window?.hermesDesktop
  try {
    if (typeof desktop?.openExternal === 'function') {
      void Promise.resolve(desktop.openExternal(url)).catch(() => (globalThis as any).window?.open?.(url, '_blank', 'noopener,noreferrer'))
      return
    }
    ;(globalThis as any).window?.open?.(url, '_blank', 'noopener,noreferrer')
  } catch {
    /* no window */
  }
}

/** The app is named after the bot as the roster shows it. */
export function openSlackCreateApp(bot: any) {
  openExternalLink(slackCreateAppUrl(displayName(bot, metaFor(bot)) || String(bot?.name || '')))
}

/** Save the tokens, then (when the gateway already serves the change) check
 *  them. Resolves {hotServed, test?}; rejects with a readable Error. */
export async function connectSlack(bot: any, tokens: { appToken: string; botToken: string }) {
  const scope = botScope(bot)
  const saved = await saveSlackTokens(botRest, scope, tokens)
  const test = saved.hotServed ? await testSlack(botRest, scope) : null
  void loadSlackState(bot)
  return { ...saved, test }
}

/** The user's Restart now: POST /api/gateway/restart on the bot's scope. */
export async function restartBotGateway(bot: any) {
  const scope = botScope(bot)
  try {
    await botRest(gatewayRestartRequest(scope))
  } catch (error) {
    throw slackError(error, 'Could not restart the gateway')
  }
}

export function waitForSlack(bot: any, cancelled: () => boolean) {
  return waitForSlackConnected(botRest, botScope(bot), { cancelled })
}

export function checkSlack(bot: any) {
  return testSlack(botRest, botScope(bot))
}

export async function readSlackPairings(bot: any) {
  return pendingSlackPairings(await botRest(pairingRequest(botScope(bot))))
}

export async function approveSlackPairing(bot: any, requestId: string) {
  try {
    await botRest(pairingApproveRequest(botScope(bot), requestId))
  } catch (error) {
    throw slackError(error, 'Could not approve that request')
  }
}

/** Provisioning requests always use the bot's own backend and profile. */
export function probeSlackProvisioning(bot: any) {
  return probeSlackConnect(botRest, botScope(bot))
}
export function slackProvisioning(bot: any, route: string, method = 'GET', body?: unknown) {
  return botRest(connectRequest(botScope(bot), route, method, body))
}
export function slackWorkspaceProvisioning(bot: any, bootstrap: boolean, method = 'GET', body?: unknown) {
  const scope = botScope(bot)
  return botRest(connectRequest(bootstrap ? { ...scope, profile: 'default' } : scope, 'workspaces', method, body))
}
export function enableSlackProvisioning(bot: any) {
  return bootstrapSlackConnect(botRest, botScope(bot))
}
