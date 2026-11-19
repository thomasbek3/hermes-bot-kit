import assert from 'node:assert/strict'
import test from 'node:test'
import { READY, waitFor } from './loader-boot.mjs'
import { buttonWithText } from './loader-surfaces.mjs'
import { bootPanel, sheetEl, slackBackends } from './slack-fakes.mjs'

test('Slack window sends the chosen audience and shows the effective one, its grants and legacy choices', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const key = 'home-server::scholar'
  const backend = slackBackends({ [key]: {} })
  let phase = 'none'
  let audience = { text: '12 people can talk to this bot: the 12 full members of Example.', open: false, grants: [], sync: { text: '' } }
  let legacy = null
  let ownerKnown = true
  const bodies = []
  const original = backend.api
  backend.api = async req => {
    if (!req.path.startsWith('/api/plugins/slack-connect/')) return original(req)
    const route = req.path.split('/slack-connect/')[1]
    if (route === 'workspaces') return [{ team_id: 'T1', team_name: 'Example' }]
    if (route === 'status') return { mode: 'http', phase, team_name: 'Example', access: legacy ? 'legacy' : 'members', owner_known: ownerKnown, audience, ...(legacy ? { legacy } : {}), readiness: { infrastructure_ready: true } }
    if (route === 'connect' && req.method === 'POST') { bodies.push(['connect', req.body]); phase = 'created'; return { authorize_url: 'https://slack.com/oauth/v2/authorize?fake=1', app_id: 'A1' } }
    if (route === 'connect' && req.method === 'DELETE') { phase = 'none'; return { ok: true } }
    if (route === 'access') { bodies.push(['access', req.body]); legacy = null; audience = { text: 'Only you can talk to this bot.', open: false, grants: [], sync: { text: '' } }; return { phase, owner_known: ownerKnown, audience } }
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
  // Connected, with an extra grant: it is named with its source and how to change it. No fix button.
  phase = 'connected'
  audience = { text: 'Anyone in Slack who can message this bot, including guests (SLACK_ALLOW_ALL_USERS=true in /h/.env).', open: true,
    grants: [{ source: '/h/.env', what: 'SLACK_ALLOW_ALL_USERS=true', ids: null, how_to_change: 'remove SLACK_ALLOW_ALL_USERS from /h/.env' }],
    sync: { text: 'Member list stale since 2026-11-18 10:00 UTC: the app lacks the users:read permission.', stale: true } }
  const bot = internals.app.roster.get().rows.find(r => r.name === 'scholar')
  internals.openDialog({ kind: 'slack-status', bot })
  sheet = await waitFor(() => sheetEl()?.querySelector('.gbo-slack-audience') ? sheetEl() : null, 'audience shown')
  const block = sheet.querySelector('.gbo-slack-audience')
  assert.ok(block.textContent.includes('including guests'))
  assert.ok(block.textContent.includes('SLACK_ALLOW_ALL_USERS=true (/h/.env). To change: remove SLACK_ALLOW_ALL_USERS from /h/.env'))
  assert.ok(block.querySelector('.gbo-slack-sync').textContent.includes('users:read'), 'sync health is its own line')
  assert.ok(!sheet.textContent.includes('Remove the extra access'), 'the fix button is gone')
  buttonWithText(sheet, 'Change who can talk to it').click()
  const owner = await waitFor(() => sheet.querySelectorAll('.gbo-slack-access-choice')[1], 'choices')
  owner.click()
  buttonWithText(sheet, 'Apply').click()
  await waitFor(() => bodies.at(-1)[0] === 'access', 'access change sent')
  assert.deepEqual(bodies.at(-1)[1], { access: 'owner' })
  await waitFor(() => sheet.querySelector('.gbo-slack-audience')?.textContent.includes('Only you can talk to this bot.'), 'changed')
  buttonWithText(sheet, 'Done').click()
  await waitFor(() => !sheetEl(), 'closed again')
  // Connected before team access, installer unknown: shown as it is, with an explicit choice and no "Only me".
  legacy = { ids: ['U0LEGACY1'], text: 'Connected before team access: it allows U0LEGACY1.' }
  ownerKnown = false
  audience = { text: '1 person can talk to this bot: the 1 person in SLACK_ALLOWED_USERS.', open: false, grants: [], sync: { text: '' } }
  internals.openDialog({ kind: 'slack-status', bot })
  sheet = await waitFor(() => sheetEl()?.querySelector('.gbo-slack-legacy') ? sheetEl() : null, 'legacy shown')
  assert.ok(sheet.querySelector('.gbo-slack-legacy').textContent.includes('Connected before team access: it allows U0LEGACY1.'))
  assert.ok(!sheet.querySelector('.gbo-slack-legacy-owner'), 'no Only me without a known installer')
  assert.ok(sheet.querySelector('.gbo-slack-legacy-members'))
  buttonWithText(sheet, 'Keep these people').click()
  await waitFor(() => bodies.at(-1)[1]?.access === 'list', 'keep sent')
  assert.deepEqual(bodies.at(-1)[1], { access: 'list', allowed: 'U0LEGACY1' })
})
