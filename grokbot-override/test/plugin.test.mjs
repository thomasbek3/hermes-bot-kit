// The built plugin.js, loaded the way the kit tests its other plugins: in a
// node:vm context with a fake SDK, fake React and a small fake DOM.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

/** Rewrite the bundle's ESM imports/exports into vm-friendly globals. */
function toScript(source) {
  return source
    .replace(/^import \* as (\w+) from "@hermes\/plugin-sdk";$/gm, 'const $1 = globalThis.__sdk;')
    .replace(/^import \* as (\w+) from "react";$/gm, 'const $1 = globalThis.__react;')
    .replace(/^import \{([^}]*)\} from "react\/jsx-runtime";$/gm, (_, names) => `const {${names.replace(/ as /g, ': ')}} = globalThis.__jsx;`)
    .replace(/^export \{\s*(\w+) as default\s*\};?$/m, 'globalThis.__plugin = $1;')
}

function atom(value) {
  const subs = new Set()
  return {
    get: () => value,
    set(next) {
      value = next
      for (const fn of subs) fn(value)
    },
    subscribe(fn) {
      subs.add(fn)
      fn(value)
      return () => subs.delete(fn)
    }
  }
}

function fakeTab(attr, paneId, selected = false) {
  const attrs = { [attr]: paneId, 'aria-selected': String(selected) }
  return {
    attrs,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    hasAttribute: name => name in attrs,
    dispatchEvent: () => true
  }
}

function fakeDocument(tabs) {
  const head = { children: [] }
  head.appendChild = child => {
    child.parentNode = head
    head.children.push(child)
    return child
  }
  const createElement = tag => {
    const node = { tagName: tag.toUpperCase(), id: '', textContent: '', parentNode: null }
    node.remove = () => {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(c => c !== node)
      node.parentNode = null
    }
    return node
  }
  const match = (selector, tab) => {
    const m = selector.match(/^\[([\w-]+)="([^"]+)"\]$/)
    return Boolean(m && tab.getAttribute(m[1]) === m[2])
  }
  return {
    head,
    documentElement: head,
    body: head,
    createElement,
    getElementById: id => head.children.find(c => c.id === id) || null,
    querySelectorAll: selector => tabs.filter(t => match(selector, t)),
    querySelector: selector => tabs.find(t => match(selector, t)) || null
  }
}

function memoryStorage(seed = {}) {
  const data = { ...seed }
  return { data, get: (k, f) => (k in data ? data[k] : f), set: (k, v) => void (data[k] = v), remove: k => void delete data[k] }
}

const ROSTER = [
  { name: 'budget', canonical_session: { id: 'c-root', resolved_id: 'c-tip', message_count: 4 }, connectionId: 'local', connectionKind: 'local', sourceScoped: true, route: { connectionId: 'local', mode: 'local', profile: 'budget', targetProfile: 'budget' } },
  { name: 'scholar', remoteSource: true, sourceScoped: true, connectionId: 'home-server', connectionKind: 'ssh', connectionLabel: 'HOME-SERVER', route: { connectionId: 'home-server', mode: 'remote', profile: 'scholar', targetProfile: 'scholar' } }
]

function load({ storage = memoryStorage(), tabs = [], roster = ROSTER } = {}) {
  const calls = []
  const record = (name, ...args) => calls.push({ name, args })
  const visibility = new Map()
  const queries = [{ queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: roster, sources: [] }, dataUpdatedAt: Date.now() } }]
  const host = {
    state: { connectionId: atom(null) },
    request: async (method, params) => {
      record('request', method, params)
      if (method === 'profiles.list') return { profiles: roster.filter(r => !r.remoteSource) }
      if (method === 'cron.manage') return { jobs: [] }
      return {}
    },
    requestProfile: async (route, method, params) => {
      record('requestProfile', method, params, route)
      if (method === 'session.list') return { sessions: [{ id: 'c-root', resolved_id: 'c-tip', title: 'Bot Chat' }] }
      if (method === 'cron.manage') return { jobs: [{ job_id: 'j1', name: 'Watch', enabled: true }] }
      return {}
    },
    agents: async () => ({ agents: [], sources: [] }),
    revealPane: id => record('revealPane', id),
    undismissPane: id => record('undismissPane', id),
    openWorkspace: (id, options) => {
      record('openWorkspace', id, options)
      return () => record('closeWorkspace', id)
    },
    openSession: async (id, options) => record('openSession', id, options),
    focusOpenWorkspaceSession: (...args) => record('focusOpenWorkspaceSession', ...args),
    paneVisibility: id => {
      if (!visibility.has(id)) visibility.set(id, atom(false))
      return visibility.get(id)
    },
    notify: n => record('notify', n),
    notifyError: (e, m) => record('notifyError', m),
    warmAgent: () => undefined
  }
  const registered = []
  const files = []
  const ctx = {
    storage,
    register: c => {
      registered.push(c)
      return () => record('dispose', c.id)
    },
    registerMany: cs => cs.forEach(c => registered.push(c)),
    onDispose: fn => (ctx.dispose = fn),
    onEvent: () => () => undefined,
    setTimeout: () => () => undefined,
    files: { writeText: async (folder, path, text) => files.push({ folder, path, text }) }
  }
  const document = fakeDocument(tabs)
  const hermesApi = async request => {
    record('api', request)
    return { messages: [{ id: 1, role: 'user', content: 'secret words', timestamp: 1 }], pagination: { order: 'latest' } }
  }
  const context = {
    __sdk: {
      host,
      PALETTE_AREA: 'palette',
      PANES_AREA: 'panes',
      BOT_CHAT_SESSION_HYDRATION_TIMEOUT_MS: 60_000,
      queryClient: { getQueryCache: () => ({ findAll: () => queries }) }
    },
    __react: { createElement: (type, props) => ({ type, props }), useSyncExternalStore: (s, g) => g(), Component: class {}, createContext: value => ({ Provider: 'Provider', _currentValue: value }) },
    __jsx: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    document,
    window: { hermesDesktop: { api: hermesApi } },
    localStorage: { getItem: () => null },
    URLSearchParams,
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
  context.globalThis = context
  vm.runInNewContext(toScript(SOURCE), vm.createContext(context), { filename: 'plugin.js' })
  const plugin = context.__plugin
  plugin.register(ctx)
  return { plugin, ctx, host, calls, registered, document, storage, files, visibility, names: () => calls.map(c => c.name) }
}

const hideStyle = kit => kit.document.getElementById('grokbot-override-hide-stock')
const flush = () => new Promise(resolve => setImmediate(resolve))

test('plugin.js is a valid single-file ESM plugin importing only the allowed modules', () => {
  const specifiers = [...SOURCE.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1])
  assert.ok(specifiers.length > 0)
  for (const spec of specifiers) assert.ok(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'].includes(spec), spec)
  assert.doesNotMatch(SOURCE, /\bimport\s*\(/, 'no dynamic imports')
  // C3: session.create appears exactly once, in core/create-chat.js (stock's
  // createCanonicalChat, titled "Bot Chat", hidden). Nothing else mints one.
  assert.equal((SOURCE.match(/'session\.create'|"session\.create"/g) || []).length, 1, 'one creation path only')
})

test('on by default: palette commands, the roster pane docked into the Bots zone, styles', () => {
  const kit = load()
  assert.equal(kit.plugin.id, 'grokbot-override')
  const ids = kit.registered.map(c => c.data?.id || c.id)
  for (const id of ['grokbot-override.toggle', 'grokbot-override.open-stock', 'grokbot-override.back', 'grokbot-override.self-check']) assert.ok(ids.includes(id), id)
  const pane = kit.registered.find(c => c.id === 'roster')
  assert.ok(pane, 'roster pane registered')
  assert.equal(pane.area, 'panes')
  assert.equal(JSON.stringify(pane.data.dock), JSON.stringify({ pane: 'hermes-bots:pane', pos: 'center', enforce: true }))
  assert.ok(kit.document.getElementById('grokbot-override-style'))
  assert.equal(kit.registered.find(c => c.data?.id === 'grokbot-override.toggle').data.detail(), 'on')
})

test('the stock tab is hidden only while the override tab exists (fail safe)', () => {
  const none = load()
  assert.equal(hideStyle(none), null)
  const kit = load({ tabs: [fakeTab('data-tree-tab', 'hermes-bots:pane'), fakeTab('data-tree-tab', 'grokbot-override:roster')] })
  assert.match(hideStyle(kit).textContent, /\[data-tree-tab="hermes-bots:pane"\]\{display:none!important\}/)
  assert.doesNotMatch(hideStyle(kit).textContent, /narrow-overlay/)
})

test('a selected stock tab is switched to the override tab', () => {
  const kit = load({ tabs: [fakeTab('data-tree-tab', 'hermes-bots:pane', true), fakeTab('data-tree-tab', 'grokbot-override:roster')] })
  assert.ok(kit.calls.some(c => c.name === 'revealPane' && c.args[0] === 'grokbot-override:roster'))
})

test('toggle OFF restores stock at once and is remembered; Bot Mode is never touched', () => {
  const tabs = [fakeTab('data-tree-tab', 'hermes-bots:pane'), fakeTab('data-tree-tab', 'grokbot-override:roster')]
  const kit = load({ tabs })
  kit.registered.find(c => c.data?.id === 'grokbot-override.toggle').data.run()
  assert.equal(hideStyle(kit), null)
  assert.equal(kit.document.getElementById('grokbot-override-style'), null)
  assert.ok(kit.calls.some(c => c.name === 'dispose' && c.args[0] === 'roster'))
  assert.ok(kit.calls.some(c => c.name === 'revealPane' && c.args[0] === 'hermes-bots:pane'))
  assert.equal(kit.storage.data.enabled, false)

  const again = load({ storage: kit.storage, tabs })
  assert.equal(again.registered.find(c => c.id === 'roster'), undefined)
  assert.equal(hideStyle(again), null)
})

test('Open in Hermes Bot Mode lifts the hide and opens the same Bot Chat with Bot Mode options', async () => {
  const tabs = [fakeTab('data-tree-tab', 'hermes-bots:pane'), fakeTab('data-tree-tab', 'grokbot-override:roster')]
  const kit = load({ tabs })
  assert.ok(hideStyle(kit))
  kit.registered.find(c => c.data?.id === 'grokbot-override.open-stock').data.run()
  // no bot selected yet -> only reveals stock
  assert.equal(hideStyle(kit), null)
  assert.ok(kit.calls.some(c => c.name === 'revealPane' && c.args[0] === 'hermes-bots:pane'))
  await flush()
  assert.ok(!kit.names().includes('openSession'))

  // back to the override: the peek ends when the override pane is seen again
  const visible = kit.visibility.get('grokbot-override:roster')
  visible.set(false)
  visible.set(true)
  assert.ok(hideStyle(kit), 'hide restored after returning to the override tab')
})

test('with a bot selected, the fallback opens its exact Bot Chat in stock with openStoredBotChat options', async () => {
  const tabs = [fakeTab('data-tree-tab', 'hermes-bots:pane'), fakeTab('data-tree-tab', 'grokbot-override:roster')]
  const kit = load({ tabs, storage: memoryStorage({ selected: 'local::budget' }) })
  for (let i = 0; i < 6; i += 1) await flush()
  kit.registered.find(c => c.data?.id === 'grokbot-override.open-stock').data.run()
  for (let i = 0; i < 6; i += 1) await flush()
  const open = kit.calls.find(c => c.name === 'openSession')
  assert.ok(open, 'openSession called')
  assert.equal(open.args[0], 'c-tip')
  const options = JSON.parse(JSON.stringify(open.args[1]))
  assert.deepEqual(options, {
    route: { connectionId: 'local', mode: 'local', profile: 'budget', targetProfile: 'budget' },
    profile: 'budget',
    intent: 'in-place',
    awaitHydration: false,
    expectHistory: true,
    forceResume: true,
    hydrationTimeoutMs: 60000,
    keepAllProfilesScope: true,
    workspaceMode: 'bots',
    workspaceOwnerKey: 'bot:local::budget',
    retryHydrationTimeoutOnce: true,
    tabTitle: 'Bot Chat'
  })
  const focus = kit.calls.find(c => c.name === 'focusOpenWorkspaceSession')
  assert.equal(focus.args[0], 'bot:local::budget')
  assert.equal(hideStyle(kit), null, 'stock tab visible while peeking')
  const all = kit.calls.filter(c => c.name === 'request' || c.name === 'requestProfile').map(c => c.args[0])
  assert.ok(!all.includes('session.create'))
})

test('the roster pane renders through a component; enabling claims the main pane with the chat tab, nothing headless', () => {
  const kit = load()
  const pane = kit.registered.find(c => c.id === 'roster')
  const element = pane.render()
  assert.equal(typeof element.type, 'function')
  // Pass 6 C: while on, the main pane is the override's (never Hermes's own
  // session view beside the roster), so enabling opens exactly its chat tab.
  const opened = kit.calls.filter(c => c.name === 'openWorkspace').map(c => c.args[0])
  assert.deepEqual(opened, ['grokbot-override'])
  const rpc = kit.calls.filter(c => c.name === 'request' || c.name === 'requestProfile').map(c => c.args[0])
  assert.ok(!rpc.includes('session.resume') && !rpc.includes('session.create'), 'no chat attached or created by enabling alone')
})

test('self-check performs reads only and records counts, never message text', async () => {
  const kit = load()
  await kit.registered.find(c => c.data?.id === 'grokbot-override.self-check').data.run()
  for (let i = 0; i < 5; i += 1) await flush()
  const methods = kit.calls.filter(c => c.name === 'request' || c.name === 'requestProfile').map(c => c.args[0])
  for (const method of methods) assert.ok(['session.list', 'cron.manage', 'profiles.list', 'groups.list'].includes(method), method) // groups.list: the R14 room list, a read
  for (const call of kit.calls.filter(c => c.args[0] === 'cron.manage')) assert.equal(call.args[1].action, 'list')
  assert.ok(kit.names().includes('api'), 'history read through the REST bridge')
  assert.equal(kit.files.length, 1)
  const report = JSON.parse(kit.files[0].text)
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.doesNotMatch(kit.files[0].text, /secret words/)
})
