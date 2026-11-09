// Pass 6 C2: no mouse-focus ring anywhere in the override (Hermes's or the
// browser's), the keyboard's :focus-visible ring kept, and a selected pinned
// tile drawn as the grey selected fill only. Read from the built plugin.js
// (the stylesheet it injects).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const built = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

test('mouse focus draws no outline in any override root; keyboard focus keeps its ring', () => {
  assert.ok(built.includes('[data-gbo-root] :focus:not(:focus-visible), [data-gbo-root]:focus:not(:focus-visible) { outline: none !important; }'))
  assert.ok(/\.pinned__tile:focus:not\(:focus-visible\)[^{]*\{ box-shadow: none !important; \}/.test(built), 'no ring shadow on a clicked tile')
  assert.ok(/\n:focus-visible \{ outline: 2px solid var\(--color-border-focus\)/.test(built), 'the keyboard ring stays')
  assert.ok(/\.pinned__tile\.is-selected \{ background: var\(--color-bg-active\); \}/.test(built), 'selected = the grey fill')
})
