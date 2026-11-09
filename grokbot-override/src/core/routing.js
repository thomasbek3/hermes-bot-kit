// Bot routing: which gateway answers an RPC for a roster row.
//
// Port of apps/desktop/src/plugins/hermes-bots/routing.ts (Hermes Agent, MIT,
// (c) Nous Research). The override must reach a bot exactly the way Bot Mode
// does, or "same chat" stops being true: a source-scoped row rides its own
// immutable route through host.requestProfile with `profile` rewritten to the
// route's target profile; a row on the active gateway uses host.request.

/** @typedef {{ connectionId: string, mode: 'local' | 'remote', profile: string, targetProfile: string }} ProfileRoute */

export function botRouteKey(route) {
  return `${route.connectionId}::${route.profile}`
}

/** `not_scoped` (active gateway), `owner_removed` (scoped row lost its
 *  connection) or `resolved` with a frozen route. */
export function resolveBotConnectionRoute(bot) {
  if (!bot?.sourceScoped && !bot?.remoteSource) return { status: 'not_scoped', route: null }

  const candidate = bot.route || {
    connectionId: bot.connectionId,
    mode: bot.connectionKind === 'local' ? 'local' : 'remote',
    profile: bot.name,
    targetProfile: bot.targetProfile || bot.name
  }
  const connectionId = String(candidate?.connectionId || '').trim()
  const profile = String(candidate?.profile || bot?.name || '').trim() || 'default'
  const targetProfile = String(candidate?.targetProfile || profile).trim() || profile

  if (!connectionId) return { status: 'owner_removed', route: null, profile }

  return {
    status: 'resolved',
    route: Object.freeze({
      connectionId,
      mode: candidate.mode === 'local' || connectionId === 'local' ? 'local' : 'remote',
      profile,
      targetProfile
    })
  }
}

export function botConnectionRoute(bot) {
  const resolved = resolveBotConnectionRoute(bot)
  if (resolved.status === 'owner_removed') throw new Error(`Bot ${resolved.profile} has no connection owner`)
  return resolved.route
}

/** Bot Mode's workspace owner key for a bot (`bot:<connection>::<profile>`). */
export function botWorkspaceOwnerKey(bot) {
  const route = resolveBotConnectionRoute(bot).route
  return `bot:${route ? botRouteKey(route) : String(bot?.name || 'default')}`
}

export function backendTargetProfile(route, fallbackProfile = 'default') {
  if (!route) return fallbackProfile
  return route.targetProfile || route.profile
}

function scopedBotParams(route, method, params) {
  const logical = route.profile
  const target = backendTargetProfile(route, logical)
  let next = params
  if (Object.prototype.hasOwnProperty.call(params, 'profile')) next = { ...next, profile: target }
  if (method.startsWith('profiles.') && method !== 'profiles.create' && params.name === logical) {
    next = { ...next, name: target }
  }
  return next
}

/**
 * Why this row cannot be reached by the profile NAME alone on the active
 * gateway, or null when it can. A row with a resolved route is always fine
 * (it carries its connection). A row without one is only safe when it really
 * is the active gateway's own profile: one that names another connection
 * (`connectionId`), is a remote/ghost/retained row, or lost its owner would
 * otherwise be asked for by name on THIS machine, where a same-named profile
 * does not exist (or is a different bot). That is how a remote "helper"
 * became a local "helper": Hermes's host.openSession dials, stamps the
 * session's owner and scopes the workspace to `<active connection>/<profile>`
 * when it gets a profile without a route.
 */
export function botRouteProblem(bot, activeConnectionId) {
  const resolved = resolveBotConnectionRoute(bot)
  if (resolved.route) return null
  const name = String(bot?.name || 'this bot')
  if (resolved.status === 'owner_removed') return `${name} has no connection owner yet; its roster row is still loading`
  if (bot?.remoteSource || bot?.ghost || bot?.retained) return `${name}’s connection is not known yet; its roster row is still loading`
  const own = String(bot?.connectionId || '').trim()
  const active = String(activeConnectionId || '').trim() || 'local'
  if (own && own !== active) return `${name} lives on ${String(bot?.connectionLabel || own)}, and its route there is not known yet`
  return null
}

/**
 * The options for host.openSession that open this bot's stored chat in
 * Hermes Bot Mode WITHOUT moving Hermes's own profile: the exact connection
 * route when the row has one, else (only for the active gateway's own
 * profile, as stock does for those rows) the profile name with
 * keepAllProfilesScope, which dials without switching the workspace.
 * Returns { ok: false, reason } for any row whose route is not known.
 */
export function stockOpenTarget(bot, activeConnectionId) {
  const problem = botRouteProblem(bot, activeConnectionId)
  if (problem) return { ok: false, reason: problem }
  const route = resolveBotConnectionRoute(bot).route
  if (route) return { ok: true, route: { ...route }, profile: route.profile }
  const profile = String(bot?.name || '').trim()
  if (!profile) return { ok: false, reason: 'This bot has no profile name' }
  return { ok: true, route: null, profile }
}

/** True when the bot is served by this machine (a local pool route, or the
 *  active gateway when that gateway is local). */
export function isLocalBot(bot, activeConnectionId) {
  const resolved = resolveBotConnectionRoute(bot)
  if (resolved.route) return resolved.route.mode === 'local'
  const active = String(activeConnectionId || '').trim()
  return !active || active === 'local'
}

function asError(value, fallback) {
  if (value && typeof value === 'object' && typeof value.message === 'string' && value.message.trim()) {
    if (value instanceof Error) return value
    const error = new Error(value.message)
    error.code = value.code
    error.cause = value
    return error
  }
  return new Error(value == null || value === '' ? fallback : String(value))
}

/** Build `requestForBot(bot, method, params, options)` over an SDK host.
 *  Mirrors Bot Mode: scoped rows → host.requestProfile, else host.request.
 *  With `activeConnectionId` (a getter), a row whose route is not known is
 *  refused instead of being asked for by name on the active gateway
 *  (botRouteProblem): a chat must never resolve, create or send on the
 *  wrong machine. */
export function createBotRequester(host, { activeConnectionId } = {}) {
  return async function requestForBot(bot, method, params = {}, options = {}) {
    if (typeof activeConnectionId === 'function') {
      const problem = botRouteProblem(bot, activeConnectionId())
      if (problem) {
        const error = new Error(problem)
        error.code = 'GBO_NO_ROUTE'
        throw error
      }
    }
    const route = botConnectionRoute(bot)
    if (route) {
      if (typeof host.requestProfile !== 'function') {
        throw new Error(`Cannot route ${method} for ${route.connectionId}::${route.profile}`)
      }
      const routed = scopedBotParams(route, method, params)
      try {
        if (options.spawnPriority) {
          return await host.requestProfile(route, method, routed, options.timeoutMs, { spawnPriority: options.spawnPriority })
        }
        return options.timeoutMs === undefined
          ? await host.requestProfile(route, method, routed)
          : await host.requestProfile(route, method, routed, options.timeoutMs)
      } catch (error) {
        throw asError(error, `Gateway request ${method} failed`)
      }
    }
    try {
      return options.timeoutMs === undefined
        ? await host.request(method, params)
        : await host.request(method, params, options.timeoutMs)
    } catch (error) {
      throw asError(error, `Gateway request ${method} failed`)
    }
  }
}

/**
 * Hold the bot's route open for a session-scoped sequence (review r2 #4).
 * Resolves a release, or rejects when the route needs a hold that cannot be
 * had: the caller must then make no session-scoped call (a runtime minted on
 * an unheld pooled socket is reaped between calls).
 *
 * - A row on the active gateway: its socket lives as long as the window; no-op.
 * - host.retainProfile (#93602): the host itself returns a no-op for local and
 *   primary routes; a failure is a real failure and is passed on.
 * - Older hosts: a local route does not depend on renderer pins (host docs for
 *   retainProfileSocket); a remote one is held by host.retainProfileSocket,
 *   the relay pin that keeps the pooled socket open. With neither, the route
 *   cannot be held: rejects with code GBO_NO_RETENTION.
 */
export async function retainBotRoute(host, bot, options) {
  const noop = () => undefined
  const resolved = resolveBotConnectionRoute(bot)
  if (resolved.status === 'not_scoped') return noop
  if (!resolved.route) throw new Error(`Bot ${resolved.profile} has no connection owner`)
  const route = resolved.route
  if (typeof host?.retainProfile === 'function') {
    const release = await host.retainProfile(route, options)
    if (typeof release !== 'function') throw new Error('the host returned no connection lease')
    return release
  }
  if (route.mode === 'local') return noop
  if (typeof host?.retainProfileSocket === 'function') {
    const release = host.retainProfileSocket(route)
    if (typeof release === 'function') return release
  }
  const error = new Error('this Hermes build cannot keep a remote bot connection open; use Hermes Bot Mode')
  error.code = 'GBO_NO_RETENTION'
  throw error
}

/** The REST scope for a bot: Electron's `hermes:api` routes `connectionId`
 *  to that source and `profile` to that backend. */
export function botRestScope(bot, activeConnectionId) {
  const route = resolveBotConnectionRoute(bot).route
  if (route) return { connectionId: route.connectionId, profile: backendTargetProfile(route, bot.name) }
  const problem = botRouteProblem(bot, activeConnectionId)
  if (problem) throw new Error(problem)
  const active = String(activeConnectionId || '').trim()
  return { ...(active ? { connectionId: active } : {}), profile: String(bot?.name || 'default') }
}
