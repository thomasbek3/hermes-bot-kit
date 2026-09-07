import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginPath = new URL('./plugin.js', import.meta.url)

const SDK_COMPONENTS = [
  'Badge',
  'Button',
  'ConfirmDialog',
  'CopyButton',
  'Dialog',
  'DialogContent',
  'DialogDescription',
  'DialogFooter',
  'DialogHeader',
  'DialogTitle',
  'DropdownMenu',
  'DropdownMenuContent',
  'DropdownMenuItem',
  'DropdownMenuSeparator',
  'DropdownMenuTrigger',
  'EmptyState',
  'ErrorState',
  'Input',
  'Loader',
  'SegmentedControl',
  'Select',
  'SelectContent',
  'SelectItem',
  'SelectTrigger',
  'SelectValue',
  'Separator',
  'StatusDot',
  'Switch',
  'Tip'
]

const PRELUDE = `
const PALETTE_AREA = 'palette'
const KEYBINDS_AREA = 'keybinds'
const PANES_AREA = 'panes'
const STATUSBAR_AREAS = { right: 'right' }
const host = globalThis.__host
const HermesSdk = globalThis.HermesSdk || {}
const atom = globalThis.__atom
const cn = (...xs) => xs.filter(Boolean).join(' ')
const useValue = store => (store && typeof store.get === 'function' ? store.get() : null)
const icons = new Proxy({}, { get: () => () => null })
${SDK_COMPONENTS.map(name => `const ${name} = '${name}'`).join('\n')}
const Fragment = 'Fragment'
const useEffect = () => {}
const useLayoutEffect = () => {}
const useMemo = fn => fn()
const useRef = value => ({ current: value })
const useState = value => [typeof value === 'function' ? value() : value, () => {}]
const jsx = (type, props, key) => ({ type, props, key })
const jsxs = jsx
`

function atom(initial) {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set: next => {
      value = next
      for (const fn of listeners) fn(value)
    },
    listen: fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}

// Enough of an element for the engine to mount its surface and swap RFB
// instances without a real DOM.
function fakeNode() {
  const attrs = new Map()
  return {
    attrs,
    children: [],
    parentNode: null,
    lastElementChild: null,
    style: {},
    setAttribute: (name, value) => attrs.set(name, value),
    getAttribute: name => (attrs.has(name) ? attrs.get(name) : null),
    addEventListener() {},
    removeEventListener() {},
    replaceChildren() {
      this.children = []
      this.lastElementChild = null
    },
    appendChild(child) {
      this.children.push(child)
      this.lastElementChild = child
      if (child) child.parentNode = this
      return child
    },
    removeChild(child) {
      this.children = this.children.filter(item => item !== child)
      this.lastElementChild = this.children[this.children.length - 1] || null
      if (child) child.parentNode = null
      return child
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 })
  }
}

function loadPlugin({ fetchImpl, importHook, hermesDesktop, timers } = {}) {
  const fetches = []
  const fetch =
    fetchImpl ||
    (async (url, init) => {
      fetches.push({ url, init })
      return { ok: true, status: 200, type: 'basic', json: async () => ({}) }
    })

  const context = {
    AbortController,
    Array,
    ArrayBuffer,
    Blob: globalThis.Blob,
    Boolean,
    DataView,
    Date,
    Error,
    Float32Array,
    Float64Array,
    Infinity,
    Int16Array,
    Int32Array,
    Int8Array,
    JSON,
    Map,
    Math,
    NaN,
    Number,
    Object,
    Promise,
    Proxy,
    RangeError,
    Reflect,
    RegExp,
    Set,
    String,
    Symbol,
    SyntaxError,
    TextDecoder,
    TextEncoder,
    TypeError,
    URIError,
    URL,
    URLSearchParams,
    Uint16Array,
    Uint32Array,
    Uint8Array,
    WeakMap,
    WeakSet,
    atob: typeof atob === 'function' ? atob : undefined,
    btoa: typeof btoa === 'function' ? btoa : undefined,
    clearInterval,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    decodeURI,
    decodeURIComponent,
    encodeURI,
    encodeURIComponent,
    fetch,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    queueMicrotask,
    setInterval,
    // `timers` parks every scheduled callback so a test can fire the
    // reconnect backoff without waiting a real second.
    setTimeout: timers ? (fn, ms) => timers.push({ fn, ms }) : setTimeout,
    undefined,
    document: {
      body: { classList: { add() {}, contains: () => false, remove() {} } },
      createElement: () => fakeNode(),
      querySelector: () => null,
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
      clear() {}
    },
    navigator: {
      userAgent: 'test',
      clipboard: { readText: async () => '', writeText: async () => {} }
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    },
    requestAnimationFrame: cb => setTimeout(cb, 0),
    cancelAnimationFrame: id => clearTimeout(id),
    HermesSdk: {},
    __host: {
      state: {},
      paneVisibility: () => ({ get: () => false, listen: () => () => undefined })
    },
    __atom: atom,
    __importHook: importHook
  }
  context.window = context
  context.globalThis = context
  context.self = context
  if (hermesDesktop) context.hermesDesktop = hermesDesktop

  const source = PRELUDE +
    fs
      .readFileSync(pluginPath, 'utf8')
      .replace(/import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\n/, '')
      .replace(/import \* as HermesSdk from '@hermes\/plugin-sdk'\n/, '')
      .replace(
        /import \{ Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState \} from 'react'\n/,
        ''
      )
      .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
      .replace('export default {', 'globalThis.__plugin = {')
      .concat(
        '\nglobalThis.__t = { credentialTargetAllowed, iframePolicy, classifyAddress, orgoApiOrigin, authFetch, rfbSourceOrder, loadRFB, rfbStatusDetail, engine, hiperfReadUe, probeUrlsFromHostPort, hiperfBuildUrl, hiperfHandshakeFrames, fingerprintDecision, fetchSession, attachEngine, connect, normalizeEndpoint, liveEndpoint }\n'
      )

  vm.runInNewContext(source, vm.createContext(context), { filename: pluginPath.pathname })
  return { t: context.__t, fetches, context }
}

test('credentialTargetAllowed accepts the configured https origin only', () => {
  const { t } = loadPlugin()
  const session = 'https://www.orgo.ai/api/session'
  assert.equal(t.credentialTargetAllowed('https://www.orgo.ai/api/computers/1', session), true)
  assert.equal(t.credentialTargetAllowed('https://evil.example/steal', session), false)
  assert.equal(
    t.credentialTargetAllowed('http://example.com/api/x', 'http://example.com/api'),
    false
  )
  assert.equal(
    t.credentialTargetAllowed('http://192.168.1.5:8000/x', 'http://192.168.1.5:8000/api'),
    true
  )
  assert.equal(
    t.credentialTargetAllowed('http://localhost:8000/x', 'http://localhost:8000/api'),
    true
  )
  assert.equal(t.credentialTargetAllowed('not a url', session), false)
})

test('classifyAddress rejects public http and names iframe origins', () => {
  const { t } = loadPlugin()
  const publicVnc = t.classifyAddress('http://1.2.3.4:6080/vnc.html')
  assert.equal(publicVnc.kind, 'invalid')
  assert.equal(publicVnc.connectEnabled, false)

  const httpsVnc = t.classifyAddress('https://x.example/vnc.html')
  assert.equal(httpsVnc.kind, 'iframe')
  assert.match(httpsVnc.line, /https:\/\/x\.example/)

  const lanVnc = t.classifyAddress('http://192.168.1.5:6080/')
  assert.equal(lanVnc.kind, 'iframe')
  assert.equal(lanVnc.connectEnabled, true)

  const publicSession = t.classifyAddress('http://1.2.3.4/api/session')
  assert.equal(publicSession.kind, 'invalid')

  const orgo = t.classifyAddress('https://www.orgo.ai/api/session')
  assert.equal(orgo.kind, 'session-json')
})

test('iframePolicy sandboxes the viewer and keeps clipboard-read opt-in', () => {
  const { t } = loadPlugin()
  const off = t.iframePolicy({})
  assert.equal(off.sandbox, 'allow-scripts allow-same-origin allow-forms')
  assert.equal(off.allow.includes('clipboard-read'), false)
  assert.equal(off.allow, 'fullscreen; clipboard-write')

  const on = t.iframePolicy({ allowClipboard: true })
  assert.equal(on.sandbox, 'allow-scripts allow-same-origin allow-forms')
  assert.match(on.allow, /clipboard-read/)
})

test('authFetch refuses off-origin targets without calling fetch', async () => {
  const { t, fetches } = loadPlugin()
  await assert.rejects(
    () =>
      t.authFetch('https://evil.example/api', {
        bearer: 'secret',
        sessionUrl: 'https://www.orgo.ai/api/session'
      }),
    err => err && err.status === 'unsafe-origin'
  )
  assert.equal(fetches.length, 0)
})

test('authFetch throws redirect on opaqueredirect and never follows', async () => {
  const { t } = loadPlugin({
    fetchImpl: async () => ({ type: 'opaqueredirect', status: 0 })
  })
  await assert.rejects(
    () =>
      t.authFetch('https://www.orgo.ai/api/session', {
        bearer: 'secret',
        sessionUrl: 'https://www.orgo.ai/api/session'
      }),
    err => err && err.status === 'redirect'
  )
})

test('authFetch sends the bearer with redirect: manual on an allowed call', async () => {
  let seen
  const { t } = loadPlugin({
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, type: 'basic' }
    }
  })
  const response = await t.authFetch('https://www.orgo.ai/api/computers/1', {
    bearer: 'secret-token',
    sessionUrl: 'https://www.orgo.ai/api/session'
  })
  assert.equal(response.status, 200)
  assert.equal(seen.init.redirect, 'manual')
  assert.equal(seen.init.headers.Authorization, 'Bearer secret-token')
})

const VENDOR_RFB_PATH = new URL('./vendor/novnc-rfb.mjs', import.meta.url)
const VENDOR_RFB_SOURCE = fs.readFileSync(VENDOR_RFB_PATH, 'utf8')
const JSDELIVR = 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0/+esm'
const ESM_SH = 'https://esm.sh/@novnc/novnc@1.7.0'

// Drift guard: the first path the plugin tries must be exactly where the
// installer puts the file, i.e. the manifest's relative path.
const MANIFEST_REL = fs
  .readFileSync(new URL('../scripts/manifest-files.txt', import.meta.url), 'utf8')
  .split('\n')
  .find(line => line.endsWith('novnc-rfb.mjs'))
const ROOT = '/tmp/hermes-home/desktop-plugins'
const VENDOR_PATH = ROOT + '/' + MANIFEST_REL
// Where releases before the vendor/ move told operators to copy the file.
const LEGACY_PATH = ROOT + '/computer-viewer/novnc-rfb.mjs'

function fakeBridge({ text, missing, truncated, throws, only, seen } = {}) {
  const source = text === undefined ? VENDOR_RFB_SOURCE : text
  return {
    desktopPluginsRoot: async () => ROOT,
    readPluginSource: async filePath => {
      if (seen) seen.push(filePath)
      assert.ok(
        filePath === VENDOR_PATH || filePath === LEGACY_PATH,
        'unexpected vendored path ' + filePath
      )
      if (only && filePath !== only) throw new Error('ENOENT')
      if (throws) throw throws
      if (missing) throw new Error('ENOENT')
      return {
        binary: false,
        byteSize: Buffer.byteLength(source),
        text: truncated ? source.slice(0, 100) : source,
        truncated: Boolean(truncated)
      }
    }
  }
}

function cdnCtorHook(seen) {
  return async url => {
    seen.push(url)
    if (url === JSDELIVR || url === ESM_SH) return { default: function RFB() {} }
    throw new Error('unexpected import ' + url)
  }
}

test('rfbSourceOrder is CDN-only', () => {
  const { t } = loadPlugin()
  assert.deepEqual([...t.rfbSourceOrder()], [JSDELIVR, ESM_SH])
})

test('loadRFB loads the real vendored source from the desktop bridge and skips the CDN', async () => {
  const seen = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge(),
    importHook: async url => {
      seen.push(url)
      if (typeof url === 'string' && url.startsWith('blob:')) {
        return { default: function RFB() {} }
      }
      throw new Error('CDN should not be tried, got ' + url)
    }
  })
  const ctor = await t.loadRFB()
  assert.equal(typeof ctor, 'function')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].startsWith('blob:'), true)
  assert.equal(t.engine.rfbLoad.source, 'vendored')
  assert.equal(t.engine.rfbLoad.reason, null)
  assert.equal(t.rfbStatusDetail(), null)
})

test('loadRFB fails closed on a tampered vendored file and never touches the CDN', async () => {
  const seen = []
  const flipped = (VENDOR_RFB_SOURCE[0] === 'x' ? 'y' : 'x') + VENDOR_RFB_SOURCE.slice(1)
  const { t, fetches } = loadPlugin({
    hermesDesktop: fakeBridge({ text: flipped }),
    importHook: cdnCtorHook(seen)
  })
  await assert.rejects(
    () => t.loadRFB(),
    err => err && err.code === 'vendored-tampered'
  )
  assert.deepEqual(seen, [])
  assert.equal(fetches.length, 0)
  assert.equal(t.engine.rfbLoad.source, null)
  assert.equal(t.engine.rfbLoad.reason, 'integrity')
  assert.equal(t.rfbStatusDetail(), 'vendored integrity check failed')
})

test('loadRFB fails closed when the vendored file cannot be imported', async () => {
  const seen = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge(),
    importHook: async url => {
      seen.push(url)
      if (typeof url === 'string' && url.startsWith('blob:')) throw new Error('bad module')
      return { default: function RFB() {} }
    }
  })
  await assert.rejects(
    () => t.loadRFB(),
    err => err && err.code === 'vendored-tampered'
  )
  assert.deepEqual(seen.filter(url => !url.startsWith('blob:')), [])
  assert.equal(t.engine.rfbLoad.reason, 'import-failed')
  assert.equal(t.rfbStatusDetail(), 'vendored import failed')
})

test('loadRFB falls back to the CDN when the vendored file is missing', async () => {
  const seen = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge({ missing: true }),
    importHook: cdnCtorHook(seen)
  })
  const ctor = await t.loadRFB()
  assert.equal(typeof ctor, 'function')
  assert.deepEqual(seen, [JSDELIVR])
  assert.equal(t.engine.rfbLoad.source, 'cdn-jsdelivr')
  assert.equal(t.engine.rfbLoad.reason, 'missing')
  assert.equal(t.rfbStatusDetail(), 'noVNC from CDN (unverified); vendored file missing')
})

test('loadRFB tells a truncated read apart from a missing file', async () => {
  const seen = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge({ truncated: true }),
    importHook: cdnCtorHook(seen)
  })
  await t.loadRFB()
  assert.equal(t.engine.rfbLoad.reason, 'truncated')
  assert.equal(t.rfbStatusDetail(), 'noVNC from CDN (unverified); vendored file truncated')
})

test('loadRFB reports a non-ENOENT read failure as read-failed', async () => {
  const seen = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge({ throws: new Error('EACCES: permission denied') }),
    importHook: cdnCtorHook(seen)
  })
  await t.loadRFB()
  assert.equal(t.engine.rfbLoad.reason, 'read-failed')
  assert.equal(t.rfbStatusDetail(), 'noVNC from CDN (unverified); vendored read failed')
})

test('loadRFB retries the desktop bridge after a CDN load', async () => {
  const seen = []
  let reads = 0
  const bridge = {
    desktopPluginsRoot: async () => '/tmp/hermes-home/desktop-plugins',
    readPluginSource: async () => {
      reads += 1
      // Both candidate paths miss on the first loadRFB pass, so it reaches the CDN.
      if (reads <= 2) throw new Error('ENOENT')
      return {
        binary: false,
        byteSize: Buffer.byteLength(VENDOR_RFB_SOURCE),
        text: VENDOR_RFB_SOURCE,
        truncated: false
      }
    }
  }
  const { t } = loadPlugin({
    hermesDesktop: bridge,
    importHook: async url => {
      seen.push(url)
      if (typeof url === 'string' && url.startsWith('blob:')) return { default: function RFB() {} }
      if (url === JSDELIVR || url === ESM_SH) return { default: function RFB() {} }
      throw new Error('unexpected import ' + url)
    }
  })
  await t.loadRFB()
  assert.equal(t.engine.rfbLoad.source, 'cdn-jsdelivr')
  await t.loadRFB()
  assert.equal(reads, 3)
  assert.equal(t.engine.rfbLoad.source, 'vendored')
  assert.equal(t.engine.rfbLoad.reason, null)
})

test('loadRFB falls back to CDN when window.hermesDesktop is missing', async () => {
  const seen = []
  const { t } = loadPlugin({
    importHook: cdnCtorHook(seen)
  })
  const ctor = await t.loadRFB()
  assert.equal(typeof ctor, 'function')
  assert.deepEqual(seen, [JSDELIVR])
  assert.equal(t.engine.rfbLoad.source, 'cdn-jsdelivr')
  assert.equal(t.engine.rfbLoad.reason, 'no-bridge')
  assert.equal(t.rfbStatusDetail(), 'noVNC from CDN (unverified); no desktop bridge')
})

test('VENDORED_RFB_SHA256 matches sha256(computer-viewer/vendor/novnc-rfb.mjs)', () => {
  const plugin = fs.readFileSync(pluginPath, 'utf8')
  const match = plugin.match(/const VENDORED_RFB_SHA256 = '([0-9a-f]{64})'/)
  assert.ok(match, 'plugin.js must pin VENDORED_RFB_SHA256')
  const fileHash = createHash('sha256').update(fs.readFileSync(VENDOR_RFB_PATH)).digest('hex')
  assert.equal(match[1], fileHash)
})

test('vendored noVNC default export is a function', async () => {
  const mod = await import('./vendor/novnc-rfb.mjs')
  assert.equal(typeof mod.default, 'function')
})

function bits(text) {
  const bytes = new Uint8Array(Math.ceil(text.length / 8) || 1)
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '1') bytes[i >> 3] |= 1 << (7 - (i & 7))
  }
  return bytes
}

test('hiperfReadUe decodes exp-Golomb codes', () => {
  const { t } = loadPlugin()
  const vectors = [
    ['1', 0],
    ['010', 1],
    ['011', 2],
    ['00100', 3],
    ['00111', 6],
    ['0001000', 7]
  ]
  for (const [text, expected] of vectors) {
    assert.equal(t.hiperfReadUe(bits(text), 0).value, expected, `ue(${text})`)
  }
})

test('classifyAddress treats a bare hostname as a host, not an API key', () => {
  const { t } = loadPlugin()
  const host = t.classifyAddress('windows-11-desktop')
  assert.notEqual(host.kind, 'api-key')
  assert.equal(host.kind, 'probe')
  assert.equal(host.connectEnabled, true)

  const key = t.classifyAddress('sk_live_abc123456789')
  assert.equal(key.kind, 'api-key')
})

test('probeUrlsFromHostPort refuses a plain-http iframe for a public host', () => {
  const { t } = loadPlugin()
  const publicHost = t.probeUrlsFromHostPort({ host: '1.2.3.4', port: 6080 })
  assert.equal(publicHost.iframeUrl, '')
  assert.equal(publicHost.wsUrl.startsWith('wss://'), true)

  const lan = t.probeUrlsFromHostPort({ host: '192.168.1.5', port: 6080 })
  assert.equal(lan.wsUrl, 'ws://192.168.1.5:6080/websockify')
  assert.equal(lan.iframeUrl, 'http://192.168.1.5:6080/vnc.html')
})

test('hiperfBuildUrl keeps the HD token out of the address', () => {
  const { t } = loadPlugin()
  const built = t.hiperfBuildUrl({
    hiperfUrl: 'ws://127.0.0.1:6090/stream',
    hiperfToken: 'secret-token'
  })
  assert.equal(built.error, undefined)
  assert.equal(built.url, 'ws://127.0.0.1:6090/stream')
  assert.equal(built.url.includes('token'), false)
})

test('hiperfHandshakeFrames sends auth first, then start', () => {
  const { t } = loadPlugin()
  const frames = t.hiperfHandshakeFrames({
    hiperfUrl: 'ws://127.0.0.1:6090/stream',
    hiperfToken: 'secret-token'
  })
  assert.equal(frames.length, 2)
  assert.equal(frames[0].type, 'auth')
  assert.equal(frames[0].token, 'secret-token')
  assert.equal(frames[1].type, 'start')

  // A user-pasted URL that already carries ?token= talks to an older agent.
  const legacy = t.hiperfHandshakeFrames({
    hiperfUrl: 'ws://127.0.0.1:6090/stream?token=pasted',
    hiperfToken: 'secret-token'
  })
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].type, 'start')

  const noToken = t.hiperfHandshakeFrames({ hiperfUrl: 'ws://127.0.0.1:6090/stream' })
  assert.equal(noToken.length, 1)
  assert.equal(noToken[0].type, 'start')
})

test('fingerprintDecision pins on first contact and rejects a changed key', () => {
  const { t } = loadPlugin()
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  assert.equal(t.fingerprintDecision('', a).action, 'pin')
  assert.equal(t.fingerprintDecision('', a).detail, 'first contact: server key pinned')
  assert.equal(t.fingerprintDecision(a, a).action, 'approve')
  assert.equal(t.fingerprintDecision(a, b).action, 'reject')
})

test('fetchSession refuses to follow a redirect without credentials', async () => {
  let seen
  const { t } = loadPlugin({
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: false, status: 302, type: 'basic' }
    }
  })
  await assert.rejects(
    () => t.fetchSession({ sessionUrl: 'https://example.test/api/session' }, t.engine.generation),
    err => err && err.status === 'redirect'
  )
  assert.equal(seen.init.redirect, 'manual')
})

test('fetchSession treats an opaqueredirect as a blocked redirect', async () => {
  const { t } = loadPlugin({
    fetchImpl: async () => ({ ok: false, status: 0, type: 'opaqueredirect' })
  })
  await assert.rejects(
    () => t.fetchSession({ sessionUrl: 'https://example.test/api/session' }, t.engine.generation),
    err => err && err.status === 'redirect'
  )
})

function fakeRfbCtorWithListeners(store) {
  return function RFB() {
    const self = this
    self.listeners = new Map()
    self.addEventListener = (name, fn) => {
      self.listeners.set(name, fn)
    }
    self.removeEventListener = () => {}
    self.disconnect = () => {}
    self.focus = () => {}
    store.push(self)
  }
}

function makeCtx() {
  const store = new Map()
  return {
    written: [],
    storage: {
      get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      set: (key, value) => store.set(key, value),
      remove: key => store.delete(key)
    },
    os: {
      writeClipboard(text) {
        this.__written.push(text)
      }
    },
    register: () => () => {},
    onDispose: () => {}
  }
}

async function connectedRfb({ allowClipboard }) {
  const written = []
  const instances = []
  const { t, context } = loadPlugin({
    importHook: async () => ({ default: fakeRfbCtorWithListeners(instances) })
  })
  const ctx = makeCtx()
  ctx.os.__written = written
  t.attachEngine(ctx)
  const endpoint = t.normalizeEndpoint({
    id: 'ep-clip',
    name: 'Test box',
    mode: 'websocket',
    wsUrl: 'ws://127.0.0.1:6080/websockify',
    allowClipboard
  })
  await t.connect(endpoint)
  assert.equal(instances.length, 1, 'the fake RFB should have been constructed')
  return { rfb: instances[0], written, context }
}

test('a remote clipboard event is ignored unless the computer is allowed', async () => {
  const denied = await connectedRfb({ allowClipboard: false })
  denied.rfb.listeners.get('clipboard')({ detail: { text: 'stolen' } })
  assert.deepEqual(denied.written, [])

  const allowed = await connectedRfb({ allowClipboard: true })
  allowed.rfb.listeners.get('clipboard')({ detail: { text: 'shared' } })
  assert.deepEqual(allowed.written, ['shared'])
})

test('loadRFB reads vendor/ first and still accepts a copy left next to plugin.js', async () => {
  const seen = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge({ only: LEGACY_PATH, seen }),
    importHook: async url => {
      if (typeof url === 'string' && url.startsWith('blob:')) return { default: function RFB() {} }
      throw new Error('CDN should not be tried, got ' + url)
    }
  })
  const ctor = await t.loadRFB()
  assert.equal(typeof ctor, 'function')
  assert.deepEqual(seen, [VENDOR_PATH, LEGACY_PATH])
  assert.equal(t.engine.rfbLoad.source, 'vendored')
  assert.equal(t.engine.rfbLoad.reason, null)
})

test('a tampered file in vendor/ fails closed instead of falling through to the legacy path', async () => {
  const seen = []
  const flipped = (VENDOR_RFB_SOURCE[0] === 'x' ? 'y' : 'x') + VENDOR_RFB_SOURCE.slice(1)
  const cdn = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge({ text: flipped, seen }),
    importHook: cdnCtorHook(cdn)
  })
  await assert.rejects(
    () => t.loadRFB(),
    err => err && err.code === 'vendored-tampered'
  )
  assert.deepEqual(seen, [VENDOR_PATH])
  assert.deepEqual(cdn, [])
})

const NOVNC_BODIES = {
  hash: 'The installed noVNC bundle does not match the expected hash. Re-run the kit installer. (hash mismatch)',
  load: 'The installed noVNC bundle could not be loaded. Re-run the kit installer. (vendored import failed)'
}

function wsEndpoint(t, extra = {}) {
  return t.normalizeEndpoint({
    id: 'ep-pin',
    name: 'Pinned box',
    mode: 'websocket',
    wsUrl: 'ws://127.0.0.1:6080/websockify',
    ...extra
  })
}

/** attachEngine + connect(), with the endpoint already in stored settings. */
async function attached({ endpoint, importHook, hermesDesktop, timers }) {
  const instances = []
  const { t } = loadPlugin({
    hermesDesktop,
    timers,
    importHook: importHook || (async () => ({ default: fakeRfbCtorWithListeners(instances) }))
  })
  const ctx = makeCtx()
  ctx.os.__written = []
  const ep = endpoint(t)
  ctx.storage.set('endpoints', [ep])
  ctx.storage.set('globalEndpointId', ep.id)
  t.attachEngine(ctx)
  await t.connect(ep)
  return { t, ctx, ep, instances }
}

async function keyHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

const KEY_A = new Uint8Array([1, 2, 3, 4])
const KEY_B = new Uint8Array([9, 8, 7, 6])

/** Fire serververification and let the async digest settle. */
async function presentKey(rfb, publickey) {
  rfb.listeners.get('serververification')({ detail: publickey ? { publickey } : {} })
  await new Promise(resolve => setTimeout(resolve, 0))
}

function storedPin(ctx, id) {
  const found = ctx.storage.get('endpoints', []).find(item => item.id === id)
  return found ? found.serverKeyFingerprint : null
}

test('a probe that succeeds keeps the server key pinned moments earlier', async () => {
  const { t, ctx, ep, instances } = await attached({
    endpoint: t => wsEndpoint(t, { probe: true, address: '192.168.1.5:6080', wsUrl: '' })
  })
  const rfb = instances[0]

  await presentKey(rfb, KEY_A)
  const pin = await keyHash(KEY_A)
  assert.equal(t.engine.endpoint.serverKeyFingerprint, pin)

  // Probe success rewrites the endpoint as a plain websocket one. Merging that
  // onto the copy captured before the pin used to wipe the pin.
  rfb.listeners.get('connect')({})
  assert.equal(t.engine.endpoint.mode, 'websocket')
  assert.equal(t.engine.endpoint.probe, false)
  assert.equal(t.engine.endpoint.serverKeyFingerprint, pin)
  assert.equal(storedPin(ctx, ep.id), pin)
})

test('an auto-reconnect presenting a different key is rejected, not re-pinned', async () => {
  const timers = []
  const { t, ctx, ep, instances } = await attached({
    endpoint: t => wsEndpoint(t),
    timers
  })
  const first = instances[0]

  await presentKey(first, KEY_A)
  const pin = await keyHash(KEY_A)
  assert.equal(storedPin(ctx, ep.id), pin)

  t.engine.paneVisible = true
  first.listeners.get('connect')({})
  first.listeners.get('disconnect')({ detail: { clean: false } })

  // The backoff timer used to hand connect() the pre-pin copy it captured.
  const backoff = timers.find(entry => entry.ms === 1000)
  assert.ok(backoff, 'reconnect backoff should be scheduled')
  backoff.fn()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(instances.length, 2, 'the reconnect should build a second RFB')

  await presentKey(instances[1], KEY_B)
  const state = t.engine.state.get()
  assert.equal(state.phase, 'error')
  assert.equal(state.code, 'server-key-changed')
  assert.equal(storedPin(ctx, ep.id), pin)
  assert.equal(t.engine.endpoint.serverKeyFingerprint, pin)
})

test('a pinned computer that presents no key at all is rejected', async () => {
  const { t, ctx, ep, instances } = await attached({ endpoint: t => wsEndpoint(t) })
  const rfb = instances[0]

  await presentKey(rfb, KEY_A)
  const pin = await keyHash(KEY_A)

  await presentKey(rfb, null)
  const state = t.engine.state.get()
  assert.equal(state.phase, 'error')
  assert.equal(state.code, 'server-key-changed')
  assert.equal(storedPin(ctx, ep.id), pin)
})

test('a computer with no pin still connects when no key is presented', async () => {
  const { t, instances } = await attached({ endpoint: t => wsEndpoint(t) })

  await presentKey(instances[0], null)
  const state = t.engine.state.get()
  assert.notEqual(state.phase, 'error')
  assert.equal(t.engine.endpoint.serverKeyFingerprint, '')
})

test('connect() reports why the vendored viewer lost, not a generic body', async () => {
  const flipped = (VENDOR_RFB_SOURCE[0] === 'x' ? 'y' : 'x') + VENDOR_RFB_SOURCE.slice(1)
  const tampered = await attached({
    endpoint: t => wsEndpoint(t),
    hermesDesktop: fakeBridge({ text: flipped }),
    importHook: async () => {
      throw new Error('CDN blocked')
    }
  })
  assert.equal(tampered.t.engine.state.get().code, 'vendored-tampered')
  assert.equal(tampered.t.engine.state.get().detail, NOVNC_BODIES.hash)

  // An import failure is fail-closed too, but it is not a hash mismatch.
  const unloadable = await attached({
    endpoint: t => wsEndpoint(t),
    hermesDesktop: fakeBridge(),
    importHook: async url => {
      if (typeof url === 'string' && url.startsWith('blob:')) throw new Error('bad module')
      throw new Error('CDN blocked')
    }
  })
  assert.equal(unloadable.t.engine.state.get().code, 'vendored-tampered')
  assert.equal(unloadable.t.engine.state.get().detail, NOVNC_BODIES.load)

  // Missing vendored copy and a blocked CDN: the pane names both.
  const blocked = await attached({
    endpoint: t => wsEndpoint(t),
    hermesDesktop: fakeBridge({ missing: true }),
    importHook: async () => {
      throw new Error('CDN blocked')
    }
  })
  const state = blocked.t.engine.state.get()
  assert.equal(state.code, 'cdn-blocked')
  assert.match(state.detail, /noVNC couldn't be fetched from the CDN/)
  assert.match(state.detail, /vendored file missing/)
})
