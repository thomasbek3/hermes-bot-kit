// Light background polling on a struggling remote gateway (core/backgroundPolls.js,
// src/ui/app.ts refreshRoster / refreshRooms, core/session.js idle refresh):
// the periodic roster read's request shape and 60 s cadence, nothing while the
// window is hidden and one refresh on visible again, per-connection backoff
// (double on a failure or a > 2 s answer, cap 5 min, reset on a fast success),
// no two background polls at once on one connection, and foreground calls
// never delayed. Injected clocks and hand-run timers only, no real sleeps.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createBackgroundPolls, POLL_BACKOFF_MAX_MS, SLOW_POLL_MS } from '../src/core/backgroundPolls.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'
import { READY } from './loader-boot.mjs'

const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: ms => (t += ms), set: v => (t = v) }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── core/backgroundPolls.js ──────────────────────────────────────────────

test('a poll runs when due, then not again before its interval', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  let runs = 0
  const fn = async () => (runs += 1, true)
  assert.equal((await polls.run('remote', 'roster', 60_000, fn)).ran, true)
  clock.advance(59_999)
  const early = await polls.run('remote', 'roster', 60_000, fn)
  assert.equal(early.ran, false)
  assert.equal(early.nextMs, 1)
  clock.advance(1)
  assert.equal((await polls.run('remote', 'roster', 60_000, fn)).ran, true)
  assert.equal(runs, 2)
})

test('backoff: a failure or a > 2 s answer doubles that poll’s interval, capped at 5 min; a fast success resets it', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  const fail = async () => {
    throw new Error('timeout')
  }
  const slow = async () => {
    clock.advance(SLOW_POLL_MS + 1)
    return true
  }
  const falsy = async () => false
  const fast = async () => {
    clock.advance(SLOW_POLL_MS)
    return true
  }
  const base = 60_000
  const seen = []
  for (const fn of [fail, slow, falsy, fail, fail, fail, fail]) {
    const result = await polls.run('remote', 'roster', base, fn, { force: true })
    assert.equal(result.ran, true)
    seen.push(result.nextMs)
  }
  assert.deepEqual(seen, [120_000, 240_000, POLL_BACKOFF_MAX_MS, POLL_BACKOFF_MAX_MS, POLL_BACKOFF_MAX_MS, POLL_BACKOFF_MAX_MS, POLL_BACKOFF_MAX_MS])
  assert.equal(POLL_BACKOFF_MAX_MS, 300_000)
  // Backed off: not due again until the doubled interval has passed.
  clock.advance(base)
  assert.equal(polls.due('remote', 'roster', base), false)
  clock.advance(POLL_BACKOFF_MAX_MS - base)
  assert.equal(polls.due('remote', 'roster', base), true)
  // A fast success (exactly 2 s is not slow) resets to the base.
  const reset = await polls.run('remote', 'roster', base, fast)
  assert.deepEqual([reset.ran, reset.ok, reset.slow, reset.nextMs], [true, true, false, base])
})

test('backoff is per connection and per poll type', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  await polls.run('remote', 'rooms', 10_000, async () => false)
  assert.equal(polls.interval('remote', 'rooms', 10_000), 20_000)
  assert.equal(polls.interval('remote', 'roster', 60_000), 60_000, 'another poll type on the same connection keeps its cadence')
  assert.equal(polls.interval('local', 'rooms', 10_000), 10_000, 'the same poll on another connection keeps its cadence')
})

test('no two background polls run at once on one connection; other connections are not held', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  const gate = deferred()
  let roomsRuns = 0
  let otherRuns = 0
  const roster = polls.run('remote', 'roster', 60_000, () => gate.promise)
  assert.equal(polls.busy('remote'), 'roster')
  const rooms = await polls.run('remote', 'rooms', 10_000, async () => (roomsRuns += 1, true))
  const idle = await polls.run('remote', 'idle', 15_000, async () => true, { force: true })
  assert.equal(rooms.ran, false)
  assert.equal(rooms.busy, true)
  assert.equal(idle.ran, false, 'force never jumps a busy lane')
  assert.equal((await polls.run('local', 'rooms', 10_000, async () => (otherRuns += 1, true))).ran, true)
  assert.equal(otherRuns, 1)
  gate.resolve(true)
  assert.equal((await roster).ran, true)
  assert.equal(polls.busy('remote'), '')
  assert.equal((await polls.run('remote', 'rooms', 10_000, async () => (roomsRuns += 1, true))).ran, true)
  assert.equal(roomsRuns, 1)
})

test('nothing runs while the window is hidden; it is due at once when visible again', async () => {
  const clock = fakeClock()
  let visible = true
  const polls = createBackgroundPolls({ now: clock.now, isVisible: () => visible })
  let runs = 0
  const fn = async () => (runs += 1, true)
  await polls.run('remote', 'roster', 60_000, fn)
  visible = false
  clock.advance(10 * 60_000)
  const hidden = await polls.run('remote', 'roster', 60_000, fn, { force: true })
  assert.deepEqual([hidden.ran, hidden.hidden], [false, true])
  assert.equal(polls.due('remote', 'roster', 60_000), false)
  visible = true
  assert.equal(polls.due('remote', 'roster', 60_000), true)
  await polls.run('remote', 'roster', 60_000, fn)
  assert.equal(runs, 2)
})

// ── core/session.js idle refresh ─────────────────────────────────────────

function idleChat({ visible = () => true, backgroundPoll } = {}) {
  const gw = gateway()
  const deps = { ...gw.deps, isVisible: () => visible() }
  if (backgroundPoll) deps.backgroundPoll = backgroundPoll
  const chat = createChatController(BOT, deps, { attachOnOpen: false })
  return { gw, chat }
}

const restReads = gw => gw.calls.filter(c => c.method === 'REST').length

test('idle refresh: stops while hidden, one refresh on wake(), then resumes its timer', async () => {
  let visible = true
  const { gw, chat } = idleChat({ visible: () => visible })
  await chat.open()
  assert.equal(restReads(gw), 1)
  await gw.runTimers()
  assert.equal(restReads(gw), 2, 'visible: the idle tick reads the tail')
  visible = false
  await gw.runTimers()
  await gw.runTimers()
  assert.equal(restReads(gw), 2, 'hidden: no read, and no timer left running')
  chat.wake()
  assert.equal(restReads(gw), 2, 'still hidden: wake does nothing')
  visible = true
  chat.wake()
  await settle()
  assert.equal(restReads(gw), 3, 'visible again: one refresh at once')
  await gw.runTimers()
  assert.equal(restReads(gw), 4, 'and the idle timer resumed')
  chat.dispose()
})

test('idle refresh goes through the background lane of the bot’s connection and takes its backed-off interval', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  const lanes = []
  const timers = []
  const { gw, chat } = idleChat({
    backgroundPoll: (type, bot, baseMs, fn, options) => {
      lanes.push([type, bot.route.connectionId, baseMs])
      return polls.run(bot.route.connectionId, type, baseMs, fn, options)
    }
  })
  const setTimer = gw.deps.setTimer
  gw.deps.setTimer = (fn, ms) => (timers.push(ms), setTimer(fn, ms))
  await chat.open()
  // Another background poll holds the bot's connection: the idle tick skips.
  const gate = deferred()
  const roster = polls.run('home-server', 'roster', 60_000, () => gate.promise)
  await gw.runTimers()
  assert.equal(restReads(gw), 1, 'no idle read beside the roster read')
  gate.resolve(true)
  await roster
  clock.advance(15_000)
  await gw.runTimers()
  assert.equal(restReads(gw), 2)
  assert.deepEqual(lanes[0], ['idle', 'home-server', 15_000])
  chat.dispose()
})

test('foreground: the chat’s own refresh/open never waits for a busy background lane', async () => {
  const polls = createBackgroundPolls({ now: () => 0 })
  const gate = deferred()
  const { gw, chat } = idleChat({ backgroundPoll: (type, bot, baseMs, fn, options) => polls.run('home-server', type, baseMs, fn, options) })
  void polls.run('home-server', 'roster', 60_000, () => gate.promise)
  await chat.open()
  assert.equal(chat.get().phase, 'ready', 'session.list + the history read ran while the lane was busy')
  await chat.refresh()
  assert.equal(restReads(gw), 2, 'a user refresh reads at once')
  gate.resolve(true)
  chat.dispose()
})

// ── the app: refreshRoster / refreshRooms / reloadRoster ─────────────────

const ready = READY && existsSync(new URL('../node_modules/esbuild', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

let shared = null
async function load(t) {
  if (!shared) {
    const { bundlePreview } = await import('../dev/bundle.mjs')
    const file = await bundlePreview()
    const mod = await import(pathToFileURL(file).href)
    const ctx = {
      storage: { get: (k, f) => (k === 'enabled' ? false : f), set: () => undefined },
      onEvent: () => () => undefined,
      setTimeout: () => () => undefined
    }
    mod.appApi.start(ctx)
    shared = { ...mod, file, host: mod.fakeSdk.host }
    process.on('exit', () => rmSync(dirname(file), { recursive: true, force: true }))
  }
  const { host, appApi } = shared
  const clock = fakeClock(10_000_000 + Math.floor(Math.random() * 1e9))
  appApi.setPollClock(clock.now)
  const calls = []
  const handlers = {}
  const answer = async (method, params) => {
    calls.push({ method, params })
    const h = handlers[method]
    return h ? h(params) : method === 'groups.list' ? { rooms: [] } : { profiles: [] }
  }
  host.request = (method, params) => answer(method, params)
  host.requestProfile = (route, method, params) => answer(method, params)
  let agents = 0
  host.agents = async () => (agents += 1, { agents: [], sources: [] })
  // A fresh connection id per test: each test starts with its own lanes.
  const connection = `conn-${Math.random().toString(36).slice(2)}`
  const savedState = host.state
  host.state = { ...(savedState || {}), connectionId: { get: () => connection }, profile: { get: () => 'default' } }
  let visible = true
  globalThis.document = { get visibilityState() { return visible ? 'visible' : 'hidden' } }
  t.after(() => {
    appApi.setPollClock(null)
    host.state = savedState
    delete globalThis.document
  })
  const count = method => calls.filter(c => c.method === method).length
  return { ...shared, clock, calls, handlers, count, agents: () => agents, setVisible: v => (visible = v) }
}

/** Simulate the 3 s roster tick for `ms` of wall time. */
async function tickFor(appApi, clock, ms) {
  for (let t = 0; t < ms; t += 3_000) {
    clock.advance(3_000)
    appApi.refreshRoster()
    await settle()
  }
}

test('app: the periodic roster read sends the documented request at most once per 60 s while visible', { skip }, async t => {
  const { appApi, clock, calls, count } = await load(t)
  assert.equal(appApi.OWN_FETCH_MIN_MS, 60_000)
  appApi.refreshRoster()
  await settle()
  const lists = calls.filter(c => c.method === 'profiles.list')
  assert.equal(lists.length, 1)
  assert.deepEqual(lists[0].params, { ...appApi.OWN_ROSTER_PARAMS }, 'the periodic path sends exactly OWN_ROSTER_PARAMS')
  await tickFor(appApi, clock, 57_000)
  assert.equal(count('profiles.list'), 1, 'no second full read inside the minute')
  await tickFor(appApi, clock, 3_000)
  assert.equal(count('profiles.list'), 2, 'the next one at 60 s')
  await tickFor(appApi, clock, 5 * 60_000)
  assert.equal(count('profiles.list'), 7, 'five minutes: five more, one per minute')
})

test('app: hidden window: no roster, re-list or room poll; one refresh at once on visible', { skip }, async t => {
  const { appApi, clock, count, setVisible } = await load(t)
  appApi.app.enabled.set(true)
  t.after(() => appApi.app.enabled.set(false))
  appApi.refreshRoster()
  await settle()
  const before = { list: count('profiles.list'), rooms: count('groups.list') }
  assert.deepEqual(before, { list: 1, rooms: 1 })
  setVisible(false)
  await tickFor(appApi, clock, 10 * 60_000)
  assert.equal(count('profiles.list'), 1, 'no roster read while hidden')
  assert.equal(count('groups.list'), 1, 'no room list while hidden')
  setVisible(true)
  appApi.onDocumentVisible()
  await settle()
  assert.equal(count('profiles.list'), 2, 'visible again: one roster read at once')
  assert.equal(count('groups.list'), 2, 'and one room list')
})

test('app: a failing roster read backs off (doubling, cap 5 min) and a fast success resets it', { skip }, async t => {
  const { appApi, clock, handlers, count } = await load(t)
  let fail = true
  handlers['profiles.list'] = () => {
    if (fail) throw new Error('request timed out')
    return { profiles: [] }
  }
  appApi.refreshRoster()
  await settle()
  assert.equal(count('profiles.list'), 1)
  await tickFor(appApi, clock, 60_000)
  assert.equal(count('profiles.list'), 1, 'backed off to 120 s after the failure')
  await tickFor(appApi, clock, 60_000)
  assert.equal(count('profiles.list'), 2)
  await tickFor(appApi, clock, 240_000)
  assert.equal(count('profiles.list'), 3, 'then 240 s')
  await tickFor(appApi, clock, 300_000)
  assert.equal(count('profiles.list'), 4, 'then the 5 min cap')
  await tickFor(appApi, clock, 300_000)
  assert.equal(count('profiles.list'), 5, 'still the cap')
  fail = false
  await tickFor(appApi, clock, 300_000)
  assert.equal(count('profiles.list'), 6, 'a fast success…')
  await tickFor(appApi, clock, 60_000)
  assert.equal(count('profiles.list'), 7, '…resets the cadence to 60 s')
})

test('app: the roster read and the room list never run at once on the connection', { skip }, async t => {
  const { appApi, handlers, calls } = await load(t)
  const gate = deferred()
  let inFlight = 0
  let maxInFlight = 0
  const track = async value => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      return await value
    } finally {
      inFlight -= 1
    }
  }
  handlers['profiles.list'] = () => track(gate.promise.then(() => ({ profiles: [] })))
  handlers['groups.list'] = () => track(Promise.resolve({ rooms: [] }))
  appApi.refreshRoster()
  await settle()
  appApi.refreshRoster()
  await appApi.refreshRooms()
  await settle()
  assert.equal(calls.filter(c => c.method === 'groups.list').length, 0, 'the room list waits for the roster read')
  gate.resolve()
  await settle()
  assert.equal(calls.filter(c => c.method === 'groups.list').length, 1, 'then runs')
  assert.equal(maxInFlight, 1)
})

test('app: foreground reads (a write’s re-read, create/disband rooms) are never delayed by a background poll', { skip }, async t => {
  const { appApi, handlers, count, calls } = await load(t)
  const gate = deferred()
  let first = true
  handlers['profiles.list'] = () => {
    if (first) {
      first = false
      return gate.promise.then(() => ({ profiles: [{ name: 'stale' }] }))
    }
    return { profiles: [{ name: 'fresh' }] }
  }
  appApi.refreshRoster()
  await settle()
  assert.equal(count('profiles.list'), 1, 'the background read is in flight')
  appApi.reloadRoster()
  await settle()
  assert.equal(count('profiles.list'), 2, 'the foreground re-read went out at once')
  assert.deepEqual(appApi.app.roster.get().rows.map(r => r.name), ['fresh'])
  gate.resolve()
  await settle()
  assert.deepEqual(appApi.app.roster.get().rows.map(r => r.name), ['fresh'], 'the older background answer never overwrites it')
  // A create/disband re-lists the rooms at once, even while a background
  // poll holds the connection's lane.
  const gate2 = deferred()
  handlers['profiles.list'] = () => gate2.promise.then(() => ({ profiles: [] }))
  appApi.setPollClock(() => 1e15)
  appApi.refreshRoster()
  await settle()
  const rooms = count('groups.list')
  await appApi.refreshRooms(true)
  assert.equal(count('groups.list'), rooms + 1, 'a forced room list skips the lane')
  gate2.resolve()
  await settle()
  void calls
})
