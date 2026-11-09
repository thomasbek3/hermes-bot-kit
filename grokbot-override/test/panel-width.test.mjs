// The chat | panel hairline: drag clamping, the stored width, double-click
// reset (pass 3, item 7). The sidebar | workspace seam is Hermes's own sash
// (restyled only, test/stock.test.mjs).

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { CHAT_MIN_WIDTH, clampPanelWidth, dragPanelWidth, PANEL_WIDTH, PANEL_WIDTH_KEY, storedPanelWidth } from '../src/core/panelWidth.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

test('panel width clamps to 260-480 px and leaves the chat column 360 px', () => {
  assert.deepEqual(PANEL_WIDTH, { default: 360, min: 260, max: 480 })
  assert.equal(CHAT_MIN_WIDTH, 360)
  assert.equal(clampPanelWidth(100), 260)
  assert.equal(clampPanelWidth(900), 480)
  assert.equal(clampPanelWidth(333.4), 333)
  assert.equal(clampPanelWidth(470, 760), 400, 'a 760px workspace leaves 400px for the panel')
  assert.equal(clampPanelWidth(470, 500), 260, 'never below the 260 floor, even in a tight workspace')
  assert.equal(clampPanelWidth(470, 0), 470, 'an unmeasured workspace only applies the fixed bounds')
  assert.equal(clampPanelWidth(Number.NaN), 360)
})

test('dragging left widens the panel, dragging right narrows it, within the bounds', () => {
  assert.equal(dragPanelWidth(360, 800, 760, 1400), 400)
  assert.equal(dragPanelWidth(360, 800, 860, 1400), 300)
  assert.equal(dragPanelWidth(360, 800, 100, 1400), 480)
  assert.equal(dragPanelWidth(360, 800, 1300, 1400), 260)
  assert.equal(dragPanelWidth(360, 800, 600, 760), 400, 'the chat keeps its 360px of a 760px workspace')
})

test('a stored width reads back clamped; anything unusable is the default', () => {
  assert.equal(storedPanelWidth(420), 420)
  assert.equal(storedPanelWidth(9999), 480)
  assert.equal(storedPanelWidth(null), 360)
  assert.equal(storedPanelWidth(undefined), 360)
  assert.equal(storedPanelWidth('wide'), 360)
})

test('app: the drag resizes live, stores once on release, double-click resets; the width survives a restart', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const { appApi } = await import(pathToFileURL(file).href)
  const { app, startPanelResize, resetPanelWidth, start, stop } = appApi
  const stored = { enabled: false }
  const writes = []
  const ctx = {
    storage: {
      get: (k, f) => (k in stored ? stored[k] : f),
      set: (k, v) => {
        writes.push([k, v])
        stored[k] = v
      }
    }
  }
  start(ctx)
  t.after(() => stop())
  assert.equal(app.panelWidth.get(), 360, 'nothing stored: the default')

  const drag = startPanelResize(900, 1200)
  assert.equal(drag.move(860), 400)
  assert.equal(app.panelWidth.get(), 400, 'live while dragging')
  assert.equal(drag.move(200), 480, 'clamped at the maximum')
  assert.equal(drag.move(600), 480, 'and at what leaves the chat 360px (1200 - 360 = 840, capped at 480)')
  assert.equal(writes.filter(([k]) => k === PANEL_WIDTH_KEY).length, 0, 'nothing stored mid-drag')
  drag.move(880)
  assert.equal(drag.end(), 380)
  assert.deepEqual(writes.filter(([k]) => k === PANEL_WIDTH_KEY), [[PANEL_WIDTH_KEY, 380]], 'stored once, on release')

  const narrow = startPanelResize(900, 700)
  assert.equal(narrow.move(500), 340, 'a 700px workspace caps the panel at 340px')
  narrow.end()

  stored[PANEL_WIDTH_KEY] = 420
  stop()
  start(ctx)
  assert.equal(app.panelWidth.get(), 420, 'read back from the override\'s plugin storage')

  resetPanelWidth()
  assert.equal(app.panelWidth.get(), 360)
  assert.equal(stored[PANEL_WIDTH_KEY], 360, 'the reset is stored too')

  const still = startPanelResize(900, 1200)
  still.end()
  assert.equal(writes.at(-1)[1], 360, 'a click without a move stores nothing new')
})
