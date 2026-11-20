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
/**
 * The body of a confirmed Remove from Slack: the connection the window's last
 * status showed (its key, app_id and record_rev). The server refuses it if
 * this bot's connection is another one by now.
 */
export function removalBody(status) {
  const pick = name => (status && typeof status === 'object' && name in status ? status[name] : null)
  return { confirm: true, key: pick('key'), app_id: pick('app_id'), record_rev: pick('record_rev') }
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

/** Who can talk to the bot in Slack. The default lets the whole team in. */
export const ACCESS_CHOICES = Object.freeze([
  { id: 'members', label: 'Everyone in the workspace', hint: 'Full members only: not guests, not Slack Connect people from other companies. Kept up to date as people join or leave.' },
  { id: 'owner', label: 'Only me', hint: 'Only you, the person who adds it.' },
  { id: 'list', label: 'Only these people', hint: 'Slack member IDs, separated by commas (Slack: profile → ⋮ → Copy member ID). You are always included.' }
])
const MEMBER_ID = /^[UW][A-Z0-9]{1,31}$/
/** The access part of a connect or change request, or an error message. */
export function accessBody(mode, listText) {
  const access = ACCESS_CHOICES.some(c => c.id === mode) ? mode : 'members'
  if (access !== 'list') return { body: { access } }
  const ids = String(listText || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean)
  if (!ids.length) return { error: 'Add at least one Slack member ID' }
  const bad = ids.filter(x => !MEMBER_ID.test(x))
  if (bad.length) return { error: `Not a Slack member ID: ${bad.slice(0, 3).join(', ')}` }
  return { body: { access, allowed: ids.join(',') } }
}
/** The access choices a bot can offer: "Only me" needs a known installer. */
export function accessChoices(ownerKnown = true) {
  return ACCESS_CHOICES.filter(c => c.id !== 'owner' || ownerKnown)
}
/**
 * The effective audience from the add-on's status (access.effective_access):
 * one line, the member-list health as a separate line, each extra grant with
 * its source and how to change it, the legacy state of a bot connected
 * before team access, and a welcome DM that could not be sent.
 */
export function audienceView(status) {
  const a = status?.audience
  if (!a || typeof a !== 'object' || typeof a.text !== 'string') return null
  const grants = Array.isArray(a.grants) ? a.grants.filter(g => g && typeof g.what === 'string') : []
  const legacy = status?.legacy && typeof status.legacy === 'object' ? status.legacy : null
  return {
    text: a.text,
    open: a.open === true,
    sync: typeof a.sync?.text === 'string' ? a.sync.text : '',
    stale: a.sync?.stale === true || typeof a.sync?.error === 'string',
    grants: grants.map(g => ({ what: g.what, source: String(g.source || ''), how: String(g.how_to_change || '') })),
    legacy: legacy ? { text: String(legacy.text || ''), ids: Array.isArray(legacy.ids) ? legacy.ids.filter(x => MEMBER_ID.test(x)) : [] } : null,
    ownerKnown: status?.owner_known !== false,
    welcomeError: status?.welcome === 'failed' ? String(status.welcome_error || 'unknown error') : ''
  }
}

export { isSlackAuthorizationUrl } from './urls.js'
