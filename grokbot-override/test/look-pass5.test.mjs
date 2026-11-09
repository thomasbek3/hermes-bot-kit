// Look pass 5: the reference layout CSS applied 1:1 (scoped, zoom-scaled,
// tokens renamed), message groups with tail corners and hover times, the
// header's Share pill, the sidebar's toggle / search / + row with the
// filters in the search field, and markdown inside bubbles.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { cornerClass, GROUP_GAP_MS, groupMessages, messageSide } from '../src/core/groups.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

async function load(t) {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  return import(pathToFileURL(file).href)
}

const bodyOf = html => html.slice(html.indexOf('<body>'))

// ── groups ───────────────────────────────────────────────────────────────

test('groups: same-side runs fold together; a new side, a 5-minute gap or any other row ends a group', () => {
  const t0 = 1_000_000
  const items = [
    { kind: 'divider', id: 'd1' },
    { kind: 'user', id: 'u1', at: t0 },
    { kind: 'user', id: 'u2', at: t0 + 1000 },
    { kind: 'assistant', id: 'a1', at: t0 + 2000 },
    { kind: 'assistant', id: 'a2', at: t0 + 3000 },
    { kind: 'assistant', id: 'a3', at: t0 + 3000 + GROUP_GAP_MS },
    { kind: 'tools', id: 't1', at: t0 + 4000 + GROUP_GAP_MS },
    { kind: 'assistant', id: 'a4', at: t0 + 5000 + GROUP_GAP_MS }
  ]
  const out = groupMessages(items)
  assert.deepEqual(
    out.map(e => (e.kind === 'group' ? `${e.side}:${e.items.map(i => i.id).join(',')}` : e.id)),
    ['d1', 'right:u1,u2', 'left:a1,a2', 'left:a3', 't1', 'left:a4']
  )
  assert.equal(out[1].id, 'group:u1')
  assert.equal(messageSide({ kind: 'approval' }), '')
  assert.deepEqual(groupMessages([]), [])
})

test('groups: tail corners for first, middle and last bubbles; none alone', () => {
  assert.equal(cornerClass(0, 1), '')
  assert.deepEqual([0, 1, 2].map(i => cornerClass(i, 3)), [' is-first', ' is-mid', ' is-last'])
  assert.deepEqual([0, 1].map(i => cornerClass(i, 2)), [' is-first', ' is-last'])
})

// ── the reference CSS, adapted ───────────────────────────────────────────

test('reference CSS: every rule is scoped to the override, tokens renamed, keyframes renamed, lengths divided by the zoom', { skip }, async t => {
  const { refCss, REF_STYLES, CSS } = await load(t)
  const out = refCss(`
:root { --color-bg: #FFF; --text-sm: 13px; }
:root[data-theme='dark'] { --color-bg: #000; }
body { font-size: var(--text-sm); }
.a, .b > .c:hover { padding: 0.5px 10px -4px; animation: rise 100ms; color: var(--bot-bubble, var(--color-bg)); }
.d { color: var(--bot-on-action, #FFFFFF); }
*::before { box-sizing: border-box; }
@keyframes rise { from { transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { .e { animation-duration: 0.01ms; } }
`)
  const W = ':where([data-gbo-root], [data-gbo-root] *)'
  assert.ok(out.includes('[data-gbo-root] { --g-color-bg: #FFF; --g-text-sm: 14.51px; }'), 'tokens on the root, renamed and scaled')
  assert.ok(out.includes('.dark [data-gbo-root], [data-gbo-root][data-gbo-theme="dark"] {'), 'dark follows Hermes')
  assert.ok(out.includes(':where([data-gbo-root]) {'), 'body is the root, with no specificity')
  assert.ok(out.includes(`.a${W}, .b${W} > .c:hover {`), 'scoped on the first compound')
  assert.ok(out.includes('padding: 0.5px 11.16px -4.46px'), 'hairlines kept, the rest / 0.896')
  assert.ok(out.includes('animation: gbo-ref-rise 100ms'))
  assert.ok(out.includes('@keyframes gbo-ref-rise { from { transform: translateY(4.46px); } }'))
  assert.ok(out.includes('var(--gbo-tint-bg, var(--g-color-bg))'), 'the bot bubble colour is the workspace tint')
  assert.ok(out.includes('var(--gbo-tint-fg, var(--g-color-on-primary))'), 'text on the bot colour')
  assert.ok(out.includes(`*${W}::before`), 'pseudo-elements stay last')
  assert.ok(out.includes(`@media (prefers-reduced-motion: reduce) {\n.e${W} {`))

  // The shipped stylesheet: nothing unscoped from the reference reaches Hermes.
  for (const rule of REF_STYLES.split('\n').filter(line => /\{/.test(line) && !/^\s/.test(line) && !line.startsWith('@') && !/^(from|to|\d)/.test(line))) {
    const selectors = rule.slice(0, rule.indexOf('{'))
    assert.ok(selectors.includes('[data-gbo-root]'), `scoped: ${selectors}`)
  }
  assert.doesNotMatch(REF_STYLES, /var\(--(color|text|radius|shadow|font)-/, 'no raw reference token names')
  assert.doesNotMatch(REF_STYLES, /@keyframes (rise|breathe|shimmer|bob|slideIn)\b/, 'no global keyframe names')
  assert.ok(CSS.includes(REF_STYLES), 'part of the override stylesheet')
  // The bubble's max width is the reference's 560px at Hermes's zoom.
  assert.ok(REF_STYLES.includes('.bubble:where([data-gbo-root], [data-gbo-root] *) {\n  max-width: 625px;'))
})

// ── the screen ───────────────────────────────────────────────────────────

test('header: the bot pill, a details toggle only while the panel is closed, and one Share pill holding "open another chat"', { skip }, async t => {
  const { render, MD_ITEMS } = await load(t)
  const closed = bodyOf(render({ theme: 'light', botIndex: 1, items: MD_ITEMS, busy: false, panelOpen: false }))
  assert.match(closed, /class="chat__pill gbo-head-pill"/)
  assert.match(closed, /class="share-btn" aria-label="Share" title="Share" aria-haspopup="menu"[^>]*>Share</)
  assert.ok(closed.includes('aria-label="Show profile"'), 'details toggle while closed')
  assert.ok(!closed.includes('aria-label="Open another chat beside this one"'), 'that action is in the Share menu')
  const open = bodyOf(render({ theme: 'light', botIndex: 1, items: MD_ITEMS, busy: false }))
  assert.ok(!open.includes('aria-label="Show profile"'), 'no toggle while the panel shows (its X and the pill close it)')
  assert.ok(open.includes('aria-label="Close profile"'))
  assert.match(open, /class="details gbo-panel-dock"/)
})

test('sidebar: toggle, search and + in the top row; the filters sit in the search field', { skip }, async t => {
  const { render, appApi } = await load(t)
  const html = bodyOf(render({ theme: 'light' }))
  const top = html.slice(html.indexOf('sidebar__titlebar'), html.indexOf('sidebar__scroll'))
  assert.deepEqual([...top.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1]), ['Hide sidebar', 'Search bots', 'New bot or group'])
  assert.ok(!html.includes('aria-label="Filter roster"'), 'filters only with the search field open')
  // The toggle runs Hermes's own sidebar action through the plugin door.
  const ran = []
  const saved = appApi.app.ctx
  appApi.app.ctx = { runAction: id => (ran.push(id), { ok: true }) }
  try {
    assert.equal(appApi.canToggleSidebar(), true)
    assert.equal(appApi.toggleSidebar(), true)
    assert.deepEqual(ran, ['view.toggleSidebar'])
    appApi.app.ctx = {}
    assert.equal(appApi.canToggleSidebar(), false, 'an older host: no button')
    appApi.app.ctx = { runAction: () => ({ ok: false, error: 'denied' }) }
    assert.equal(appApi.toggleSidebar(), false)
  } finally {
    appApi.app.ctx = saved
  }
})

test('transcript: grouped bubbles with tail corners and hover times; markdown inside the bot bubble', { skip }, async t => {
  const { render, MD_ITEMS } = await load(t)
  const html = bodyOf(render({ theme: 'light', botIndex: 1, items: MD_ITEMS, busy: false, hasMore: false }))
  assert.match(html, /class="transcript__col gbo-column"/)
  // a2 and a3 are one group: first and last corners.
  assert.match(html, /<div class="group is-left"><div class="gbo-msg is-bot"><div class="bubble-wrap is-left"><div class="bubble is-agent is-first">/)
  assert.match(html, /class="bubble is-agent is-last"><div class="md"><div class="aui-md /)
  assert.match(html, /class="bubble is-user"><div class="bubble__plain">Hello!<\/div><\/div><span class="bubble__time">\d{1,2}:\d{2}/)
  assert.ok(html.includes('<strong>This week</strong>'))
  assert.ok(html.includes('class="activity-line') === false, 'idle: no activity line')
  const busy = bodyOf(render({ theme: 'light' }))
  assert.match(busy, /class="activity-line gbo-activity" role="status"><span class="activity-line__mark">/)
})
