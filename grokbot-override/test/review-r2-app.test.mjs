// Round-2 review findings that live in the app layer (src/ui/app.ts and the
// React UI): the real modules, bundled with the fake SDK (dev/bundle.mjs),
// driven without a DOM. Needs the dev dependencies; skipped without them.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const deferred = () => {
  let resolve
  const promise = new Promise(res => (resolve = res))
  return { promise, resolve }
}

const bot = name => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId: 'home-server',
  connectionKind: 'ssh',
  route: { connectionId: 'home-server', mode: 'remote', profile: name, targetProfile: name },
  canonical_session: { id: `${name}-root` }
})

async function loadApp(t) {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const mod = await import(pathToFileURL(file).href)
  const { appApi, fakeSdk } = mod
  const timers = []
  const listeners = new Set()
  const ctx = {
    storage: { get: (k, f) => (k === 'enabled' ? false : f), set: () => undefined },
    onEvent: (type, fn) => (listeners.add(fn), () => listeners.delete(fn)),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => (timer.cancelled = true)
    }
  }
  appApi.start(ctx)
  return { ...mod, ctx, timers, listeners, host: fakeSdk.host }
}

test('r2 #1 a cron toggle that finishes after switching bots never touches the new bot\'s panel or route', { skip }, async t => {
  const { appApi, host, renderElement, ProfilePanel } = await loadApp(t)
  const pause = deferred()
  const calls = []
  host.requestProfile = async (route, method, params) => {
    calls.push({ profile: route.profile, method, params })
    if (method !== 'cron.manage') return {}
    if (params.action === 'pause') return pause.promise
    return { jobs: [{ job_id: `${route.profile}-job`, name: `${route.profile} job`, enabled: true }] }
  }
  const A = bot('alpha')
  const B = bot('beta')
  await appApi.loadCron(A)
  const toggling = appApi.toggleCron(A, appApi.app.cron.get().jobs[0])
  await appApi.loadCron(B) // the user switched to B
  pause.resolve({ ok: true })
  await toggling
  await settle()
  const cron = appApi.app.cron.get()
  assert.equal(cron.key, 'home-server::beta', 'the store still belongs to B')
  assert.deepEqual(cron.jobs.map(j => j.job_id), ['beta-job'])
  assert.deepEqual(cron.busy, {})

  // a stale store never renders under another bot, and never toggles on its route
  appApi.app.cron.set({ key: 'home-server::alpha', loading: false, error: null, busy: {}, jobs: [{ job_id: 'alpha-job', name: 'alpha job', enabled: true }] })
  assert.ok(!renderElement(ProfilePanel, { bot: B }).includes('alpha job'), 'A\'s jobs are not drawn in B\'s panel')
  const before = calls.length
  await appApi.toggleCron(B, { job_id: 'alpha-job', enabled: true })
  assert.equal(calls.length, before, 'no cron.manage for B with A\'s job id')
})

test('r2 #5 closing the chat workspace retires the controller: lease, listener and refresh go', { skip }, async t => {
  const { appApi, host, listeners, timers } = await loadApp(t)
  let released = 0
  let onClose = null
  host.retainProfile = async () => () => (released += 1)
  host.openWorkspace = (_id, options) => ((onClose = options.onClose), () => undefined)
  host.requestProfile = async (_route, method) => {
    if (method === 'session.list') return { sessions: [{ id: 'alpha-root', title: 'Bot Chat' }] }
    if (method === 'session.resume') return { session_id: 'rt-1', running: false, messages: [] }
    if (method === 'cron.manage') return { jobs: [] }
    return {}
  }
  appApi.setRenderers({ roster: () => null, workspace: () => null })
  appApi.selectBot(bot('alpha'))
  await settle()
  assert.ok(appApi.currentController(), 'chat open')
  assert.equal(listeners.size, 1)
  assert.equal(typeof onClose, 'function')
  onClose()
  await settle()
  assert.equal(appApi.currentController(), null)
  assert.equal(released, 1, 'route lease released')
  assert.equal(listeners.size, 0, 'event listener removed')
  assert.ok(timers.every(timer => timer.cancelled), 'no refresh timer left running')
})

test('r2 #6 superseded by C19/C20: no handoff note; an @mention says the bot will be told who it is', { skip }, async t => {
  const { ComposerNote, renderElement } = await loadApp(t)
  const html = renderElement(ComposerNote, { mentionNames: 'Research', note: '', stopError: null, blocked: null })
  assert.ok(html.includes('will be told who Research is'))
  assert.ok(!html.includes('Hermes Bot Mode'), 'no handoff to the stock composer')
})

test('r2 #5 switching bots during attachment staging: the send still lands, the lease is held until its turn ends', { skip }, async t => {
  const { appApi, host, listeners } = await loadApp(t)
  const gate = deferred()
  let released = 0
  const submits = []
  host.retainProfile = async () => () => (released += 1)
  host.openWorkspace = () => () => undefined
  host.requestProfile = async (route, method, params) => {
    if (method === 'session.list') return { sessions: [{ id: `${route.profile}-root`, title: 'Bot Chat' }] }
    if (method === 'session.resume') return { session_id: `rt-${route.profile}`, running: false, messages: [] }
    if (method === 'image.attach_bytes') return gate.promise
    if (method === 'prompt.submit') return (submits.push(params), { status: 'streaming' })
    if (method === 'cron.manage') return { jobs: [] }
    return {}
  }
  appApi.setRenderers({ roster: () => null, workspace: () => null })
  const A = bot('alpha')
  appApi.selectBot(A)
  await settle()
  const chatA = appApi.currentController()
  const sending = chatA.sendDraft('look', [{ id: 'i1', kind: 'image', name: 'a.png', data: 'data:image/png;base64,AAAA', owner: 'bot:home-server::alpha' }])
  await settle()
  appApi.selectBot(bot('beta'))
  await settle()
  assert.notEqual(appApi.currentController(), chatA)
  assert.equal(released, 0, 'A keeps its lease while its send is in flight')
  gate.resolve({ attached: true })
  assert.equal((await sending).ok, true)
  assert.deepEqual(submits.map(p => p.session_id), ['rt-alpha'])
  for (const fn of [...listeners]) fn({ type: 'message.complete', session_id: 'rt-alpha', payload: { text: 'ok' } })
  await settle()
  assert.equal(released, 1, 'released once A\'s turn ended')
  assert.equal(chatA.isDisposed(), true)
})

test('r2 #6 superseded by C19/C20: the app no longer hands drafts to the stock composer', { skip }, async t => {
  const { appApi } = await loadApp(t)
  assert.equal(appApi.handOffToBotMode, undefined, 'slash commands and @mentions run natively (PARITY C19, C20)')
})
