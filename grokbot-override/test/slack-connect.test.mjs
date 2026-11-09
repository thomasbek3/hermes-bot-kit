import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapSlackConnect, connectRequest, isSlackAuthorizationUrl, needsWorkspace, probeSlackConnect, refreshTokenError, slackConnectReady, workspaceLabel } from '../src/core/slackConnect.js'
import { withoutSecrets } from '../src/core/slack.js'
import { READY, waitFor } from './loader-boot.mjs'
import { buttonWithText } from './loader-surfaces.mjs'
import { bootPanel, sheetEl, slackBackends } from './slack-fakes.mjs'

const scope = { connectionId: 'mini', profile: 'test' }
test('Slack provisioning scopes requests and falls back only for a missing route', async () => {
  assert.deepEqual(connectRequest(scope, 'workspaces', 'POST', { refresh_token: 'fake' }), { ...scope, priority: 'foreground', path: '/api/plugins/slack-connect/workspaces', method: 'POST', body: { refresh_token: 'fake' } })
  assert.equal((await probeSlackConnect(async () => { throw Object.assign(new Error('no'), { status: 404 }) }, scope)).kind, 'missing')
  assert.equal((await probeSlackConnect(async () => { throw Object.assign(new Error('no'), { status: 503 }) }, scope)).kind, 'error')
  const result = await probeSlackConnect(async req => req.path.endsWith('/workspaces') ? [{team_id:'T1'}] : {phase:'none',mode:'http',readiness:{infrastructure_ready:true}}, scope)
  assert.equal(result.kind, 'available')
  assert.equal((await probeSlackConnect(async req => req.path.endsWith('/workspaces') ? [] : {readiness:{infrastructure_ready:false}}, scope)).kind, 'missing')
  assert.equal((await probeSlackConnect(async req => req.path.endsWith('/workspaces') ? [] : {readiness:{infrastructure_ready:true,workspace_ready:false}}, scope)).kind, 'available')
  assert.equal(workspaceLabel({team_id:'T1'}, [{result:{team_id:'T1',team:'Workspace'}}]), 'Workspace')
  assert.equal(workspaceLabel({team_id:'T1'}, []), 'Slack workspace (T1)')
  assert.equal(refreshTokenError('xoxe-fake-refresh-token'), null)
  assert.ok(refreshTokenError('xoxb-fake-token'))
  assert.equal(withoutSecrets('failure xoxe.fake-token and xoxe-fake-token', []), 'failure [token] and [token]')
  assert.ok(isSlackAuthorizationUrl('https://slack.com/oauth/v2/authorize?example=1'))
  assert.ok(!isSlackAuthorizationUrl('https://slack.com.attacker.invalid/oauth/v2/authorize'))
})

test('fallback uses default capability, then bootstraps and waits for target routes', async () => {
  const calls = []
  let mounted = false, attempts = 0
  const missing = () => { throw Object.assign(new Error('missing'), { status: 404 }) }
  const call = async req => {
    calls.push(`${req.profile}:${req.method}:${req.path.split('/').pop()}`)
    if (req.profile === 'default' && req.path.endsWith('/status')) return {mode:'bootstrap',readiness:{infrastructure_ready:true}}
    if (req.profile === 'default' && req.path.endsWith('/workspaces')) return [{team_id:'T1'}]
    if (req.profile === 'default' && req.path.endsWith('/bootstrap')) { assert.equal(req.body.profile, 'test'); mounted = true; return {ok:true} }
    if (req.profile === 'test' && mounted && req.path.endsWith('/status') && ++attempts === 2) return {phase:'none'}
    return missing()
  }
  const result = await probeSlackConnect(call, scope)
  assert.equal(result.bootstrap, true)
  assert.deepEqual(calls, ['test:GET:workspaces', 'default:GET:status', 'default:GET:workspaces'])
  await bootstrapSlackConnect(call, scope, async () => {})
  assert.deepEqual(calls.slice(3), ['default:POST:bootstrap', 'test:GET:status', 'test:GET:status'])
})

test('Slack provisioning confirms removal and cancels a created app', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const key = 'home-server::scholar'
  const backend = slackBackends({ [key]: {} })
  let phase = 'none'
  const calls = []
  const original = backend.api
  backend.api = async req => {
    if (!req.path.startsWith('/api/plugins/slack-connect/')) return original(req)
    assert.equal(`${req.connectionId}::${req.profile}`, key)
    calls.push(`${req.method} ${req.path}`)
    if (req.path.endsWith('/workspaces')) return [{team_id:'T1',team_name:'Example'}]
    if (req.path.endsWith('/status')) return {mode:'http',phase,team_name:'Example',readiness:{infrastructure_ready:true}}
    if (req.method === 'POST') { phase = 'created'; return {authorize_url:'https://slack.com/oauth/v2/authorize?fake=1',app_id:'A1'} }
    if (req.method === 'DELETE') { phase = 'none'; return {ok:true} }
    throw new Error('unexpected')
  }
  const {panelNow, internals} = await bootPanel(t, backend)
  window.hermesDesktop.openExternal = async () => {}
  ;(await waitFor(() => panelNow().querySelector('.gbo-suggest-card'), 'Slack card')).click()
  let sheet = await waitFor(() => sheetEl()?.textContent.includes('Uses your Slack connection') ? sheetEl() : null, 'new Slack dialog')
  assert.ok(sheet.textContent.includes('Example'))
  buttonWithText(sheet, 'Connect ↗').click()
  await waitFor(() => sheet.textContent.includes('Finish in Slack'), 'authorization step')
  buttonWithText(sheet, 'Cancel').click()
  await waitFor(() => !sheetEl(), 'cancel closes')
  assert.equal(calls.filter(x => x.startsWith('DELETE')).length, 1)
  phase = 'connected'
  const bot = internals.app.roster.get().rows.find(r => r.name === 'scholar')
  internals.openDialog({kind:'slack-status', bot})
  sheet = await waitFor(() => sheetEl()?.textContent.includes('Connected to Example Slack') ? sheetEl() : null, 'connected dialog')
  buttonWithText(sheet, 'Test connection').click()
  await waitFor(() => sheet.textContent.includes('Slack authentication and the bot’s events endpoint are working.'), 'HTTP connection test')
  assert.ok(!sheet.textContent.includes('App connection failed'))
  buttonWithText(sheet, 'Remove from Slack').click()
  await waitFor(() => sheet.textContent.includes('This deletes the app'), 'remove confirmation')
  assert.equal(calls.filter(x => x.startsWith('DELETE')).length, 1)
  buttonWithText(sheet, 'Cancel').click()
  await waitFor(() => sheet.textContent.includes('Connected to Example Slack'), 'cancel removal')
  buttonWithText(sheet, 'Remove from Slack').click()
  await waitFor(() => sheet.textContent.includes('This deletes the app'), 'confirmation again')
  buttonWithText(sheet, 'Remove').click()
  await waitFor(() => calls.filter(x => x.startsWith('DELETE')).length === 2, 'confirmed deletion')
  await waitFor(() => sheet.textContent.includes('Bring Scholar to Slack'), 'removal finishes')
  sheet.querySelector('[aria-label="Close"]').click()
  await waitFor(() => !sheetEl(), 'sheet closes after removal')
  phase = 'denied'
  internals.openDialog({kind:'slack', bot})
  sheet = await waitFor(() => sheetEl()?.textContent.includes('Slack install was cancelled') ? sheetEl() : null, 'denied dialog')
  buttonWithText(sheet, 'Cancel').click()
  await waitFor(() => !sheetEl(), 'denied cancel cleans up and closes')
  assert.equal(calls.filter(x => x.startsWith('DELETE')).length, 3)
})

test('readiness picks one-click, add-a-workspace or the paste-tokens dialog', async () => {
  const answer = (workspaces, status) => async req => req.path.endsWith('/workspaces') ? workspaces : status
  // Ready: one-click with a usable workspace.
  const ready = await probeSlackConnect(answer([{team_id:'T1',ok:true}], {phase:'none',mode:'http',readiness:{infrastructure_ready:true,workspace_ready:true}}), scope)
  assert.equal(ready.kind, 'available')
  assert.equal(needsWorkspace(ready.workspaces), false)
  // Add-on ready but no usable workspace token: one-click window, opened on adding one.
  const empty = await probeSlackConnect(answer([{team_id:'T1',ok:false}], {phase:'none',readiness:{infrastructure_ready:true,workspace_ready:false}}), scope)
  assert.equal(empty.kind, 'available')
  assert.equal(needsWorkspace(empty.workspaces), true)
  assert.equal(needsWorkspace([]), true)
  // Not ready (no public URL, relay down): the paste-tokens dialog.
  assert.equal((await probeSlackConnect(answer([], {phase:'none',readiness:{infrastructure_ready:false,missing:'public_url'}}), scope)).kind, 'missing')
  // An HTTP bot that is already connected stays manageable while the relay is down.
  assert.equal((await probeSlackConnect(answer([], {phase:'connected',mode:'http',readiness:{infrastructure_ready:false}}), scope)).kind, 'available')
  // An older add-on without a readiness report keeps working as before.
  assert.equal(slackConnectReady({phase:'none'}), true)
  assert.equal((await probeSlackConnect(answer([], {phase:'none',mode:'http'}), scope)).kind, 'available')
  // Bootstrap through the default profile follows the same readiness.
  const missing = () => { throw Object.assign(new Error('missing'), { status: 404 }) }
  const viaDefault = ready => async req => req.profile === 'default'
    ? (req.path.endsWith('/status') ? {mode:'bootstrap',readiness:{infrastructure_ready:ready}} : [])
    : missing()
  assert.equal((await probeSlackConnect(viaDefault(false), scope)).kind, 'missing')
  assert.equal((await probeSlackConnect(viaDefault(true), scope)).bootstrap, true)
})
