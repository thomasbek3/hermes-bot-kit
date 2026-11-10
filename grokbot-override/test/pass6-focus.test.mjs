// Pass 6 C2: no mouse-focus ring anywhere in the override (Hermes's or the
// browser's), the keyboard's :focus-visible ring kept, and a selected pinned
// tile drawn as a faint neutral fill only (look pass 6). Read from the built plugin.js
// (the stylesheet it injects).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const built = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

test('mouse focus draws no outline in any override root; keyboard focus keeps its ring', () => {
  assert.ok(built.includes('[data-gbo-root] :focus:not(:focus-visible), [data-gbo-root]:focus:not(:focus-visible) { outline: none !important; }'))
  assert.ok(/\.pinned__tile:focus:not\(:focus-visible\)[^{]*\{ box-shadow: none !important; \}/.test(built), 'no ring shadow on a clicked tile')
  assert.ok(/\n:focus-visible \{ outline: 2px solid var\(--color-border-focus\)/.test(built), 'the keyboard ring stays')
  // Look pass 6: the selected pin is a faint neutral fill only, after the reference's grey.
  assert.ok(built.includes('.pinned__tile:hover, .pinned__tile.is-selected { background: var(--color-pin-selected); }'), 'selected = a faint neutral fill')
  assert.ok(built.includes('.pinned__tile { color: inherit; max-width: 100%; border: 0; outline: none; box-shadow: none; }'), 'no box on the tile')
})
