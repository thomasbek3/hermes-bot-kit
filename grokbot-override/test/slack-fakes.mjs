// Fakes for the Add to Slack tests, shaped from Hermes Agent @ 2bd378ed1b:
// GET/PUT /api/messaging/platforms[/slack], POST .../slack/test
// (web_routers/messaging.py:974,1033,1239), GET /api/pairing,
// POST /api/pairing/approve (apps/desktop/src/api/messaging.ts:153-175),
// POST /api/gateway/restart (web_routers/actions.py:160), GET /api/status
// (web_routers/status.py:530: gateway_running, gateway_state, gateway_shared_with),
// and the slack-check add-on's GET /api/plugins/slack-check/test
// (../slack-check/dashboard/plugin_api.py; `check`: its answer, an Error to
// throw, or unset = not installed, a 404 as Electron's transport reports it).

import { waitFor } from './loader-boot.mjs'
import { bootFull, rowButton } from './loader-surfaces.mjs'

// Look-alike values only: the right prefixes, never a real token.
export const APP = 'xapp-' + '1-A0TEST0000-0000000000000-fakefakefakefakefake'
export const BOT = 'xoxb-' + '0000000000-0000000000000-fakefakefakefake'

export const slackEntry = (over = {}) => ({
  id: 'slack',
  name: 'Slack',
  enabled: false,
  configured: false,
  state: 'not_configured',
  env_vars: [
    { key: 'SLACK_BOT_TOKEN', required: true, is_set: false, redacted_value: null },
    { key: 'SLACK_APP_TOKEN', required: true, is_set: false, redacted_value: null }
  ],
  ...over
})

const ROUTES = ['GET /api/status', 'GET /api/messaging/platforms', 'PUT /api/messaging/platforms/slack', 'POST /api/messaging/platforms/slack/test', 'GET /api/pairing', 'POST /api/pairing/approve', 'POST /api/gateway/restart', 'GET /api/plugins/slack-check/test']

/** A strict fake of each bot's own backend, keyed `<connection>::<profile>`.
 *  A call on any other scope, or any other route, is stray and fails. */
export function slackBackends(initial) {
  const bots = new Map()
  const reset = (key, over = {}) =>
    bots.set(key, { entry: slackEntry(), status: { gateway_running: true, gateway_state: 'running', gateway_shared_with: null }, put: { ok: true, platform: 'slack', hot_served: false }, restarted: false, pending: [], connectAfterRestart: true, ...over })
  for (const [key, over] of Object.entries(initial)) reset(key, over)
  const log = []
  const stray = []
  const api = async request => {
    const full = String(request.path)
    const [path, query = ''] = full.split('?')
    if (path.startsWith('/api/plugins/slack-connect/')) throw Object.assign(new Error('Not Found'), { status: 404 })
    if (!/^\/api\/(messaging|pairing|gateway|plugins\/slack-check)\//.test(path) && path !== '/api/pairing' && path !== '/api/status') return undefined
    const scope = `${request.connectionId}::${request.profile}`
    const route = `${request.method || 'GET'} ${path}`
    if (path === '/api/status' && new URLSearchParams(query).get('profile') !== request.profile) {
      stray.push(request)
      throw new Error(`status for the wrong profile: ${full}`)
    }
    const bot = bots.get(scope)
    if (!bot || !ROUTES.includes(route)) {
      stray.push(request)
      throw new Error(`unexpected ${route} on ${scope}`)
    }
    log.push({ scope, route, body: request.body })
    switch (route) {
      case 'GET /api/status':
        return bot.status
      case 'GET /api/messaging/platforms': {
        const state = bot.restarted && bot.connectAfterRestart ? 'connected' : bot.entry.state
        return { platforms: [{ id: 'telegram', configured: false }, { ...bot.entry, state }] }
      }
      case 'PUT /api/messaging/platforms/slack':
        if (bot.put instanceof Error) throw bot.put
        bot.entry = { ...bot.entry, configured: true, enabled: true, state: bot.put.hot_served ? 'connected' : 'pending_restart' }
        return bot.put
      case 'POST /api/gateway/restart':
        bot.restarted = true
        bot.pending = [{ platform: 'slack', request_id: 'req-1', user_id: 'U07', user_name: 'Alex', age_minutes: 0 }]
        return { ok: true, pid: 4242, name: 'gateway-restart' }
      case 'POST /api/messaging/platforms/slack/test':
        return bot.testAnswer || { ok: true, state: 'connected', message: 'Slack is connected.' }
      case 'GET /api/plugins/slack-check/test':
        if (bot.check instanceof Error) throw bot.check
        if (!bot.check) throw new Error(`Error invoking remote method 'hermes:api': Error: 404: ${JSON.stringify({ detail: 'Not Found' })}`)
        return bot.check
      case 'GET /api/pairing':
        return { approved: [], pending: bot.pending }
      case 'POST /api/pairing/approve':
        bot.pending = bot.pending.filter(p => p.request_id !== request.body?.request_id)
        return { ok: true, user: { platform: 'slack', user_id: 'U07' } }
      default:
        return undefined
    }
  }
  return { api, log, stray, bots, reset, routes: scope => log.filter(l => !scope || l.scope === scope).map(l => l.route) }
}

/** The open Slack dialog (kit Sheet: fallback overlay without SDK Dialog). */
export function sheetEl() {
  const all = [...document.querySelectorAll('.gbo-modal-fallback.is-sheet, [role="dialog"]')].filter(el => el.querySelector('.gbo-sheet'))
  return all[all.length - 1] || null
}

export function typeInto(input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

/** Boot (one per test file: the harness opens the chat workspace only on the
 *  first boot in a process), open `name`'s chat and its profile panel. */
export async function bootPanel(t, backend, { storage, name = 'Scholar' } = {}) {
  const booted = await bootFull(t, { primitives: false, api: backend.api, ...(storage ? { storage } : {}) })
  const { panes, workspaces, mount } = booted
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => rowButton(rosterEl, name), `the ${name} row`)).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat workspace')).render)
  const panel = await waitFor(() => {
    if (!chatEl.querySelector('.gbo-panel')) chatEl.querySelector('[aria-label="Show profile"]')?.click()
    return chatEl.querySelector('.gbo-panel')
  }, 'the profile panel')
  return { ...booted, rosterEl, chatEl, panel, panelNow: () => chatEl.querySelector('.gbo-panel') }
}
