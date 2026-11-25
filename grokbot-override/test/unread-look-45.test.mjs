// Unread look, core rules: the "More unreads" pill's geometry (one
// visibility rule for showing it and for choosing its target), and the
// styles (the pill's contrast, the dot's accent blue, the running cue apart).
// Loader-faithful: loader-unread-dot-45, loader-unread-pill-45,
// loader-unread-running-45.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { IN_VIEW_RATIO, nearestUnread, pillSides, scrollTopFor, sideOf } from '../src/core/unreadPill.js'

const css = readFileSync(new URL('../src/ui/styles-adapt.ts', import.meta.url), 'utf8')

test('unread look: one visibility rule: less than half in view is out of view, on the side of its middle', () => {
  assert.equal(IN_VIEW_RATIO, 0.5)
  const view = { top: 100, bottom: 400 }
  const row = (top, h = 54) => ({ rect: { top, bottom: top + h } })
  assert.equal(sideOf(row(0).rect, view), 'up')
  assert.equal(sideOf(row(420).rect, view), 'down')
  assert.equal(sideOf(row(380).rect, view), 'down', 'less than half in view: out of view, below')
  assert.equal(sideOf(row(360).rect, view), null, 'at least half in view')
  assert.equal(sideOf({ top: 60, bottom: 120 }, view), 'up', 'a third in view at the top')
  assert.deepEqual(pillSides([], view), { up: false, down: false })
  assert.deepEqual(pillSides([row(-200), row(500)], view), { up: true, down: true })
})

test('unread look: the pill\'s target is the nearest row out of view that way, a part-visible one included, and it is centred', () => {
  const view = { top: 100, bottom: 400 }
  const row = (top, h = 54) => ({ rect: { top, bottom: top + h } })
  const items = [row(-300), row(-50), row(450), row(900)]
  assert.equal(nearestUnread('up', items, view), items[1])
  assert.equal(nearestUnread('down', items, view), items[2])
  assert.equal(nearestUnread('up', [row(500)], view), null)
  const cut = row(380)
  assert.equal(nearestUnread('down', [cut, row(600)], view), cut, 'the row that shows the pill is the row it reaches')
  assert.equal(scrollTopFor({ top: 450, bottom: 504 }, view, 200), 200 + 350 - 123)
  assert.equal(scrollTopFor({ top: -100, bottom: -46 }, view, 50), 0, 'never above the top')
})

test('unread look: the pill\'s white text reads at 4.5:1 or more, hovered too; the dot keeps the accent blue', () => {
  const pill = css.match(/\.gbo-unread-pill \{[^}]*background: (#[0-9A-Fa-f]{6});/)[1]
  const hover = css.match(/\.gbo-unread-pill:hover \{ background: (#[0-9A-Fa-f]{6}); \}/)[1]
  const lum = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const onWhite = hex => 1.05 / (lum(hex) + 0.05)
  assert.equal(pill.toUpperCase(), '#1366D6')
  assert.equal(hover.toUpperCase(), '#0B59BE')
  assert.ok(onWhite(pill) >= 4.5, `pill ${pill}: ${onWhite(pill).toFixed(2)}:1`)
  assert.ok(onWhite(hover) >= 4.5, `hover ${hover}: ${onWhite(hover).toFixed(2)}:1`)
  assert.ok(!/\.gbo-unread-pill:hover \{[^}]*filter/.test(css), 'no brightening filter on hover')
  assert.match(css, /\.gbo-unread-dot \[role="status"\]\[data-gbo-unread="true"\] \{ background: var\(--color-bot-blue\); \}/)
})

test('unread look: the unread dot draws only the plugin dot; the running cue only working, stalled, background and needs-input', () => {
  assert.match(css, /\.gbo-unread-dot \{ display: inline-flex;/)
  assert.match(css, /\.gbo-unread-dot \[role="status"\]\[data-gbo-unread="true"\] \{ background: var\(--color-bot-blue\); \}/)
  assert.match(css, /\.gbo-run-dot \{ display: none;/)
  // Needs-input (Hermes's amber) moved from the unread slot to the avatar cue
  // when the unread slot became the plugin's own dot (spec 106); Hermes's
  // native unread state (ui-success) never draws anywhere in a bot row.
  assert.match(css, /\.gbo-run-dot:has\(\[role="status"\]\[class\*="ui-accent"\]\), \.gbo-run-dot:has\(\[role="status"\]\[class\*="ui-text-tertiary"\]\), \.gbo-run-dot:has\(\[role="status"\]\[class\*="amber"\]\) \{ display: inline-flex; \}/)
  assert.ok(!/gbo-run-dot:has\(\[role="status"\]\[class\*="ui-success"\]\)/.test(css), 'native unread never drawn')
})
