// The bot's Approval mode in the profile panel (stock keeps it in the status
// bar, which the override hides): Manual / Smart / Off with stock's labels and
// one-line descriptions, read from the bot's own profile on open and when the
// window regains focus, written with stock's RPC (config.set approvals.mode,
// profile named, no session, no scope) to that profile only, on the bot's own
// route; hidden when the gateway has no approvals.mode. Core rules are
// unit-tested; the card runs in jsdom from the real modules (dev bundle, fake SDK).

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  APPROVAL_DESCRIPTIONS,
  APPROVAL_LABELS,
  approvalParams,
  approvalUnsupported,
  createApprovalModes,
  normalizeApprovalMode
} from '../src/core/approvalMode.js'

const ready =
  existsSync(new URL('../node_modules/esbuild', import.meta.url)) &&
  existsSync(new URL('../node_modules/react-dom', import.meta.url)) &&
  existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await flush()
}

// ── core ─────────────────────────────────────────────────────────────────

test('modes, labels and descriptions are stock\'s (store/approval-mode.ts, i18n/en.ts shell.approvalMode)', () => {
  assert.deepEqual(APPROVAL_LABELS, { manual: 'Manual', smart: 'Smart', off: 'Off' })
  assert.deepEqual(APPROVAL_DESCRIPTIONS, {
    manual: 'Ask before actions that require approval',
    smart: 'Automatically assess actions and ask when needed',
    off: 'Run without approval prompts'
  })
  assert.equal(normalizeApprovalMode(' SMART '), 'smart')
  assert.equal(normalizeApprovalMode('off'), 'off')
  assert.equal(normalizeApprovalMode('yolo'), 'manual', 'anything else reads as manual, as stock does')
  assert.equal(normalizeApprovalMode(undefined), 'manual')
})

test('params name the profile (blank = the launch profile, param left out), never a session or a scope', () => {
  assert.deepEqual(approvalParams('scout'), { key: 'approvals.mode', profile: 'scout' })
  assert.deepEqual(approvalParams(' ', { value: 'off' }), { key: 'approvals.mode', value: 'off' })
  assert.deepEqual(approvalParams('scout', { value: 'smart' }), { key: 'approvals.mode', value: 'smart', profile: 'scout' })
})

test('a gateway without the key or the RPC counts as unsupported; other failures do not', () => {
  assert.equal(approvalUnsupported({ code: 4002, message: 'unknown config key: approvals.mode' }), true)
  assert.equal(approvalUnsupported({ code: -32601, message: 'Method not found' }), true)
  assert.equal(approvalUnsupported(new Error('unknown method: config.get')), true)
  assert.equal(approvalUnsupported({ code: 4002, message: 'unknown approval mode: x' }), false)
  assert.equal(approvalUnsupported({ code: 5001, message: 'config unreadable' }), false)
  assert.equal(approvalUnsupported(new Error('socket closed')), false)
})

test('an older read never overwrites a newer one; a failed write goes back to the last confirmed mode', async () => {
  const changes = []
  const modes = createApprovalModes({ onChange: k => changes.push(k) })
  let releaseSlow
  const slow = () => new Promise(resolve => (releaseSlow = () => resolve({ value: 'manual' })))
  const first = modes.read('k', slow, 'scout')
  await modes.read('k', async () => ({ value: 'smart' }), 'scout')
  releaseSlow()
  await first
  assert.equal(modes.get('k').mode, 'smart')
  await assert.rejects(modes.write('k', async () => Promise.reject(new Error('locked key')), 'scout', 'off'), /locked key/)
  assert.equal(modes.get('k').mode, 'smart')
  assert.equal(await modes.write('k', async () => ({ key: 'approvals.mode', value: 'off' }), 'scout', 'off'), 'off')
  assert.equal(modes.get('k').mode, 'off')
  assert.ok(changes.length > 0)
})

// ── the card (jsdom, real modules) ───────────────────────────────────────

let env = null
async function setup(t) {
  if (env) return env
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
    set(key, key === 'getComputedStyle' ? w.getComputedStyle.bind(w) : w[key])
  }
  set('IS_REACT_ACT_ENVIRONMENT', false)
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  const m = await import(pathToFileURL(file).href)
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  m.appApi.start({ storage: { get: (k, f) => (k === 'enabled' ? false : f), set: () => undefined }, onEvent: () => () => undefined, setTimeout: () => () => undefined })
  t.after(() => {
    rmSync(dirname(file), { recursive: true, force: true })
    dom.window.close()
  })
  env = { m, React, createRoot, host: m.fakeSdk.host }
  return env
}

/** Every gateway call, with the route it took; `handlers[method](params, route)` answers. */
function wire(e) {
  const calls = []
  const handlers = {}
  const errors = []
  const answer = async (method, params, route, opts) => {
    calls.push({ method, params, route, opts })
    const h = handlers[method]
    return h ? h(params, route) : {}
  }
  e.host.request = (method, params, timeoutMs, opts) => answer(method, params, null, opts)
  e.host.requestProfile = (route, method, params, timeoutMs, opts) => answer(method, params, route, opts)
  e.host.notifyError = (error, message) => errors.push({ error, message })
  e.host.notify = note => errors.push({ note })
  e.m.rosterApi.resetApprovalModes()
  return { calls, handlers, errors }
}

function mount({ m, React, createRoot }, bot) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(React.createElement(m.ApprovalCard, { bot }))
  const select = () => container.querySelector('select[aria-label="Approval mode"]')
  return {
    container,
    select,
    hint: () => container.querySelector('.gbo-approvals-hint')?.textContent,
    options: () => [...(select()?.options || [])].map(o => [o.value, o.textContent]),
    choose: value => {
      const el = select()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new window.Event('change', { bubbles: true }))
    },
    unmount: () => (root.unmount(), container.remove())
  }
}
const painted = async () => {
  for (let i = 0; i < 50 && !document.querySelector('select[aria-label="Approval mode"]'); i += 1) await flush()
  await settle()
}

const remote = (name, targetProfile = name, connectionId = 'mini') => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId,
  connectionKind: 'ssh',
  route: { connectionId, mode: 'remote', profile: name, targetProfile }
})
const local = name => ({ name })

test('reads the bot\'s own profile on open: stock labels, the hint for the mode, scoped to that profile', { skip }, async t => {
  const e = await setup(t)
  const { calls, handlers } = wire(e)
  handlers['config.get'] = params => ({ value: params.key === 'approvals.mode' ? 'smart' : 'x' })
  const card = mount(e, local('helper'))
  await painted()
  assert.equal(card.select().value, 'smart')
  assert.deepEqual(card.options(), [['manual', 'Manual'], ['smart', 'Smart'], ['off', 'Off']])
  assert.equal(card.hint(), 'Automatically assess actions and ask when needed')
  assert.equal(card.container.querySelector('.panel-row__title').textContent, 'Approval mode')
  const reads = calls.filter(c => c.method === 'config.get')
  assert.equal(reads.length, 1)
  assert.deepEqual(reads[0].params, { key: 'approvals.mode', profile: 'helper' })
  assert.equal(reads[0].route, null, 'the active gateway, by the bot\'s profile name')
  card.unmount()
})

test('a pick writes config.set approvals.mode for THAT bot\'s profile only (no session, no scope), on its own route', { skip }, async t => {
  const e = await setup(t)
  const { calls, handlers, errors } = wire(e)
  let stored = 'manual'
  handlers['config.get'] = () => ({ value: stored })
  handlers['config.set'] = params => ((stored = params.value), { key: 'approvals.mode', value: params.value })
  // A remote bot whose backend profile is named differently on its machine.
  const bot = remote('scout', 'scout-backend')
  const card = mount(e, bot)
  await painted()
  assert.equal(card.select().value, 'manual')
  card.choose('off')
  await settle()
  const writes = calls.filter(c => c.method === 'config.set')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].params, { key: 'approvals.mode', value: 'off', profile: 'scout-backend' })
  assert.equal(writes[0].route?.connectionId, 'mini', 'the bot\'s own connection')
  assert.equal(writes[0].opts?.spawnPriority, 'foreground', 'a user action')
  assert.ok(!('scope' in writes[0].params) && !('session_id' in writes[0].params), 'never global, never a session')
  assert.equal(card.select().value, 'off')
  assert.equal(card.hint(), 'Run without approval prompts')
  assert.deepEqual(errors, [])
  // Every call this card made named only this bot's profile.
  for (const c of calls) assert.equal(c.params.profile, 'scout-backend')
  card.unmount()
})

test('a refused write shows the error toast and goes back to the read value', { skip }, async t => {
  const e = await setup(t)
  const { handlers, errors } = wire(e)
  handlers['config.get'] = () => ({ value: 'smart' })
  handlers['config.set'] = () => Promise.reject(Object.assign(new Error('approvals.mode is managed by your administrator'), { code: 4030 }))
  const card = mount(e, local('helper'))
  await painted()
  card.choose('off')
  await settle()
  assert.equal(card.select().value, 'smart')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /Could not set helper’s approval mode to Off/i)
  assert.match(String(errors[0].error?.message), /managed by your administrator/)
  card.unmount()
})

test('regaining window focus re-reads the bot\'s mode (changed elsewhere, e.g. in stock or the CLI)', { skip }, async t => {
  const e = await setup(t)
  const { calls, handlers } = wire(e)
  let stored = 'manual'
  handlers['config.get'] = () => ({ value: stored })
  const card = mount(e, local('helper'))
  await painted()
  assert.equal(card.select().value, 'manual')
  stored = 'off'
  window.dispatchEvent(new window.Event('focus'))
  await settle()
  assert.equal(card.select().value, 'off')
  assert.equal(calls.filter(c => c.method === 'config.get').length, 2)
  card.unmount()
  // Unmounted: focus no longer reads.
  window.dispatchEvent(new window.Event('focus'))
  await settle()
  assert.equal(calls.filter(c => c.method === 'config.get').length, 2)
})

test('hidden when the bot\'s gateway lacks the key or the RPC; a plain read failure still shows the row', { skip }, async t => {
  const e = await setup(t)
  const { handlers } = wire(e)
  handlers['config.get'] = () => Promise.reject(Object.assign(new Error('unknown config key: approvals.mode'), { code: 4002 }))
  const card = mount(e, local('old'))
  await settle(30)
  assert.equal(card.select(), null)
  assert.equal(card.container.textContent, '')
  card.unmount()
  wire(e).handlers['config.get'] = () => Promise.reject(Object.assign(new Error('Method not found'), { code: -32601 }))
  const card2 = mount(e, remote('far'))
  await settle(30)
  assert.equal(card2.select(), null)
  card2.unmount()
  wire(e).handlers['config.get'] = () => Promise.reject(new Error('socket closed'))
  const card3 = mount(e, local('flaky'))
  await painted()
  assert.equal(card3.select().disabled, true)
  assert.equal(card3.hint(), 'Could not read it (socket closed)')
  card3.unmount()
})
