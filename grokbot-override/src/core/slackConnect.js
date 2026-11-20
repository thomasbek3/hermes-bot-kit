// Profile-scoped Slack provisioning. Token values are confined to request bodies.
import { slackCheckMissing, slackError } from './slack.js'

const base = '/api/plugins/slack-connect'
export function connectRequest(scope, route, method = 'GET', body) {
  return { ...(scope.connectionId ? { connectionId: scope.connectionId } : {}), profile: scope.profile,
    priority: 'foreground', path: `${base}/${route}`, method, ...(body === undefined ? {} : { body }) }
}
// One-click readiness from the add-on's status route. A status without a
// readiness report comes from an older add-on that predates it: treat it as ready.
export function slackConnectReady(status) {
  const readiness = status?.readiness
  return !readiness || typeof readiness !== 'object' || readiness.infrastructure_ready !== false
}
const unreachable = error => ({ kind: 'error', message: slackError(error, 'Could not reach the bot’s server. Check its connection and try again.').message })
/**
 * available: the one-click window (it opens on "Connect another workspace" when no
 * workspace token is usable); missing: the add-on is absent, or not ready for a new
 * connection, so the paste-tokens dialog is used; error: the bot's server failed.
 * A bot that is already connected over HTTP stays available so it can be removed.
 */
export async function probeSlackConnect(call, scope) {
  try {
    const workspaces = await call(connectRequest(scope, 'workspaces'))
    if (!Array.isArray(workspaces)) throw new Error('Slack connection returned an invalid response')
    const status = await call(connectRequest(scope, 'status'))
    if (!status || typeof status !== 'object') throw new Error('Slack connection status is unavailable')
    if (!slackConnectReady(status) && (status.phase || 'none') === 'none') return { kind: 'missing' }
    return { kind: 'available', workspaces, status }
  } catch (error) {
    if (!slackCheckMissing(error)) return unreachable(error)
    try {
      const root = { ...scope, profile: 'default' }
      const status = await call(connectRequest(root, 'status'))
      if (status?.mode !== 'bootstrap' || !slackConnectReady(status)) return { kind: 'missing' }
      const workspaces = await call(connectRequest(root, 'workspaces'))
      if (!Array.isArray(workspaces)) throw new Error('Slack connection returned an invalid response')
      return { kind: 'available', workspaces, status: { phase: 'none', readiness: status.readiness }, bootstrap: true }
    } catch (fallbackError) {
      return slackCheckMissing(fallbackError) ? { kind: 'missing' } : unreachable(fallbackError)
    }
  }
}
/** True when no stored workspace token can be used: the window opens on adding one. */
export function needsWorkspace(workspaces) {
  return !Array.isArray(workspaces) || !workspaces.some(w => w && w.ok !== false)
}
export async function bootstrapSlackConnect(call, scope, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  await call(connectRequest({ ...scope, profile: 'default' }, 'bootstrap', 'POST', { profile: scope.profile }))
  for (let attempt = 0; attempt < 20; attempt++) {
    try { return await call(connectRequest(scope, 'status')) }
    catch (error) {
      if (!slackCheckMissing(error) || attempt === 19) throw error
      await delay(500)
    }
  }
}
export function workspaceLabel(workspace, checks = []) {
  const match = checks.find(entry => entry?.result?.team_id === workspace.team_id && entry.result.team)
  return String(workspace.team_name || match?.result?.team || `Slack workspace (${workspace.team_id})`)
}
export function refreshTokenError(value) {
  const s = String(value || '').trim()
  if (!s) return 'Paste the refresh token'
  if (!s.startsWith('xoxe-') || /\s/.test(s) || s.length <= 13) return 'Paste the complete refresh token starting with xoxe-'
  return null
}

export { isSlackAuthorizationUrl } from './urls.js'
