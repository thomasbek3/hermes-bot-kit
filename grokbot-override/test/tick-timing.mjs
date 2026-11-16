// Load-robust per-tick timing for the streaming performance gates (review
// INT-04). Each tick is measured in CPU time (scheduler preemption does not
// count) over several sweeps, and its best run is kept (GC or a stall only
// ever adds), so a busy machine or a parallel test run cannot fail the gate
// while a real slowdown, which shows in every run, still does.

/** Per-tick best-of-`runs` CPU milliseconds of fn(big.slice(0, i)). */
export function bestTickMs(fn, big, { step = 40, runs = 3 } = {}) {
  const ticks = []
  for (let i = step; i <= big.length; i += step) ticks.push(i)
  const best = new Array(ticks.length).fill(Infinity)
  for (let r = 0; r < runs; r += 1) {
    ticks.forEach((end, k) => {
      const text = big.slice(0, end)
      const t0 = process.cpuUsage()
      fn(text)
      const d = process.cpuUsage(t0)
      best[k] = Math.min(best[k], (d.user + d.system) / 1000)
    })
  }
  return { worst: Math.max(...best), total: best.reduce((a, b) => a + b, 0) }
}
