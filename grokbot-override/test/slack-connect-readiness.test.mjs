// The Slack window follows the add-on's readiness: one-click when ready, the
// one-click window opened on adding a workspace when no workspace token is
// usable, and the unchanged paste-tokens dialog when the add-on is not ready.
import assert from 'node:assert/strict'
import test from 'node:test'
import { READY, waitFor } from './loader-boot.mjs'
import { buttonWithText } from './loader-surfaces.mjs'
import { bootPanel, sheetEl, slackBackends } from './slack-fakes.mjs'

test('Slack window: paste-tokens when not ready, add-a-workspace when no token, one-click when ready', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const key = 'home-server::scholar'
  const backend = slackBackends({ [key]: {} })
  const original = backend.api
  let readiness = { infrastructure_ready: false, workspace_ready: false, missing: 'public_url' }
  let workspaces = []
  backend.api = async req => {
    if (!req.path.startsWith('/api/plugins/slack-connect/')) return original(req)
    assert.equal(`${req.connectionId}::${req.profile}`, key)
    if (req.path.endsWith('/workspaces')) return workspaces
    if (req.path.endsWith('/status')) return { mode: 'http', phase: 'none', readiness }
    throw new Error('unexpected')
  }
  const { panelNow, internals } = await bootPanel(t, backend)
  const bot = internals.app.roster.get().rows.find(r => r.name === 'scholar')
  const open = async label => {
    internals.openDialog({ kind: 'slack', bot })
    return waitFor(() => sheetEl()?.textContent.includes(label) ? sheetEl() : null, label)
  }
  const close = async sheet => { buttonWithText(sheet, 'Cancel').click(); await waitFor(() => !sheetEl(), 'closed') }

  // Not ready: the existing paste-tokens dialog.
  ;(await waitFor(() => panelNow().querySelector('.gbo-suggest-card'), 'Slack card')).click()
  let sheet = await waitFor(() => sheetEl()?.textContent.includes('Bring Scholar to Slack') ? sheetEl() : null, 'paste dialog')
  assert.ok(!sheet.textContent.includes('Uses your Slack connection'), 'not the one-click window')
  await close(sheet)

  // Ready but no usable workspace token: one-click window on "Connect another workspace".
  readiness = { infrastructure_ready: true, workspace_ready: false, missing: 'workspace_token' }
  workspaces = [{ team_id: 'T1', team_name: 'Example', ok: false }]
  sheet = await open('Connect another workspace')
  assert.ok(sheet.textContent.includes('Uses your Slack connection'))
  const howto = sheet.querySelector('.gbo-slack-howto')
  assert.ok(howto.textContent.includes('api.slack.com/apps') && howto.textContent.includes('Generate Token'), 'where to click')
  assert.ok(howto.textContent.includes('Refresh token') && howto.textContent.includes('xoxe-'), 'which value to paste')
  assert.equal(howto.querySelectorAll('br').length, 1, 'two lines')
  await close(sheet)

  // Ready with a workspace: one-click Connect.
  readiness = { infrastructure_ready: true, workspace_ready: true, missing: null }
  workspaces = [{ team_id: 'T1', team_name: 'Example', ok: true }]
  sheet = await open('Uses your Slack connection')
  assert.ok(sheet.textContent.includes('Bring Scholar to Slack') && sheet.textContent.includes('Example'))
  assert.ok(buttonWithText(sheet, 'Connect ↗'))
  await close(sheet)
})
