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
        '\nglobalThis.__t = { credentialTargetAllowed, iframePolicy, classifyAddress, sessionOrigin, authFetch, loadRFB, rfbStatusDetail, engine, hiperfReadUe, probeUrlsFromHostPort, hiperfBuildUrl, hiperfHandshakeFrames, fingerprintDecision, fetchSession, attachEngine, connect, normalizeEndpoint, liveEndpoint, handleToolStart, control, $control, $ui, $settings, controlView, normalizeLease, normalizeStatus, statusWords, takeOver, handBack, handBackOnClose, syncControlTarget, controlLocked, effectiveViewOnly, showPane, hidePane, userDisconnect, refreshLease, createRemoteCuaClient, remoteCuaRestRequest, refreshStatus, ControlBar, ControlStatusLine, ComputerPane, OverlayBar, syncSurfacePointer, ensureIframeEl, resolveControlOwner, onFocusedOwnerChange }\n'
      )

  vm.runInNewContext(source, vm.createContext(context), { filename: pluginPath.pathname })
  return { t: context.__t, fetches, context }
}

test('credentialTargetAllowed accepts the configured https origin only', () => {
  const { t } = loadPlugin()
  const session = 'https://api.example.com/api/session'
  assert.equal(t.credentialTargetAllowed('https://api.example.com/api/computers/1', session), true)
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

  const api = t.classifyAddress('https://api.example.com/api/session')
  assert.equal(api.kind, 'session-json')
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
        sessionUrl: 'https://api.example.com/api/session'
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
      t.authFetch('https://api.example.com/api/session', {
        bearer: 'secret',
        sessionUrl: 'https://api.example.com/api/session'
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
  const response = await t.authFetch('https://api.example.com/api/computers/1', {
    bearer: 'secret-token',
    sessionUrl: 'https://api.example.com/api/session'
  })
  assert.equal(response.status, 200)
  assert.equal(seen.init.redirect, 'manual')
  assert.equal(seen.init.headers.Authorization, 'Bearer secret-token')
})

const VENDOR_RFB_PATH = new URL('./vendor/novnc-rfb.mjs', import.meta.url)
const VENDOR_RFB_SOURCE = fs.readFileSync(VENDOR_RFB_PATH, 'utf8')

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

// Records every import; anything that is not the vendored blob would be a
// network module, which the loader must never request.
function cdnCtorHook(seen) {
  return async url => {
    seen.push(url)
    return { default: function RFB() {} }
  }
}

test('plugin.js names no CDN or network module source for noVNC', () => {
  const plugin = fs.readFileSync(pluginPath, 'utf8')
  assert.ok(!/jsdelivr|esm\.sh|unpkg|skypack/i.test(plugin), 'no CDN URL left in the loader')
  assert.ok(!/rfbSourceOrder|NOVNC_FALLBACK_URL|NOVNC_URL\b/.test(plugin))
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

test('loadRFB fails closed when the vendored file is missing: no CDN import', async () => {
  const seen = []
  const { t, fetches } = loadPlugin({
    hermesDesktop: fakeBridge({ missing: true }),
    importHook: cdnCtorHook(seen)
  })
  await assert.rejects(
    () => t.loadRFB(),
    err => err && err.code === 'novnc-missing'
  )
  assert.deepEqual(seen, [], 'nothing imported')
  assert.equal(fetches.length, 0)
  assert.equal(t.engine.rfbLoad.source, null)
  assert.equal(t.engine.rfbLoad.reason, 'missing')
  assert.equal(t.rfbStatusDetail(), 'vendored file missing')
})

test('loadRFB tells a truncated read apart from a missing file', async () => {
  const seen = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge({ truncated: true }),
    importHook: cdnCtorHook(seen)
  })
  await assert.rejects(() => t.loadRFB(), err => err && err.code === 'novnc-missing')
  assert.deepEqual(seen, [])
  assert.equal(t.engine.rfbLoad.reason, 'truncated')
  assert.equal(t.rfbStatusDetail(), 'vendored file truncated')
})

test('loadRFB reports a non-ENOENT read failure as read-failed', async () => {
  const seen = []
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge({ throws: new Error('EACCES: permission denied') }),
    importHook: cdnCtorHook(seen)
  })
  await assert.rejects(() => t.loadRFB(), err => err && err.code === 'novnc-missing')
  assert.deepEqual(seen, [])
  assert.equal(t.engine.rfbLoad.reason, 'read-failed')
  assert.equal(t.rfbStatusDetail(), 'vendored read failed')
})

test('loadRFB retries the desktop bridge after a failed load', async () => {
  const seen = []
  let reads = 0
  const bridge = {
    desktopPluginsRoot: async () => '/tmp/hermes-home/desktop-plugins',
    readPluginSource: async () => {
      reads += 1
      // Both candidate paths miss on the first loadRFB pass, so it fails.
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
      throw new Error('unexpected import ' + url)
    }
  })
  await assert.rejects(() => t.loadRFB(), err => err && err.code === 'novnc-missing')
  assert.deepEqual(seen, [])
  await t.loadRFB()
  assert.equal(reads, 3)
  assert.equal(t.engine.rfbLoad.source, 'vendored')
  assert.equal(t.engine.rfbLoad.reason, null)
})

test('loadRFB fails closed when window.hermesDesktop is missing', async () => {
  const seen = []
  const { t } = loadPlugin({
    importHook: cdnCtorHook(seen)
  })
  await assert.rejects(() => t.loadRFB(), err => err && err.code === 'novnc-missing')
  assert.deepEqual(seen, [])
  assert.equal(t.engine.rfbLoad.source, null)
  assert.equal(t.engine.rfbLoad.reason, 'no-bridge')
  assert.equal(t.rfbStatusDetail(), 'no desktop bridge')
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

test('classifyAddress treats a bare hostname as a host, and a bare key as nothing', () => {
  const { t } = loadPlugin()
  const host = t.classifyAddress('windows-11-desktop')
  assert.equal(host.kind, 'probe')
  assert.equal(host.connectEnabled, true)

  // No cloud-provider key discovery any more: a key on its own is not an address.
  const key = t.classifyAddress('sk_live_abc123456789')
  assert.notEqual(key.kind, 'api-key')
  assert.equal(key.connectEnabled, key.kind === 'probe')
})

test('credentialTargetAllowed sends a key nowhere without a session address', () => {
  const { t } = loadPlugin()
  assert.equal(t.credentialTargetAllowed('https://api.example.com/x', ''), false)
  assert.equal(t.credentialTargetAllowed('https://api.example.com/x', 'not a url'), false)
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
    hermesDesktop: fakeBridge(),
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
    // The viewer loads only the vendored, hash-checked copy (no CDN).
    hermesDesktop: hermesDesktop === undefined ? fakeBridge() : hermesDesktop,
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
  // The digest runs off the main thread; give it a few turns under load.
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 1))
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
  // The reconnect re-verifies the vendored noVNC (async); wait for it.
  for (let i = 0; i < 100 && instances.length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
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

  // Missing vendored copy: a clear "re-run the installer", nothing imported.
  const imported = []
  const blocked = await attached({
    endpoint: t => wsEndpoint(t),
    hermesDesktop: fakeBridge({ missing: true }),
    importHook: async url => {
      imported.push(url)
      return { default: function RFB() {} }
    }
  })
  const state = blocked.t.engine.state.get()
  assert.equal(state.code, 'novnc-missing')
  assert.match(state.detail, /Re-run the kit installer/)
  assert.match(state.detail, /vendored file missing/)
  assert.deepEqual(imported, [])
})

// ---------------------------------------------------------------------------
// Orgo is gone.
// ---------------------------------------------------------------------------

test('no Orgo strings are left in the kit (history and the remover excepted)', async () => {
  const { execFileSync } = await import('node:child_process')
  const root = new URL('..', import.meta.url)
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const allowed = new Set([
    'computer-viewer/remove-orgo-computer.sh',
    'computer-viewer/tests/test-remove-orgo-computer.sh',
    'computer-viewer/plugin.test.mjs',
    'install.sh',
    'tests/test-install.sh'
  ])
  const hits = []
  for (const rel of files) {
    if (/(^|\/)CHANGELOG\.md$/.test(rel) || allowed.has(rel)) continue
    if (/\.(png|jpe?g|gif|webp|ico|pdf|woff2?)$/i.test(rel)) continue
    let text
    try {
      text = fs.readFileSync(new URL(rel, root), 'utf8')
    } catch {
      continue
    }
    // Upgrade notes may name the remover script and the retired plugin it removes.
    text = text.replace(/remove-orgo-computer\.sh|`orgo-computer`/g, '')
    // Word boundary: the MIT-attributed "Korgo Bot" project stays credited.
    if (/\borgo/i.test(text)) hits.push(rel)
  }
  assert.deepEqual(hits, [])
})

// ---------------------------------------------------------------------------
// Auto-open on Hermes's own computer_use / browser tool calls.
// ---------------------------------------------------------------------------

function boundSetup({ remoteCua = false, bind = true, profile = 'ava', client, api, routes, state } = {}) {
  const instances = []
  const loaded = loadPlugin({
    hermesDesktop: api ? { ...fakeBridge(), api } : fakeBridge(),
    importHook: async () => ({ default: fakeRfbCtorWithListeners(instances) })
  })
  const { t, context } = loaded
  context.__host.state.profile = atom(profile)
  if (state) Object.assign(context.__host.state, state)
  if (typeof routes === 'function') context.__host.profileRoutes = routes
  else if (routes) context.__host.profileRoutes = () => routes
  const ctx = makeCtx()
  ctx.os.__written = []
  const registered = []
  // Scoped timers: the lease poll and cleanup retries run only when a test fires them.
  ctx.timeouts = []
  ctx.setTimeout = (fn, ms) => {
    ctx.timeouts.push({ fn, ms })
    return () => {}
  }
  ctx.disposers = []
  ctx.onDispose = fn => ctx.disposers.push(fn)
  ctx.intervals = []
  ctx.setInterval = (fn, ms) => {
    ctx.intervals.push({ fn, ms })
    return () => {}
  }
  ctx.register = contribution => {
    registered.push(contribution)
    return () => {}
  }
  const ep = t.normalizeEndpoint({
    id: 'ep-mac',
    name: 'Bot Mac',
    mode: 'websocket',
    wsUrl: 'ws://127.0.0.1:6080/websockify',
    remoteCua
  })
  ctx.storage.set('endpoints', [ep])
  ctx.storage.set('globalEndpointId', ep.id)
  if (bind) ctx.storage.set('perBotEndpoint', { [profile]: ep.id })
  if (client) t.control.client = client
  t.attachEngine(ctx)
  return { t, ctx, ep, instances, registered, context }
}

const toolStart = (name, extra = {}) => ({ type: 'tool.start', profile: 'ava', payload: { name }, ...extra })

test('a live computer_use call wakes the pane for a bot with a bound computer', () => {
  const { t, registered } = boundSetup()
  assert.equal(t.handleToolStart(toolStart('computer_use'), 1_000_000), true)
  assert.equal(registered.length, 1, 'the pane was shown')
  assert.notEqual(t.engine.state.get().phase, 'idle')
})

test('browser tool calls wake too; other tools do not', () => {
  const a = boundSetup()
  assert.equal(a.t.handleToolStart(toolStart('browser_navigate'), 1_000_000), true)
  const b = boundSetup()
  assert.equal(b.t.handleToolStart(toolStart('terminal'), 1_000_000), false)
  assert.equal(b.t.handleToolStart(toolStart('orgo_computer_bash'), 1_000_000), false)
  assert.equal(b.registered.length, 0)
})

test('replayed history never wakes the pane', () => {
  const { t, registered } = boundSetup()
  assert.equal(t.handleToolStart(toolStart('computer_use', { replayed: true }), 1_000_000), false)
  assert.equal(registered.length, 0)
})

test('no wake for a bot without its own bound computer, or for another bot', () => {
  const unbound = boundSetup({ bind: false })
  assert.equal(unbound.t.handleToolStart(toolStart('computer_use'), 1_000_000), false)
  const other = boundSetup()
  assert.equal(other.t.handleToolStart(toolStart('computer_use', { profile: 'bob' }), 1_000_000), false)
})

test('at most one wake per bot every 30 s, and a manual close holds for 30 s', () => {
  const { t } = boundSetup()
  assert.equal(t.handleToolStart(toolStart('computer_use'), 1_000_000), true)
  assert.equal(t.handleToolStart(toolStart('computer_use'), 1_010_000), false)
  assert.equal(t.handleToolStart(toolStart('computer_use'), 1_031_000), true)

  const closed = boundSetup()
  closed.t.showPane()
  const realNow = Date.now
  try {
    closed.context.Date.now = () => 2_000_000
    closed.t.hidePane()
  } finally {
    closed.context.Date.now = realNow
  }
  assert.equal(closed.t.handleToolStart(toolStart('computer_use'), 2_010_000), false)
  assert.equal(closed.t.handleToolStart(toolStart('computer_use'), 2_031_000), true)
})

// ---------------------------------------------------------------------------
// Take over / Hand back against a fake remote-cua backend reached through the
// desktop REST bridge, answering exactly as remote-cua/dashboard/plugin_api.py.
// ---------------------------------------------------------------------------

const AGENT_LEASE = { holder: 'agent', viewer: null, since: 0, epoch: 0 }
const MACHINE = { host: '100.64.0.10', user: 'you', os: 'macos', driver: '', vnc: '' }
// GET /status fixtures, copied from the plugin's documented responses.
const STATUS_READY = {
  ok: true, configured: true, supported: true, machine: MACHINE, reachable: true,
  driver: { found: true, path: '/Users/you/.hermes/tools/cua-driver-0.21.0-darwin-arm64/cua-driver', version: '0.21.0', pin: '0.21.0', ok: true, problem: '' },
  permissions: { accessibility: true, screen_recording: true, ok: true },
  screen_awake: true, windows: 10, logged_in: true, error: '', checked_at: 1763251200.1, cached: false,
  summary: ['Reachable over SSH', 'Driver ready: cua-driver 0.21.0', 'Permissions OK (Accessibility and Screen Recording)', 'Screen awake']
}
const STATUS_UNREACHABLE = {
  ok: false, configured: true, supported: true, machine: MACHINE, reachable: false,
  driver: null, permissions: null, screen_awake: null, windows: null, logged_in: null,
  error: 'could not reach you@100.64.0.10 over SSH (Permission denied (publickey).)', checked_at: 1763251200.1, cached: false,
  summary: ['Not reachable over SSH: could not reach you@100.64.0.10 over SSH (Permission denied (publickey).)']
}
const STATUS_WINDOWS = {
  ok: false, configured: true, supported: false, machine: { ...MACHINE, os: 'windows' },
  error: 'Windows support coming: needs cua Session proxy.', summary: ['Windows support coming: needs cua Session proxy.'], checked_at: 1763251200.1
}
const STATUS_ASLEEP = {
  ...STATUS_READY, ok: false, screen_awake: false, windows: 0, error: 'Screen asleep or locked: no windows are visible',
  summary: ['Reachable over SSH', 'Driver ready: cua-driver 0.21.0', 'Permissions OK (Accessibility and Screen Recording)', 'Screen asleep or locked: no windows are visible']
}

/** The plugin's routes behind `window.hermesDesktop.api`. HTTP >= 400 rejects
 *  the way the bridge does: Error("<status>: <body>"). */
function fakeRemoteCua({ lease = AGENT_LEASE, status = STATUS_READY, configured = true, missing = false } = {}) {
  const server = { lease: { ...lease }, status, calls: [] }
  const reply = (code, body) => {
    if (code >= 400) throw new Error(`${code}: ${JSON.stringify(body)}`)
    return JSON.parse(JSON.stringify(body))
  }
  const bump = next => {
    server.lease = { ...next, since: 1763251200.5, epoch: server.lease.epoch + 1 }
  }
  // server.hold(route): the next request to that route is committed on the
  // server now, and its answer is held until .deliver() (or .fail(error)).
  server.held = new Map()
  server.hold = (route, { beforeCommit = false } = {}) => {
    let open
    const gate = new Promise(resolve => {
      open = resolve
    })
    const entry = { gate, beforeCommit, error: null, deliver: () => open(), fail: error => { entry.error = error; open() } }
    server.held.set(route, entry)
    return entry
  }
  server.api = async request => {
    const route = request.path.replace('/api/plugins/remote-cua/', '').replace(/\?.*$/, '')
    const entry = server.held.get(route)
    if (entry) server.held.delete(route)
    // beforeCommit: the request has not reached the server yet.
    if (entry && entry.beforeCommit) {
      await entry.gate
      if (entry.error) throw entry.error
    }
    let outcome
    try {
      outcome = { value: answer(request) }
    } catch (error) {
      outcome = { error }
    }
    if (entry && !entry.beforeCommit) {
      await entry.gate
      if (entry.error) throw entry.error
    }
    if (outcome.error) throw outcome.error
    return outcome.value
  }
  const answer = request => {
    const { method, path, body, profile, connectionId, priority } = request
    server.calls.push({ method, path, body, profile, connectionId, priority })
    if (missing) return reply(404, { detail: 'Plugin not found' })
    const route = path.replace('/api/plugins/remote-cua/', '')
    if (method === 'GET' && route === 'lease') {
      return reply(200, configured
        ? { ok: true, lease: server.lease, configured: true, machine: MACHINE }
        : { ok: true, lease: server.lease, configured: false, machine: null, error: 'this profile has no remote_cua block in config.yaml' })
    }
    if (method === 'POST' && route === 'take') {
      const viewer = body && body.viewer
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(viewer || ''))) {
        return reply(400, { ok: false, error: 'bad_viewer', message: 'viewer must be 1-128 letters, digits, . _ : -' })
      }
      if (server.lease.holder === 'human' && server.lease.viewer !== viewer) {
        return reply(409, { ok: false, error: 'held_by_other_viewer', message: 'Another viewer has control of this computer', lease: server.lease })
      }
      if (server.lease.viewer !== viewer) bump({ holder: 'human', viewer })
      return reply(200, { ok: true, lease: server.lease })
    }
    if (method === 'POST' && route === 'release') {
      const viewer = body && body.viewer
      const force = Boolean(body && body.force === true)
      if (server.lease.holder === 'human') {
        if (!force && server.lease.viewer !== viewer) {
          return reply(409, { ok: false, error: 'not_holder', message: 'This viewer does not hold control; use force to hand back anyway', lease: server.lease })
        }
        bump({ holder: 'agent', viewer: null })
      }
      return reply(200, { ok: true, lease: server.lease })
    }
    if (method === 'GET' && route.startsWith('status')) return reply(200, server.status)
    return reply(404, { detail: 'Not Found' })
  }
  server.api.answer = answer
  server.takes = () => server.calls.filter(c => c.path.endsWith('/take'))
  server.releases = () => server.calls.filter(c => c.path.endsWith('/release'))
  return server
}

// Objects made inside the plugin's vm realm: compare by value.
const plain = value => JSON.parse(JSON.stringify(value))

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

const AVA_ROUTE = [{ profile: 'ava', targetProfile: 'ava', connectionId: 'conn-mini', mode: 'remote' }]

async function remoteSetup(server, opts = {}) {
  const setup = boundSetup({ remoteCua: true, api: server.api, routes: AVA_ROUTE, ...opts })
  setup.t.syncControlTarget()
  await setup.t.connect(setup.ep)
  await settle()
  return setup
}

test('the pane calls the plugin routes on the bot\'s own connection and profile', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server)
  await t.takeOver()
  await t.handBack()
  await t.refreshStatus(true)
  // plain(): a missing body reads as null.
  assert.deepEqual(
    plain(server.calls.map(c => [c.method, c.path, c.body, c.profile, c.connectionId, c.priority])),
    [
      ['GET', '/api/plugins/remote-cua/status', null, 'ava', 'conn-mini', 'foreground'],
      ['GET', '/api/plugins/remote-cua/lease', null, 'ava', 'conn-mini', 'foreground'],
      ['POST', '/api/plugins/remote-cua/take', { viewer: t.control.viewerId }, 'ava', 'conn-mini', 'foreground'],
      ['POST', '/api/plugins/remote-cua/release', { viewer: t.control.viewerId, force: false }, 'ava', 'conn-mini', 'foreground'],
      ['GET', '/api/plugins/remote-cua/status?fresh=1', null, 'ava', 'conn-mini', 'foreground']
    ]
  )
  assert.match(t.control.viewerId, /^[A-Za-z0-9._:-]{1,128}$/)
})

test('an older desktop without route inventory asks the single gateway by profile name', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server, { routes: null })
  assert.equal(server.calls[0].profile, 'ava')
  assert.equal(server.calls[0].connectionId, undefined)
  assert.ok(t)
})

test('bot in control: the pane is view-only for that machine, even expanded', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await remoteSetup(server)
  t.$ui.set({ ...t.$ui.get(), expanded: true, viewOnly: false })
  const view = t.controlView(t.$control.get(), t.control.viewerId)
  assert.equal(view.chip, 'Bot is in control')
  assert.equal(view.canTakeOver, true)
  assert.equal(t.controlLocked(), true)
  assert.equal(t.effectiveViewOnly(), true)
  assert.ok(instances.length >= 1)
})

test('Take over gives input and the red-border state; Hand back returns it', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await remoteSetup(server)
  await t.takeOver()
  assert.equal(server.lease.holder, 'human')
  assert.equal(server.lease.viewer, t.control.viewerId)
  const view = t.controlView(t.$control.get(), t.control.viewerId)
  assert.equal(view.iHold, true)
  assert.equal(view.chip, 'You are in control')
  assert.equal(t.$ui.get().expanded, true, 'Take over opens the large view')
  assert.equal(t.controlLocked(), false)
  assert.equal(instances[instances.length - 1].viewOnly, false)

  await t.handBack()
  assert.equal(server.lease.holder, 'agent')
  assert.equal(t.controlLocked(), true)
  assert.equal(instances[instances.length - 1].viewOnly, true)
})

test('a dropped connection keeps the human lease until reconnect', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await remoteSetup(server)
  instances[instances.length - 1].listeners.get('connect')({})
  await t.takeOver()
  const releasesBefore = server.releases().length
  instances[instances.length - 1].listeners.get('disconnect')({ detail: { clean: false } })
  await settle()
  assert.equal(server.releases().length, releasesBefore)
  assert.equal(server.lease.holder, 'human')
  await t.refreshLease()
  assert.equal(t.controlView(t.$control.get(), t.control.viewerId).iHold, true)
})

test('closing the pane hands back; so does Disconnect', async () => {
  const server = fakeRemoteCua()
  const a = await remoteSetup(server)
  a.t.showPane()
  await a.t.takeOver()
  a.t.hidePane()
  await settle()
  assert.equal(server.lease.holder, 'agent')

  const server2 = fakeRemoteCua()
  const b = await remoteSetup(server2)
  await b.t.takeOver()
  b.t.userDisconnect()
  await settle()
  assert.equal(server2.lease.holder, 'agent')
})

test('after a reload the old lease shows "Hand back (force)", which clears it', async () => {
  const server = fakeRemoteCua({ lease: { holder: 'human', viewer: 'cv-from-before-reload', since: 1763251100, epoch: 3 } })
  const { t } = await remoteSetup(server)
  const view = t.controlView(t.$control.get(), t.control.viewerId)
  assert.equal(view.iHold, false)
  assert.equal(view.chip, 'Another viewer is in control')
  assert.equal(view.canForce, true)
  assert.equal(t.controlLocked(), true)
  await t.handBack(false)
  assert.equal(server.releases().length, 0, 'a plain hand back from a non-holder sends nothing')
  await t.handBack(true)
  assert.deepEqual(plain(server.releases()[0].body), { viewer: t.control.viewerId, force: true })
  assert.equal(server.lease.holder, 'agent')
})

test('a refused take (409 held_by_other_viewer) shows the holder and the message', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server)
  server.lease = { holder: 'human', viewer: 'cv-other-window', since: 1763251300, epoch: 8 }
  await t.takeOver()
  const state = t.$control.get()
  assert.equal(state.pending, null)
  assert.equal(state.error, 'Another viewer has control of this computer')
  assert.equal(t.controlView(state, t.control.viewerId).chip, 'Another viewer is in control')
  assert.equal(t.controlLocked(), true)
})

test('another viewer taking over drops this window back to watching', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server)
  await t.takeOver()
  server.lease = { holder: 'human', viewer: 'cv-other-window', since: 1763251300, epoch: 9 }
  await t.refreshLease()
  assert.equal(t.$control.get().evicted, true)
  assert.equal(t.controlLocked(), true)
})

test('a remote-cua computer that is only the global default cannot be taken over', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server, { bind: false })
  const view = t.controlView(t.$control.get(), t.control.viewerId)
  assert.equal(view.canTakeOver, false)
  assert.equal(t.controlLocked(), true)
  await t.takeOver()
  assert.equal(server.calls.length, 0)
})

test('an unconfigured profile and a missing plugin say so in plain words', async () => {
  const unconfigured = fakeRemoteCua({ configured: false })
  const a = await remoteSetup(unconfigured)
  assert.equal(a.t.$control.get().error, 'this profile has no remote_cua block in config.yaml')
  const missing = fakeRemoteCua({ missing: true })
  const b = await remoteSetup(missing)
  assert.match(b.t.$control.get().error, /doesn't have the remote-cua plugin enabled/)
  assert.match(b.t.$control.get().statusError, /remote-cua plugin/)
})

test('plain VNC computers keep the manual View only switch', async () => {
  const { t } = boundSetup({ remoteCua: false })
  t.$ui.set({ ...t.$ui.get(), expanded: true, viewOnly: false })
  assert.equal(t.controlLocked(), false)
  assert.equal(t.effectiveViewOnly(), false)
  t.$ui.set({ ...t.$ui.get(), viewOnly: true })
  assert.equal(t.effectiveViewOnly(), true)
})

test('a bound machine shows the plugin status summary in plain words', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server)
  assert.deepEqual(plain(t.statusWords(t.$control.get().status)), {
    tone: 'good',
    line: 'Reachable over SSH · Driver ready: cua-driver 0.21.0 · Permissions OK (Accessibility and Screen Recording) · Screen awake'
  })
  const asleep = t.statusWords(t.normalizeStatus(STATUS_ASLEEP))
  assert.equal(asleep.tone, 'bad')
  assert.match(asleep.line, /Screen asleep or locked/)
  const down = t.statusWords(t.normalizeStatus(STATUS_UNREACHABLE))
  assert.equal(down.tone, 'bad')
  assert.match(down.line, /Not reachable over SSH/)
  const windows = t.statusWords(t.normalizeStatus(STATUS_WINDOWS))
  assert.equal(windows.tone, 'bad')
  assert.match(windows.line, /Windows support coming/)
  // An answer with no summary falls back to its error.
  assert.equal(t.statusWords(t.normalizeStatus({ ok: false, configured: null, error: 'status check failed: OSError: x' })).line, 'status check failed: OSError: x')
})

test('the lease parser reads the plugin shape; no file reads as agent', () => {
  const { t } = loadPlugin()
  assert.deepEqual(plain(t.normalizeLease({ ok: true, lease: AGENT_LEASE, configured: true, machine: MACHINE })), AGENT_LEASE)
  assert.deepEqual(plain(t.normalizeLease({ ok: true, lease: { holder: 'human', viewer: 'pane-7f3a', since: 1763251200.5, epoch: 4 } })), {
    holder: 'human', viewer: 'pane-7f3a', since: 1763251200.5, epoch: 4
  })
  assert.deepEqual(plain(t.normalizeLease(null)), AGENT_LEASE)
})

test('the bridge error "<status>: <body>" is parsed back into its JSON body', async () => {
  const { t, context } = loadPlugin({
    hermesDesktop: {
      api: async () => {
        throw new Error('409: {"ok": false, "error": "not_holder", "message": "This viewer does not hold control; use force to hand back anyway", "lease": {"holder": "human", "viewer": "x", "since": 1, "epoch": 2}}')
      }
    }
  })
  context.__host.profileRoutes = () => []
  await assert.rejects(
    () => t.remoteCuaRestRequest({ connectionId: null, profile: 'ava' }, 'release', { viewer: 'y', force: false }),
    err => err.status === 409 && err.body.error === 'not_holder' && err.body.lease.viewer === 'x'
  )
})

function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const props = node.props || {}
  return textOf(props.children) + (props.label ? ' ' + props.label : '')
}

test('the pane and overlay render the chip, the buttons and the status line', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server)
  let text = textOf(t.ControlBar({})) + ' ' + textOf(t.ControlStatusLine())
  assert.match(text, /Bot is in control/)
  assert.match(text, /Take over/)
  assert.match(text, /Reachable over SSH · Driver ready: cua-driver 0\.21\.0/)
  assert.ok(t.ComputerPane())
  const bar = t.OverlayBar({ iframeMode: false, connected: true, viewOnly: true, remote: true })
  assert.doesNotMatch(JSON.stringify(bar), /"View only"/)
  await t.takeOver()
  text = textOf(t.ControlBar({ onDark: true }))
  assert.match(text, /You are in control/)
  assert.match(text, /Hand back/)
  server.lease = { holder: 'human', viewer: 'cv-gone', since: 1, epoch: 7 }
  await t.refreshLease()
  text = textOf(t.ControlBar({}))
  assert.match(text, /Another viewer is in control/)
  assert.match(text, /Hand back \(force\)/)
})

// ---------------------------------------------------------------------------
// Review round 1 regressions (each fails on 605da23).
// ---------------------------------------------------------------------------

const lastRfb = instances => instances[instances.length - 1]

async function heldByMe(server) {
  const setup = await remoteSetup(server)
  lastRfb(setup.instances).listeners.get('connect')({})
  await setup.t.takeOver()
  assert.equal(lastRfb(setup.instances).viewOnly, false, 'precondition: this window drives the machine')
  return setup
}

test('R1-01: input goes off when Hand back starts, before the release answer arrives', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await heldByMe(server)
  const held = server.hold('release')
  const pending = t.handBack()
  await settle()
  assert.equal(server.lease.holder, 'agent', 'the server has already given the bot control')
  assert.equal(t.$control.get().pending, 'release')
  assert.equal(lastRfb(instances).viewOnly, true, 'no human input while the release is in flight')
  assert.equal(t.controlLocked(), true)
  held.deliver()
  await pending
  assert.equal(lastRfb(instances).viewOnly, true)
})

test('R1-01: a lost release answer keeps input off until a fresh read', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await heldByMe(server)
  const held = server.hold('release')
  const pending = t.handBack()
  await settle()
  held.fail(new Error('connection lost after POST'))
  await pending
  await settle()
  assert.equal(server.lease.holder, 'agent')
  assert.equal(lastRfb(instances).viewOnly, true)
  assert.equal(t.controlLocked(), true)
  assert.equal(t.controlView(t.$control.get(), t.control.viewerId).chip, 'Bot is in control', 'the reconciling read landed')
})

test('R1-01: a lost release that did NOT commit stays fenced; its id is retired, Take over uses a new one', async () => {
  const server = fakeRemoteCua()
  const { t, ctx, instances } = await heldByMe(server)
  const oldId = t.control.viewerId
  // The request never reaches the server: the human still holds the lease.
  let offline = true
  t.control.client = t.createRemoteCuaClient(async (owner, op, body, query) => {
    if (offline && op === 'release') throw new Error('connection lost before POST')
    return t.remoteCuaRestRequest(owner, op, body, query)
  })
  await t.handBack()
  await settle()
  assert.equal(server.lease.holder, 'human')
  assert.equal(lastRfb(instances).viewOnly, true, 'no input under an id whose release may still land')
  assert.notEqual(t.control.viewerId, oldId, 'the id is retired')
  const view = t.controlView(t.$control.get(), t.control.viewerId)
  assert.equal(view.chip, 'Handing back…')
  assert.equal(view.canTakeOver, false)
  assert.equal(view.canHandBack, true)
  // Back online: the scheduled retry hands the old id back, then Take over grants the new id.
  offline = false
  ctx.timeouts.shift().fn()
  await settle()
  assert.equal(server.lease.holder, 'agent')
  await t.takeOver()
  assert.equal(server.lease.viewer, t.control.viewerId)
  assert.equal(lastRfb(instances).viewOnly, false)
})

test('R1-02: a lease read sent before Hand back cannot resurrect control after it', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await heldByMe(server)
  const epochHeld = server.lease.epoch
  const parked = server.hold('lease')
  const read = t.refreshLease()
  await settle()
  await t.handBack()
  assert.equal(server.lease.holder, 'agent')
  parked.deliver()
  await read
  const state = t.$control.get()
  assert.equal(state.lease.holder, 'agent')
  assert.ok(state.lease.epoch > epochHeld)
  assert.equal(lastRfb(instances).viewOnly, true)
})

test('R1-02: an older-epoch grant is ignored even without a mutation in between', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await heldByMe(server)
  // Another window forced it back and the bot works; then an old answer lands.
  server.lease = { holder: 'agent', viewer: null, since: 1763251400, epoch: 10 }
  await t.refreshLease()
  assert.equal(lastRfb(instances).viewOnly, true)
  const stale = { ok: true, lease: { holder: 'human', viewer: t.control.viewerId, since: 1, epoch: 3 } }
  server.lease = stale.lease
  await t.refreshLease()
  assert.equal(t.$control.get().lease.epoch, 10)
  assert.equal(lastRfb(instances).viewOnly, true)
})

test('R1-03: closing the pane during Take over hands the late grant back and stays closed', async () => {
  const server = fakeRemoteCua()
  const { t, registered } = await remoteSetup(server)
  t.showPane()
  const shown = registered.length
  const held = server.hold('take')
  const taking = t.takeOver()
  await settle()
  assert.equal(server.lease.holder, 'human', 'the server granted it')
  t.hidePane()
  held.deliver()
  await taking
  await settle()
  assert.equal(server.lease.holder, 'agent', 'the late grant was handed back')
  assert.equal(server.releases().length, 1)
  assert.equal(registered.length, shown, 'the pane was not reopened')
  assert.equal(t.$ui.get().expanded, false)
  assert.equal(t.$control.get().pending, null)
})

test('R1-03: Disconnect during Take over hands the late grant back', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server)
  const held = server.hold('take')
  const taking = t.takeOver()
  await settle()
  t.userDisconnect()
  held.deliver()
  await taking
  await settle()
  assert.equal(server.lease.holder, 'agent')
  assert.equal(t.$ui.get().expanded, false)
})

test('R1-03: switching bots during Take over hands back on the old bot\'s gateway', async () => {
  const server = fakeRemoteCua()
  const { t, ctx, context } = await remoteSetup(server)
  const held = server.hold('take')
  const taking = t.takeOver()
  await settle()
  context.__host.state.profile.set('bob')
  ctx.storage.get('perBotEndpoint')
  t.syncControlTarget()
  held.deliver()
  await taking
  await settle()
  assert.equal(server.lease.holder, 'agent')
  const release = server.releases()[0]
  assert.equal(release.connectionId, 'conn-mini')
  assert.equal(release.profile, 'ava')
})

const TWO_AVAS = [
  { profile: 'ava', targetProfile: 'ava', connectionId: 'conn-a', mode: 'remote' },
  { profile: 'ava', targetProfile: 'ava', connectionId: 'conn-b', mode: 'remote', primary: true }
]

test('R1-05: two gateways with the same bot name: the focused chat\'s owner decides, never list order', async () => {
  const server = fakeRemoteCua()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes: TWO_AVAS })
  setup.context.__host.state.focusedSessionOwner = atom({ connectionId: 'conn-b', profile: 'ava' })
  await setup.t.resolveControlOwner()
  await settle()
  await setup.t.takeOver()
  assert.ok(server.calls.length > 0)
  for (const call of server.calls) assert.equal(call.connectionId, 'conn-b')
})

test('R1-05: ambiguous owner fails closed: no requests, no Take over, a plain reason', async () => {
  const server = fakeRemoteCua()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes: TWO_AVAS })
  setup.t.syncControlTarget()
  await settle()
  await setup.t.takeOver()
  assert.equal(server.calls.length, 0)
  assert.match(setup.t.$control.get().ownerError, /More than one gateway has a bot named ava/)
  assert.equal(setup.t.controlLocked(), true)
  setup.t.$ui.set({ ...setup.t.$ui.get(), expanded: true })
  assert.equal(setup.t.effectiveViewOnly(), true)
})

test('R1-05: a route inventory failure fails closed instead of an unpinned request', async () => {
  const server = fakeRemoteCua()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes: [] })
  setup.context.__host.profileRoutes = async () => {
    throw new Error('registry unavailable')
  }
  await setup.t.resolveControlOwner()
  await settle()
  await setup.t.takeOver()
  assert.equal(server.calls.length, 0)
  assert.match(setup.t.$control.get().ownerError, /Couldn't list the gateways/)
})

test('R1-05: a tool call from another gateway with the same bot name does not wake the pane', async () => {
  const server = fakeRemoteCua()
  const { t, registered } = await remoteSetup(server)
  assert.equal(t.handleToolStart(toolStart('computer_use', { connectionId: 'conn-unrelated' }), 5_000_000), false)
  assert.equal(registered.length, 0)
  assert.equal(t.handleToolStart(toolStart('computer_use', { connectionId: 'conn-mini' }), 5_000_000), true)
})

test('R1-05: the same bot name moving to another gateway hands the old lease back there', async () => {
  const server = fakeRemoteCua()
  const { t, context } = await heldByMe(server)
  context.__host.profileRoutes = () => [{ profile: 'ava', targetProfile: 'ava', connectionId: 'conn-other', mode: 'remote' }]
  // The other gateway has its own lease file: nobody holds it.
  const minis = context.hermesDesktop.api
  context.hermesDesktop.api = async request =>
    request.connectionId === 'conn-other' ? { ok: true, lease: AGENT_LEASE, configured: true, machine: MACHINE } : minis(request)
  await t.resolveControlOwner()
  await settle()
  const release = server.releases()[0]
  assert.equal(release.connectionId, 'conn-mini', 'released on the gateway it was taken on')
  assert.equal(t.$control.get().owner.connectionId, 'conn-other')
  assert.equal(t.controlLocked(), true)
})

test('R1-06: an embedded viewer page for a bot-driven computer gets no focus and no keys', async () => {
  const server = fakeRemoteCua()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes: AVA_ROUTE })
  const ep = setup.t.normalizeEndpoint({ ...setup.ep, mode: 'iframe', iframeUrl: 'http://127.0.0.1:6080/vnc.html' })
  setup.ctx.storage.set('endpoints', [ep])
  setup.t.$settings.set({ ...setup.t.$settings.get(), endpoints: [ep] })
  setup.t.syncControlTarget()
  await settle()
  const frame = setup.t.ensureIframeEl()
  let blurred = 0
  frame.blur = () => {
    blurred += 1
  }
  setup.context.document.activeElement = frame
  setup.t.$ui.set({ ...setup.t.$ui.get(), expanded: true })
  setup.t.syncSurfacePointer()
  assert.equal(frame.inert, true)
  assert.equal(frame.getAttribute('inert'), '')
  assert.equal(frame.getAttribute('tabindex'), '-1')
  assert.equal(frame.style.pointerEvents, 'none')
  assert.ok(blurred >= 1, 'focus inside the page is taken back')
  const view = setup.t.controlView(setup.t.$control.get(), setup.t.control.viewerId)
  assert.equal(view.canTakeOver, false)
  await setup.t.takeOver()
  assert.equal(server.takes().length, 0)
})

test('R1-06: a probe that falls back to an embedded page is fenced too', async () => {
  const server = fakeRemoteCua()
  const setup = await remoteSetup(server)
  // The live engine endpoint switched to iframe (probe fallback) while settings still say websocket.
  setup.t.engine.endpoint = setup.t.normalizeEndpoint({ ...setup.ep, mode: 'iframe', iframeUrl: 'http://127.0.0.1:6080/vnc.html' })
  setup.t.syncControlTarget()
  const frame = setup.t.ensureIframeEl()
  setup.t.syncSurfacePointer()
  assert.equal(frame.inert, true)
  assert.equal(setup.t.controlView(setup.t.$control.get(), setup.t.control.viewerId).canTakeOver, false)
})

test('R1-06: an ordinary (not bot-driven) embedded page keeps its input', () => {
  const setup = boundSetup({ remoteCua: false })
  const frame = setup.t.ensureIframeEl()
  setup.t.$ui.set({ ...setup.t.$ui.get(), expanded: true })
  setup.t.syncSurfacePointer()
  assert.notEqual(frame.inert, true)
  assert.equal(frame.style.pointerEvents, 'auto')
})

// ---------------------------------------------------------------------------
// Review round 2 regressions (each fails on 8187d82). The invariant checked
// throughout: this window sends input only while the SERVER's lease names it.
// ---------------------------------------------------------------------------

function assertInputMatchesServer(t, server, instances, label) {
  const serverSaysMe = server.lease.holder === 'human' && server.lease.viewer === t.control.viewerId
  // The pane's control state agrees with the server, and the real RFB never
  // takes input the server has not granted (collapsed panes stay view-only).
  assert.equal(t.controlView(t.$control.get(), t.control.viewerId).inputEnabled, serverSaysMe, `${label}: control state`)
  if (!serverSaysMe) assert.equal(lastRfb(instances).viewOnly, true, `${label}: input on only while the server lease is ours`)
}

test('R2-01: a close-release that commits late cannot undo the next Take over', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await heldByMe(server)
  t.showPane()
  const slow = server.hold('release', { beforeCommit: true })
  t.hidePane()
  await settle()
  t.showPane()
  const taking = t.takeOver()
  await settle()
  assert.equal(lastRfb(instances).viewOnly, true, 'no input while the old release is outstanding')
  slow.deliver()
  await taking
  await settle()
  assert.equal(server.lease.holder, 'human')
  assert.equal(server.lease.viewer, t.control.viewerId)
  assertInputMatchesServer(t, server, instances, 'after the retake')
  assert.equal(lastRfb(instances).viewOnly, false, 'the retake does drive the machine')
  const calls = server.calls.filter(c => c.method === 'POST').map(c => c.path.split('/').pop())
  assert.deepEqual(calls.slice(-2), ['release', 'take'], 'the release reached the server before the new take')
})

test('R2-01: an abandoned-take cleanup that commits late cannot undo the next Take over', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await remoteSetup(server)
  t.showPane()
  const held = server.hold('take')
  const first = t.takeOver()
  await settle()
  const slow = server.hold('release', { beforeCommit: true })
  t.hidePane()
  held.deliver()
  await first
  await settle()
  t.showPane()
  const second = t.takeOver()
  await settle()
  slow.deliver()
  await second
  await settle()
  assertInputMatchesServer(t, server, instances, 'after the second take')
  assert.equal(server.lease.holder, 'human')
})

test('R2-02: the focused chat\'s owner picks the gateway, not the active socket', async () => {
  const server = fakeRemoteCua()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes: TWO_AVAS })
  setup.context.__host.state.connectionId = atom('conn-a')
  setup.context.__host.state.focusedSessionOwner = atom({ connectionId: 'conn-b', profile: 'ava' })
  await setup.t.resolveControlOwner()
  await setup.t.takeOver()
  assert.ok(server.takes().length === 1)
  for (const call of server.calls) assert.equal(call.connectionId, 'conn-b')
  // A tool call on the socket's gateway is another bot: no wake.
  assert.equal(setup.t.handleToolStart(toolStart('computer_use', { connectionId: 'conn-a' }), 9_000_000), false)
  assert.equal(setup.t.handleToolStart(toolStart('computer_use', { connectionId: 'conn-b' }), 9_000_000), true)
})

test('R2-02: with no provable focused owner, two same-name gateways fail closed even if the socket says one', async () => {
  const server = fakeRemoteCua()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes: TWO_AVAS })
  setup.context.__host.state.connectionId = atom('conn-a')
  setup.context.__host.state.focusedSessionOwner = atom(null)
  await setup.t.resolveControlOwner()
  await setup.t.takeOver()
  assert.equal(server.calls.length, 0)
  assert.match(setup.t.$control.get().ownerError, /More than one gateway/)
})

test('R2-02: focus moving to the same bot name on another gateway during a Take over releases on the first', async () => {
  const server = fakeRemoteCua()
  const owner = atom({ connectionId: 'conn-b', profile: 'ava' })
  // conn-a has its own lease file, which nobody holds.
  const api = async request =>
    request.connectionId === 'conn-a' && request.path.endsWith('/lease')
      ? { ok: true, lease: AGENT_LEASE, configured: true, machine: MACHINE }
      : server.api(request)
  const setup = boundSetup({ remoteCua: true, api, routes: TWO_AVAS })
  setup.context.__host.state.focusedSessionOwner = owner
  await setup.t.resolveControlOwner()
  const held = server.hold('take')
  const taking = setup.t.takeOver()
  await settle()
  owner.set({ connectionId: 'conn-a', profile: 'ava' })
  await setup.t.resolveControlOwner()
  held.deliver()
  await taking
  await settle()
  const releases = server.releases()
  assert.equal(releases.length, 1)
  assert.equal(releases[0].connectionId, 'conn-b')
  assert.equal(setup.t.$control.get().owner.connectionId, 'conn-a')
  assert.equal(setup.t.controlLocked(), true)
})

test('R2-03: a Take over whose answer was lost is handed back when the pane closes', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server)
  t.showPane()
  const lost = server.hold('take')
  const taking = t.takeOver()
  await settle()
  lost.fail(new Error('connection lost after take committed'))
  await taking
  assert.equal(server.takes().length, 1, 'the take reached the server')
  t.hidePane()
  await settle()
  assert.equal(server.lease.holder, 'agent')
  assert.ok(server.releases().length >= 1)
})

test('R2-03: the same, closed with Disconnect, and reconciled first', async () => {
  const server = fakeRemoteCua()
  const { t, instances } = await remoteSetup(server)
  const lost = server.hold('take')
  const taking = t.takeOver()
  await settle()
  lost.fail(new Error('connection lost after take committed'))
  await taking
  await settle()
  // The reconciling read found the grant: shown as ours, input matches the server.
  assertInputMatchesServer(t, server, instances, 'after reconciling')
  t.userDisconnect()
  await settle()
  assert.equal(server.lease.holder, 'agent')
})

test('R2-03: a definitive refusal is not treated as a possible hold', async () => {
  const server = fakeRemoteCua({ lease: { holder: 'human', viewer: 'cv-other', since: 1, epoch: 4 } })
  const { t } = await remoteSetup(server)
  await t.takeOver()
  t.hidePane()
  await settle()
  assert.equal(server.releases().length, 0, 'a 409 proved nothing was taken')
})

test('R2-04: removing the binding of a held computer that stays the global default hands it back', async () => {
  const server = fakeRemoteCua()
  const { t, ep } = await heldByMe(server)
  const settings = t.$settings.get()
  assert.equal(settings.globalEndpointId, ep.id)
  t.$settings.set({ ...settings, perBotEndpoint: {} })
  await settle()
  assert.equal(server.lease.holder, 'agent')
  assert.equal(t.$control.get().bound, false)
  t.hidePane()
  await settle()
  assert.equal(server.releases().length, 1)
})

test('R2-04: unbinding during a pending Take over hands the late grant back', async () => {
  const server = fakeRemoteCua()
  const { t } = await remoteSetup(server)
  const held = server.hold('take')
  const taking = t.takeOver()
  await settle()
  t.$settings.set({ ...t.$settings.get(), perBotEndpoint: {} })
  held.deliver()
  await taking
  await settle()
  assert.equal(server.lease.holder, 'agent')
})

test('R2-04: a held computer turning watch-only (embedded page) is handed back', async () => {
  const server = fakeRemoteCua()
  const { t, ep } = await heldByMe(server)
  const page = t.normalizeEndpoint({ ...ep, mode: 'iframe', iframeUrl: 'http://127.0.0.1:6080/vnc.html' })
  t.$settings.set({ ...t.$settings.get(), endpoints: [page] })
  await settle()
  assert.equal(server.lease.holder, 'agent')
  assert.equal(t.controlLocked(), true)
})

test('R2: a cleanup whose answer is lost is retried until the server says it is not ours', async () => {
  const server = fakeRemoteCua()
  const { t, ctx } = await heldByMe(server)
  const timers = []
  ctx.setTimeout = (fn, ms) => {
    timers.push({ fn, ms })
    return () => {}
  }
  const first = server.hold('release', { beforeCommit: true })
  t.hidePane()
  await settle()
  first.fail(new Error('connection lost before POST'))
  await settle()
  assert.equal(server.lease.holder, 'human')
  assert.equal(timers.length, 1, 'a retry is scheduled')
  timers[0].fn()
  await settle()
  assert.equal(server.lease.holder, 'agent')
})

// ---------------------------------------------------------------------------
// Review round 3 regressions (each fails on 9f4bd96).
// ---------------------------------------------------------------------------

/** profileRoutes() whose answers the test hands out one at a time. */
function parkedRoutes() {
  const waiting = []
  const fn = () =>
    new Promise(resolve => {
      waiting.push(resolve)
    })
  fn.waiting = waiting
  fn.answerNext = routes => waiting.shift()(routes)
  return fn
}

test('R3-01: focus moving to the same bot name on another gateway fences at once; Take over cannot reach the old one', async () => {
  const server = fakeRemoteCua()
  const focused = atom({ connectionId: 'conn-a', profile: 'ava' })
  const routes = parkedRoutes()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes, state: { focusedSessionOwner: focused } })
  routes.answerNext(TWO_AVAS)
  await settle()
  assert.equal(setup.t.$control.get().owner.connectionId, 'conn-a')
  // Focus moves; its lookup is held.
  focused.set({ connectionId: 'conn-b', profile: 'ava' })
  assert.equal(setup.t.$control.get().owner, null, 'the old owner is dropped synchronously')
  assert.equal(setup.t.controlView(setup.t.$control.get(), setup.t.control.viewerId).canTakeOver, false)
  await setup.t.takeOver()
  assert.equal(server.takes().length, 0, 'no take goes anywhere while the owner is unknown')
  routes.answerNext(TWO_AVAS)
  await settle()
  await setup.t.takeOver()
  assert.deepEqual(server.takes().map(c => c.connectionId), ['conn-b'])
})

test('R3-01: an older owner lookup that lands last cannot replace the newer owner', async () => {
  const server = fakeRemoteCua()
  const focused = atom({ connectionId: 'conn-a', profile: 'ava' })
  const routes = parkedRoutes()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes, state: { focusedSessionOwner: focused } })
  // Lookup 1 (focus A) is parked; focus moves to B and lookup 2 answers first.
  focused.set({ connectionId: 'conn-b', profile: 'ava' })
  assert.equal(routes.waiting.length, 2)
  routes.waiting[1](TWO_AVAS)
  await settle()
  routes.waiting[0](TWO_AVAS)
  await settle()
  assert.equal(setup.t.$control.get().owner.connectionId, 'conn-b')
  await setup.t.takeOver()
  assert.deepEqual(server.takes().map(c => c.connectionId), ['conn-b'])
})

test('R3-01: an owner lookup that lands after the plugin is disposed does nothing', async () => {
  const server = fakeRemoteCua()
  const routes = parkedRoutes()
  const setup = boundSetup({ remoteCua: true, api: server.api, routes })
  setup.t.showPane()
  for (const dispose of setup.ctx.disposers) dispose()
  const intervalsBefore = setup.ctx.intervals.length
  const callsBefore = server.calls.length
  routes.answerNext(AVA_ROUTE)
  await settle()
  assert.equal(setup.ctx.intervals.length, intervalsBefore, 'no poll re-armed')
  assert.equal(setup.t.control.pollStop, null)
  assert.equal(server.calls.length, callsBefore, 'no status or lease request')
  assert.equal(setup.t.$control.get().owner, null)
})

/** A transport that times out on the next release while the server still
 *  runs it: the commit happens when the test says so. */
function timeoutThenLateCommit(context, server) {
  const late = []
  let armed = true
  const real = context.hermesDesktop.api
  context.hermesDesktop.api = async request => {
    if (armed && request.method === 'POST' && request.path.endsWith('/release')) {
      armed = false
      late.push(() => {
        try {
          return server.api.answer(request)
        } catch (error) {
          return error
        }
      })
      throw new Error('request timed out')
    }
    return real(request)
  }
  return late
}

test('R3-02: a timed-out release that commits later cannot revoke the next Take over', async () => {
  const server = fakeRemoteCua()
  const { t, ctx, context, instances } = await heldByMe(server)
  const firstId = t.control.viewerId
  t.showPane()
  const late = timeoutThenLateCommit(context, server)
  t.hidePane()
  await settle()
  assert.equal(server.lease.viewer, firstId, 'the release has not committed')
  t.showPane()
  await t.takeOver()
  await settle()
  // The retake was refused while an old id of ours still holds it.
  assert.equal(lastRfb(instances).viewOnly, true)
  assertInputMatchesServer(t, server, instances, 'before the late commit')
  // The old release commits now.
  late[0]()
  await settle()
  assert.equal(server.lease.holder, 'agent')
  assertInputMatchesServer(t, server, instances, 'after the late commit')
  // The next poll shows it free.
  await t.refreshLease()
  assert.equal(t.controlView(t.$control.get(), t.control.viewerId).chip, 'Bot is in control')
  // Take over again: granted to a NEW id, which no old release can clear.
  await t.takeOver()
  await settle()
  assert.notEqual(t.control.viewerId, firstId)
  assert.equal(server.lease.viewer, t.control.viewerId)
  assert.equal(lastRfb(instances).viewOnly, false)
  // Every scheduled retry for the old id runs: none of them touches the new grant.
  while (ctx.timeouts.length) ctx.timeouts.shift().fn()
  await settle()
  assert.equal(server.lease.viewer, t.control.viewerId)
  assertInputMatchesServer(t, server, instances, 'after the retries')
})

test('R3-02: a stale release landing AFTER the new grant is refused by the server, input stays correct', async () => {
  const server = fakeRemoteCua()
  const { t, ctx, context, instances } = await heldByMe(server)
  t.showPane()
  const late = timeoutThenLateCommit(context, server)
  t.hidePane()
  await settle()
  // A retry gets through and hands the old id back.
  ctx.timeouts.shift().fn()
  await settle()
  assert.equal(server.lease.holder, 'agent')
  t.showPane()
  await t.takeOver()
  await settle()
  const grant = { ...server.lease }
  assert.equal(grant.viewer, t.control.viewerId)
  assert.equal(lastRfb(instances).viewOnly, false)
  // Now the timed-out release finally runs on the server.
  const result = late[0]()
  assert.match(String(result && result.message), /^409: .*not_holder/)
  assert.deepEqual(plain(server.lease), plain(grant))
  await t.refreshLease()
  assertInputMatchesServer(t, server, instances, 'after the stale release')
  assert.equal(lastRfb(instances).viewOnly, false)
})
