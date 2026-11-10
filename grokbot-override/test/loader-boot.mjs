// Boot the built plugin.js inside a DOM the way Hermes Desktop does
// (test/hermes-loader.mjs, the ONE loader replica every loader-faithful test
// uses), with a fake host shaped like the SDK's. One plugin per test file:
// react-dom keeps references to the window it first runs against, as in the
// app (one window, one plugin instance).
//
// Options: `primitives` adds the SDK's Radix dialog / menu parts
// (fixtures/smoke-sdk.mjs; without them the override's own fallbacks render,
// as on an older Desktop); `smoke` passes the `ctx.__gboSmoke` seam so the
// test receives the internals (Hermes never passes it).

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { sdkExtras, sdkPrimitives } from './fixtures/smoke-sdk.mjs'
import { loadPluginLikeHermes, reactRequire } from './hermes-loader.mjs'

// Hermes ships production React; set before anything requires it.
process.env.NODE_ENV = 'production'

export const PLUGIN = fileURLToPath(new URL('../plugin.js', import.meta.url))
export const READY = existsSync(new URL('../node_modules/jsdom', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

export const LOCAL = {
  name: 'security',
  display_name: 'Security',
  connectionId: 'local',
  connectionKind: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: 'security', targetProfile: 'security' },
  canonical_session: { id: 's-root', preview: 'local preview', last_active: 1762560000 }
}
export const REMOTE = {
  name: 'scholar',
  display_name: 'Scholar',
  remoteSource: true,
  sourceScoped: true,
  connectionId: 'home-server',
  connectionKind: 'ssh',
  connectionLabel: 'HOME-SERVER',
  route: { connectionId: 'home-server', mode: 'remote', profile: 'scholar', targetProfile: 'scholar' },
  canonical_session: { id: 'k-root', resolved_id: 'k-tip', preview: 'remote preview', last_active: 1762550000 }
}

/** REST /api/sessions/{id}/messages (SessionMessage rows). */
export function history(profile) {
  const t = 1762560000
  return {
    session_id: profile,
    messages: [
      { id: 11, role: 'user', content: `hello ${profile}`, timestamp: t },
      { id: 12, role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' } }], timestamp: t + 1 },
      { id: 13, role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'file body', timestamp: t + 2 },
      { id: 14, role: 'assistant', content: `**${profile}** answers with \`code\``, reasoning: 'thinking about it', timestamp: t + 3 }
    ],
    pagination: { limit: 120, offset: 0, order: 'latest', returned: 4 }
  }
}

function installDom(JSDOM) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'FileReader', 'DOMException']) {
    set(key, key === 'window' ? w : typeof w[key] === 'function' && /^[a-z]/.test(key) ? w[key].bind(w) : w[key])
  }
  set('IS_REACT_ACT_ENVIRONMENT', false)
  return dom
}

const atom = value => ({ get: () => value, subscribe: fn => (fn(value), () => undefined) })

export function fakeSdk(React, calls, answers = {}, { primitives = false, rows = [LOCAL, REMOTE], sources = [] } = {}) {
  const workspaces = new Map()
  const routeKey = r => (typeof r === 'string' ? r : `${r.connectionId}::${r.profile}`)
  const answer = (profile, method, params) => {
    if (answers[method]) return answers[method](params, profile)
    switch (method) {
      case 'session.list': {
        const bot = rows.find(b => b.name === profile)
        return { sessions: bot?.canonical_session ? [{ ...bot.canonical_session, title: 'Bot Chat', message_count: 4 }] : [] }
      }
      case 'session.resume':
        return { session_id: `rt-${profile}`, running: false, message_count: 4 }
      case 'cron.manage':
        return { jobs: [] }
      case 'display.status':
        return { running: false }
      case 'approval.pending':
        return { approvals: [] }
      case 'session.active_list':
        return { sessions: [] }
      default:
        return {}
    }
  }
  const listeners = new Set()
  const host = {
    state: { connectionId: atom(null), profile: atom('default') },
    activeConnectionId: () => null,
    request: async (method, params) => (calls.push({ via: 'request', method, params }), answer('default', method, params)),
    requestProfile: async (r, method, params) => (calls.push({ via: routeKey(r), method, params }), answer(r.profile, method, params)),
    retainProfile: async () => () => undefined,
    onEvent: (type, fn) => (listeners.add(fn), () => listeners.delete(fn)),
    revealPane: () => undefined,
    undismissPane: () => undefined,
    paneVisibility: () => atom(true),
    notify: n => calls.push({ method: 'notify', params: n }),
    notifyError: (e, title) => calls.push({ method: 'notifyError', params: { title, message: String(e?.message || e) } }),
    warmAgent: () => undefined,
    openSession: async (...args) => (calls.push({ method: 'openSession', params: args }), undefined),
    agents: async () => ({ agents: [], sources }),
    connections: async () => [],
    openWorkspace: (id, options) => {
      workspaces.set(id, options)
      return () => workspaces.delete(id)
    },
    composer: {}
  }
  const now = Date.now()
  const sdk = {
    host,
    PALETTE_AREA: 'palette',
    PANES_AREA: 'panes',
    BOT_CHAT_SESSION_HYDRATION_TIMEOUT_MS: 60_000,
    queryClient: {
      getQueryCache: () => ({
        findAll: () => [{ queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: rows, sources }, dataUpdatedAt: now } }]
      }),
      invalidateQueries: () => undefined
    },
    profileColor: () => '#3b82f6',
    blobatarSvg: () => '<svg></svg>',
    // The app's renderer is a component (it uses hooks): the plugin must
    // render it as an element, never call it.
    MessageTextContent: ({ text }) => React.createElement('div', { className: 'aui-md' }, React.useMemo(() => text, [text])),
    ...sdkExtras(React),
    ...(primitives ? sdkPrimitives(React) : {})
  }
  return { sdk, workspaces, emit: event => listeners.forEach(fn => fn(event)) }
}

export async function waitFor(check, label, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Load plugin.js like Hermes, register it, and return the handles a test
 *  drives. Everything is torn down by `t.after`. */
export async function bootPlugin(t, { tweak, answers, historyFor = history, api, primitives = false, smoke = false, rows, sources, storage = {}, showWork = false, ctxExtras = {} } = {}) {
  const { JSDOM } = await import('jsdom')
  const dom = installDom(JSDOM)
  const calls = []
  const errors = []
  const { require } = reactRequire()
  const fake = fakeSdk(require('react'), calls, answers, { primitives, ...(rows ? { rows } : {}), ...(sources ? { sources } : {}) })
  tweak?.(fake.sdk)
  window.hermesDesktop = {
    api: async request => {
      calls.push({ method: 'REST', params: request })
      if (api) {
        const answer = await api(request)
        if (answer !== undefined) return answer
      }
      return historyFor(request.profile)
    }
  }
  let loaded = await loadPluginLikeHermes(PLUGIN, fake.sdk)
  const { React, ReactDOMClient } = loaded
  const panes = []
  let disposers = []
  const roots = []
  const store = new Map(Object.entries(storage))
  // The override's work-rows setting: tool and Thought rows are drawn.
  if (showWork) store.set('showWork', true)
  let internals = null
  const timers = new Set()
  const ctx = () => ({
    register: c => (panes.push(c), () => undefined),
    registerMany: list => list.forEach(c => panes.push(c)),
    storage: { get: (k, f) => (store.has(k) ? store.get(k) : f), set: (k, v) => store.set(k, v) },
    setTimeout: (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
      return () => {
        timers.delete(id)
        clearTimeout(id)
      }
    },
    onDispose: fn => disposers.push(fn),
    onEvent: fake.sdk.host.onEvent,
    files: {},
    ...ctxExtras,
    ...(smoke ? { __gboSmoke: value => (internals = value) } : {})
  })
  loaded.plugin.register(ctx())
  /** Hermes's "Reload desktop plugins" (contrib/runtime-loader.ts activate):
   *  run every disposer of the running instance, evaluate plugin.js afresh
   *  and register the new module with a new context on the same storage. */
  const reload = async () => {
    const previous = disposers
    disposers = []
    for (const fn of previous) fn()
    panes.length = 0
    const old = loaded
    loaded = await loadPluginLikeHermes(PLUGIN, fake.sdk)
    old.cleanup()
    loaded.plugin.register(ctx())
  }
  const rootOptions = {
    onUncaughtError: (error, info) => errors.push({ kind: 'uncaught', error, stack: info?.componentStack }),
    onCaughtError: (error, info) => errors.push({ kind: 'caught', error, stack: info?.componentStack }),
    onRecoverableError: error => errors.push({ kind: 'recoverable', error })
  }
  const mount = render => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = ReactDOMClient.createRoot(el, rootOptions)
    root.render(React.createElement(() => render()))
    roots.push(root)
    return el
  }
  t.after(() => {
    for (const root of roots) root.unmount()
    for (const fn of disposers) fn()
    for (const id of timers) clearTimeout(id)
    loaded.cleanup()
    dom.window.close()
  })
  return { ...fake, calls, errors, panes, store, mount, React, internals, reload }
}
