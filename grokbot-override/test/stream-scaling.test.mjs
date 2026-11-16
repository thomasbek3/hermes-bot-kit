// streamSafe's per-tick work grows linearly with the reply (review INT-03):
// an emphasis scan that searched every earlier delimiter run for each closer
// took ~90 ms on a 20k paragraph of closing-only runs ('a* a* …') and grew
// 4x when the text doubled. Checked by growth, never by absolute time: a
// deterministic work count, and a CPU-time ratio (best of several runs).

import assert from 'node:assert/strict'
import test from 'node:test'

import { scanStats, streamSafeParts } from '../src/core/streamSafe.js'

const SHAPES = {
  'closing-only runs': n => 'a* '.repeat(n).slice(0, n),
  'opening-only runs': n => ' *a'.repeat(n).slice(0, n),
  'underscore runs': n => 'a_ b _c '.repeat(n).slice(0, n),
  'mixed runs': n => '*a **b c* d** e*** ***f ~g~ ~~h~ i_ _j__ '.repeat(n).slice(0, n),
  'intraword runs': n => '2*3*4**5***6 a*b*c '.repeat(n).slice(0, n),
  'tilde runs': n => '~a ~~b ~c~~ d~ '.repeat(n).slice(0, n)
}

function steps(text) {
  scanStats.emphasisSteps = 0
  streamSafeParts(text)
  return scanStats.emphasisSteps
}

test('scaling: emphasis work is linear in the paragraph (4x the text, at most 6x the steps)', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    const small = steps(make(5_000))
    const large = steps(make(20_000))
    assert.ok(large <= Math.max(6 * small, 200), `${name}: ${small} steps at 5k, ${large} at 20k`)
    assert.ok(large <= 20 * 20_000, `${name}: ${large} steps for 20k characters`)
  }
})

/** Best-of-`runs` CPU time of fn (ms): preemption and GC only ever add. */
function cpuMs(fn, runs = 5) {
  let best = Infinity
  for (let r = 0; r < runs; r += 1) {
    const t0 = process.cpuUsage()
    fn()
    const d = process.cpuUsage(t0)
    best = Math.min(best, (d.user + d.system) / 1000)
  }
  return best
}

test('scaling: a whole tick grows linearly too (4x the text, under 8x the CPU time; quadratic is 16x)', () => {
  for (const name of ['closing-only runs', 'mixed runs']) {
    const make = SHAPES[name]
    const small = make(10_000)
    const large = make(40_000)
    streamSafeParts(small) // warm up
    const a = cpuMs(() => streamSafeParts(small))
    const b = cpuMs(() => streamSafeParts(large))
    // A floor keeps a sub-millisecond small run from inflating the ratio.
    assert.ok(b < 8 * Math.max(a, 2), `${name}: ${a.toFixed(2)} ms at 10k, ${b.toFixed(2)} ms at 40k`)
  }
})
