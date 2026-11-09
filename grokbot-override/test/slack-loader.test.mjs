// Add to Slack through the built plugin.js under the loader replica (jsdom,
// clicks), on a strict per-bot REST fake (slack-fakes.mjs). One boot, steps
// in order: the card on a remote bot's own route, no card on a configured
// bot, the whole dialog (create link, tokens, PUT, restart only on the
// click, poll to connected, test, approve), hot_served true, the 409
// conflict, the restart timeout state, and Hide; the Slack · status card and
// its sheet's Test connection (the slack-check add-on: works, a Slack error,
// not installed) on a bot that has Slack. Tokens are checked to be
// nowhere in plugin storage, localStorage, the console or the DOM.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { buttonWithText, reactErrors, rowButton } from './loader-surfaces.mjs'
import { APP, BOT, bootPanel, sheetEl, slackBackends, slackEntry, typeInto } from './slack-fakes.mjs'

const KNOW = 'home-server::scholar'
const SEC = 'local::security'
const CHECK = 'GET /api/plugins/slack-check/test'
// The add-on's answer (plugin_api.py run_check) for a working bot.
const CHECK_OK = {
  ok: true,
  configured: true,
  bot: '@security',
  bot_id: 'B0TEST',
  team: 'Acme Studio',
  team_id: 'T0TEST',
  url: 'https://acme-studio.slack.com/',
  app_token_ok: true,
  last_log: { ts: '2026-11-09 13:40:02,113', text: '[Slack] Socket Mode connected' }
}

function captureConsole(t) {
  const seen = []
  const original = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    original[level] = console[level]
    console[level] = (...args) => {
      seen.push(
        args
          .map(a => {
            if (typeof a === 'string') return a
            try {
              return JSON.stringify(a)
            } catch {
              return String(a)
            }
          })
          .join(' ')
      )
    }
  }
  t.after(() => Object.assign(console, original))
  return seen
}

test('loader: Add to Slack card and dialog, end to end on the bot’s own route', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const consoleSeen = captureConsole(t)
  const backend = slackBackends({ [KNOW]: {}, [SEC]: { entry: slackEntry({ configured: true, enabled: true, state: 'connected' }), check: CHECK_OK } })
  const { rosterEl, panelNow, store, internals, errors } = await bootPanel(t, backend)
  const opened = []
  window.hermesDesktop.openExternal = async url => void opened.push(url)
  const scholar = () => internals.app.roster.get().rows.find(r => r.name === 'scholar')
  const select = async (name, scope) => {
    const before = backend.routes(scope).filter(r => r === 'GET /api/messaging/platforms').length
    rowButton(rosterEl, name).click()
    await waitFor(() => backend.routes(scope).filter(r => r === 'GET /api/messaging/platforms').length > before && panelNow()?.textContent.includes(name), `${name}’s panel and its platforms read`)
    await new Promise(r => setTimeout(r, 20))
  }

  // 1. A remote bot without Slack: the card, read on home-server / scholar.
  const card = await waitFor(() => panelNow().querySelector('.gbo-suggest-card'), 'the Add to Slack card')
  assert.equal(card.textContent.trim(), 'Add to Slack', 'one line, no subtitle')
  assert.ok(card.querySelector('.gbo-slack-mark'), 'the four-colour mark')
  {
    const sections = [...panelNow().querySelectorAll('.gbo-panel-section')]
    const pos = sections.indexOf(card.closest('.gbo-panel-section'))
    assert.ok(sections[pos - 1].textContent.includes('Scheduled') && sections[pos + 1].textContent.includes('Computer'), 'Suggested sits between the jobs and Computer')
  }
  const suggested = panelNow().querySelector('[aria-label="Suggested"]')
  assert.ok(suggested.querySelector('.gbo-panel-label').textContent.includes('Suggested'))
  assert.ok(buttonWithText(suggested, 'Hide'), 'Hide beside the caption')
  assert.deepEqual(backend.routes(KNOW).sort(), ['GET /api/messaging/platforms', 'GET /api/status'])

  assert.equal(Boolean(panelNow().querySelector('.gbo-slack-card-sub')), false, 'one of two: no status card without Slack')

  // 2. A bot whose profile has Slack: the Slack · Connected card between the
  // jobs and Computer, no Suggested section; its sheet tests on its own route.
  await select('Security', SEC)
  assert.equal(Boolean(panelNow().querySelector('[aria-label="Suggested"]')), false)
  const status = await waitFor(() => panelNow().querySelector('.gbo-slack-card-sub')?.closest('.gbo-slack-card'), 'the Slack status card')
  assert.equal(status.querySelector('.gbo-slack-card-title').textContent, 'Slack')
  assert.equal(status.querySelector('.gbo-slack-card-sub').textContent, 'Connected')
  const sections = [...panelNow().querySelectorAll('.gbo-panel-section')]
  const pos = sections.indexOf(status.closest('.gbo-panel-section'))
  assert.ok(sections[pos - 1].textContent.includes('Scheduled') && sections[pos + 1].textContent.includes('Computer'), 'between the jobs and Computer')
  assert.equal(Boolean(status.closest('.gbo-panel-section').querySelector('.gbo-panel-label')), false, 'no caption')
  status.click()
  const sheet = await waitFor(() => sheetEl()?.textContent.includes('Security is in Slack') ? sheetEl() : null, 'the Slack sheet')
  assert.ok(sheet.textContent.includes('Security is in Slack') && sheet.textContent.includes('Uses its own Slack app'))
  assert.ok(sheet.textContent.includes('Connected') && sheet.textContent.includes('Open Slack'))
  assert.equal(sheet.querySelectorAll('input').length, 0, 'no token editing here')
  const testsBefore = backend.routes(SEC).filter(r => r === 'POST /api/messaging/platforms/slack/test').length
  buttonWithText(sheet, 'Test connection').click()
  const ok = await waitFor(() => sheet.querySelector('.gbo-slack-check.is-ok'), 'the test result')
  assert.equal(ok.querySelector('.gbo-slack-ok').textContent, 'Works · @security in Acme Studio · App connection OK', 'one green line')
  assert.match(ok.querySelector('.gbo-slack-log').textContent, /^Last connected (2026-11-09 )?13:40$/, 'when it last connected, muted')
  assert.equal(backend.routes(SEC).filter(r => r === CHECK).length, 1, 'one add-on test on local / security')
  assert.equal(backend.routes(SEC).filter(r => r === 'POST /api/messaging/platforms/slack/test').length, testsBefore, 'Hermes’s status re-read is not used')
  {
    const call = backend.log.filter(l => l.route === CHECK).at(-1)
    assert.equal(call.scope, SEC, 'on the bot’s own connection and profile')
  }
  await waitFor(() => [...sheet.querySelectorAll('.gbo-sheet-row')].some(r => /^StatusConnected · checked /.test(r.textContent)), 'Status says when it was checked')
  // A Slack error, with token-shaped text in it: plain words, no token.
  backend.bots.get(SEC).check = { ok: false, configured: true, error: 'invalid_auth' }
  buttonWithText(sheet, 'Test connection').click()
  const failed = await waitFor(() => sheet.querySelector('.gbo-slack-check.is-error'), 'the Slack error')
  assert.equal(failed.textContent, 'Slack does not accept this bot token')
  backend.bots.get(SEC).check = { ok: false, configured: true, error: `network: refused for ${BOT}` }
  buttonWithText(sheet, 'Test connection').click()
  await waitFor(() => sheet.querySelector('.gbo-slack-check.is-error')?.textContent.startsWith('Could not reach Slack'), 'the transport error')
  assert.ok(!sheet.textContent.includes(BOT) && !/xox[a-z]-|xapp-/.test(sheet.textContent), 'no token-like text rendered')
  assert.ok(buttonWithText(sheet, 'Test connection'), 'still offered after a failure')
  buttonWithText(sheet, 'Open Slack').click()
  await waitFor(() => opened.includes('https://app.slack.com/client'), 'Open Slack')
  opened.length = 0
  sheet.querySelector('[aria-label="Close"]').click()
  await waitFor(() => !sheetEl(), 'the sheet closes')
  await select('Scholar', KNOW)
  await waitFor(() => panelNow().querySelector('.gbo-suggest-card'), 'the card again')

  // 3. The dialog.
  panelNow().querySelector('.gbo-suggest-card').click()
  const dialog = await waitFor(() => sheetEl()?.textContent.includes('Bring Scholar to Slack') ? sheetEl() : null, 'the Slack dialog')
  assert.ok(dialog.textContent.includes('Bring Scholar to Slack') && dialog.textContent.includes('Uses its own Slack app'))
  assert.ok(dialog.textContent.includes('You can DM or @mention Scholar in Slack.'))
  assert.ok(dialog.textContent.includes('Pick your workspace, press Create, then Install to Workspace.'))
  assert.ok(buttonWithText(dialog, 'Cancel'), 'Cancel on the left')
  buttonWithText(dialog, 'Create Slack app').click()
  await waitFor(() => opened.length === 1, 'the browser link (host open-external)')
  const link = new URL(opened[0])
  assert.equal(`${link.origin}${link.pathname}`, 'https://api.slack.com/apps')
  assert.equal(link.searchParams.get('new_app'), '1')
  const manifest = JSON.parse(link.searchParams.get('manifest_json'))
  assert.equal(manifest.features.bot_user.display_name, 'Scholar')
  assert.equal(manifest.display_information.description, 'Scholar, your Hermes bot')

  const inputs = await waitFor(() => {
    const list = [...dialog.querySelectorAll('input[type="password"]')]
    return list.length === 2 ? list : null
  }, 'two password inputs')
  const connect = () => buttonWithText(dialog, 'Connect')
  assert.equal(connect().disabled, true)
  typeInto(inputs[0], BOT)
  typeInto(inputs[1], BOT)
  await waitFor(() => dialog.textContent.includes('starts with xapp-'), 'the app-level prefix error')
  assert.equal(connect().disabled, true, 'a wrong prefix never reaches the server')
  typeInto(inputs[0], APP)
  await waitFor(() => !connect().disabled, 'Connect enabled')
  connect().click()

  await waitFor(() => dialog.textContent.includes('Almost done: Scholar’s connection needs a quick restart to pick up Slack'), 'the restart step')
  assert.ok(dialog.textContent.includes('Any reply Scholar is writing right now will be cut off.'))
  const put = backend.log.find(l => l.route === 'PUT /api/messaging/platforms/slack')
  assert.equal(put.scope, KNOW)
  assert.deepEqual(put.body, { env: { SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP }, enabled: true })
  assert.ok(!backend.routes(KNOW).includes('POST /api/messaging/platforms/slack/test'), 'no test before the restart')
  await new Promise(r => setTimeout(r, 100))
  assert.ok(!backend.routes().includes('POST /api/gateway/restart'), 'never restarts without the click')

  buttonWithText(dialog, 'Restart now').click()
  await waitFor(() => dialog.textContent.includes('Connected. DM Scholar in Slack.'), 'connected after the restart', 8000)
  const after = backend.routes(KNOW)
  const at = after.indexOf('POST /api/gateway/restart')
  assert.ok(at > 0 && backend.log.find(l => l.route === 'POST /api/gateway/restart').scope === KNOW, 'restart on home-server / scholar')
  assert.ok(after.indexOf('GET /api/messaging/platforms', at) > at, 'polled after the restart')
  assert.ok(after.indexOf('POST /api/messaging/platforms/slack/test') > at, 'tested after it shows connected')
  assert.deepEqual(backend.routes(SEC).filter(r => /^(PUT|POST \/api\/(gateway|pairing))/.test(r)), [], 'no write on the other bot')

  const approve = await waitFor(() => buttonWithText(dialog, 'Approve'), 'the pending first DM', 8000)
  assert.ok(dialog.textContent.includes('Alex'))
  approve.click()
  await waitFor(() => backend.routes(KNOW).includes('POST /api/pairing/approve'), 'the approve call')
  assert.deepEqual(backend.log.find(l => l.route === 'POST /api/pairing/approve').body, { platform: 'slack', request_id: 'req-1', profile: 'scholar' })
  await waitFor(() => !buttonWithText(dialog, 'Approve'), 'the request leaves the list')
  buttonWithText(dialog, 'Done').click()
  await waitFor(() => !sheetEl(), 'the dialog closes')
  await waitFor(() => !panelNow().querySelector('.gbo-suggest-card') && panelNow().querySelector('.gbo-slack-card-sub'), 'the Suggested card gives way to the status card')
  assert.equal(panelNow().querySelector('.gbo-slack-card-sub').textContent, 'Connected')

  // 4. hot_served true: connected without a restart.
  backend.reset(KNOW, { put: { ok: true, platform: 'slack', hot_served: true } })
  const openAt = async initial => {
    internals.openDialog(null)
    await waitFor(() => !sheetEl(), 'no dialog')
    internals.openDialog({ kind: 'slack', bot: scholar(), initial })
    return waitFor(() => sheetEl(), 'the Slack dialog')
  }
  const fill = async el => {
    const [app, bot] = [...el.querySelectorAll('input[type="password"]')]
    typeInto(app, APP)
    typeInto(bot, BOT)
    await waitFor(() => !buttonWithText(el, 'Connect').disabled, 'Connect enabled')
    buttonWithText(el, 'Connect').click()
  }
  let el = await openAt({ stage: 'tokens' })
  const restartsBefore = backend.routes().filter(r => r === 'POST /api/gateway/restart').length
  await fill(el)
  await waitFor(() => el.textContent.includes('Connected. DM Scholar in Slack.'), 'connected (hot served)')
  assert.equal(backend.routes().filter(r => r === 'POST /api/gateway/restart').length, restartsBefore, 'no restart when hot served')
  const hot = backend.routes(KNOW)
  assert.ok(hot.lastIndexOf('POST /api/messaging/platforms/slack/test') > hot.lastIndexOf('PUT /api/messaging/platforms/slack'), 'tested right after the save')

  // 5. 409: the server's detail, the form stays.
  const detail = "Cannot enable 'slack' on profile 'scholar': gateway.multiplex_profiles is on and the default profile's listener already serves it"
  backend.reset(KNOW, { put: new Error(`Error invoking remote method 'hermes:api': Error: 409: ${JSON.stringify({ detail })}`) })
  el = await openAt({ stage: 'tokens' })
  await fill(el)
  await waitFor(() => el.querySelector('.gbo-form-error')?.textContent === detail, 'the conflict detail')
  assert.ok(buttonWithText(el, 'Connect'), 'still on the token step')

  // 6. The restart timeout state keeps the dialog usable.
  el = await openAt({ stage: 'restart-timeout' })
  assert.ok(el.textContent.includes('Still restarting. Check back in a minute'))
  assert.equal(buttonWithText(el, 'Check again').disabled, false)
  assert.equal(buttonWithText(el, 'Close').disabled, false)
  buttonWithText(el, 'Close').click()
  await waitFor(() => !sheetEl(), 'closed')

  // 7. Hide, stored per route key.
  backend.reset(KNOW)
  await select('Security', SEC)
  await select('Scholar', KNOW)
  const again = await waitFor(() => panelNow().querySelector('[aria-label="Suggested"]'), 'the card back for an unconfigured profile')
  buttonWithText(again, 'Hide').click()
  await waitFor(() => !panelNow().querySelector('[aria-label="Suggested"]'), 'the card hides')
  assert.equal(Boolean(panelNow().querySelector('.gbo-slack-card')), false, 'hidden: neither card')
  assert.deepEqual(store.get('slackCardHidden'), [KNOW])

  // 8. A multiplexed (served) bot whose Slack works but has no live row:
  // Status Connected, Gateway Running, no technical notes, and no Test
  // connection (Hermes's test cannot answer without a row): Close instead.
  backend.reset(KNOW, {
    entry: slackEntry({ enabled: true, configured: true, gateway_running: true, state: 'pending_restart', error_message: null, env_vars: [{ key: 'SLACK_BOT_TOKEN', required: true, is_set: true }, { key: 'SLACK_APP_TOKEN', required: true, is_set: true }] }),
    status: { gateway_running: true, gateway_state: 'running', gateway_shared_with: ['default', 'scholar', 'intake'] }
  })
  backend.bots.get(KNOW).testAnswer = { ok: false, state: 'pending_restart', message: 'Setup looks complete, but the gateway has not reported a connection yet. Restart the gateway.' }
  await select('Security', SEC)
  await select('Scholar', KNOW)
  const served = await waitFor(() => panelNow().querySelector('.gbo-slack-card-sub')?.textContent === 'Connected' && panelNow().querySelector('.gbo-slack-card'), 'served bot reads Connected')
  served.click()
  const servedSheet = await waitFor(() => sheetEl(), 'the served sheet')
  const rowsText = [...servedSheet.querySelectorAll('.gbo-sheet-row')].map(r => r.textContent)
  assert.ok(rowsText.includes('StatusConnected'), 'Status reads Connected')
  assert.ok(rowsText.includes('GatewayRunning'), 'Gateway reads Running')
  assert.ok(!servedSheet.textContent.includes('shared'), 'no "· shared"')
  assert.ok(!servedSheet.textContent.includes('Live status not reported'), 'no unreported note')
  assert.ok(!servedSheet.textContent.includes('Not confirmed'), 'no test note')
  // Every configured bot offers Test connection; without the add-on (404)
  // the button goes and a muted hint stays, cached for the connection.
  const testsBeforeServed = backend.routes(KNOW).filter(r => r === 'POST /api/messaging/platforms/slack/test').length
  assert.ok(buttonWithText(servedSheet, 'Test connection'), 'Test connection for a configured bot')
  buttonWithText(servedSheet, 'Test connection').click()
  await waitFor(() => servedSheet.querySelector('.gbo-slack-hint')?.textContent === 'Install the Slack check add-on for a live test', 'the install hint')
  assert.equal(buttonWithText(servedSheet, 'Test connection'), null, 'hidden without the add-on')
  assert.equal(backend.routes(KNOW).filter(r => r === CHECK).length, 1, 'one add-on call on home-server / scholar')
  assert.equal(Boolean(servedSheet.querySelector('.gbo-form-error, .gbo-slack-check')), false, 'not shown as an error')
  assert.ok(buttonWithText(servedSheet, 'Open Slack'), 'Open Slack stays')
  const foot = servedSheet.querySelector('.gbo-sheet-foot')
  assert.equal(foot.firstElementChild.textContent, 'Close', 'a plain Close on the left')
  assert.ok(foot.lastElementChild.textContent.includes('Open Slack'), 'Open Slack on the right')
  assert.ok(!/restart (the|this|now)/i.test(servedSheet.textContent), 'never asks to restart a served bot')
  foot.firstElementChild.click()
  await waitFor(() => !sheetEl(), 'Close closes')
  served.click()
  const again2 = await waitFor(() => sheetEl(), 'the served sheet again')
  assert.ok(again2.querySelector('.gbo-slack-hint'), 'the not-installed answer is remembered')
  assert.equal(buttonWithText(again2, 'Test connection'), null)
  assert.equal(backend.routes(KNOW).filter(r => r === CHECK).length, 1, 'no second call while cached')
  again2.querySelector('.gbo-sheet-foot').firstElementChild.click()
  await waitFor(() => !sheetEl(), 'closed again')
  assert.equal(backend.routes(KNOW).filter(r => r === 'POST /api/messaging/platforms/slack/test').length, testsBeforeServed, 'no test POST')

  // Tokens: nowhere in storage, the console or the DOM.
  const stored = JSON.stringify([...store.entries()])
  for (const token of [APP, BOT]) {
    assert.ok(!stored.includes(token), 'not in plugin storage')
    assert.ok(!consoleSeen.some(line => line.includes(token)), 'not on the console')
    assert.ok(!document.body.innerHTML.includes(token), 'not left in the DOM')
    for (let i = 0; i < localStorage.length; i += 1) assert.ok(!String(localStorage.getItem(localStorage.key(i))).includes(token), 'not in localStorage')
  }
  assert.deepEqual(backend.stray, [], 'every call on the bot’s own connection and profile')
  assert.deepEqual(reactErrors(errors), [])
})
