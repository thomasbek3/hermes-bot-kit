// Email draft card in the running plugin (ui/EmailDraft.tsx): the rules menu: Allow recipient, Disable drafts for <bot>, Manage rules removes an address.
// One boot per file (test/email-drafts-fixture.mjs). Nothing is sent anywhere.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { button, fakePlugin, openScholar } from './email-drafts-fixture.mjs'

const skip = !READY && 'dev dependencies not installed'

test('loader: the rules menu: Allow recipient, Disable drafts for <bot>, Manage rules removes an address', { skip }, async t => {
  const plugin = fakePlugin()
  const { card } = await openScholar(t, plugin)
  const openMenu = async () => {
    card.querySelector('.gbo-ed-rules').click()
    return waitFor(() => card.querySelector('[role="menu"]'), 'menu')
  }
  let menu = await openMenu()
  const labels = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map(b => b.textContent.trim())
  assert.deepEqual(labels.filter(Boolean), ['Allow recipient', 'Needs approval', 'Disable drafts for Scholar', 'Manage rules'])
  ;[...menu.querySelectorAll('button')].find(b => b.textContent.includes('Allow recipient')).click()
  await waitFor(() => card.querySelector('.gbo-ed-rules').textContent === 'Allow recipient', 'mode label')
  assert.deepEqual(plugin.rules, { mode: 'allow', allowed: ['sam@example.com'] })
  assert.equal(card.dataset.status, 'pending', 'this draft still waits for Send')

  menu = await openMenu()
  ;[...menu.querySelectorAll('button')].find(b => b.textContent.includes('Manage rules')).click()
  const dialog = await waitFor(() => document.querySelector('[aria-label="Email draft rules"]'), 'rules dialog')
  assert.ok(dialog.textContent.includes('sam@example.com'))
  dialog.querySelector('button[aria-label="Remove sam@example.com"]').click()
  await waitFor(() => plugin.rules.allowed.length === 0, 'removed')
  ;[...dialog.querySelectorAll('button[role="radio"]')].find(b => b.textContent.includes('Drafts off')).click()
  await waitFor(() => plugin.rules.mode === 'disabled', 'disabled')
  assert.equal(plugin.ops.filter(o => o.op === 'send').length, 0)
})
