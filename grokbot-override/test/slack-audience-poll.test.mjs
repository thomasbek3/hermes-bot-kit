import assert from 'node:assert/strict'
import test from 'node:test'
import { READY, waitFor } from './loader-boot.mjs'
import { buttonWithText } from './loader-surfaces.mjs'
import { bootPanel, sheetEl, slackBackends } from './slack-fakes.mjs'

// The open window on a connected bot refreshes who can talk to it every 20 s
// from the local-only /audience route; /status (Slack auth.test and the signed
// events check) runs only on open and on Test connection.
test('Slack window polls the local audience route, never the live status, and names a failed welcome', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const key = 'home-server::scholar'
  const backend = slackBackends({ [key]: {} })
  const routes = []
  let text = '2 people can talk to this bot: the 2 full members of Example.'
  const original = backend.api
  backend.api = async req => {
    if (!req.path.startsWith('/api/plugins/slack-connect/')) return original(req)
    const route = req.path.split('/slack-connect/')[1]
    routes.push(route)
    const audience = { text, open: false, grants: [], sync: { text: '' } }
    const welcome = { welcome: 'failed', welcome_error: 'channel_not_found' }
    if (route === 'workspaces') return [{ team_id: 'T1', team_name: 'Example' }]
    if (route === 'status') return { mode: 'http', phase: 'connected', team_name: 'Example', access: 'members', owner_known: true, audience, ...welcome, readiness: { infrastructure_ready: true } }
    if (route === 'audience') return { mode: 'http', phase: 'installed', team_name: 'Example', access: 'members', owner_known: true, audience, ...welcome }
    throw new Error('unexpected ' + route)
  }
  const { internals } = await bootPanel(t, backend)
  // Capture the window's 20 s poll and run it on demand (other intervals run as usual).
  const polls = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (fn, ms, ...rest) => ms === 20_000 ? (polls.push(fn), realSetInterval(() => {}, 2 ** 30)) : realSetInterval(fn, ms, ...rest)
  t.after(() => { globalThis.setInterval = realSetInterval })
  const tick = () => polls.at(-1)()
  const bot = internals.app.roster.get().rows.find(r => r.name === 'scholar')
  internals.openDialog({ kind: 'slack-status', bot })
  const sheet = await waitFor(() => sheetEl()?.querySelector('.gbo-slack-audience') ? sheetEl() : null, 'audience shown')
  assert.ok(sheet.querySelector('.gbo-slack-welcome').textContent.includes('Welcome message couldn’t be sent: channel_not_found'))
  const opened = routes.filter(r => r === 'status').length
  assert.ok(opened >= 1, 'opening runs the live status once')
  text = '1 person can talk to this bot: the 1 full member of Example.'
  tick()
  await waitFor(() => sheet.querySelector('.gbo-slack-audience')?.textContent.includes('1 full member of Example'), 'refreshed')
  tick()
  await waitFor(() => routes.filter(r => r === 'audience').length === 2, 'second poll')
  assert.equal(routes.filter(r => r === 'status').length, opened, 'the poll never runs the live status route')
  buttonWithText(sheet, 'Done').click()
  await waitFor(() => !sheetEl(), 'closed')
})
