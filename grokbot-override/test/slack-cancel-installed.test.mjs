// Round 6: Cancel or close on every screen of the Slack window never deletes
// an app whose bot token is installed; only the confirmed Remove does.
import assert from 'node:assert/strict'
import test from 'node:test'
import { READY, waitFor } from './loader-boot.mjs'
import { buttonWithText } from './loader-surfaces.mjs'
import { bootPanel, sheetEl, slackBackends } from './slack-fakes.mjs'

// Round 6: an app whose bot token is installed (an upgraded connection, or a
// stale error record) is deleted only by Remove from Slack, confirmed.
test('Cancel or close on any screen never deletes an app whose bot token is installed', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const key = 'home-server::scholar'
  const backend = slackBackends({ [key]: {} })
  let phase = 'none'
  const calls = []
  // Round 7: the connection the window shows; a confirmed Remove names it.
  const shown = { key: 'c'.repeat(32), app_id: 'A1', record_rev: 1763600000123 }
  const removeBodies = []
  const original = backend.api
  backend.api = async req => {
    if (!req.path.startsWith('/api/plugins/slack-connect/')) return original(req)
    calls.push(`${req.method} ${req.path.split('/slack-connect/')[1]}`)
    if (req.path.endsWith('/workspaces')) return [{team_id:'T1',team_name:'Example'}]
    if (req.path.endsWith('/status') || req.path.endsWith('/audience')) return {mode:'http',phase,...(phase === 'none' ? {} : shown),team_name:'Example',token_installed:true,readiness:{infrastructure_ready:true}}
    if (req.method === 'POST' && req.path.endsWith('/remove')) { removeBodies.push(req.body); phase = 'none'; return {ok:true} }
    if (req.method === 'DELETE') return {ok:true}
    throw new Error('unexpected ' + req.method + ' ' + req.path)
  }
  const {internals} = await bootPanel(t, backend)
  window.hermesDesktop.openExternal = async () => {}
  const bot = internals.app.roster.get().rows.find(r => r.name === 'scholar')
  const screens = { created: 'Finish in Slack', installed: 'Slack is installed', denied: 'Slack install was cancelled', error: 'Slack setup needs attention', connected: 'Connected to Example Slack' }
  const removals = () => calls.filter(c => c.startsWith('DELETE') || c === 'POST remove')
  const open = async p => {
    phase = p
    internals.openDialog({kind: p === 'connected' ? 'slack-status' : 'slack', bot})
    return waitFor(() => sheetEl()?.textContent.includes(screens[p]) ? sheetEl() : null, `the ${p} screen`)
  }
  for (const p of Object.keys(screens)) {
    for (const how of ['button', 'Close']) {
      const sheet = await open(p)
      if (how === 'Close') sheet.querySelector('[aria-label="Close"]').click()
      else buttonWithText(sheet, p === 'connected' ? 'Done' : 'Cancel').click()
      await waitFor(() => !sheetEl(), `${how} closes the ${p} screen`)
      await new Promise(r => setTimeout(r, 20))
      assert.deepEqual(removals(), [], `${how} on the ${p} screen deletes nothing`)
    }
  }
  // On an error screen with a token: the only way out is the confirmed Remove.
  let sheet = await open('error')
  assert.ok(!buttonWithText(sheet, 'Remove and try again'), 'no unconfirmed removal is offered')
  assert.ok(sheet.textContent.includes('Cancel keeps the app'))
  buttonWithText(sheet, 'Remove from Slack').click()
  await waitFor(() => sheet.textContent.includes('This deletes the app'), 'the confirmation step')
  buttonWithText(sheet, 'Cancel').click()
  await waitFor(() => sheet.textContent.includes(screens.error), 'cancel the removal')
  assert.deepEqual(removals(), [])
  buttonWithText(sheet, 'Remove from Slack').click()
  await waitFor(() => sheet.textContent.includes('This deletes the app'), 'the confirmation step again')
  buttonWithText(sheet, 'Remove').click()
  await waitFor(() => removals().length === 1, 'the confirmed removal')
  assert.deepEqual(removals(), ['POST remove'])
  assert.deepEqual(removeBodies, [{ confirm: true, ...shown }], 'Remove names the connection the window showed')
  await waitFor(() => sheet.textContent.includes('Bring Scholar to Slack'), 'removal finishes')
  sheet.querySelector('[aria-label="Close"]').click()
  await waitFor(() => !sheetEl(), 'closed')
})
