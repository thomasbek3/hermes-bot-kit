// Live regression (2026-11-09, Hermes 0.23.0 = 2bd378ed1b): a remote bot
// ("planner" on the SSH connection home-server, no such profile locally) must
// never reach Hermes as a bare profile name. host.openSession with a profile
// and no route dials, stamps the session's owner and scopes the workspace to
// `<active connection>/planner`, i.e. a LOCAL planner that does not exist (the
// live "Profile 'planner' does not exist" loop). Also: the roster click opens
// the override's own chat, never stock; SSH rows that are merely
// connect-on-demand are not dimmed; the chat tab is captioned with the bot's
// name and the sidebar tab reads "Bots".
//
// Loader-faithful through test/hermes-loader.mjs (via loader-boot.mjs).

import assert from 'node:assert/strict'
import test from 'node:test'

import { deleteBotProfile } from '../src/core/profileOps.js'
import { annotateSources, sourceUnreachable } from '../src/core/roster.js'
import { botRestScope, botRouteProblem, createBotRequester, stockOpenTarget } from '../src/core/routing.js'
import { bootPlugin, LOCAL, READY, REMOTE, waitFor } from './loader-boot.mjs'

const CANONICAL = { id: 'c-root', preview: 'planner preview', last_active: 1762560000 }

/** Planner as a roster row looks before its route has resolved: it names its
 *  connection but carries no route / scope flags. */
const PLANNER_NO_ROUTE = {
  name: 'planner',
  display_name: 'Planner',
  connectionId: 'home-server',
  connectionKind: 'ssh',
  connectionLabel: 'HOME-SERVER',
  canonical_session: CANONICAL
}
const PLANNER = {
  ...PLANNER_NO_ROUTE,
  remoteSource: true,
  sourceScoped: true,
  route: { connectionId: 'home-server', mode: 'remote', profile: 'planner', targetProfile: 'planner' }
}
const ON_DEMAND = [
  { connectionId: 'local', label: 'This Mac', reachable: true },
  // An SSH source that is not the live gateway: reachable false, but
  // available (Bot Mode paints it "On demand", data.ts botSourceStatus).
  { connectionId: 'home-server', label: 'HOME-SERVER', reachable: false, error: 'connect-on-demand' }
]

// ── core seams ───────────────────────────────────────────────────────────

test('a remote row without a route is never reachable by its bare name', async () => {
  assert.match(botRouteProblem(PLANNER_NO_ROUTE, 'local'), /HOME-SERVER/)
  assert.match(botRouteProblem(PLANNER_NO_ROUTE, null), /HOME-SERVER/, 'no active connection means local')
  assert.match(botRouteProblem({ name: 'x', remoteSource: true }, 'local'), /no connection owner/)
  assert.match(botRouteProblem({ name: 'x', ghost: true, connectionId: 'local' }, 'local'), /not known/)
  assert.equal(botRouteProblem(PLANNER, 'local'), null)
  assert.equal(botRouteProblem({ name: 'budget' }, 'local'), null, 'the active gateway’s own profile')
  assert.equal(botRouteProblem({ name: 'budget', connectionId: 'local' }, null), null)
  assert.match(botRouteProblem({ name: 'budget', connectionId: 'local' }, 'home-server'), /This|local/, 'a local row on a remote-primary desktop')

  assert.deepEqual(stockOpenTarget(PLANNER, 'local'), { ok: true, route: PLANNER.route, profile: 'planner' })
  assert.deepEqual(stockOpenTarget({ name: 'budget' }, 'local'), { ok: true, route: null, profile: 'budget' })
  assert.equal(stockOpenTarget(PLANNER_NO_ROUTE, 'local').ok, false)

  const seen = []
  const host = {
    request: async (method, params) => (seen.push(['active', method, params]), {}),
    requestProfile: async (route, method, params) => (seen.push([route.connectionId, method, params]), {})
  }
  const request = createBotRequester(host, { activeConnectionId: () => 'local' })
  await assert.rejects(request(PLANNER_NO_ROUTE, 'session.list', { profile: 'planner' }), err => err.code === 'GBO_NO_ROUTE')
  await request(PLANNER, 'session.list', { profile: 'planner' })
  await request({ name: 'budget' }, 'session.list', { profile: 'budget' })
  assert.deepEqual(seen.map(([via, method]) => `${via}:${method}`), ['home-server:session.list', 'active:session.list'])

  assert.throws(() => botRestScope(PLANNER_NO_ROUTE, 'local'), /HOME-SERVER/, 'no REST read of a same-named local profile')
  await assert.rejects(deleteBotProfile({ request: async () => ({ code: 0 }), deleteProfile: async () => undefined }, PLANNER_NO_ROUTE, 'local'), /HOME-SERVER/, 'never deletes by name on this machine')
})

test('connect-on-demand SSH rows are available, as in Bot Mode; a down source still dims', () => {
  const [row] = annotateSources([PLANNER], ON_DEMAND)
  assert.equal(row.sourceError, 'connect-on-demand')
  assert.equal(sourceUnreachable(row), false)
  assert.equal(sourceUnreachable({ ...PLANNER, sourceReachable: false, sourceError: null }), true)
  assert.equal(sourceUnreachable({ ...PLANNER, sourceMissing: true }), true)
  assert.equal(sourceUnreachable({ ...PLANNER, unserved: true }), true)
})

// ── loader-faithful ──────────────────────────────────────────────────────

// Every host call that can move Hermes's own profile / route or front stock.
const PROFILE_MOVERS = new Set(['openSession', 'newChat', 'setWorkspaceScope', 'switchProfile', 'setActiveProfile', 'ensureGatewayProfile'])

test('loader-faithful: a remote bot whose route is missing/slow never reaches Hermes by name; the roster click stays in the override', { skip: !READY && 'dev dependencies not installed' }, async t => {
  // One mutable array: the stock roster cache and the fake gateway read it.
  const rows = [LOCAL, REMOTE, PLANNER_NO_ROUTE]
  const hostCalls = []
  const { panes, workspaces, mount, calls, errors, sdk } = await bootPlugin(t, {
    rows,
    sources: ON_DEMAND,
    tweak: sdk => {
      const real = sdk.host
      sdk.host = new Proxy(real, {
        get(target, prop) {
          const value = target[prop]
          if (typeof value !== 'function') return value
          return (...args) => (hostCalls.push({ name: String(prop), args }), value.apply(target, args))
        }
      })
    }
  })
  const rosterPane = panes.find(p => p.id === 'roster')
  assert.equal(rosterPane.title, 'Bots', 'the sidebar tab reads Bots')
  const rosterEl = mount(rosterPane.render)
  const row = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name)) || null

  // The home-server rows are connect-on-demand: available, not dimmed.
  const scholar = await waitFor(() => row('Scholar'), 'roster rows')
  assert.ok(!scholar.classList.contains('is-dim'), 'an on-demand SSH row is not dimmed')

  // ── click Planner while its route is still missing ──
  ;(await waitFor(() => row('Planner'), 'the Planner row')).click()
  const ws = await waitFor(() => workspaces.get('grokbot-override'), 'the override chat tab')
  assert.equal(ws.title, 'Planner', 'the chat tab is captioned with the bot, not CHAT')
  const chatEl = mount(ws.render)
  await waitFor(() => chatEl.textContent.includes('Could not open Planner'), 'the inline refusal')
  assert.match(chatEl.textContent, /route there is not known yet/)
  assert.ok(!chatEl.textContent.includes('Open in Hermes Bot Mode'), 'no stock hand-off without the exact route')

  // The palette's "open Hermes Bot Mode for this bot" refuses too.
  panes.find(p => p.id === 'palette-stock').data.run()
  await waitFor(() => calls.some(c => c.method === 'notify' && /Not opened in Hermes Bot Mode/.test(c.params?.title || '')), 'the refusal toast')

  const touchedPlannerByName = calls.filter(c =>
    (c.via === 'request' && (c.params?.profile === 'planner' || c.params?.name === 'planner')) ||
    (c.method === 'REST' && (c.params?.profile === 'planner' || /profile=planner/.test(String(c.params?.path || ''))))
  )
  assert.deepEqual(touchedPlannerByName, [], 'no gateway or REST call for "planner" on the active (local) gateway')
  assert.deepEqual(hostCalls.filter(c => PROFILE_MOVERS.has(c.name)), [], 'nothing that moves Hermes’s profile or opens a stock chat')
  assert.ok(!hostCalls.some(c => c.name === 'revealPane' && c.args[0] === 'hermes-bots:pane'), 'stock Bot Mode is not fronted')
  assert.ok(!hostCalls.some(c => c.name === 'warmAgent' && c.args[1] === 'planner' && c.args[0] !== 'home-server'), 'never warmed by name locally')
  assert.equal(globalThis.window.location.hash, '', 'no navigation')

  // ── the route arrives (next roster tick) ──
  rows.splice(rows.indexOf(PLANNER_NO_ROUTE), 1, PLANNER)
  await waitFor(() => {
    const retry = [...chatEl.querySelectorAll('button')].find(b => b.textContent.trim() === 'Try again')
    if (!retry) return false
    retry.click()
    return calls.some(c => c.via === 'home-server::planner' && c.method === 'session.list')
  }, 'Try again on the routed row', 6000)
  await waitFor(() => chatEl.textContent.includes('hello planner'), 'Planner’s transcript over its own route')
  assert.equal(workspaces.get('grokbot-override').title, 'Planner')

  // A stock hand-off now carries the exact route, and keeps Hermes's scope.
  panes.find(p => p.id === 'palette-stock').data.run()
  const opened = await waitFor(() => hostCalls.find(c => c.name === 'openSession'), 'the routed stock open')
  const [storedId, options] = opened.args
  assert.equal(storedId, 'c-root')
  assert.deepEqual(options.route, PLANNER.route, 'the exact connection route')
  assert.equal(options.profile, 'planner')
  assert.equal(options.keepAllProfilesScope, true, 'never switches Hermes’s workspace profile')
  assert.equal(hostCalls.filter(c => c.name === 'openSession').length, 1)

  // Switching bots re-captions the tab.
  row('Security').click()
  await waitFor(() => workspaces.get('grokbot-override').title === 'Security', 'the tab follows the bot')

  assert.equal(globalThis.window.location.hash, '', 'still no navigation')
  // Hermes's own profile / connection: untouched throughout.
  assert.equal(sdk.host.state.profile.get(), 'default')
  assert.equal(sdk.host.state.connectionId.get(), null)
  assert.deepEqual(errors, [])
})
