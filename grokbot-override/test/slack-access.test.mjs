import assert from 'node:assert/strict'
import test from 'node:test'
import { READY, waitFor } from './loader-boot.mjs'
import { buttonWithText } from './loader-surfaces.mjs'
import { bootPanel, sheetEl, slackBackends } from './slack-fakes.mjs'

test('Slack window sends the chosen audience and shows the effective one with a fix', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const key = 'home-server::scholar'
  const backend = slackBackends({ [key]: {} })
  let phase = 'none'
  let audience = { text: 'Full members of Example (12 people; not guests or Slack Connect users).', open: false, extra_grants: [] }
  const bodies = []
  const original = backend.api
  backend.api = async req => {
    if (!req.path.startsWith('/api/plugins/slack-connect/')) return original(req)
    const route = req.path.split('/slack-connect/')[1]
    if (route === 'workspaces') return [{ team_id: 'T1', team_name: 'Example' }]
    if (route === 'status') return { mode: 'http', phase, team_name: 'Example', access: 'members', audience, readiness: { infrastructure_ready: true } }
    if (route === 'connect' && req.method === 'POST') { bodies.push(['connect', req.body]); phase = 'created'; return { authorize_url: 'https://slack.com/oauth/v2/authorize?fake=1', app_id: 'A1' } }
    if (route === 'connect' && req.method === 'DELETE') { phase = 'none'; return { ok: true } }
    if (route === 'access') { bodies.push(['access', req.body]); audience = { text: 'Only you.', open: false, extra_grants: [] }; return { phase, audience } }
    if (route === 'access/fix') { bodies.push(['fix', req.body]); audience = { text: 'Only you.', open: false, extra_grants: [] }; return { phase, audience } }
    throw new Error('unexpected ' + route)
  }
  const { panelNow, internals } = await bootPanel(t, backend)
  window.hermesDesktop.openExternal = async () => {}
  ;(await waitFor(() => panelNow().querySelector('.gbo-suggest-card'), 'Slack card')).click()
  let sheet = await waitFor(() => sheetEl()?.textContent.includes('Uses your Slack connection') ? sheetEl() : null, 'Slack dialog')
  assert.ok(sheet.textContent.includes('Everyone in the workspace'), 'the team option is offered')
  assert.ok(sheet.textContent.includes('acts with its own access'), 'what anyone who can talk to it can do')
  const choices = [...sheet.querySelectorAll('.gbo-slack-access-choice')]
  assert.equal(choices.length, 3)
  assert.equal(choices[0].checked, true, 'whole team selected by default')
  buttonWithText(sheet, 'Connect ↗').click()
  await waitFor(() => bodies.length === 1, 'connect sent')
  assert.equal(bodies[0][1].access, 'members')
  await waitFor(() => sheet.textContent.includes('Finish in Slack'), 'authorization step')
  buttonWithText(sheet, 'Cancel').click()
  await waitFor(() => !sheetEl(), 'closed')
  // Connected, with an extra grant: it is named, and can be removed.
  phase = 'connected'
  audience = { text: 'Anyone who can message the bot in Slack can talk to it, including guests (SLACK_ALLOW_ALL_USERS=true).', open: true,
    extra_grants: [{ grant: 'SLACK_ALLOW_ALL_USERS=true', who: 'anyone who can message the bot, including guests', fixable: true, how: 'remove it' }] }
  const bot = internals.app.roster.get().rows.find(r => r.name === 'scholar')
  internals.openDialog({ kind: 'slack-status', bot })
  sheet = await waitFor(() => sheetEl()?.querySelector('.gbo-slack-audience') ? sheetEl() : null, 'audience shown')
  assert.ok(sheet.querySelector('.gbo-slack-audience').textContent.includes('including guests'))
  assert.ok(sheet.textContent.includes('SLACK_ALLOW_ALL_USERS=true'))
  buttonWithText(sheet, 'Remove the extra access').click()
  await waitFor(() => sheet.querySelector('.gbo-slack-audience')?.textContent.includes('Only you.'), 'fixed')
  assert.equal(bodies.at(-1)[0], 'fix')
  buttonWithText(sheet, 'Change who can talk to it').click()
  const owner = await waitFor(() => sheet.querySelectorAll('.gbo-slack-access-choice')[1], 'choices')
  owner.click()
  buttonWithText(sheet, 'Apply').click()
  await waitFor(() => bodies.at(-1)[0] === 'access', 'access change sent')
  assert.deepEqual(bodies.at(-1)[1], { access: 'owner' })
})
