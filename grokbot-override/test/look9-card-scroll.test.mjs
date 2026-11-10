// Look 9, item 3: the open Bot Chat "popping up and down" while scrolling past
// a live ::card. Cause: the roster hands the transcript a fresh bot object on
// every refresh (3 s); the card's read was keyed by that object, so each
// refresh restarted it, blanked the card to its loading box and drew it again
// (the transcript has overflow-anchor: none, so everything under it moved).
// The ::preview frame did the same (re-read, iframe remounted at its start
// height). Now reads key by the bot's route, a poll that returns the same text
// changes nothing, a final card is never read again, and a re-read never
// blanks what is drawn. The message hover bar floats beside the message, out
// of flow, and the stick-to-bottom margin is small. jsdom + the real modules
// (dev bundle, fake SDK).

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ready =
  existsSync(new URL('../node_modules/esbuild', import.meta.url)) &&
  existsSync(new URL('../node_modules/react-dom', import.meta.url)) &&
  existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await flush()
}

const CARD = {
  schema: 'card.v1',
  kind: 'approval',
  title: 'Quick test',
  status: { state: 'awaiting-approval' },
  body: [{ type: 'text', text: 'Can you see this card?' }],
  actions: [
    { label: 'Yes', send: 'yes' },
    { label: 'No', send: 'no' }
  ]
}
const RESOLVED = { ...CARD, status: { state: 'done' }, resolved: { action: 'Yes', at: '2026-11-09T21:00:00Z' } }

const botObject = () => ({
  name: 'scholar',
  display_name: 'Scholar',
  connectionId: 'local',
  connectionKind: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: 'scholar', targetProfile: 'scholar' },
  canonical_session: { id: 's-root' }
})

let env = null
async function setup(t) {
  if (env) return env
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
    set(key, key === 'getComputedStyle' ? w.getComputedStyle.bind(w) : w[key])
  }
  set('IS_REACT_ACT_ENVIRONMENT', false)
  // The card's 3 s poll timers are held here and run by the test.
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const polls = new Map()
  let seq = 0
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms !== 3000) return realSet(fn, ms, ...rest)
    seq += 1
    const id = { poll: seq }
    polls.set(id, fn)
    return id
  }
  globalThis.clearTimeout = id => (id && typeof id === 'object' && 'poll' in id ? polls.delete(id) : realClear(id))
  const runPolls = () => {
    const due = [...polls.entries()]
    polls.clear()
    for (const [, fn] of due) fn()
  }
  const reads = []
  let fileText = JSON.stringify(CARD)
  w.hermesDesktop = {
    api: async request => {
      reads.push(request.path)
      return { text: fileText }
    }
  }
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  const m = await import(pathToFileURL(file).href)
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  t.after(() => {
    rmSync(dirname(file), { recursive: true, force: true })
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    dom.window.close()
  })
  env = { m, React, createRoot, polls, runPolls, reads, setText: text => (fileText = text) }
  return env
}

function mountCard({ m, React, createRoot }, file = 'cards/c.json', name = 'card') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const segment = { name, attrs: { file }, source: `::${name}{file=${file}}` }
  const draw = (bot, poll = true) => {
    // A fresh scope object each time, as the transcript builds it.
    const scope = { bot, sessionId: 's-root', sendIntent: async () => ({ ok: true }), recent: new Set(['m1']) }
    root.render(React.createElement(m.DirectiveBlock, { segment, poll, scope }))
  }
  const observer = new MutationObserver(() => undefined)
  observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true })
  return { container, draw, mutations: () => observer.takeRecords(), unmount: () => (observer.disconnect(), root.unmount(), container.remove()) }
}

test('a poll that returns the same card changes nothing; a fresh bot object neither re-reads nor blanks the card; an aged-out card stops polling', { skip }, async t => {
  const e = await setup(t)
  e.reads.length = 0
  e.setText(JSON.stringify(CARD))
  const card = mountCard(e, 'cards/same.json')
  card.draw(botObject())
  await settle()
  assert.equal(card.container.querySelector('.gbo-dcard-title')?.textContent, 'Quick test')
  assert.equal(e.reads.length, 1)
  assert.equal(e.polls.size, 1, 'a waiting card polls')
  card.mutations()

  // Three polls with unchanged content: read each time, DOM untouched.
  for (let i = 0; i < 3; i += 1) {
    e.runPolls()
    await settle()
  }
  assert.equal(e.reads.length, 4)
  assert.deepEqual(card.mutations(), [], 'an unchanged poll makes no DOM change (no height change)')
  assert.equal(e.polls.size, 1, 'still polling')

  // A roster refresh: same route, new bot object, new scope.
  for (let i = 0; i < 3; i += 1) {
    card.draw(botObject())
    await settle()
  }
  assert.equal(e.reads.length, 4, 'no re-read on a fresh bot object')
  assert.deepEqual(card.mutations(), [], 'never swapped to the loading box')
  assert.ok(!card.container.querySelector('.is-loading'))

  // The message ages out of the polling window: drawn as is, no more polls.
  card.draw(botObject(), false)
  await settle()
  assert.equal(e.polls.size, 0, 'polling stopped')
  assert.equal(e.reads.length, 4, 'no read either')
  assert.deepEqual(card.mutations(), [])

  // Sanity: a change in the file still shows (polling is not just broken).
  card.draw(botObject(), true)
  await settle()
  e.setText(JSON.stringify({ ...CARD, title: 'Quick test, updated' }))
  e.runPolls()
  await settle()
  assert.equal(card.container.querySelector('.gbo-dcard-title')?.textContent, 'Quick test, updated')
  card.unmount()
  e.polls.clear()
})

test('a resolved card is read once and never polled again', { skip }, async t => {
  const e = await setup(t)
  e.reads.length = 0
  e.setText(JSON.stringify(RESOLVED))
  const card = mountCard(e, 'cards/resolved.json')
  card.draw(botObject())
  await settle()
  assert.ok(card.container.querySelector('.gbo-dcard.is-settled'), 'settled card drawn')
  assert.ok(card.container.querySelector('.gbo-ask-row.is-on .gbo-ask-check'), 'Yes is checked')
  assert.equal(e.reads.length, 1)
  assert.equal(e.polls.size, 0, 'no poll scheduled for a final card')
  card.mutations()
  for (let i = 0; i < 3; i += 1) {
    card.draw(botObject())
    await settle()
  }
  assert.equal(e.reads.length, 1, 'never read again')
  assert.equal(e.polls.size, 0)
  assert.deepEqual(card.mutations(), [])
  card.unmount()
})

test('a ::preview reads once: a fresh bot object neither re-reads it nor remounts its frame', { skip }, async t => {
  const e = await setup(t)
  e.reads.length = 0
  e.setText('<p>hello</p>')
  const view = mountCard(e, 'widgets/w.html', 'preview')
  view.draw(botObject())
  await settle()
  const frame = view.container.querySelector('iframe.gbo-preview-frame')
  assert.ok(frame, 'frame drawn')
  assert.equal(e.reads.length, 1)
  view.mutations()
  for (let i = 0; i < 3; i += 1) {
    view.draw(botObject())
    await settle()
  }
  assert.equal(e.reads.length, 1, 'no re-read')
  assert.equal(view.container.querySelector('iframe.gbo-preview-frame'), frame, 'same frame element (not remounted at its start height)')
  assert.ok(!view.container.querySelector('.is-loading'))
  view.unmount()
})

test('the hover action bar is out of flow, beside the message, and the same box hovered or not; small stick-to-bottom margin', { skip }, async t => {
  const e = await setup(t)
  const css = e.m.CSS
  const rule = sel => {
    const re = new RegExp(`(^|\\n)${sel}\\s*\\{([^}]*)\\}`)
    const hit = css.match(re)
    assert.ok(hit, `rule ${sel}`)
    return hit[2]
  }
  const W = ':where\\(\\[data-gbo-root\\], \\[data-gbo-root\\] \\*\\)'
  const base = rule(`\\.gbo-msg${W} > \\.gbo-msg-actions`)
  assert.match(base, /position: absolute/, 'out of flow')
  assert.match(base, /bottom: 0/)
  assert.ok(!/top: calc\(100%/.test(base), 'no longer under the message (it covered the next bubble)')
  const hover = rule(`\\.gbo-msg:hover${W} > \\.gbo-msg-actions, \\.gbo-msg:focus-within${W} > \\.gbo-msg-actions`)
  const props = hover
    .split(';')
    .map(part => part.split(':')[0].trim())
    .filter(Boolean)
  assert.deepEqual(props.sort(), ['opacity', 'pointer-events'], 'hover changes nothing that takes room')
  assert.match(rule(`\\.gbo-msg\\.is-bot${W} > \\.gbo-msg-actions`), /left: min\(calc\(100% \+ [\d.]+px\), calc\(100cqw \+ [\d.]+px - [\d.]+px\)\)/, 'right of a bot message, kept in the column')
  assert.match(rule(`\\.gbo-msg\\.is-user${W} > \\.gbo-msg-actions`), /right: min\(calc\(100% \+ [\d.]+px\), calc\(100cqw \+ [\d.]+px - [\d.]+px\)\)/)
  assert.match(css, /\.transcript__col[^{]*\{[^}]*container-type: inline-size/)
  assert.ok(e.m.STICK_PX <= 24, 'a reader a few lines up is not pulled back down')
})
