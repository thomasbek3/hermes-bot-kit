// The bot's computer: cold open and self-recovery (src/core/screenWake.js),
// driven with a fake gateway and a fake clock. Opening a visible viewer wakes
// a screen that is asleep (display.start once) and dials it; a dropped stream
// redials without a start while the screen still runs; blocked states and a
// hidden viewer never start; the backoff gives up after about a minute and
// Retry then starts a fresh sequence.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createScreenWaker, recoveryDelay, RECOVERY_GIVE_UP_MS, wakeDecision } from '../src/core/screenWake.js'

const lease = { holder: 'agent', epoch: 1, since: 0 }
const RUNNING = { supported: true, installed: true, running: true, lease }
const ASLEEP = { supported: true, installed: true, running: false, lease }
const NOT_RUNNING = "this profile's Bot Desktop is not running; call display.start first"

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/** A fake gateway + clock. `screen.running` is the gateway's truth. */
function rig({ running = false, status = null, visible = true, startFails = 0, connectFails = 0 } = {}) {
  const screen = { running }
  const calls = []
  const modes = []
  let clock = 0
  let timers = []
  const failing = { start: startFails, connect: connectFails }
  const gateway = {
    readStatus: async () => {
      calls.push('display.status')
      if (status) return typeof status === 'function' ? status() : status
      return screen.running ? RUNNING : ASLEEP
    },
    start: async () => {
      calls.push('display.start')
      if (failing.start > 0) {
        failing.start -= 1
        throw new Error('the launcher did not publish its display in time')
      }
      screen.running = true
      return RUNNING
    },
    connect: async () => {
      calls.push('connect')
      if (failing.connect > 0) {
        failing.connect -= 1
        throw new Error(screen.running ? 'the bridge refused the dial' : NOT_RUNNING)
      }
      if (!screen.running) throw new Error(NOT_RUNNING)
    }
  }
  const view = { visible }
  const waker = createScreenWaker({
    ...gateway,
    isVisible: () => view.visible,
    onChange: state => modes.push(state.mode),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => {
      timers = timers.filter(t => t !== timer)
    }
  })
  /** Advance the clock to the next timer and run it. */
  const next = async () => {
    await flush()
    timers.sort((a, b) => a.at - b.at)
    const timer = timers.shift()
    if (!timer) return null
    clock = timer.at
    timer.fn()
    await flush()
    return timer.ms
  }
  return {
    screen,
    failing,
    calls,
    modes,
    view,
    waker,
    next,
    flush,
    timers: () => timers.length,
    count: method => calls.filter(c => c === method).length,
    advance: ms => {
      clock += ms
    }
  }
}

test('wakeDecision: dial a running screen, start an asleep one, leave every card alone', () => {
  assert.equal(wakeDecision(RUNNING), 'connect')
  assert.equal(wakeDecision(ASLEEP), 'start')
  assert.equal(wakeDecision({ ...ASLEEP, blocker: 'Only 180 MB of memory free; the screen needs 600 MB.' }), 'blocked')
  assert.equal(wakeDecision({ ...ASLEEP, installed: false, missing: ['Xvnc'] }), 'blocked')
  assert.equal(wakeDecision({ ...ASLEEP, image_switch: { current_image: 'a', target_image: 'b', containers: 1 } }), 'blocked')
  assert.equal(wakeDecision({ supported: false, installed: false, running: false }), 'blocked')
  assert.equal(wakeDecision(null), 'blocked')
})

test('backoff: 1 s, 2 s, 4 s, then every 8 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(recoveryDelay), [1000, 2000, 4000, 8000, 8000, 8000])
})

test('cold open: not running -> display.start once -> connects, with no click', async () => {
  const r = rig({ running: false })
  r.waker.open()
  await r.flush()
  assert.deepEqual(r.calls, ['display.status', 'display.start', 'connect'])
  assert.deepEqual(r.modes, ['checking', 'waking', 'connecting'])
  r.waker.connected()
  assert.equal(r.waker.get().mode, 'live')
  assert.equal(r.timers(), 0, 'nothing ticks while live (the idle stop is untouched)')
  // Opening again while live does nothing.
  r.waker.open()
  await r.flush()
  assert.equal(r.count('display.start'), 1)
})

test('cold open of a running screen dials it without a start', async () => {
  const r = rig({ running: true })
  r.waker.open()
  await r.flush()
  assert.deepEqual(r.calls, ['display.status', 'connect'])
})

test('a dropped stream redials without a start while the screen still runs', async () => {
  const r = rig({ running: true })
  r.waker.open()
  await r.flush()
  r.waker.connected()
  r.waker.lost('The screen stream was lost.')
  assert.equal(r.waker.get().mode, 'retrying')
  assert.equal(r.waker.get().recovering, true)
  assert.equal(await r.next(), 1000, 'first retry after 1 s')
  assert.deepEqual(r.calls, ['display.status', 'connect', 'display.status', 'connect'])
  assert.equal(r.count('display.start'), 0)
  r.waker.connected()
  assert.equal(r.waker.get().mode, 'live')
  assert.equal(r.waker.get().recovering, false)
})

test('"not running; call display.start first" after a restart: re-check, start, reconnect', async () => {
  const r = rig({ running: true })
  r.waker.open()
  await r.flush()
  r.waker.connected()
  // The gateway restarts the screen: the stream drops and the dial is refused.
  r.screen.running = false
  r.waker.lost('The screen stream was lost.')
  await r.next()
  assert.deepEqual(r.calls.slice(2), ['display.status', 'display.start', 'connect'])
  r.waker.connected()
  assert.equal(r.waker.get().mode, 'live')

  // The observe error itself (status said running a moment before).
  const s = rig({ running: true, connectFails: 1 })
  s.screen.running = true
  s.waker.open()
  await s.flush()
  assert.equal(s.waker.get().mode, 'retrying', 'a refused dial backs off')
  s.screen.running = false
  await s.next()
  assert.equal(s.count('display.start'), 1, 'the re-check found it asleep and woke it')
})

test('start-blocked states never auto-start', async () => {
  for (const status of [
    { ...ASLEEP, blocker: 'Only 180 MB of memory free.' },
    { ...ASLEEP, installed: false, missing: ['Xvnc'] },
    { ...ASLEEP, image_switch: { current_image: 'a', target_image: 'b', containers: 1 } },
    { supported: false, installed: false, running: false },
    'blocked' // this Hermes has no screen at all (readStatus's unavailable verdict)
  ]) {
    const r = rig({ status })
    r.waker.open()
    await r.flush()
    assert.equal(r.count('display.start'), 0, JSON.stringify(status))
    assert.equal(r.waker.get().mode, 'blocked')
    assert.equal(r.timers(), 0, 'no retry loop on a card')
  }
})

test('a start the gateway refuses with a blocker stops at the card', async () => {
  const blocked = { ...ASLEEP, blocker: 'Only 180 MB of memory free.' }
  let reads = 0
  const r = rig({ status: () => (reads++ === 0 ? ASLEEP : blocked), startFails: 1 })
  r.waker.open()
  await r.flush()
  assert.equal(r.waker.get().mode, 'retrying')
  await r.next()
  assert.equal(r.waker.get().mode, 'blocked', 'the re-check sees the blocker')
  assert.equal(r.count('display.start'), 1)
  assert.equal(r.timers(), 0)
})

test('a hidden viewer never starts; it wakes when shown', async () => {
  const r = rig({ running: false, visible: false })
  r.waker.open()
  await r.flush()
  assert.deepEqual(r.calls, [], 'not even a status read from the machine')
  r.view.visible = true
  r.waker.setVisible(true)
  await r.flush()
  assert.deepEqual(r.calls, ['display.status', 'display.start', 'connect'])
})

test('lost while hidden: pause (no timers, no start); shown again: a fresh wake', async () => {
  const r = rig({ running: true })
  r.waker.open()
  await r.flush()
  r.waker.connected()
  r.view.visible = false
  r.waker.setVisible(false)
  r.screen.running = false // idle-stopped by the gateway while nobody looks
  r.waker.lost('The screen stream closed.')
  assert.equal(r.waker.get().mode, 'paused')
  assert.equal(r.timers(), 0)
  await r.flush()
  assert.equal(r.count('display.start'), 0, 'no start for a hidden viewer')
  r.view.visible = true
  r.waker.setVisible(true)
  await r.flush()
  assert.equal(r.count('display.start'), 1)
  assert.equal(r.waker.get().mode, 'connecting')
})

test('hidden mid-backoff: the pending retry is dropped until shown', async () => {
  const r = rig({ running: true, connectFails: 1 })
  r.waker.open()
  await r.flush()
  assert.equal(r.waker.get().mode, 'retrying')
  r.view.visible = false
  r.waker.setVisible(false)
  assert.equal(r.waker.get().mode, 'paused')
  assert.equal(r.timers(), 0)
})

test('gives up about 60 s after the first failure, then Retry starts a fresh sequence', async () => {
  const r = rig({ running: true, connectFails: 1000 })
  r.waker.open()
  await r.flush()
  const waits = []
  while (r.waker.get().mode === 'retrying') waits.push(await r.next())
  assert.equal(r.waker.get().mode, 'gave-up')
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000])
  const spent = waits.reduce((a, b) => a + b, 0)
  assert.ok(spent <= RECOVERY_GIVE_UP_MS && spent >= RECOVERY_GIVE_UP_MS - 8000, `about a minute (${spent} ms)`)
  assert.equal(r.waker.get().error, 'the bridge refused the dial', 'the backend words are kept (for the tooltip)')
  assert.equal(r.timers(), 0, 'nothing more after giving up')
  const dials = r.count('connect')

  // Retry: a fresh sequence with a fresh budget.
  r.waker.retry()
  await r.flush()
  assert.equal(r.count('connect'), dials + 1)
  assert.equal(r.waker.get().mode, 'retrying', 'still failing: back to the backoff with a fresh budget')
  assert.equal(await r.next(), 1000, 'the budget restarted at 1 s')
})

test('a start that keeps failing is retried through the backoff, then given up', async () => {
  const r = rig({ running: false, startFails: 1000 })
  r.waker.open()
  await r.flush()
  while (r.waker.get().mode === 'retrying') await r.next()
  assert.equal(r.waker.get().mode, 'gave-up')
  // display.start is idempotent on the gateway (one launcher per profile).
  assert.equal(r.count('display.start'), 10, 'the first try plus nine backoff attempts')
  assert.equal(r.count('connect'), 0)
})

test('Retry after giving up: a gateway that answers again wakes and goes live', async () => {
  const r = rig({ running: false, startFails: 1000 })
  r.waker.open()
  await r.flush()
  while (r.waker.get().mode === 'retrying') await r.next()
  assert.equal(r.waker.get().mode, 'gave-up')
  r.failing.start = 0 // the gateway is back
  r.waker.retry()
  await r.flush()
  assert.deepEqual(r.calls.slice(-3), ['display.status', 'display.start', 'connect'])
  r.waker.connected()
  assert.equal(r.waker.get().mode, 'live')
})

test('fail(): someone keeps taking control -> gave up at once, no retries', async () => {
  const r = rig({ running: true })
  r.waker.open()
  await r.flush()
  r.waker.fail('Someone else took control of this screen.')
  assert.equal(r.waker.get().mode, 'gave-up')
  r.waker.lost('late disconnect')
  assert.equal(r.waker.get().mode, 'gave-up', 'a late loss does not restart the loop')
  assert.equal(r.timers(), 0)
})

test('a superseded sequence (Retry mid-start) drops its late replies; dispose stops everything', async () => {
  let release
  const calls = []
  const waker = createScreenWaker({
    readStatus: async () => (calls.push('status'), ASLEEP),
    start: () => {
      calls.push('start')
      return new Promise(resolve => {
        release = resolve
      })
    },
    connect: async () => void calls.push('connect'),
    isVisible: () => true,
    setTimer: () => 0,
    clearTimer: () => undefined
  })
  waker.open()
  await flush()
  const first = release
  waker.retry()
  await flush()
  first(RUNNING) // the first start answers late
  await flush()
  assert.equal(calls.filter(c => c === 'connect').length, 0, 'the stale start does not dial')
  release(RUNNING)
  await flush()
  assert.equal(calls.filter(c => c === 'connect').length, 1)
  waker.dispose()
  waker.open()
  waker.retry()
  await flush()
  assert.equal(calls.filter(c => c === 'status').length, 2, 'nothing after dispose')
})
