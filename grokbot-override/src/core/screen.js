// The bot's computer (P4): Bot Screen over the gateway's display.* methods.
// Ports from apps/desktop/src/plugins/hermes-bots (Hermes Agent, MIT,
// (c) Nous Research):
//
//   - viewerHash, leaseHeldBy, isDisplayUnavailable          ← screen-connection.ts:35-66
//   - botScreenRoute, isEventForBotScreen, displayRequest
//     (route owns `profile`)                                 ← screen-connection.ts:76-134
//   - retainBotScreen                                        ← screen-connection.ts:143
//   - resolveScreenWsUrl (resolveSiblingWsUrl + display_ticket) ← screen-connection.ts:166
//   - status/lease ordering (epoch; superseded replies)      ← screen-state.ts
//   - start / takeOver / handBack (force) / image switch     ← screen-pane.tsx:353-430
//   - eviction loop budget, close code 4000, paste cap       ← screen-pane.tsx:60-67
//
// Method names and params are exactly the gateway contract
// (tui_gateway/contracts/display.py).

import { looksUnsupported } from './outcomes.js'
import { resolveBotConnectionRoute } from './routing.js'

export const CLOSE_CONTROL_TAKEN = 4000
export const EVICTION_LOOP_WINDOW_MS = 10_000
export const MAX_RAPID_EVICTIONS = 3
export const MAX_PASTE_CUT_TEXT = 256 * 1024
const VIEWER_HASH_HEX = 12

export async function viewerHash(viewerId, subtle = globalThis.crypto?.subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(viewerId))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, VIEWER_HASH_HEX)
}

export function leaseHeldBy(lease, viewer) {
  if (!lease || !viewer || lease.holder !== 'human') return false
  return lease.viewer_hash === viewer.hash
}

/** Read-only availability of the display tab (outcomes.js looksUnsupported). */
export const isDisplayUnavailable = looksUnsupported

export function isManagedBackend(bot) {
  return bot?.connectionKind === 'cloud'
}

/** A route, the bare profile name (v1 local), or null (owner removed). */
export function botScreenRoute(bot) {
  const resolved = resolveBotConnectionRoute(bot)
  if (resolved.status === 'resolved') return resolved.route
  return resolved.status === 'not_scoped' ? String(bot?.name || 'default') : null
}

/** display.* goes through host.requestProfile with the route's profile;
 *  a caller param never overrides it (screen-connection.ts:123-133). */
export function displayRequest(host, bot, method, params = {}) {
  const route = botScreenRoute(bot)
  if (route === null) return Promise.reject(new Error(`Bot ${bot?.name} has no connection owner`))
  const profile = typeof route === 'string' ? route : route.targetProfile || route.profile
  return host.requestProfile(route, method, { ...params, profile })
}

export function isEventForBotScreen(bot, event, profileKey) {
  if (!profileKey || event?.payload?.profile_key !== profileKey) return false
  const resolved = resolveBotConnectionRoute(bot)
  if (resolved.status === 'owner_removed') return false
  const expected = resolved.route?.connectionId ?? null
  const actual = event?.connectionId ?? null
  return expected === actual || (expected === 'local' && actual === null)
}

export async function retainBotScreen(host, bot) {
  const noop = () => undefined
  const route = botScreenRoute(bot)
  if (typeof host?.retainProfile !== 'function' || route === null) return noop
  try {
    const release = await host.retainProfile(route)
    return typeof release === 'function' ? release : noop
  } catch {
    return noop
  }
}

export async function resolveScreenWsUrl(resolveSiblingWsUrl, bot, ticket) {
  const resolved = resolveBotConnectionRoute(bot)
  if (resolved.status === 'owner_removed') throw new Error(`Bot ${bot?.name} has no connection owner`)
  if (typeof resolveSiblingWsUrl !== 'function') throw new Error('This Hermes Desktop cannot open a screen stream (update Hermes Desktop).')
  const route = resolved.route
  const url = new URL(
    await resolveSiblingWsUrl(
      { connectionId: route?.connectionId ?? null, profile: route?.targetProfile ?? route?.profile ?? bot.name },
      '/api/display/ws',
      { stripGatewayCredential: true }
    )
  )
  url.searchParams.set('display_ticket', ticket)
  return url.toString()
}

/** A lease whose epoch is below the one held is a slower reply about the past. */
export function isOlderLease(held, next) {
  return Boolean(held && next && Number(next.epoch) < Number(held.epoch))
}

/**
 * Per-bot screen state, kept outside React so a reply overtaken by a newer
 * request or a pushed event is dropped (screen-state.ts).
 */
export function createScreenStore() {
  let state = { status: null, lease: null, viewer: null, unavailable: false }
  let generation = 0
  const listeners = new Set()
  const emit = () => {
    for (const l of [...listeners]) l(state)
  }
  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    beginRequest: () => ++generation,
    setStatus(status, request) {
      if (request === undefined) generation += 1
      else if (request !== generation) return false
      const lease = status?.lease && !isOlderLease(state.lease, status.lease) ? status.lease : state.lease
      state = { ...state, status, lease, unavailable: false }
      emit()
      return true
    },
    setLease(lease) {
      if (!lease || isOlderLease(state.lease, lease)) return false
      state = { ...state, lease }
      emit()
      return true
    },
    setViewer(viewer) {
      state = { ...state, viewer }
      emit()
    },
    setUnavailable() {
      state = { status: null, lease: null, viewer: null, unavailable: true }
      emit()
    }
  }
}

/** What the screen view shows for a state (screen-pane.tsx:430-470). */
export function screenPhase(state) {
  const status = state?.status
  if (state?.unavailable) return 'unavailable'
  if (!status) return 'loading'
  if (!status.supported) return 'unsupported'
  if (!status.installed) return 'not-installed'
  if (!status.running && status.image_switch) return 'image-switch'
  if (!status.running) return 'stopped'
  return 'running'
}

/** The eviction loop guard: returns the next count and whether to give up. */
export function nextEviction(count, dialedAt, now = Date.now()) {
  const next = now - dialedAt < EVICTION_LOOP_WINDOW_MS ? count + 1 : 1
  return { count: next, giveUp: next > MAX_RAPID_EVICTIONS }
}

export function handBackParams(viewer, force = false) {
  return force ? { force: true } : { viewer_id: viewer?.id }
}
