// Light background polling on a struggling remote gateway (core/backgroundPolls.js,
// src/ui/app.ts pumpPolls / refreshRooms / reloadRoster, core/session.js
// idleRefresh): the periodic roster read's request shape and 60 s cadence,
// nothing while the window is hidden and one refresh when it is visible again,
// per-connection backoff (double on a failure or a > 2 s answer, cap 5 min,
// reset on a fast success), a deadline, no two background polls at once on one
// connection, foreground calls never delayed, and the review round 1 findings
// (LR1-01..10). Injected clocks, deferred promises and hand-run timers only.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createBackgroundPolls, POLL_BACKOFF_MAX_MS, POLL_DEADLINE_MS, refreshInTurn, SLOW_POLL_MS } from '../src/core/backgroundPolls.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'
import { READY } from './loader-boot.mjs'

const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: ms => (t += ms) }
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
  clock.advance(base)
  assert.equal(polls.due('remote', 'roster', base), false)
  clock.advance(POLL_BACKOFF_MAX_MS - base)
  assert.equal(polls.due('remote', 'roster', base), true)
  const reset = await polls.run('remote', 'roster', base, fast)
  assert.deepEqual([reset.ran, reset.ok, reset.slow, reset.nextMs], [true, true, false, base])
})

test('backoff is per connection and per poll type', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  await polls.run('remote', 'rooms', 10_000, async () => false)
  assert.equal(polls.interval('remote', 'rooms', 10_000), 20_000)
  assert.equal(polls.interval('remote', 'roster', 60_000), 60_000)
  assert.equal(polls.interval('local', 'rooms', 10_000), 10_000)
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
  assert.deepEqual([rooms.ran, rooms.busy], [false, true])
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
  visible = true
  await polls.run('remote', 'roster', 60_000, fn)
  assert.equal(runs, 2)
})

test('LR1-02 deadline: a hung run stops holding its lane after POLL_DEADLINE_MS, backs off, and its late answer is not live', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  const gate = deferred()
  let liveAtEnd = null
  const hung = polls.run('A', 'idle', 15_000, async live => {
    await gate.promise
    liveAtEnd = live()
    return true
  })
  clock.advance(POLL_DEADLINE_MS - 1)
  assert.equal(polls.busy('A'), 'idle')
  clock.advance(1)
  assert.equal(polls.busy('A'), '', 'past the deadline the lane is free')
  assert.equal(polls.interval('A', 'idle', 15_000), 30_000, 'and the hung poll backed off')
  let ran = false
  assert.equal((await polls.run('A', 'rooms', 10_000, async () => (ran = true))).ran, true)
  assert.equal(ran, true)
  gate.resolve()
  const result = await hung
  assert.equal(liveAtEnd, false, 'the late answer is not applied')
  assert.equal(result.stale, true)
})

test('LR1-07 core: a run claims every lane its work touches, all or nothing', async () => {
  const polls = createBackgroundPolls({ now: () => 0 })
  const gate = deferred()
  void polls.run('B', 'idle', 15_000, () => gate.promise)
  let ran = false
  const blocked = await polls.run('A', 'roster', 60_000, async () => (ran = true), { lanes: ['B'] })
  assert.deepEqual([blocked.ran, blocked.busy, ran], [false, true, false])
  assert.equal(polls.busy('A'), '', 'nothing half-claimed')
  gate.resolve(true)
  await settle()
  const own = deferred()
  const roster = polls.run('A', 'roster', 60_000, () => own.promise, { lanes: ['B'] })
  assert.equal(polls.busy('B'), 'roster', 'B is held while the union read runs')
  own.resolve(true)
  await roster
})

test('LR1-09 core: resume() makes a backed-off poll due at once, keeping resumeMinMs; want() marks one poll', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  await polls.run('A', 'roster', 60_000, async () => false)
  await polls.run('A', 'rooms', 10_000, async () => true)
  clock.advance(5_000)
  polls.resume()
  assert.equal(polls.due('A', 'rooms', 10_000), true, 'rooms: due at once')
  assert.equal(polls.due('A', 'roster', 60_000, { resumeMinMs: 60_000 }), false, 'roster: not before its 60 s minimum')
  clock.advance(56_000)
  assert.equal(polls.due('A', 'roster', 60_000, { resumeMinMs: 60_000 }), true, 'at 61 s, although backed off to 120 s')
  await polls.run('A', 'roster', 60_000, async () => true, { resumeMinMs: 60_000 })
  assert.equal(polls.due('A', 'roster', 60_000, { resumeMinMs: 60_000 }), false, 'one-shot')
  polls.want('A', 'idle')
  assert.equal(polls.due('A', 'idle', 15_000), true)
})

test('LR1-10 core: reset() retires every run: lanes free, late answers not live', async () => {
  const polls = createBackgroundPolls({ now: () => 0 })
  const gate = deferred()
  let liveAtEnd = null
  const run = polls.run('A', 'roster', 60_000, async live => (await gate.promise, (liveAtEnd = live()), true))
  polls.reset()
  assert.equal(polls.busy('A'), '')
  gate.resolve()
  assert.equal((await run).stale, true)
  assert.equal(liveAtEnd, false)
})

// ── idle refresh (core/session.js idleRefresh + refreshInTurn) ───────────

const restReads = gw => gw.calls.filter(c => c.method === 'REST').length

function hostChat(name, extra = {}) {
  const gw = gateway(extra)
  const bot = { ...BOT, name, route: { ...BOT.route, profile: name, targetProfile: name } }
  const chat = createChatController(bot, { ...gw.deps, idleByHost: true }, { attachOnOpen: false })
  return { gw, chat }
}

test('idleByHost: the controller keeps no idle timer of its own; idleRefresh reads, a dead pass drops the answer', async () => {
  const { gw, chat } = hostChat('alpha')
  await chat.open()
  await gw.runTimers()
  await gw.runTimers()
  assert.equal(restReads(gw), 1, 'no self-scheduled idle read')
  assert.equal(await chat.idleRefresh(() => true), true)
  assert.equal(restReads(gw), 2)
  assert.equal(await chat.idleRefresh(() => false), true, 'read, but not applied')
  chat.dispose()
})

test('LR1-01: two chats on one connection both refresh every pass, a streaming one never starves the other', async () => {
  const clock = fakeClock()
  const polls = createBackgroundPolls({ now: clock.now })
  const a = hostChat('alpha')
  const b = hostChat('beta')
  await a.chat.open()
  await b.chat.open()
  const chats = [a.chat, b.chat]
  for (let i = 0; i < 8; i += 1) {
    clock.advance(15_000)
    await polls.run('home-server', 'idle', 15_000, live => refreshInTurn(chats, live))
  }
  assert.deepEqual([restReads(a.gw), restReads(b.gw)], [9, 9], 'each chat: open + eight passes')
  // alpha streams a turn: it skips its own read, beta still reads.
  const streaming = hostChat('gamma')
  await streaming.chat.open()
  await streaming.chat.attach()
  await streaming.chat.send('hi')
  assert.equal(streaming.chat.get().chat.busy, true)
  const before = [restReads(streaming.gw), restReads(b.gw)]
  for (let i = 0; i < 3; i += 1) {
    clock.advance(15_000)
    await polls.run('home-server', 'idle', 15_000, live => refreshInTurn([streaming.chat, b.chat], live))
  }
  assert.deepEqual([restReads(streaming.gw) - before[0], restReads(b.gw) - before[1]], [0, 3])
  for (const c of [a.chat, b.chat, streaming.chat]) c.dispose()
})

// ── the app (bundled with the fake SDK) ──────────────────────────────────

const ready = READY && existsSync(new URL('../node_modules/esbuild', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const remoteBot = (name, connectionId = 'home-server') => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId,
  connectionKind: 'ssh',
  route: { connectionId, mode: 'remote', profile: name, targetProfile: name },
  canonical_session: { id: `${name}-root`, last_active: 1 }
})

async function loadApp(t) {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  const mod = await import(pathToFileURL(file).href)
  const { appApi, fakeSdk } = mod
  const host = fakeSdk.host
  const saved = { ...host }
  const savedCache = fakeSdk.queryClient.getQueryCache
  const ctx = {
    storage: { get: (k, f) => (k === 'enabled' ? false : f), set: () => undefined },
    onEvent: () => () => undefined,
    setTimeout: () => () => undefined
  }
  appApi.start(ctx)
  const clock = fakeClock(10_000_000)
  appApi.setPollClock(clock.now)
  const calls = []
  const handlers = {}
  const conn = { id: 'A' }
  const answer = async (method, params, route) => {
    calls.push({ method, params, connection: route?.connectionId ?? conn.id })
    const h = handlers[method]
    if (h) return h(params, route)
    if (method === 'groups.list') return { rooms: [] }
    if (method === 'session.list') return { sessions: [{ id: `${route?.profile}-root`, title: 'Bot Chat' }] }
    if (method === 'cron.manage') return { jobs: [] }
    return { profiles: [] }
  }
  host.request = (method, params) => answer(method, params, null)
  host.requestProfile = (route, method, params) => answer(method, params, route)
  host.agents = async () => {
    calls.push({ method: 'agents', connection: conn.id })
    return handlers.agents ? handlers.agents() : { agents: [], sources: [] }
  }
  host.retainProfile = async () => () => undefined
  host.openWorkspace = () => () => undefined
  host.state = { connectionId: { get: () => conn.id }, profile: { get: () => 'default' } }
  appApi.setRenderers({ roster: () => null, workspace: () => null, tab: () => null })
  let visible = true
  globalThis.document = {
    get visibilityState() {
      return visible ? 'visible' : 'hidden'
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  globalThis.window = {
    hermesDesktop: {
      api: async req => {
        calls.push({ method: 'REST', profile: req.profile, connection: req.connectionId })
        if (handlers.REST) return handlers.REST(req)
        return { messages: [{ id: 1, role: 'assistant', content: 'hello', timestamp: 1 }], pagination: { returned: 1 } }
      }
    }
  }
  /** Bot Mode's own roster cache: a fresh snapshot of `profiles`. */
  const stockCache = profiles => {
    fakeSdk.queryClient.getQueryCache = () => ({
      findAll: () => [{ queryKey: ['hermes-bots', 'roster', conn.id], state: { data: { profiles, sources: [] }, dataUpdatedAt: Date.now() } }]
    })
  }
  t.after(() => {
    try {
      appApi.stop()
    } catch {
      /* fine */
    }
    appApi.setPollClock(null)
    Object.assign(host, saved)
    fakeSdk.queryClient.getQueryCache = savedCache
    delete globalThis.document
    delete globalThis.window
    rmSync(dirname(file), { recursive: true, force: true })
  })
  const count = (method, connection) => calls.filter(c => c.method === method && (connection === undefined || c.connection === connection)).length
  /** The 3 s roster tick, for `ms` of wall time. */
  const tickFor = async ms => {
    for (let t = 0; t < ms; t += 3_000) {
      clock.advance(3_000)
      appApi.refreshRoster()
      await settle()
    }
  }
  return { ...mod, appApi, host, clock, calls, handlers, conn, count, tickFor, stockCache, setVisible: v => (visible = v) }
}

test('app: the periodic roster read sends the documented request at most once per 60 s while visible', { skip }, async t => {
  const { appApi, calls, count, tickFor } = await loadApp(t)
  assert.equal(appApi.OWN_FETCH_MIN_MS, 60_000)
  appApi.refreshRoster()
  await settle()
  const lists = calls.filter(c => c.method === 'profiles.list')
  assert.equal(lists.length, 1)
  assert.deepEqual(lists[0].params, { ...appApi.OWN_ROSTER_PARAMS })
  await tickFor(57_000)
  assert.equal(count('profiles.list'), 1)
  await tickFor(3_000)
  assert.equal(count('profiles.list'), 2)
  await tickFor(5 * 60_000)
  assert.equal(count('profiles.list'), 7)
})

test('app: hidden window: no roster, re-list or room poll; one refresh at once on visible', { skip }, async t => {
  const { appApi, count, setVisible, tickFor } = await loadApp(t)
  appApi.app.enabled.set(true)
  appApi.refreshRoster()
  await settle()
  assert.deepEqual([count('profiles.list'), count('groups.list')], [1, 1])
  setVisible(false)
  await tickFor(10 * 60_000)
  assert.deepEqual([count('profiles.list'), count('groups.list'), count('agents')], [1, 1, 1])
  setVisible(true)
  appApi.onDocumentVisible()
  await settle()
  assert.deepEqual([count('profiles.list'), count('groups.list')], [2, 2])
})

test('LR1-03: visibility restored with no visibilitychange event: the next tick resumes polls and the idle refresh', { skip }, async t => {
  const { appApi, count, setVisible, tickFor } = await loadApp(t)
  appApi.app.enabled.set(true)
  appApi.selectBot(remoteBot('alpha'))
  await settle()
  assert.equal(appApi.currentController().get().phase, 'ready')
  const opened = count('REST')
  setVisible(false)
  await tickFor(60_000)
  assert.equal(count('REST'), opened, 'hidden: no idle read')
  setVisible(true) // no event delivered
  await tickFor(3_000)
  assert.equal(count('REST'), opened + 1, 'the tick noticed and refreshed once')
  await tickFor(15_000)
  assert.equal(count('REST'), opened + 2, 'and the idle cadence continues')
})

test('app: a failing roster read backs off (doubling, cap 5 min) and a fast success resets it', { skip }, async t => {
  const { appApi, handlers, count, tickFor } = await loadApp(t)
  let fail = true
  handlers['profiles.list'] = () => {
    if (fail) throw new Error('request timed out')
    return { profiles: [] }
  }
  appApi.refreshRoster()
  await settle()
  await tickFor(60_000)
  assert.equal(count('profiles.list'), 1)
  await tickFor(60_000)
  assert.equal(count('profiles.list'), 2)
  await tickFor(240_000)
  assert.equal(count('profiles.list'), 3)
  await tickFor(300_000)
  assert.equal(count('profiles.list'), 4)
  await tickFor(300_000)
  assert.equal(count('profiles.list'), 5)
  fail = false
  await tickFor(300_000)
  assert.equal(count('profiles.list'), 6)
  await tickFor(60_000)
  assert.equal(count('profiles.list'), 7)
})

test('LR1-09: back from hidden before a backed-off deadline: one roster read at once (60 s minimum kept), rooms at once', { skip }, async t => {
  const { appApi, handlers, clock, count, setVisible, tickFor } = await loadApp(t)
  appApi.app.enabled.set(true)
  let fail = true
  handlers['profiles.list'] = () => {
    if (fail) throw new Error('timeout')
    return { profiles: [] }
  }
  appApi.refreshRoster()
  await settle()
  assert.equal(appApi.polls.interval('A', 'roster'), 120_000, 'backed off')
  fail = false
  setVisible(false)
  await tickFor(60_000)
  clock.advance(1_000)
  setVisible(true)
  appApi.onDocumentVisible()
  await settle()
  assert.equal(count('profiles.list'), 2, 'at 61 s, not at 120 s')
  // A brief hide: the room list (10 s cadence) is still re-read at once.
  const rooms = count('groups.list')
  setVisible(false)
  appApi.refreshRoster()
  clock.advance(2_000)
  setVisible(true)
  appApi.onDocumentVisible()
  await settle()
  assert.equal(count('groups.list'), rooms + 1)
  assert.equal(count('profiles.list'), 2, 'the full roster keeps its 60 s minimum')
})

test('app: the roster read and the room list never run at once on the connection', { skip }, async t => {
  const { appApi, handlers, count } = await loadApp(t)
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
  assert.equal(count('groups.list'), 0)
  gate.resolve()
  await settle()
  assert.equal(count('groups.list'), 1)
  assert.equal(maxInFlight, 1)
})

test('LR1-02: a hung roster read on A never holds B’s polls; past the deadline A’s lane frees and its late answer is dropped', { skip }, async t => {
  const { appApi, handlers, conn, clock, count } = await loadApp(t)
  const hung = deferred()
  handlers['profiles.list'] = (_p, route) => (conn.id === 'A' && !route ? hung.promise : { profiles: [{ name: 'b-bot' }] })
  appApi.refreshRoster()
  await settle()
  assert.equal(count('profiles.list', 'A'), 1)
  conn.id = 'B'
  handlers['profiles.list'] = () => ({ profiles: [{ name: 'b-bot' }] })
  clock.advance(24 * 3_600_000)
  for (let i = 0; i < 10; i += 1) {
    clock.advance(3_000)
    appApi.refreshRoster()
    await settle()
  }
  assert.ok(count('profiles.list', 'B') >= 1, 'B got its roster read')
  assert.ok(count('groups.list', 'B') >= 1, 'and its room list')
  assert.equal(appApi.polls.busy('A'), '', 'A’s lane is free past the deadline')
  hung.resolve({ profiles: [{ name: 'late-a' }] })
  await settle()
  assert.ok(!appApi.app.roster.get().rows.some(r => r.name === 'late-a'), 'A’s late answer is not painted')
})

test('LR1-05: an older source re-list never erases a newer foreground reload', { skip }, async t => {
  const { appApi, handlers, stockCache, conn } = await loadApp(t)
  const agent = name => ({ profile: name, connectionId: conn.id, connectionKind: 'remote' })
  const union = names => ({ agents: names.map(agent), sources: [{ connectionId: conn.id, kind: 'remote', reachable: true }] })
  stockCache([{ name: 'old', connectionId: conn.id }])
  const stale = deferred()
  let n = 0
  handlers.agents = () => (++n === 1 ? stale.promise : union(['old', 'new']))
  handlers['profiles.list'] = () => ({ profiles: [{ name: 'old' }, { name: 'new' }] })
  appApi.refreshRoster() // fresh stock snapshot: the background re-list
  await settle()
  assert.equal(n, 1)
  appApi.reloadRoster()
  await settle()
  assert.deepEqual(appApi.app.roster.get().rows.map(r => r.name).sort(), ['new', 'old'])
  stale.resolve(union(['old']))
  await settle()
  assert.deepEqual(appApi.app.roster.get().rows.map(r => r.name).sort(), ['new', 'old'], 'the older re-list is dropped')
})

test('LR1-06: create/disband while a background room list is pending: the forced list goes out at once and the old answer is dropped', { skip }, async t => {
  const { appApi, handlers, count } = await loadApp(t)
  const old = deferred()
  let n = 0
  handlers['groups.list'] = () => (++n === 1 ? old.promise : { rooms: [{ room_id: 'r1', name: 'kept' }] })
  const background = appApi.refreshRooms()
  await settle()
  assert.equal(count('groups.list'), 1)
  await appApi.refreshRooms(true)
  assert.equal(count('groups.list'), 2, 'issued at once')
  assert.deepEqual(appApi.app.rooms.get().rooms.map(r => r.room_id), ['r1'])
  old.resolve({ rooms: [{ room_id: 'r1', name: 'kept' }, { room_id: 'r2', name: 'disbanded' }] })
  await background
  assert.deepEqual(appApi.app.rooms.get().rooms.map(r => r.room_id), ['r1'], 'the older list never paints')
})

test('LR1-07: the union roster read waits while a connection it touches is busy (a chat’s idle read on B); SSH sources are not claimed', { skip }, async t => {
  const { appApi, count, tickFor } = await loadApp(t)
  appApi.app.roster.set(s => ({
    ...s,
    sources: [
      { connectionId: 'A', kind: 'remote', reachable: true },
      { connectionId: 'B', kind: 'remote', reachable: true },
      { connectionId: 'S', kind: 'ssh', reachable: false, error: 'connect-on-demand' }
    ]
  }))
  const gate = deferred()
  void appApi.polls.run('B', 'idle', 15_000, () => gate.promise)
  void appApi.polls.run('S', 'idle', 15_000, () => new Promise(() => undefined))
  appApi.refreshRoster()
  await settle()
  assert.equal(count('agents'), 0, 'no union read beside B’s background read')
  assert.equal(count('profiles.list'), 0)
  gate.resolve(true)
  await settle()
  await tickFor(3_000)
  assert.equal(count('agents'), 1, 'it runs once B is free, although the SSH lane is busy')
})

test('LR1-08: a failed union read, or a source that errored, backs the roster poll off', { skip }, async t => {
  const { appApi, handlers, count, tickFor } = await loadApp(t)
  handlers.agents = () => Promise.reject(new Error('enumeration timed out'))
  appApi.refreshRoster()
  await settle()
  assert.equal(count('profiles.list'), 1)
  assert.equal(appApi.polls.interval('A', 'roster'), 120_000)
  await tickFor(60_000)
  assert.equal(count('profiles.list'), 1, 'no full read at +60 s')
  handlers.agents = () => ({ agents: [], sources: [{ connectionId: 'B', kind: 'remote', reachable: false, error: 'HTTP 503' }] })
  await tickFor(60_000)
  assert.equal(count('profiles.list'), 2)
  assert.equal(appApi.polls.interval('A', 'roster'), 240_000, 'a per-source error does not reset the backoff')
})

test('LR1-10: stop() during pending roster, re-list and room reads: nothing late is painted and no follow-up read starts', { skip }, async t => {
  const { appApi, handlers, count, stockCache } = await loadApp(t)
  const roster = deferred()
  handlers['profiles.list'] = () => roster.promise
  appApi.refreshRoster()
  await settle()
  const before = appApi.app.roster.get()
  appApi.stop()
  roster.resolve({ profiles: [{ name: 'late' }] })
  await settle()
  assert.equal(appApi.app.roster.get(), before, 'the late roster is not written')
  assert.equal(count('groups.list'), 0, 'no room list after stop')
  // re-list and rooms pending at stop
  appApi.start({ storage: { get: (k, f) => (k === 'enabled' ? false : f), set: () => undefined }, onEvent: () => () => undefined, setTimeout: () => () => undefined })
  stockCache([{ name: 'x', connectionId: 'A' }])
  const union = deferred()
  const rooms = deferred()
  handlers.agents = () => union.promise
  handlers['groups.list'] = () => rooms.promise
  appApi.refreshRoster()
  void appApi.refreshRooms()
  await settle()
  const lists = count('groups.list')
  const agents = count('agents')
  const state = { roster: appApi.app.roster.get(), rooms: appApi.app.rooms.get() }
  appApi.stop()
  union.resolve({ agents: [], sources: [{ connectionId: 'A', reachable: true }] })
  rooms.resolve({ rooms: [{ room_id: 'late' }] })
  await settle()
  assert.equal(appApi.app.rooms.get(), state.rooms, 'the late room list is not written')
  assert.equal(appApi.app.roster.get(), state.roster)
  assert.deepEqual([count('groups.list'), count('agents')], [lists, agents], 'no follow-up reads')
})

test('LR1-04: activity on the open chat while hidden or while its connection is busy marks it, but reads no history until visible and free', { skip }, async t => {
  const { appApi, count, setVisible, stockCache, tickFor } = await loadApp(t)
  appApi.app.enabled.set(true)
  const alpha = remoteBot('alpha')
  stockCache([alpha])
  appApi.selectBot(alpha)
  await settle()
  appApi.refreshRoster() // seeds the activity watermarks
  await settle()
  const reads = count('REST')
  const gate = deferred()
  void appApi.polls.run('home-server', 'other', 1, () => gate.promise)
  setVisible(false)
  stockCache([{ ...alpha, canonical_session: { ...alpha.canonical_session, last_active: 2, preview: 'new' } }])
  appApi.refreshRoster()
  await settle()
  assert.equal(count('REST'), reads, 'hidden and busy: no history read')
  setVisible(true)
  appApi.refreshRoster()
  await settle()
  assert.equal(count('REST'), reads, 'visible but the lane is busy: still none')
  gate.resolve(true)
  await settle()
  await tickFor(3_000)
  assert.equal(count('REST'), reads + 1, 'then one coalesced background read')
})

test('LR1-01 app: two chats open on one connection (main + new tab) both refresh every idle pass', { skip }, async t => {
  const { appApi, calls, tickFor } = await loadApp(t)
  appApi.app.enabled.set(true)
  appApi.selectBot(remoteBot('alpha'))
  assert.equal(appApi.openBotInNewTab(remoteBot('beta')), true)
  await settle()
  const reads = profile => calls.filter(c => c.method === 'REST' && c.profile === profile).length
  const start = [reads('alpha'), reads('beta')]
  await tickFor(8 * 15_000)
  assert.deepEqual([reads('alpha') - start[0], reads('beta') - start[1]], [8, 8])
})

test('app: foreground reads (a write’s re-read, Retry) are never delayed by a background poll and are never overwritten by it', { skip }, async t => {
  const { appApi, handlers, count } = await loadApp(t)
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
  assert.equal(count('profiles.list'), 1)
  appApi.reloadRoster()
  await settle()
  assert.equal(count('profiles.list'), 2, 'the foreground re-read went out at once')
  assert.deepEqual(appApi.app.roster.get().rows.map(r => r.name), ['fresh'])
  gate.resolve()
  await settle()
  assert.deepEqual(appApi.app.roster.get().rows.map(r => r.name), ['fresh'])
})
