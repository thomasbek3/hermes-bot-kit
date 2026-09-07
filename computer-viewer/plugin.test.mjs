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

function loadPlugin({ fetchImpl, importHook, hermesDesktop } = {}) {
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
    setTimeout,
    undefined,
    document: {
      body: { classList: { add() {}, contains: () => false, remove() {} } },
      createElement: () => ({
        setAttribute() {},
        getAttribute: () => null,
        style: {},
        addEventListener() {}
      }),
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
        '\nglobalThis.__t = { credentialTargetAllowed, iframePolicy, classifyAddress, orgoApiOrigin, authFetch, rfbSourceOrder, loadRFB, rfbStatusDetail, engine }\n'
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

function fakeBridge({ text, missing } = {}) {
  const source = text === undefined ? VENDOR_RFB_SOURCE : text
  return {
    desktopPluginsRoot: async () => '/tmp/hermes-home/desktop-plugins',
    readPluginSource: async filePath => {
      // Drift guard: the plugin must look exactly where the installer puts the
      // file, i.e. the manifest's relative path under desktop-plugins.
      const manifestRel = fs
        .readFileSync(new URL('../scripts/manifest-files.txt', import.meta.url), 'utf8')
        .split('\n')
        .find(line => line.endsWith('novnc-rfb.mjs'))
      assert.equal(filePath, '/tmp/hermes-home/desktop-plugins/' + manifestRel)
      if (missing) throw new Error('ENOENT')
      return {
        binary: false,
        byteSize: Buffer.byteLength(source),
        text: source,
        truncated: false
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
  assert.equal(t.engine.rfbSource, 'vendored')
  assert.equal(t.engine.rfbVendoredReason, null)
})

test('loadRFB skips a vendored file that fails the SHA-256 check and falls back to CDN', async () => {
  const seen = []
  const flipped = (VENDOR_RFB_SOURCE[0] === 'x' ? 'y' : 'x') + VENDOR_RFB_SOURCE.slice(1)
  const { t } = loadPlugin({
    hermesDesktop: fakeBridge({ text: flipped }),
    importHook: cdnCtorHook(seen)
  })
  const ctor = await t.loadRFB()
  assert.equal(typeof ctor, 'function')
  assert.equal(seen.includes(JSDELIVR), true)
  assert.equal(
    seen.some(url => typeof url === 'string' && url.startsWith('blob:')),
    false
  )
  assert.equal(t.engine.rfbSource, 'cdn-jsdelivr')
  assert.equal(t.engine.rfbVendoredReason, 'integrity')
  assert.equal(t.rfbStatusDetail(), 'vendored noVNC failed integrity check; loaded from CDN')
})

test('loadRFB falls back to CDN when window.hermesDesktop is missing', async () => {
  const seen = []
  const { t } = loadPlugin({
    importHook: cdnCtorHook(seen)
  })
  const ctor = await t.loadRFB()
  assert.equal(typeof ctor, 'function')
  assert.deepEqual(seen, [JSDELIVR])
  assert.equal(t.engine.rfbSource, 'cdn-jsdelivr')
  assert.equal(t.engine.rfbVendoredReason, 'no-bridge')
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
