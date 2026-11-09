// Loader-faithful click-through: the built plugin.js under Hermes's loader
// (hermes-loader.mjs), a real DOM, driven only by clicks the way a user
// would: a roster click opens the chat, switching bots many times over (the
// live Transcript crash fired on exactly this unmount), then the profile
// panel, then every dialog from the menus and panel buttons that open it in
// the app. Nothing is submitted: no gateway write may happen.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, buttonWithText, byLabel, closeDialog, dialogEl, menuItem, openMenu, reactErrors, rowButton } from './loader-surfaces.mjs'

const WRITES = /^(prompt\.submit|session\.create|session\.title|profiles\.(create|configure|set_asset)|cron\.manage:(?!list)|groups\.(create|send|approve|stop|continue|rename|disband)|message\.react|display\.(start|stop|takeover|install))/

test('loader-faithful click-through: roster → chat → switch bots repeatedly → profile → every dialog', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const primitives = true
  const { panes, workspaces, mount, errors, calls, internals } = await bootFull(t, { primitives })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowButton(rosterEl, 'Security') && rowButton(rosterEl, 'Scholar') && rowButton(rosterEl, 'Scout'), 'roster rows')

  // Switch bots repeatedly through the roster.
  let chatEl = null
  const order = ['Security', 'Scholar', 'Scout', 'Security', 'Scout', 'Scholar', 'Security', 'Scholar', 'Scout']
  for (const [i, name] of order.entries()) {
    rowButton(rosterEl, name).click()
    if (!chatEl) chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat workspace')).render)
    const profile = name.toLowerCase()
    await waitFor(() => (chatEl.querySelector('.gbo-transcript') && chatEl.textContent.includes(`hello ${profile}`)) || errors.length, `${name}'s transcript (switch ${i + 1})`)
    assert.deepEqual(reactErrors(errors), [], `no React error after switch ${i + 1} to ${name}`)
    assert.ok(!chatEl.querySelector('[data-gbo-error]'), `no boundary card after switch ${i + 1}`)
  }

  // Open the profile panel (Scout is the open bot).
  if (!chatEl.querySelector('.gbo-panel')) byLabel(chatEl, 'Show profile').click()
  const panel = await waitFor(() => chatEl.querySelector('.gbo-panel .gbo-job-open') && chatEl.querySelector('.gbo-panel'), 'the profile panel with Scout\'s job')
  assert.match(panel.getAttribute('aria-label') || '', /Scout profile/)

  const expectDialog = async (open, title) => {
    await open()
    const el = await waitFor(() => dialogEl(primitives), `the ${title} dialog`)
    assert.ok(el.textContent.includes(title), `${title}: ${el.textContent.slice(0, 120)}`)
    await closeDialog(internals, primitives)
    assert.deepEqual(reactErrors(errors), [], `no React error around ${title}`)
  }
  const fromRowMenu = (bot, item) => async () => {
    const menu = await openMenu(byLabel(rosterEl, `Actions for ${bot}`), primitives)
    menuItem(menu, item).click()
  }
  const fromPlusMenu = item => async () => {
    const menu = await openMenu(byLabel(rosterEl, 'New bot or group'), primitives)
    menuItem(menu, item).click()
  }
  const click = (root, find) => async () => {
    const el = typeof find === 'function' ? find() : byLabel(root, find)
    assert.ok(el, `control ${typeof find === 'string' ? find : 'found'}`)
    el.click()
  }

  // Row menu dialogs (R11, R12, P6).
  await expectDialog(fromRowMenu('Scout', 'Edit profile…'), 'Edit profile')
  await expectDialog(fromRowMenu('Scout', 'Skills, tools and model…'), 'skills, tools and model')
  await expectDialog(fromRowMenu('Scout', 'Groups: Research'), 'Groups')
  await expectDialog(fromRowMenu('Scout', 'Delete…'), 'Delete this bot?')
  // + menu (R13), then the native New group form (R14 via setNewGroupOpener).
  await expectDialog(fromPlusMenu('New bot…'), 'New bot')
  await fromPlusMenu('New group chat…')()
  await waitFor(() => rosterEl.querySelector('.gbo-new-group'), 'the New group form')
  // Profile panel dialogs (P3 jobs, profile, config, groups).
  await expectDialog(click(panel, 'New scheduled job'), 'New scheduled job')
  await expectDialog(click(panel, () => panel.querySelector('.gbo-job-open')), 'Digest')
  await expectDialog(click(panel, 'Edit Digest'), 'Edit scheduled job')
  await expectDialog(click(panel, 'Delete Digest'), 'Delete this job?')
  await expectDialog(click(panel, () => buttonWithText(panel, 'Edit profile and avatar')), 'Edit profile')
  await expectDialog(click(panel, () => buttonWithText(panel, 'Skills, tools, MCP and model')), 'skills, tools and model')
  await expectDialog(click(panel, () => [...panel.querySelectorAll('button.gbo-panel-link')].find(b => b.textContent.trim() === 'Groups')), 'Groups')

  // And back to switching after the dialogs.
  for (const name of ['Security', 'Scout', 'Scholar']) {
    rowButton(rosterEl, name).click()
    await waitFor(() => chatEl.textContent.includes(`hello ${name.toLowerCase()}`), `${name} again`)
  }

  assert.deepEqual(reactErrors(errors), [], 'no React error in the whole click-through')
  const writes = calls.filter(c => WRITES.test(`${c.method}${c.method === 'cron.manage' ? `:${c.params?.action}` : ''}`))
  assert.deepEqual(writes, [], 'opening, switching and browsing dialogs never writes')
})
