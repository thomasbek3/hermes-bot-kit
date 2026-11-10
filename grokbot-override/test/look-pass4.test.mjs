// Look pass 4: bot swatches (user bubbles, send, switches), hidden work rows,
// pinned bots, avatar silhouettes. Pure core tests first, then the real UI
// bundled with the fake SDK (dev/bundle.mjs), rendered without a DOM.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { BOT_SWATCHES, botSwatch, botTintVars, parseColor } from '../src/core/colors.js'
import { MAX_PINS, pinsFrom, pinState, togglePin, withoutPinned } from '../src/core/pins.js'
import { activityLabel, loadShowWork, showWorkFrom, visibleItems } from '../src/core/workRows.js'
import { rowKey } from '../src/core/roster.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

async function load(t) {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  return import(pathToFileURL(file).href)
}

/** A rendered page's body (the inline stylesheet names every class). */
const bodyOf = html => html.slice(html.indexOf('<body>'))

const bot = (name, connectionId = 'local', extra = {}) => ({
  name,
  connectionId,
  sourceScoped: true,
  ...(connectionId === 'local' ? {} : { remoteSource: true }),
  route: { connectionId, mode: connectionId === 'local' ? 'local' : 'remote', profile: name, targetProfile: name },
  ...extra
})

// ── colours ──────────────────────────────────────────────────────────────

test('every bot colour maps to the nearest of the eleven swatches', () => {
  assert.equal(BOT_SWATCHES.length, 11)
  const cases = {
    '#ea3f8f': 'magenta',
    'hsl(330 68% 58%)': 'magenta', // Hermes's own profileColor() form
    'hsl(330, 68%, 58%)': 'magenta',
    '#facc15': 'yellow',
    '#eab308': 'yellow',
    '#8b5cf6': 'violet',
    '#ff6b35': 'orange',
    '#3b82f6': 'blue',
    '#22c55e': 'green',
    '#14b8a6': 'cyan',
    '#ef4444': 'red',
    'rgb(160, 107, 57)': 'brown',
    '#999999': 'gray',
    '#111': 'black'
  }
  for (const [colour, name] of Object.entries(cases)) assert.equal(botSwatch(colour).name, name, colour)
  // Each swatch's own fill maps to itself.
  for (const swatch of BOT_SWATCHES) assert.equal(botSwatch(swatch.fill).name, swatch.name)
  assert.equal(botSwatch('not a colour').name, 'violet')
  assert.deepEqual(parseColor('hsl(0 100% 50%)'), [255, 0, 0])
  assert.equal(parseColor('nope'), null)
})

test('a bot\'s chat wears its swatch: bubble under white text, action and hover; black keeps the theme', () => {
  assert.deepEqual(botTintVars('#ea3f8f'), { '--gbo-tint-bg': '#C82779', '--gbo-tint-fg': '#FFFFFF', '--gbo-action': '#E52F8B', '--gbo-action-hover': '#C82779' })
  // A light yellow is not deepened or given dark text: the yellow swatch.
  assert.deepEqual(botTintVars('#facc15'), { '--gbo-tint-bg': '#C2730B', '--gbo-tint-fg': '#FFFFFF', '--gbo-action': '#DA830E', '--gbo-action-hover': '#C2730B' })
  assert.equal(botTintVars('#000000'), undefined)
})

// ── work rows ────────────────────────────────────────────────────────────

const ITEMS = [
  { kind: 'user', id: 'u1', text: 'hi' },
  { kind: 'assistant', id: 'a1', text: 'Hello', reasoning: 'greet' },
  { kind: 'assistant', id: 'a2', text: '', reasoning: 'only thinking' },
  { kind: 'tools', id: 't1', tools: [{ id: 'c1', status: 'done' }] },
  { kind: 'approval', id: 'ap', status: 'pending' },
  { kind: 'notice', id: 'n1', text: 'note' },
  { kind: 'error', id: 'e1', text: 'boom' },
  { kind: 'command', id: 'c1', command: '/x' }
]

test('Thought and tool rows are hidden by default; approvals, notices, errors and commands stay', () => {
  const shown = visibleItems(ITEMS, false)
  assert.deepEqual(shown.map(item => item.id), ['u1', 'a1', 'ap', 'n1', 'e1', 'c1'])
  assert.equal(shown[1].reasoning, undefined, 'the reply keeps its text, not its reasoning')
  assert.equal(ITEMS[1].reasoning, 'greet', 'display only: the item itself is untouched')
  assert.equal(visibleItems(ITEMS, true), ITEMS, 'the preference brings every row back')
})

test('the work-rows setting is the override\'s stored showWork, true only when explicitly true', () => {
  assert.equal(showWorkFrom(true), true)
  for (const value of [false, undefined, null, 'true', 1]) assert.equal(showWorkFrom(value), false)
})

test('the work-rows setting: Bubble Mode\'s old preference is copied once, the override\'s own value wins after', () => {
  assert.deepEqual(loadShowWork(undefined, true), { value: true, write: true }, 'copied on the first run')
  assert.deepEqual(loadShowWork(undefined, undefined), { value: false, write: true }, 'none: hidden, stored once')
  assert.deepEqual(loadShowWork(undefined, 'true'), { value: false, write: true }, 'only an explicit true')
  assert.deepEqual(loadShowWork(false, true), { value: false, write: false }, 'already set: the old preference is not read again')
  assert.deepEqual(loadShowWork(true, false), { value: true, write: false })
  assert.deepEqual(loadShowWork('yes', true), { value: true, write: true }, 'a malformed own value is replaced by the copy')
})

test('with work rows hidden the working indicator stands in for a running tool or a reply still thinking', () => {
  const running = { items: [{ kind: 'tools', tools: [{ status: 'running' }] }] }
  assert.equal(activityLabel(running, false), 'Working')
  assert.equal(activityLabel(running, true), '')
  const thinking = { items: [{ kind: 'assistant', streaming: true, text: '' }] }
  assert.equal(activityLabel(thinking, false), 'Thinking')
  assert.equal(activityLabel({ items: [{ kind: 'assistant', streaming: true, text: 'Hel' }] }, false), '')
  assert.equal(activityLabel({ items: [{ kind: 'approval', status: 'pending' }] }, false), '')
  assert.equal(activityLabel({ items: [], waiting: { kind: 'clarify' } }, false), '')
})

// ── pins ─────────────────────────────────────────────────────────────────

test('pins are exact route keys: a local and a remote bot with the same name never share one', () => {
  const local = bot('alpha')
  const remote = bot('alpha', 'mini')
  const rows = [local, remote]
  const { pins } = togglePin([], rowKey(remote), rows, rowKey)
  assert.deepEqual(pins, ['mini::alpha'])
  const state = pinState(pins, rows, rowKey)
  assert.deepEqual(state.shown, [remote])
  assert.deepEqual(withoutPinned(rows, state, rowKey), [local], 'the pinned one leaves its section; its namesake stays')
})

test('pin, unpin, and a cap of four shown pins', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map(name => bot(name))
  let pins = []
  for (const row of rows.slice(0, 4)) {
    const result = togglePin(pins, rowKey(row), rows, rowKey)
    assert.ok(result.changed && result.pinned)
    pins = result.pins
  }
  assert.equal(MAX_PINS, 4)
  assert.equal(pinState(pins, rows, rowKey).canPin, false)
  const refused = togglePin(pins, rowKey(rows[4]), rows, rowKey)
  assert.equal(refused.changed, false, 'a fifth is refused')
  assert.deepEqual(refused.pins, pins)
  const unpinned = togglePin(pins, 'local::b', rows, rowKey)
  assert.ok(unpinned.changed && !unpinned.pinned)
  assert.deepEqual(unpinned.pins, ['local::a', 'local::c', 'local::d'])
  assert.deepEqual(togglePin(unpinned.pins, 'local::e', rows, rowKey).pins, ['local::a', 'local::c', 'local::d', 'local::e'], 'pin order is kept')
})

test('a pin whose bot left the roster is kept but hidden, and does not count toward the cap', () => {
  const rows = ['a', 'b', 'c', 'd'].map(name => bot(name))
  const pins = ['local::gone', 'local::a', 'local::b', 'local::c']
  const state = pinState(pins, rows, rowKey)
  assert.deepEqual(state.shown.map(row => row.name), ['a', 'b', 'c'])
  assert.equal(state.canPin, true)
  const next = togglePin(pins, 'local::d', rows, rowKey)
  assert.deepEqual(next.pins, [...pins, 'local::d'], 'the missing bot\'s pin survives')
  assert.deepEqual(pinsFrom(['x', 'x', '', 3, null, 'y']), ['x', 'y'], 'stored junk is dropped')
  assert.deepEqual(pinsFrom('nope'), [])
})

// ── UI ───────────────────────────────────────────────────────────────────

test('avatar silhouettes: stable per route key, varied across keys, and a real photo still wins', { skip }, async t => {
  const { avatarShapesApi, render } = await load(t)
  const { AVATAR_SHAPES, avatarShapeFor, hashKey } = avatarShapesApi
  assert.deepEqual(AVATAR_SHAPES.map(shape => shape.name), ['blob', 'cloud', 'clover', 'flower', 'heart', 'hexagon', 'house', 'sparkle', 'square', 'star', 'teardrop', 'pebble'])
  for (const shape of AVATAR_SHAPES) {
    assert.match(shape.viewBox, /^[\d.]+ [\d.]+ [\d.]+ [\d.]+$/, shape.name)
    assert.equal((shape.outline.match(/M/g) || []).length, 1, `${shape.name}: one closed contour`)
    assert.equal((shape.eyes.match(/M/g) || []).length, 2, `${shape.name}: two eyes`)
    assert.ok(Object.isFrozen(shape), shape.name)
  }
  const bytes = AVATAR_SHAPES.reduce((sum, shape) => sum + shape.outline.length + shape.eyes.length, 0)
  assert.ok(bytes < 20_000, `shape data is ${bytes} bytes`)
  assert.equal(hashKey('mini::alpha'), hashKey('mini::alpha'))
  assert.equal(avatarShapeFor('mini::alpha'), avatarShapeFor('mini::alpha'))
  const names = new Set(Array.from({ length: 200 }, (_, i) => avatarShapeFor(`local::bot${i}`).name))
  assert.ok(names.size >= 12, `200 keys use ${names.size} shapes`)
  const keys = Array.from({ length: 50 }, (_, i) => `x${i}`)
  assert.ok(keys.some(name => avatarShapeFor(`local::${name}`).name !== avatarShapeFor(`mini::${name}`).name), 'the route key, not the name, picks the shape')

  const html = render({ theme: 'light', botIndex: 4 })
  const pink = avatarShapeFor('local::recipes').name
  assert.ok(html.includes(`data-shape="${pink}"`), 'the pink bot wears its route key\'s shape')
  assert.ok(html.includes('fill="#F93498"'), 'filled with the magenta swatch fill')
})

test('a bot with a real avatar image shows the image, not a silhouette', { skip }, async t => {
  const { renderElement, Avatar } = await load(t)
  const html = renderElement(Avatar.BotAvatar, { name: 'x', meta: { image: 'data:image/png;base64,AAAA', color: '#ea3f8f' }, size: 40, shapeKey: 'local::x' })
  assert.match(html, /<img/)
  assert.ok(!html.includes('data-shape'))
  const shape = renderElement(Avatar.BotAvatar, { name: 'x', meta: { color: '#ea3f8f' }, size: 40, shapeKey: 'local::x' })
  assert.match(shape, /data-shape=/)
  assert.ok(shape.includes('fill="#F93498"'))
})

test('the chat hides Thought and tool rows by default and shows them with the preference', { skip }, async t => {
  const { render } = await load(t)
  const hidden = bodyOf(render({ theme: 'light' }))
  for (const text of ['May I run this?', 'Allow once', 'Can you find a cabin near the lake for next weekend?', 'Working…']) assert.ok(hidden.includes(text), `kept: ${text}`)
  for (const text of ['Thought', '2 tools', 'gbo-think', 'class="gbo-tools']) assert.ok(!hidden.includes(text), `hidden: ${text}`)
  const shown = bodyOf(render({ theme: 'light', showWork: true }))
  for (const text of ['Thought', '2 tools']) assert.ok(shown.includes(text), `shown: ${text}`)
})

test('the user bubbles, send button and switches take the bot\'s swatch through workspace variables', { skip }, async t => {
  const { render, CSS } = await load(t)
  const html = render({ theme: 'light', botIndex: 4 })
  assert.match(html, /--gbo-tint-bg:\s*#C82779/)
  assert.match(html, /--gbo-action:\s*#E52F8B/)
  // The reference layout's rules (styles-ref.ts), scoped to the override
  // root, read the bot's colour from the workspace variables.
  assert.match(CSS, /\.bubble\.is-user:where\(\[data-gbo-root\], \[data-gbo-root\] \*\) \{[^}]*var\(--gbo-tint-bg, var\(--g-color-bubble-user\)\)/)
  assert.match(CSS, /\.composer__cta:where\(\[data-gbo-root\], \[data-gbo-root\] \*\) \{[^}]*background: var\(--gbo-action, var\(--g-color-primary\)\); color: var\(--gbo-tint-fg, var\(--g-color-on-primary\)\)/)
  assert.match(CSS, /\.toggle\.is-on:where\(\[data-gbo-root\], \[data-gbo-root\] \*\) \{ background: var\(--gbo-action, var\(--g-color-primary\)\); \}/)
  const html2 = render({ theme: 'light', botIndex: 4, items: [{ kind: 'user', id: 'u', text: 'hi', at: Date.now() }], busy: false })
  assert.match(html2, /class="bubble is-user"/, 'your bubble uses the reference markup')
  assert.match(render({ theme: 'light' }), /class="toggle gbo-switch is-on" aria-checked="true"/, 'an on switch')
})

test('pinned bots render on top, once, with names; panel rows are one line with the full text in title', { skip }, async t => {
  const { render, CSS } = await load(t)
  const html = bodyOf(render({ theme: 'light', pins: ['scholar', 'recipes'] }))
  const pins = html.slice(html.indexOf('gbo-pins'), html.indexOf('aria-label="This device"'))
  assert.match(pins, /gbo-pin-name">Scholar</)
  assert.match(pins, /gbo-pin-name">Recipes</)
  assert.equal((html.match(/gbo-row-name">Scholar</g) || []).length, 0, 'not listed again in its section')
  assert.equal((html.match(/gbo-row-name">Travel</g) || []).length, 1)
  assert.ok(!bodyOf(render({ theme: 'light' })).includes('gbo-pins'), 'no strip without pins')
  for (const text of ['title="Skills, tools, MCP and model"', 'title="Bot’s computer · Asleep"', 'title="Edit profile and avatar"']) assert.ok(html.includes(text), text)
  assert.match(CSS, /\.panel-row__title:where\(\[data-gbo-root\], \[data-gbo-root\] \*\), \.panel-row__sub:where\(\[data-gbo-root\], \[data-gbo-root\] \*\) \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/)
  assert.match(html, /class="panel-row__title">Skills, tools, MCP and model</)
  // A class sets its own font: the element rule has no extra specificity.
  assert.match(CSS, /:where\(\[data-gbo-root\]\) button \{ font: inherit; color: inherit; \}/)
})

test('a black bot\'s shape turns dark grey on a dark theme so it stays visible; eyes stay white', { skip }, async t => {
  const { renderElement, Avatar, CSS } = await load(t)
  const html = renderElement(Avatar.BotAvatar, { name: 'x', meta: { color: '#000000' }, size: 40, shapeKey: 'local::x' })
  assert.match(html, /data-swatch="black"/)
  assert.ok(html.includes('fill="#000000"'), 'black on light')
  assert.ok(html.includes('fill="#fff"'), 'white eyes underneath')
  assert.match(CSS, /\.dark \.gbo-avatar svg\[data-swatch="black"\] > path:last-child,\s*\[data-gbo-theme="dark"\] \.gbo-avatar svg\[data-swatch="black"\] > path:last-child \{ fill: #2c2c2c; \}/)
})
