// The roster's own sections under the loader replica (built plugin.js,
// jsdom, clicks): a Bot Sections layout is copied in once on the first run
// and its storage is left exactly as it was; New section (+ menu), Rename,
// Move up / down, collapse, Move to section → (and Default), and Delete (at
// once when empty, behind a confirm when it has bots), each saved to the
// override's own plugin storage. No gateway write happens.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, byLabel, menuItem, reactErrors, rowButton } from './loader-surfaces.mjs'

const WRITES = /^(prompt\.submit|session\.create|profiles\.(create|configure|set_asset)|config\.set)/

const LEGACY = {
  customSections: ['work', 'play'],
  sectionNames: { work: '💼 Work' },
  collapsedSections: ['play'],
  sectionOverrides: { security: 'work', scholar: 'play', scout: 'Unassigned' },
  enabled: true
}

function seedLegacy() {
  for (const [key, value] of Object.entries(LEGACY)) localStorage.setItem(`hermes.plugin.bot-sections.${key}`, JSON.stringify(value))
}

function legacySnapshot() {
  const out = {}
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key.startsWith('hermes.plugin.bot-sections.')) out[key] = localStorage.getItem(key)
  }
  return out
}

const heads = rosterEl => [...rosterEl.querySelectorAll('button.gbo-section-head')].filter(b => !b.closest('.gbo-hidden-head') && !b.classList.contains('is-rooms'))
const head = (rosterEl, name) => heads(rosterEl).find(b => b.childNodes[1]?.textContent === name || b.textContent.replace(/\d+$/, '') === name) || null
const headNames = rosterEl => heads(rosterEl).map(b => b.textContent.replace(/\d+$/, ''))
const contextMenuOf = el => {
  const menu = el?.nextElementSibling
  assert.ok(menu && menu.getAttribute('role') === 'menu', 'a context menu beside it')
  return menu
}
const sectionOfRow = (rosterEl, name) => rowButton(rosterEl, name)?.closest('[role="group"]')?.getAttribute('aria-label') ?? null

function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }))

async function nameField(rosterEl, label, value, finish = 'Enter') {
  const input = await waitFor(() => byLabel(rosterEl, label), `the ${label} field`)
  typeInto(input, value)
  key(input, finish)
  await waitFor(() => !byLabel(rosterEl, label), `the ${label} field closes`)
}

test('loader: a Bot Sections layout is copied once, its storage untouched, and not copied again', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let before = null
  const { panes, mount, store, reload, errors } = await bootFull(t, {
    tweak: () => {
      seedLegacy()
      before = legacySnapshot()
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => head(rosterEl, '💼 Work'), 'the copied section')
  assert.deepEqual(store.get('sections'), {
    version: 1,
    sections: [
      { id: 'work', name: '💼 Work', collapsed: false },
      { id: 'play', name: 'play', collapsed: true }
    ],
    assign: { security: 'work', scholar: 'play' }
  })
  assert.equal(sectionOfRow(rosterEl, 'Security'), '💼 Work')
  assert.equal(rowButton(rosterEl, 'Scholar'), null, 'play is collapsed')
  assert.equal(head(rosterEl, 'play').getAttribute('aria-expanded'), 'false')
  assert.deepEqual(legacySnapshot(), before, 'the Bot Sections storage is left exactly as it was')

  // A change after the copy survives a plugin reload: nothing is re-copied.
  menuItem(contextMenuOf(head(rosterEl, 'play')), 'Delete section').click()
  const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 'the confirm')
  ;[...dialog.querySelectorAll('button')].find(b => b.textContent === 'Delete section').click()
  await waitFor(() => !head(rosterEl, 'play'), 'play deleted')
  await reload()
  const again = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => head(again, '💼 Work'), 'the roster after reload')
  assert.equal(head(again, 'play'), null, 'not copied again')
  assert.deepEqual(store.get('sections').sections.map(s => s.id), ['work'])
  assert.deepEqual(legacySnapshot(), before)
  assert.deepEqual(reactErrors(errors), [])
})

test('loader: new, rename, move, collapse, move a bot, Default and delete', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, mount, store, errors, calls } = await bootFull(t, { primitives: true })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowButton(rosterEl, 'Security') && rowButton(rosterEl, 'Scholar'), 'roster rows')
  const defaultOf = sectionOfRow(rosterEl, 'Security')

  // New section from the roster's + menu; Escape cancels, Enter saves.
  const plusMenu = () => byLabel(rosterEl, 'New bot or group').nextElementSibling
  menuItem(plusMenu(), 'New section').click()
  await nameField(rosterEl, 'New section name', 'Nope', 'Escape')
  assert.equal(head(rosterEl, 'Nope'), null, 'Escape saves nothing')
  menuItem(plusMenu(), 'New section').click()
  await nameField(rosterEl, 'New section name', 'Money')
  await waitFor(() => head(rosterEl, 'Money'), 'the new, empty section')
  const money = store.get('sections').sections[0]
  assert.equal(money.name, 'Money')

  // Move a bot in from its row menu.
  menuItem(contextMenuOf(rowButton(rosterEl, 'Security')), 'Money').click()
  await waitFor(() => sectionOfRow(rosterEl, 'Security') === 'Money', 'Security in Money')
  assert.equal(store.get('sections').assign['local::security'], money.id, 'stored by exact route key')

  // Rename inline from the header's menu.
  menuItem(contextMenuOf(head(rosterEl, 'Money')), 'Rename').click()
  await nameField(rosterEl, 'Rename Money', '💵 Cash')
  await waitFor(() => head(rosterEl, '💵 Cash'), 'renamed')
  assert.equal(sectionOfRow(rosterEl, 'Security'), '💵 Cash', 'its bots stay')

  // A second section, then Move up / Move down.
  menuItem(contextMenuOf(head(rosterEl, '💵 Cash')), 'New section').click()
  await nameField(rosterEl, 'New section name', 'Later')
  await waitFor(() => head(rosterEl, 'Later'), 'second section')
  assert.deepEqual(headNames(rosterEl).slice(0, 2), ['💵 Cash', 'Later'])
  const laterMenu = contextMenuOf(head(rosterEl, 'Later'))
  assert.equal(menuItem(laterMenu, 'Move down').getAttribute('aria-disabled'), 'true', 'the last cannot move down')
  menuItem(laterMenu, 'Move up').click()
  await waitFor(() => headNames(rosterEl)[0] === 'Later', 'Later first')
  menuItem(contextMenuOf(head(rosterEl, 'Later')), 'Move down').click()
  await waitFor(() => headNames(rosterEl)[0] === '💵 Cash', 'Cash first again')

  // Click a header to collapse / expand (persisted).
  head(rosterEl, '💵 Cash').click()
  await waitFor(() => !rowButton(rosterEl, 'Security'), 'collapsed')
  assert.equal(store.get('sections').sections[0].collapsed, true)
  head(rosterEl, '💵 Cash').click()
  await waitFor(() => rowButton(rosterEl, 'Security'), 'expanded')

  // Move to section → Default puts a bot back in its default grouping.
  menuItem(contextMenuOf(rowButton(rosterEl, 'Scholar')), 'Later').click()
  await waitFor(() => sectionOfRow(rosterEl, 'Scholar') === 'Later', 'Scholar in Later')
  menuItem(contextMenuOf(rowButton(rosterEl, 'Scholar')), 'Default').click()
  await waitFor(() => sectionOfRow(rosterEl, 'Scholar') === 'HOME-SERVER', 'Scholar back in its connection section')
  assert.equal(store.get('sections').assign['home-server::scholar'], '')

  // Delete: an empty section goes at once, one with bots asks first.
  menuItem(contextMenuOf(head(rosterEl, 'Later')), 'Delete section').click()
  await waitFor(() => !head(rosterEl, 'Later'), 'Later deleted')
  assert.equal(document.querySelector('[role="dialog"]'), null, 'no confirm for an empty section')
  menuItem(contextMenuOf(head(rosterEl, '💵 Cash')), 'Delete section').click()
  const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 'the confirm')
  assert.match(dialog.textContent, /one bot goes back to its default section/)
  ;[...dialog.querySelectorAll('button')].find(b => b.textContent === 'Delete section').click()
  await waitFor(() => !head(rosterEl, '💵 Cash'), 'Cash deleted')
  await waitFor(() => sectionOfRow(rosterEl, 'Security') === defaultOf, 'Security back in its default section')
  assert.deepEqual(store.get('sections').sections, [])
  assert.equal(store.get('sections').assign['local::security'], undefined)

  assert.deepEqual(reactErrors(errors), [])
  assert.deepEqual(calls.filter(c => WRITES.test(String(c.method))).map(c => c.method), [], 'no gateway write')
})
