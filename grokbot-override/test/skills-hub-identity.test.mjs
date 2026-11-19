// Skills hub (src/ui/ProfileConfig.tsx SkillsHub): one-click Install only for
// a row whose identifier pins one hub entry (Hermes's rule: it contains "/");
// every other row shows the CLI command to copy, safely quoted.

import assert from 'node:assert/strict'
import test from 'node:test'

import { shellQuote, skillQualifiedId, skillRowAction, skillSource, skillsInstallParams } from '../src/core/profileConfig.js'
import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, buttonWithText, dialogEl, SCOUT } from './loader-surfaces.mjs'

const skip = !READY && 'dev dependencies not installed'

test('skills hub: a bare-name row gets no Install, only the quoted CLI command', () => {
  for (const row of [{ name: 'notes' }, { name: 'notes', identifier: 'notes' }, { name: 'notes', id: 'official/notes' }, { name: 'notes', source: 'official' }]) {
    assert.equal(skillQualifiedId(row), '', JSON.stringify(row))
    const action = skillRowAction(row, 'scout')
    assert.equal(action.kind, 'command', JSON.stringify(row))
    assert.equal(action.command, "hermes -p 'scout' skills install 'notes'")
    assert.match(action.note, /hermes skills search/)
  }
})

test('skills hub: a qualified row installs exactly its identifier', () => {
  const row = { name: 'pdf', identifier: ' skills-sh/org/repo/pdf ', source: 'skills-sh' }
  const action = skillRowAction(row, 'scout')
  assert.deepEqual(action, { kind: 'install', identifier: 'skills-sh/org/repo/pdf' })
  assert.deepEqual(skillsInstallParams({ name: 'scout' }, action.identifier), { action: 'install', query: 'skills-sh/org/repo/pdf', profile: 'scout' })
  assert.equal(skillRowAction({ name: 'pdf', identifier: 'official/pdf' }, "o'brien").kind, 'install', 'the profile name does not matter for one-click Install')
})

test('skills hub: a quote, control character or leading dash is refused, never put in a command', () => {
  assert.equal(shellQuote("it's"), '')
  assert.equal(shellQuote('a\nb'), '')
  assert.equal(shellQuote('--force'), '')
  assert.equal(shellQuote(''), '')
  assert.equal(shellQuote('a b;$(rm)'), "'a b;$(rm)'", 'inside single quotes a shell expands nothing')
  for (const [name, profile] of [["it's", 'scout'], ['notes', "o'brien"], ['-x', 'scout'], ['notes', '']]) {
    const action = skillRowAction({ name }, profile)
    assert.equal(action.kind, 'none', `${name} / ${profile}`)
    assert.equal(action.command, undefined)
    assert.match(action.note, /Skills page/)
  }
  assert.equal(skillSource({ source: 'official', trust: 'trusted' }), 'official, trusted')
})

function typeInto(input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('skills hub panel: bare rows show the command and Copy; a qualified row installs its identifier', { skip }, async t => {
  const results = [{ name: 'notes', description: 'one' }, { name: 'notes', description: 'two' }, { name: 'pdf', identifier: 'official/pdf', source: 'official' }]
  const { panes, mount, calls, internals } = await bootFull(t, {
    primitives: false,
    answers: { 'skills.manage': params => (params?.action === 'search' ? { results } : { ok: true }) }
  })
  const copied = []
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } })
  mount(panes.find(p => p.id === 'roster').render)
  internals.openDialog({ kind: 'config', bot: SCOUT, initial: { loaded: true, provider: '', model: '', soul: '', skills: [], toolsets: [], mcp: [] } })
  const dialog = await waitFor(() => dialogEl(false), 'the config dialog')
  const input = dialog.querySelector('input[placeholder="Find skills in the hub"]')
  typeInto(input, 'notes')
  buttonWithText(input.form, 'Search').click()
  const rows = await waitFor(() => {
    const list = [...dialog.querySelectorAll('.gbo-skill-row')]
    return list.length === 3 ? list : null
  }, 'three result rows')

  for (const row of rows.slice(0, 2)) {
    assert.equal(buttonWithText(row, 'Install'), null, 'a bare-name row has no Install')
    assert.equal(row.querySelector('code').textContent, `hermes -p '${SCOUT.name}' skills install 'notes'`)
    assert.match(row.textContent, /hermes skills search/)
  }
  buttonWithText(rows[0], 'Copy').click()
  await waitFor(() => copied.length === 1, 'the copy')
  assert.deepEqual(copied, [`hermes -p '${SCOUT.name}' skills install 'notes'`])

  assert.equal(rows[2].querySelector('code'), null, 'a qualified row shows no command')
  buttonWithText(rows[2], 'Install').click()
  await waitFor(() => calls.some(c => c.method === 'skills.manage' && c.params?.action === 'install'), 'the install call')
  const installs = calls.filter(c => c.method === 'skills.manage' && c.params?.action === 'install')
  assert.equal(installs.length, 1)
  assert.equal(installs[0].params.query, 'official/pdf', 'Install sends exactly the identifier')
})
