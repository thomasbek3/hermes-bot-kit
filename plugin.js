import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  Input,
  KEYBINDS_AREA,
  Loader,
  PALETTE_AREA,
  PANES_AREA,
  STATUSBAR_AREAS,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  StatusDot,
  Switch,
  Tip,
  atom,
  cn,
  host,
  icons,
  useValue
} from '@hermes/plugin-sdk'
import * as HermesSdk from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'computer-viewer'
const PANE_CONTRIB_ID = 'computer-viewer:pane'
const NOVNC_URL = 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0/+esm'
const NOVNC_FALLBACK_URL = 'https://esm.sh/@novnc/novnc@1.7.0'
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
const CHROME_IDLE_MS = 2000
/** Remote XFCE panel height in framebuffer pixels. Thumbnail crop uses this
 *  as a fixed strip, capped at 12% of fb height (Korgo SCREEN_PANEL_PX). */
const SCREEN_PANEL_PX = 28
const PASSWORD_CAVEAT =
  'Stored locally in plugin storage (plain text). Prefer token-in-URL or session endpoints for anything sensitive.'
const MIXED_CONTENT_HINT = 'Insecure ws:// to a public host will likely be blocked. Use wss://.'
const RAW_REPO_URL = 'https://raw.githubusercontent.com/thomasbek3/hermes-computer-viewer/master'
const SNAPSHOT_CAP = 8
const HIPERF_BACKOFF_MS = [2000, 4000, 8000]
const HIPERF_IDLE = { phase: 'off', code: null, fps: 0, mbps: 0, rtt: 0, url: '' }
const HIPERF_LINES = {
  'webcodecs-unsupported': 'HD mode needs WebCodecs (not available in this build) — using VNC.',
  'codec-unsupported': "This machine can't decode the host's H.264 profile — using VNC.",
  'hiperf-auth': 'HD stream rejected the token — check endpoint settings. Using VNC.',
  superseded: 'HD stream taken by another viewer — using VNC.',
  'hiperf-unreachable': 'HD agent not reachable on {hiperfUrl} — using VNC.',
  'resolution-mismatch': "HD stream resolution doesn't match VNC — using VNC.",
  'capture-failed': 'HD capture failed on the host (permissions?) — using VNC.',
  'decode-failed': 'HD unavailable — using VNC.',
  'ffmpeg-died': 'HD stream failed (ffmpeg-died) — using VNC.',
  'no-encoder': 'HD stream failed (no-encoder) — using VNC.',
  'mixed-public': MIXED_CONTENT_HINT
}

const KIND_OPTIONS = [
  { id: 'cloud', label: 'Cloud' },
  { id: 'local', label: 'Local' }
]

const OS_OPTIONS = [
  { id: 'mac', label: 'Mac' },
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' }
]

const ERRORS = {
  unconfigured: {
    title: 'No computer endpoint',
    body: 'Add a VNC endpoint to see a live desktop here.'
  },
  'cdn-blocked': {
    title: "Couldn't load the viewer",
    body: "noVNC couldn't be fetched from the CDN (network or CSP). Switch this endpoint to iframe mode, or check your connection."
  },
  'mixed-content': {
    title: 'Blocked insecure connection',
    body: 'ws:// to a public host is blocked. Use wss:// (TLS) or a localhost/Tailscale address.'
  },
  'password-required': {
    title: 'Password required',
    body: 'This server asked for a VNC password. Add it in endpoint settings.'
  },
  'vnc-auth-failed': {
    title: 'Authentication failed',
    body: ''
  },
  'session-failed': {
    title: 'Session request failed',
    body: 'GET {sessionUrl} → HTTP {status}.'
  },
  unreachable: {
    title: "Can't reach the computer",
    body: 'Gave up after 5 attempts. Check that the endpoint is up ({wsUrl}).'
  }
}

const MODE_OPTIONS = [
  { id: 'websocket', label: 'WebSocket' },
  { id: 'iframe', label: 'Iframe' },
  { id: 'session-json', label: 'Session JSON' }
]

const SCALE_OPTIONS = [
  { id: 'fit', label: 'Fit' },
  { id: 'native', label: 'Native' }
]

const IDLE_STATE = {
  phase: 'idle',
  code: null,
  detail: null,
  desktopName: null,
  fbW: 0,
  fbH: 0,
  attempt: 0
}

function el(type, props, ...kids) {
  const hasKey = props != null && Object.prototype.hasOwnProperty.call(props, 'key')
  const key = hasKey ? props.key : undefined
  const next = props == null ? {} : { ...props }
  if (hasKey) delete next.key
  const children = []
  for (const kid of kids) {
    if (kid == null || kid === false) continue
    if (Array.isArray(kid)) {
      for (const item of kid) {
        if (item != null && item !== false) children.push(item)
      }
    } else {
      children.push(kid)
    }
  }
  if (children.length === 1) next.children = children[0]
  else if (children.length > 1) next.children = children
  if (children.length > 1) return key === undefined ? jsxs(type, next) : jsxs(type, next, key)
  return key === undefined ? jsx(type, next) : jsx(type, next, key)
}

function getSdkPortal() {
  return typeof HermesSdk.createPortal === 'function' ? HermesSdk.createPortal : null
}

function measureTitlebarHeight() {
  const selectors = ['[data-titlebar]', 'header[class*="titlebar" i]', '[class*="titlebar" i]']
  let best = null
  for (const sel of selectors) {
    let nodes
    try {
      nodes = document.querySelectorAll(sel)
    } catch (_) {
      continue
    }
    for (const node of nodes) {
      if (!node || typeof node.getBoundingClientRect !== 'function') continue
      const rect = node.getBoundingClientRect()
      if (rect.top > 2) continue
      if (rect.height < 20 || rect.height > 60) continue
      if (!best || rect.height < best.height) best = rect
    }
  }
  return best ? best.bottom : 40
}

function svgDiagonalArrows(inward, className) {
  return el(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className,
      'aria-hidden': true
    },
    inward
      ? [
          el('polyline', { points: '4 14 10 14 10 20' }),
          el('polyline', { points: '20 10 14 10 14 4' }),
          el('line', { x1: 14, x2: 21, y1: 10, y2: 3 }),
          el('line', { x1: 3, x2: 10, y1: 21, y2: 14 })
        ]
      : [
          el('polyline', { points: '15 3 21 3 21 9' }),
          el('polyline', { points: '9 21 3 21 3 15' }),
          el('line', { x1: 21, x2: 14, y1: 3, y2: 10 }),
          el('line', { x1: 3, x2: 10, y1: 21, y2: 14 })
        ]
  )
}

function collapseArrowsIcon() {
  const Icon = icons.Minimize2 || icons.Shrink
  if (Icon) return el(Icon, { className: 'size-4', 'aria-hidden': true })
  return svgDiagonalArrows(true, 'size-4')
}

function expandArrowsIcon() {
  const Icon = icons.Maximize2 || icons.Expand
  if (Icon) return el(Icon, { className: 'size-3.5', 'aria-hidden': true })
  return svgDiagonalArrows(false, 'size-3.5')
}

function newId() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function isTailscaleIpv4(hostName) {
  const octets = hostName.split('.').map(Number)
  return (
    octets.length === 4 &&
    octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    octets[1] >= 64 &&
    octets[1] <= 127
  )
}

function isPrivateIpv4(hostName) {
  const octets = String(hostName || '').split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false
  }
  if (octets[0] === 10) return true
  if (octets[0] === 192 && octets[1] === 168) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  if (octets[0] === 169 && octets[1] === 254) return true
  return isTailscaleIpv4(hostName)
}

function isPrivateWsHost(hostName) {
  const host = String(hostName || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  if (host.endsWith('.ts.net') || host.endsWith('.local') || host.endsWith('.localhost')) return true
  return isPrivateIpv4(host)
}

function isInsecurePublicWs(wsUrl) {
  if (!wsUrl || !String(wsUrl).startsWith('ws://')) return false
  try {
    return !isPrivateWsHost(new URL(wsUrl).hostname)
  } catch {
    return true
  }
}

const DEFAULT_ENDPOINT_NAME = 'My computer'
const ADDRESS_EMPTY_HELP =
  "Works with a wss:// address, a noVNC web page, a cloud API key, or just host:port — paste it and I'll figure out which."
const ADDRESS_INVALID_LINE = "Hmm — that doesn't look like an address or key."
const SK_KEY_RE = /^sk[_-][A-Za-z0-9_-]{8,}$/

function isDefaultishName(name) {
  const n = String(name || '').trim()
  return n === '' || n === DEFAULT_ENDPOINT_NAME || n === 'Local box' || n === 'Untitled'
}

function formatHostForUrl(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '')
  return h.includes(':') ? `[${h}]` : h
}

function isPlausibleHostname(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!h || h.length > 253) return false
  if (h === 'localhost' || h === '::1') return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) {
    return h.split('.').every(part => {
      const n = Number(part)
      return Number.isInteger(n) && n >= 0 && n <= 255
    })
  }
  if (/^[0-9a-f:]+$/.test(h) && h.includes(':')) return true
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/.test(h)
}

function parseHostPort(value) {
  const text = String(value || '').trim()
  if (!text || /[\s/\\@?#]/.test(text)) return null
  let host = ''
  let portStr = ''
  const bracketed = /^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/.exec(text)
  if (bracketed) {
    host = bracketed[1]
    portStr = bracketed[2] || ''
  } else if ((text.match(/:/g) || []).length > 1) {
    if (/^[0-9a-fA-F:]+$/.test(text)) host = text
    else return null
  } else {
    const colon = text.lastIndexOf(':')
    if (colon > 0 && /^\d{1,5}$/.test(text.slice(colon + 1))) {
      host = text.slice(0, colon)
      portStr = text.slice(colon + 1)
    } else if (colon === -1) {
      host = text
    } else {
      return null
    }
  }
  if (!isPlausibleHostname(host)) return null
  const port = portStr ? Number(portStr) : 6080
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function probeUrlsFromHostPort(parsed) {
  const host = formatHostForUrl(parsed.host)
  const scheme = isPrivateWsHost(parsed.host) ? 'ws' : 'wss'
  return {
    wsUrl: `${scheme}://${host}:${parsed.port}/websockify`,
    iframeUrl: `http://${host}:${parsed.port}/vnc.html`
  }
}

function looksLikeApiKey(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (SK_KEY_RE.test(text)) return true
  if (text.length < 16) return false
  if (/[./\\:@]/.test(text)) return false
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return false
  return /[A-Za-z]/.test(text) && /[0-9]/.test(text)
}

function isNovncPageUrl(href) {
  let parsed
  try {
    parsed = new URL(String(href || '').trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const path = parsed.pathname || '/'
  if (/vnc\.html/i.test(path) || /vnc_lite\.html/i.test(path)) return true
  const withoutQuery = `${parsed.origin}${path}`
  if (/:\d+\/$/.test(withoutQuery)) return true
  if ((path === '/' || path === '') && parsed.port) return true
  return false
}

function classifyAddress(raw) {
  const address = String(raw || '').trim()
  if (!address) {
    return { kind: 'empty', line: ADDRESS_EMPTY_HELP, connectEnabled: false, patch: { probe: false } }
  }
  const lower = address.toLowerCase()
  if (lower.startsWith('ws://') || lower.startsWith('wss://')) {
    return {
      kind: 'websocket',
      line: '✓ VNC address — ready to connect',
      connectEnabled: true,
      patch: { mode: 'websocket', wsUrl: address, probe: false }
    }
  }
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    try {
      const parsed = new URL(address)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { kind: 'invalid', line: ADDRESS_INVALID_LINE, connectEnabled: false, patch: { probe: false } }
      }
    } catch {
      return { kind: 'invalid', line: ADDRESS_INVALID_LINE, connectEnabled: false, patch: { probe: false } }
    }
    if (isNovncPageUrl(address)) {
      return {
        kind: 'iframe',
        line: '✓ Web viewer page — will be embedded',
        connectEnabled: true,
        patch: { mode: 'iframe', iframeUrl: address, probe: false }
      }
    }
    return {
      kind: 'session-json',
      line: "✓ API address — I'll fetch the connection from it",
      connectEnabled: true,
      patch: { mode: 'session-json', sessionUrl: address, probe: false }
    }
  }
  if (looksLikeApiKey(address)) {
    return {
      kind: 'api-key',
      line: "✓ API key — I'll find your computers",
      connectEnabled: true,
      patch: { mode: 'session-json', sessionBearer: address, probe: false }
    }
  }
  const hostPort = parseHostPort(address)
  if (hostPort) {
    const urls = probeUrlsFromHostPort(hostPort)
    return {
      kind: 'probe',
      line: "I'll probe this and figure out the connection",
      connectEnabled: true,
      patch: { mode: 'websocket', wsUrl: urls.wsUrl, iframeUrl: urls.iframeUrl, probe: true }
    }
  }
  return { kind: 'invalid', line: ADDRESS_INVALID_LINE, connectEnabled: false, patch: { probe: false } }
}

function withClassifiedAddress(draft, address) {
  const classified = classifyAddress(address)
  return { ...draft, address, ...classified.patch }
}

function synthesizeAddress(raw) {
  const stored = raw && raw.address != null ? String(raw.address) : ''
  if (stored.trim()) return stored
  const mode = raw && (raw.mode === 'iframe' || raw.mode === 'session-json') ? raw.mode : 'websocket'
  if (mode === 'iframe') return String((raw && raw.iframeUrl) || '')
  if (mode === 'session-json') return String((raw && raw.sessionUrl) || '')
  return String((raw && raw.wsUrl) || '')
}

function rfbConstructorCredentials(username, password) {
  const user = String(username || '')
  const pass = String(password || '')
  if (user) return { username: user, password: pass }
  if (pass) return { password: pass }
  return undefined
}

function isProbeEndpoint(endpoint) {
  return Boolean(endpoint && endpoint.probe)
}

function blankEndpoint() {
  return {
    id: newId(),
    name: DEFAULT_ENDPOINT_NAME,
    address: '',
    mode: 'websocket',
    wsUrl: '',
    iframeUrl: '',
    sessionUrl: '',
    sessionBearer: '',
    username: '',
    password: '',
    probe: false,
    viewOnlyDefault: false,
    scaleMode: 'fit',
    autoConnect: true,
    cropPanel: false,
    qualityLevel: 7,
    compressionLevel: 2,
    hiperfEnabled: false,
    hiperfUrl: '',
    hiperfToken: ''
  }
}

function normalizeEndpoint(raw) {
  if (!raw || typeof raw !== 'object') return null
  const mode = raw.mode === 'iframe' || raw.mode === 'session-json' ? raw.mode : 'websocket'
  return {
    id: String(raw.id || newId()),
    name: String(raw.name || 'Untitled'),
    address: synthesizeAddress(raw),
    mode,
    wsUrl: String(raw.wsUrl || ''),
    iframeUrl: String(raw.iframeUrl || ''),
    sessionUrl: String(raw.sessionUrl || ''),
    sessionBearer: String(raw.sessionBearer || ''),
    username: String(raw.username || ''),
    password: String(raw.password || ''),
    probe: raw.probe === true,
    viewOnlyDefault: Boolean(raw.viewOnlyDefault),
    scaleMode: raw.scaleMode === 'native' ? 'native' : 'fit',
    autoConnect: raw.autoConnect !== false,
    cropPanel: raw.cropPanel === true,
    qualityLevel: clampInt(raw.qualityLevel, 0, 9, 7),
    compressionLevel: clampInt(raw.compressionLevel, 0, 9, 2),
    hiperfEnabled: raw.hiperfEnabled === true,
    hiperfUrl: String(raw.hiperfUrl || ''),
    hiperfToken: String(raw.hiperfToken || '')
  }
}

function fingerprint(endpoint) {
  if (!endpoint) return ''
  return [
    endpoint.id,
    endpoint.mode,
    endpoint.address || '',
    endpoint.wsUrl,
    endpoint.iframeUrl,
    endpoint.sessionUrl,
    endpoint.sessionBearer,
    endpoint.username || '',
    endpoint.password,
    endpoint.probe ? '1' : '0',
    endpoint.qualityLevel,
    endpoint.compressionLevel,
    endpoint.autoConnect ? '1' : '0'
  ].join('\0')
}

function unwrapSessionBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  for (const key of ['data', 'session', 'computer']) {
    const nested = value[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested
  }
  return value
}

// Orgo has no list-computers endpoint (GET /api/computers?workspace_id= → HTTP 405).
// Live list is { projects: [{ desktops: [...] }] }. Docs still describe { workspaces }
// plus GET /api/workspaces/{id}; that detail route takes a project id and 404s on a desktop id.

const ORGO_INSTANCE_ID_RE = /^[a-zA-Z0-9-]+$/
const ORGO_WORKSPACE_KEYS = ['projects', 'workspaces', 'data', 'items', 'results']
const ORGO_COMPUTER_KEYS = ['desktops', 'computers', 'data', 'items', 'results']

function orgoApiOrigin(sessionUrl) {
  try {
    const parsed = new URL(String(sessionUrl || '').trim())
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin
  } catch {
    /* not an absolute URL */
  }
  return 'https://www.orgo.ai'
}

function orgoShapeKeys(value) {
  if (Array.isArray(value)) return ['<array>']
  if (value && typeof value === 'object') return Object.keys(value)
  return []
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const text = value.trim()
      if (text) return text
    }
  }
  return ''
}

function uuidFromText(value) {
  const matches = String(value || '').match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  )
  return matches && matches.length ? matches[matches.length - 1] : ''
}

function instanceIdFromConnectionUrl(value) {
  if (value == null || value === '') return ''
  let last = ''
  try {
    const parts = new URL(String(value)).pathname.split('/').filter(Boolean)
    last = parts.length ? parts[parts.length - 1] : ''
  } catch {
    const parts = String(value).split('/').filter(Boolean)
    last = parts.length ? parts[parts.length - 1] : ''
  }
  last = String(last).trim()
  return ORGO_INSTANCE_ID_RE.test(last) ? last : ''
}

function orgoInstanceId(record, payload) {
  const bags = []
  if (record && typeof record === 'object') bags.push(record)
  if (payload && typeof payload === 'object' && payload !== record) bags.push(payload)
  for (const bag of bags) {
    for (const key of ['instance_id', 'instanceId', 'fly_instance_id', 'flyInstanceId']) {
      const candidate = typeof bag[key] === 'string' ? bag[key].trim() : ''
      if (candidate && ORGO_INSTANCE_ID_RE.test(candidate)) return candidate
    }
  }
  for (const bag of bags) {
    const derived = instanceIdFromConnectionUrl(bag.connection_url)
    if (derived) return derived
  }
  return ''
}

function unwrapNamedArray(value, keys) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key]
  }
  for (const key of keys) {
    const nested = value[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const inner of keys) {
        if (Array.isArray(nested[inner])) return nested[inner]
      }
    }
  }
  return []
}

function unwrapWorkspaceList(value) {
  return unwrapNamedArray(value, ORGO_WORKSPACE_KEYS).filter(
    item =>
      item && typeof item === 'object' && !Array.isArray(item) && item.id != null && String(item.id).trim() !== ''
  )
}

function computerArrayFrom(record) {
  if (!record || typeof record !== 'object') return null
  for (const key of ORGO_COMPUTER_KEYS) {
    if (Array.isArray(record[key])) return record[key]
  }
  return null
}

function computerArrayKey(record) {
  if (!record || typeof record !== 'object') return null
  for (const key of ORGO_COMPUTER_KEYS) {
    if (Array.isArray(record[key])) return key
  }
  return null
}

function computersFromArray(arr) {
  if (!Array.isArray(arr)) return []
  return arr.filter(
    item =>
      item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && item.id.trim() !== ''
  )
}

function extractComputers(body) {
  if (Array.isArray(body)) return computersFromArray(body)
  if (!body || typeof body !== 'object') return []
  const records = [body]
  for (const key of ['data', 'workspace', 'project']) {
    const nested = body[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) records.push(nested)
  }
  for (const record of records) {
    const arr = computerArrayFrom(record)
    if (arr) return computersFromArray(arr)
  }
  return []
}

function mapOrgoPick(computer, workspaceName) {
  const computerId = String(computer.id).trim()
  return {
    workspaceName: workspaceName || 'Workspace',
    computerId,
    computerName: String(computer.name || '').trim() || computerId,
    status: String(computer.status || '').trim() || 'unknown'
  }
}

function orgoDiscoverError(kind) {
  const err = new Error(kind)
  err.kind = kind
  return err
}

async function orgoFetchJson(url, headers) {
  let response
  try {
    response = await fetch(url, { headers })
  } catch {
    throw orgoDiscoverError('network')
  }
  if (response.status === 401 || response.status === 403) throw orgoDiscoverError('auth')
  if (!response.ok) throw orgoDiscoverError('network')
  try {
    return { status: response.status, body: await response.json() }
  } catch {
    throw orgoDiscoverError('network')
  }
}

async function orgoFetchJsonOptional(url, headers) {
  let response
  try {
    response = await fetch(url, { headers })
  } catch {
    return { ok: false, status: 'network', body: null }
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { ok: response.ok, status: response.status, body }
}

function pushOrgoComputers(computers, list, workspaceName) {
  for (const computer of computersFromArray(list)) {
    computers.push(mapOrgoPick(computer, workspaceName))
  }
}

async function discoverOrgoComputers(origin, bearer, sessionUrl) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${bearer}` }
  const listed = await orgoFetchJson(`${origin}/api/workspaces`, headers)
  const workspaces = unwrapWorkspaceList(listed.body)
  const workspaceCount = workspaces.length
  const computers = []
  const needingDetail = []
  const embedded = []

  for (const ws of workspaces) {
    const arr = computerArrayFrom(ws)
    const key = computerArrayKey(ws)
    if (arr) {
      embedded.push({ key, count: arr.length })
      const workspaceName =
        String((ws && ws.name) || '').trim() || String((ws && ws.project_name) || '').trim() || 'Workspace'
      pushOrgoComputers(computers, arr, workspaceName)
    } else {
      embedded.push({ key: null, count: 0 })
      needingDetail.push(ws)
    }
  }

  console.info('[computer-viewer] orgo discovery', {
    stage: 'list',
    status: listed.status,
    keys: orgoShapeKeys(listed.body),
    workspaceCount,
    firstWorkspaceKeys: workspaces[0] ? orgoShapeKeys(workspaces[0]) : [],
    embedded
  })

  const detailSlice = needingDetail.slice(0, 10)
  const details = await Promise.all(
    detailSlice.map(async ws => {
      const id = String(ws.id).trim()
      const result = await orgoFetchJsonOptional(`${origin}/api/workspaces/${encodeURIComponent(id)}`, headers)
      return { ws, result }
    })
  )

  for (const { ws, result } of details) {
    const body = result.body
    const extracted = extractComputers(body)
    console.info('[computer-viewer] orgo discovery', {
      stage: 'detail',
      status: result.status,
      keys: orgoShapeKeys(body),
      computerCount: extracted.length,
      computerKey:
        computerArrayKey(body) ||
        computerArrayKey(body && body.data) ||
        computerArrayKey(body && body.workspace)
    })
    if (!result.ok || body == null) continue
    const workspaceName =
      String((ws && ws.name) || '').trim() ||
      String((body && body.name) || '').trim() ||
      'Workspace'
    pushOrgoComputers(computers, extracted, workspaceName)
  }

  let uuidFallback = false
  let uuidFallbackStatus = null
  if (computers.length === 0) {
    const uuid = uuidFromText(sessionUrl)
    if (uuid) {
      uuidFallback = true
      const result = await orgoFetchJsonOptional(`${origin}/api/computers/${encodeURIComponent(uuid)}`, headers)
      uuidFallbackStatus = result.status
      const record = unwrapSessionBody(result.body)
      const id = record && typeof record.id === 'string' ? record.id.trim() : ''
      console.info('[computer-viewer] orgo discovery', {
        stage: 'uuid-fallback',
        status: result.status,
        keys: orgoShapeKeys(result.body),
        hasId: Boolean(id)
      })
      if (result.ok && id) {
        const workspaceName =
          String(record.project_name || record.projectName || '').trim() || 'Workspace'
        computers.push(mapOrgoPick(record, workspaceName))
      }
    }
  }

  console.info('[computer-viewer] orgo discovery', {
    stage: 'done',
    workspaceCount,
    computerCount: computers.length,
    detailFetches: detailSlice.length,
    uuidFallback,
    uuidFallbackStatus,
    statuses: computers.map(item => item.status)
  })

  return { computers, workspaceCount }
}

function hostnameOf(value) {
  if (value == null || value === '') return ''
  try {
    return String(new URL(String(value)).hostname || '').trim()
  } catch {
    return ''
  }
}

const NON_RUNNING_COMPUTER = {
  stopped: true,
  stopping: true,
  creating: true,
  starting: true,
  restarting: true,
  deleting: true,
  error: true
}

function errorTitle(code) {
  return (ERRORS[code] && ERRORS[code].title) || 'Connection error'
}

function toneFor(phase, attempt) {
  if (phase === 'connected') return 'good'
  if (phase === 'error') return 'bad'
  if (phase === 'connecting' || phase === 'resolving' || phase === 'loading-novnc') return 'warn'
  if (phase === 'disconnected' && attempt > 0) return 'warn'
  return 'muted'
}

function phaseLine(state) {
  switch (state.phase) {
    case 'unconfigured':
      return 'No endpoint selected'
    case 'idle':
      return 'Idle'
    case 'resolving':
      return 'Resolving session…'
    case 'loading-novnc':
      return 'Loading viewer…'
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return 'Connected'
    case 'disconnected':
      return state.detail || 'Disconnected'
    case 'error':
      return errorTitle(state.code)
    default:
      return state.phase
  }
}

function readProfileName() {
  try {
    const focused = host.state.focusedSessionProfile && host.state.focusedSessionProfile.get()
    if (focused) return focused
  } catch {
    /* older SDK */
  }
  try {
    return host.state.profile.get() || 'default'
  } catch {
    return 'default'
  }
}

// useValue (@nanostores/react useStore) calls store.get() then store.listen().
const $absent = atom(null)
const safeAtom = a =>
  a && typeof a.get === 'function' && typeof a.listen === 'function' ? a : $absent

const $settings = atom({
  endpoints: [],
  globalEndpointId: null,
  perBotEndpoint: {},
  ui: { lastExpanded: false }
})

const $ui = atom({
  expanded: false,
  settingsOpen: false,
  settingsIntent: 'list',
  highlightPassword: false,
  viewOnly: false,
  scaleMode: 'fit',
  chromeOn: true,
  overlayTop: 40
})

const $placeTick = atom(0)
const $hiperf = atom({ ...HIPERF_IDLE })

let RFB = null
let pluginCtx = null
const wsProtocolByEndpoint = new Map()
const lastFrameByEndpoint = new Map()
const $lastFrames = atom({})
/** In-memory only: explicit disconnect survives pane collapse, not app restart. */
const userDisconnectIds = new Set()

const engine = {
  state: atom({ ...IDLE_STATE }),
  rfb: null,
  generation: 0,
  surfaceEl: null,
  iframeEl: null,
  slotEl: null,
  overlayMountEl: null,
  overlayRootEl: null,
  canvasObserver: null,
  backoffTimer: null,
  chromeTimer: null,
  fetchAbort: null,
  reconnectAttempt: 0,
  paneVisible: false,
  currentEndpointId: null,
  endpoint: null,
  endpointFingerprint: '',
  resolvedWsUrl: '',
  appliedDefaultsFor: null,
  authLock: false,
  intentionalDisconnect: false
}

function bumpGen() {
  engine.generation += 1
  if (engine.fetchAbort) {
    try {
      engine.fetchAbort.abort()
    } catch {
      /* already aborted */
    }
    engine.fetchAbort = null
  }
  clearBackoff()
  return engine.generation
}

function still(gen) {
  return gen === engine.generation
}

function patchState(partial) {
  engine.state.set({ ...engine.state.get(), ...partial })
}

function setError(code, detail) {
  patchState({
    phase: 'error',
    code,
    detail: detail || (ERRORS[code] && ERRORS[code].body) || ''
  })
}

function clearBackoff() {
  if (engine.backoffTimer != null) {
    clearTimeout(engine.backoffTimer)
    engine.backoffTimer = null
  }
}

function bumpPlace() {
  $placeTick.set($placeTick.get() + 1)
}

function persistSettings(next) {
  $settings.set(next)
  if (!pluginCtx) return
  pluginCtx.storage.set('endpoints', next.endpoints)
  pluginCtx.storage.set('globalEndpointId', next.globalEndpointId)
  pluginCtx.storage.set('perBotEndpoint', next.perBotEndpoint)
  pluginCtx.storage.set('ui', next.ui)
}

function persistEndpointFields(endpoint) {
  if (!endpoint || !endpoint.id) return
  const next = normalizeEndpoint(endpoint)
  engine.endpoint = next
  engine.endpointFingerprint = fingerprint(next)
  const settings = $settings.get()
  const endpoints = settings.endpoints.map(item => (item.id === next.id ? next : item))
  persistSettings({ ...settings, endpoints })
}

function persistUiFlags(partial) {
  const cur = $settings.get()
  persistSettings({ ...cur, ui: { ...cur.ui, ...partial } })
}

function loadWsProtocolMap(ctx) {
  wsProtocolByEndpoint.clear()
  const raw = ctx.storage.get('wsProtocolByEndpoint', {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  for (const [id, variant] of Object.entries(raw)) {
    if (variant === 'none' || variant === 'binary') wsProtocolByEndpoint.set(id, variant)
  }
}

function rememberedWsProtocol(endpointId) {
  return wsProtocolByEndpoint.get(endpointId) === 'binary' ? 'binary' : 'none'
}

function otherWsProtocol(variant) {
  return variant === 'binary' ? 'none' : 'binary'
}

function persistWsProtocol(endpointId, variant) {
  if (!endpointId || (variant !== 'none' && variant !== 'binary')) return
  if (wsProtocolByEndpoint.get(endpointId) === variant) return
  wsProtocolByEndpoint.set(endpointId, variant)
  if (!pluginCtx) return
  pluginCtx.storage.set('wsProtocolByEndpoint', Object.fromEntries(wsProtocolByEndpoint))
}

function publishLastFrames() {
  $lastFrames.set(Object.fromEntries(lastFrameByEndpoint))
}

function storeLastFrame(endpointId, dataUrl) {
  if (!endpointId || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:') || dataUrl.length < 32) return
  if (lastFrameByEndpoint.has(endpointId)) lastFrameByEndpoint.delete(endpointId)
  lastFrameByEndpoint.set(endpointId, dataUrl)
  while (lastFrameByEndpoint.size > SNAPSHOT_CAP) {
    const oldest = lastFrameByEndpoint.keys().next().value
    lastFrameByEndpoint.delete(oldest)
  }
  publishLastFrames()
}

function rememberLastFrame(endpointId, rfb) {
  if (!endpointId) return
  const endpoint = engine.endpoint
  if (endpoint && endpoint.mode === 'iframe') return
  if (hiperfIsStreaming()) {
    const dataUrl = hiperfToDataURL()
    if (dataUrl) {
      storeLastFrame(endpointId, dataUrl)
      return
    }
  }
  const target = rfb || engine.rfb
  if (!target || typeof target.toDataURL !== 'function') return
  if (!rfb && engine.state.get().phase !== 'connected') return
  let dataUrl
  try {
    dataUrl = target.toDataURL()
  } catch {
    return
  }
  storeLastFrame(endpointId, dataUrl)
}

function loadSettingsFrom(ctx) {
  // First-run convenience seed (demo machines only): if this machine has
  // never saved any endpoint, offer the local bridge so the pane works out
  // of the box. Skipped entirely once the user has stored anything.
  const existing = ctx.storage.get('endpoints', [])
  if (!Array.isArray(existing) || existing.length === 0) {
    const seeded = [normalizeEndpoint({
      id: 'local-mac',
      name: 'This Mac',
      mode: 'websocket',
      wsUrl: 'ws://127.0.0.1:6081/websockify',
      password: 'Hermes26'
    })]
    ctx.storage.set('endpoints', seeded)
    ctx.storage.set('globalEndpointId', 'local-mac')
  }
  const endpoints = ctx.storage.get('endpoints', [])
  const list = Array.isArray(endpoints) ? endpoints.map(normalizeEndpoint).filter(Boolean) : []
  const globalEndpointId = ctx.storage.get('globalEndpointId', null)
  const perBotEndpoint = ctx.storage.get('perBotEndpoint', {})
  const ui = ctx.storage.get('ui', { lastExpanded: false })
  $settings.set({
    endpoints: list,
    globalEndpointId: typeof globalEndpointId === 'string' ? globalEndpointId : null,
    perBotEndpoint: perBotEndpoint && typeof perBotEndpoint === 'object' && !Array.isArray(perBotEndpoint) ? perBotEndpoint : {},
    ui: { lastExpanded: Boolean(ui && ui.lastExpanded) }
  })
  loadWsProtocolMap(ctx)
}

function resolveEndpoint() {
  const settings = $settings.get()
  const profile = readProfileName()
  const overrideId = settings.perBotEndpoint ? settings.perBotEndpoint[profile] : null
  const id = overrideId || settings.globalEndpointId
  if (!id) return null
  return settings.endpoints.find(item => item.id === id) || null
}

function setUi(partial) {
  $ui.set({ ...$ui.get(), ...partial })
}

function setExpanded(next) {
  const ui = $ui.get()
  if (ui.expanded === next) {
    applyRfbDisplay()
    placeLive()
    return
  }
  const patch = { expanded: next, chromeOn: true }
  if (next) patch.overlayTop = measureTitlebarHeight()
  setUi(patch)
  persistUiFlags({ lastExpanded: next })
  applyRfbDisplay()
  syncSurfacePointer()
  bumpPlace()
  placeLive()
}

function toggleExpanded() {
  setExpanded(!$ui.get().expanded)
}

function trySetPaneVisible(value) {
  if (typeof host.paneVisibility !== 'function') return false
  const vis = host.paneVisibility(PANE_CONTRIB_ID)
  if (vis && typeof vis.set === 'function') {
    vis.set(value)
    return true
  }
  return false
}

function togglePane() {
  if (typeof host.paneVisibility === 'function') {
    const vis = host.paneVisibility(PANE_CONTRIB_ID)
    const currently = vis && typeof vis.get === 'function' ? vis.get() : true
    if (trySetPaneVisible(!currently)) return
  }
  toggleExpanded()
}

function openSettings(opts = {}) {
  const intent = opts.intent === 'add' ? 'add' : opts.intent === 'edit-hiperf' ? 'edit-hiperf' : 'list'
  $ui.set({
    ...$ui.get(),
    expanded: false,
    settingsOpen: true,
    settingsIntent: intent,
    highlightPassword: Boolean(opts.highlightPassword),
    chromeOn: true
  })
  applyRfbDisplay()
  syncSurfacePointer()
  bumpPlace()
  placeLive()
}

function openAddComputer() {
  openSettings({ intent: 'add' })
}

function openManageComputers() {
  openSettings({ intent: 'list' })
}

function openHiperfEditor() {
  openSettings({ intent: 'edit-hiperf' })
}

function isHeldDisconnect(endpointId) {
  return Boolean(endpointId && userDisconnectIds.has(endpointId))
}

function releaseDisconnect(endpointId) {
  if (endpointId) userDisconnectIds.delete(endpointId)
}

function switchComputer(id) {
  const settings = $settings.get()
  const next = settings.endpoints.find(item => item.id === id)
  if (!next) return
  const alreadyGlobal = settings.globalEndpointId === id
  if (!alreadyGlobal) persistSettings({ ...settings, globalEndpointId: id })
  const resolved = resolveEndpoint()
  if (!resolved || resolved.id !== id) return
  if (isHeldDisconnect(id)) return
  if (!alreadyGlobal) return
  const phase = engine.state.get().phase
  if (phase === 'connected' || phase === 'connecting' || phase === 'resolving' || phase === 'loading-novnc') return
  void connect(next)
}

async function loadRFB() {
  if (RFB) return RFB
  const urls = [NOVNC_URL, NOVNC_FALLBACK_URL]
  let lastError = null
  for (const url of urls) {
    try {
      const mod = await import(/* webpackIgnore: true */ url)
      let ctor = mod && (mod.default || mod.RFB)
      if (ctor && typeof ctor !== 'function' && typeof ctor.default === 'function') ctor = ctor.default
      if (typeof ctor !== 'function') throw new Error('RFB constructor missing')
      RFB = ctor
      return RFB
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('cdn-blocked')
}

function ensureSurfaceEl() {
  if (engine.surfaceEl) return engine.surfaceEl
  const elNode = document.createElement('div')
  elNode.setAttribute('data-computer-surface', '')
  elNode.style.position = 'relative'
  elNode.style.width = '100%'
  elNode.style.height = '100%'
  elNode.style.minHeight = '0'
  elNode.style.overflow = 'hidden'
  elNode.style.background = 'rgb(0, 0, 0)'
  elNode.addEventListener(
    'pointerdown',
    () => {
      if (!$ui.get().expanded || $ui.get().viewOnly) return
      try {
        engine.rfb && engine.rfb.focus({ preventScroll: true })
      } catch {
        /* unfocused rfb is fine */
      }
    },
    true
  )
  engine.surfaceEl = elNode
  return elNode
}

function ensureIframeEl() {
  if (engine.iframeEl) return engine.iframeEl
  const frame = document.createElement('iframe')
  frame.setAttribute('title', 'Remote computer')
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen')
  frame.style.width = '100%'
  frame.style.height = '100%'
  frame.style.border = '0'
  frame.style.background = 'rgb(0, 0, 0)'
  engine.iframeEl = frame
  return frame
}

function syncSurfacePointer() {
  const expanded = $ui.get().expanded
  if (engine.surfaceEl) engine.surfaceEl.style.pointerEvents = expanded ? 'auto' : 'none'
  if (engine.iframeEl) engine.iframeEl.style.pointerEvents = expanded ? 'auto' : 'none'
}

function liveEl() {
  if (engine.endpoint && engine.endpoint.mode === 'iframe') return engine.iframeEl
  return engine.surfaceEl
}

function thumbnailPanelCrop() {
  if ($ui.get().expanded) return 0
  const endpoint = resolveEndpoint() || engine.endpoint
  if (!endpoint || endpoint.cropPanel !== true) return 0
  const { fbW, fbH } = engine.state.get()
  if (!(fbW > 0 && fbH > 0)) return 0
  return Math.min(0.12, SCREEN_PANEL_PX / fbH)
}

function resetLiveCropStyles(node) {
  if (!node) return
  node.style.position = node === engine.surfaceEl ? 'relative' : ''
  node.style.left = ''
  node.style.right = ''
  node.style.top = ''
  node.style.bottom = ''
  node.style.width = '100%'
  node.style.height = '100%'
  node.style.aspectRatio = ''
  node.style.transform = ''
  node.style.transformOrigin = ''
}

function applyPanelCrop() {
  const live = liveEl()
  if (engine.surfaceEl && engine.surfaceEl !== live) resetLiveCropStyles(engine.surfaceEl)
  if (engine.iframeEl && engine.iframeEl !== live) resetLiveCropStyles(engine.iframeEl)
  if (!live) return
  const crop = thumbnailPanelCrop()
  const { fbW, fbH } = engine.state.get()
  if (crop <= 0 || !(fbW > 0 && fbH > 0)) {
    resetLiveCropStyles(live)
    return
  }
  // Slot keeps its aspect box. Surface uses the true framebuffer aspect and
  // sits on the bottom; scale so overflow:hidden clips the top `crop` of the
  // remote image. Cleared on expand so fullscreen shows the panel.
  const scale = 1 / (1 - crop)
  live.style.position = 'absolute'
  live.style.left = '0'
  live.style.right = '0'
  live.style.bottom = '0'
  live.style.top = 'auto'
  live.style.width = '100%'
  live.style.height = 'auto'
  live.style.aspectRatio = `${fbW} / ${fbH}`
  live.style.transformOrigin = 'bottom center'
  live.style.transform = `scale(${scale})`
}

function placeLive() {
  const live = liveEl()
  const other = live === engine.iframeEl ? engine.surfaceEl : engine.iframeEl
  if (other && other.parentNode) other.parentNode.removeChild(other)
  if (!live) return
  const expanded = $ui.get().expanded
  const parent = expanded ? engine.overlayMountEl : engine.slotEl
  if (parent && live.parentNode !== parent) parent.appendChild(live)
  syncSurfacePointer()
  applyPanelCrop()
  hiperfSyncGeometry()
}

function applyRfbDisplay() {
  const rfb = engine.rfb
  const expanded = $ui.get().expanded
  const scaleMode = $ui.get().scaleMode
  const viewOnly = $ui.get().viewOnly
  if (rfb) {
    rfb.viewOnly = !expanded || viewOnly
    rfb.scaleViewport = !expanded || scaleMode === 'fit'
    rfb.clipViewport = false
    rfb.resizeSession = false
    rfb.dragViewport = false
  }
  if (engine.surfaceEl) {
    engine.surfaceEl.style.overflow = expanded && scaleMode === 'native' ? 'auto' : 'hidden'
  }
  if (engine.overlayMountEl) {
    engine.overlayMountEl.style.overflow = expanded && scaleMode === 'native' ? 'auto' : 'hidden'
  }
  applyPanelCrop()
  hiperfSyncGeometry()
}

function measureScreen() {
  const canvas = engine.surfaceEl && engine.surfaceEl.querySelector('canvas:not([data-hiperf-canvas])')
  if (!canvas || !canvas.width || !canvas.height) return
  const cur = engine.state.get()
  if (cur.fbW === canvas.width && cur.fbH === canvas.height) return
  patchState({ fbW: canvas.width, fbH: canvas.height })
  applyPanelCrop()
}

function detachCanvasObserver() {
  if (engine.canvasObserver) {
    engine.canvasObserver.disconnect()
    engine.canvasObserver = null
  }
}

function attachCanvasObserver() {
  detachCanvasObserver()
  const hostEl = engine.surfaceEl
  if (!hostEl) return
  measureScreen()
  const observer = new MutationObserver(measureScreen)
  observer.observe(hostEl, {
    attributeFilter: ['width', 'height'],
    attributes: true,
    childList: true,
    subtree: true
  })
  engine.canvasObserver = observer
}

function teardownRfb() {
  hiperfTeardown()
  detachCanvasObserver()
  const rfb = engine.rfb
  engine.rfb = null
  if (rfb) {
    try {
      rfb.disconnect()
    } catch {
      /* already dead */
    }
  }
  if (engine.surfaceEl) engine.surfaceEl.replaceChildren()
}

function teardownIframe(blank) {
  if (!engine.iframeEl) return
  engine.iframeEl.onload = null
  if (blank) engine.iframeEl.src = 'about:blank'
}

async function fetchOrgoVncPassword(origin, computerId, headers, signal, gen) {
  let response
  try {
    response = await fetch(`${origin}/api/computers/${encodeURIComponent(computerId)}/vnc-password`, {
      headers,
      signal
    })
  } catch (error) {
    if (error && error.name === 'AbortError') throw error
    return ''
  }
  if (!still(gen)) {
    const aborted = new Error('aborted')
    aborted.status = 'aborted'
    throw aborted
  }
  if (!response.ok) return ''
  let payload
  try {
    payload = await response.json()
  } catch {
    return ''
  }
  const record = unwrapSessionBody(payload)
  const raw = record.password ?? record.vnc_password ?? payload.password ?? payload.vnc_password
  return raw == null ? '' : String(raw)
}

async function fetchSession(endpoint, gen) {
  const ac = new AbortController()
  engine.fetchAbort = ac
  const headers = { Accept: 'application/json' }
  if (endpoint.sessionBearer) headers.Authorization = `Bearer ${endpoint.sessionBearer}`
  let response
  try {
    response = await fetch(endpoint.sessionUrl, { headers, signal: ac.signal })
  } catch (error) {
    if (error && error.name === 'AbortError') throw error
    const wrapped = new Error('network')
    wrapped.status = 'network'
    throw wrapped
  }
  if (!still(gen)) {
    const aborted = new Error('aborted')
    aborted.status = 'aborted'
    throw aborted
  }
  if (!response.ok) {
    const wrapped = new Error('http')
    wrapped.status = response.status
    throw wrapped
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    const wrapped = new Error('invalid-json')
    wrapped.status = response.status
    throw wrapped
  }
  const record = unwrapSessionBody(payload)
  let websocketUrl = String(record.websocketUrl || payload.websocketUrl || '').trim()
  let password = String(record.password ?? payload.password ?? '')
  if (!websocketUrl) {
    const instanceId = orgoInstanceId(record, payload)
    if (instanceId) {
      const statusRaw = record.status != null ? record.status : payload.status
      if (statusRaw != null && statusRaw !== '') {
        const status = String(statusRaw).trim()
        if (NON_RUNNING_COMPUTER[status.toLowerCase()]) {
          const wrapped = new Error('computer-status')
          wrapped.status = status
          wrapped.sessionDetail = `Computer status: ${status}. Start it in Orgo first.`
          throw wrapped
        }
      }
      const rawPassword = record.vnc_password ?? record.password ?? payload.vnc_password ?? payload.password
      password = rawPassword == null ? '' : String(rawPassword)
      if (password === '') {
        const computerId = firstNonEmptyString([record.id, payload.id]) || uuidFromText(endpoint.sessionUrl)
        if (computerId) {
          password = await fetchOrgoVncPassword(
            orgoApiOrigin(endpoint.sessionUrl),
            computerId,
            headers,
            ac.signal,
            gen
          )
        }
      }
      const host =
        hostnameOf(record.connection_url != null ? record.connection_url : payload.connection_url) ||
        String(record.hostname || payload.hostname || '').trim() ||
        hostnameOf(endpoint.sessionUrl)
      if (host) {
        websocketUrl = `wss://${host}/desktops/${encodeURIComponent(instanceId)}/ws/websockify`
        if (password !== '') websocketUrl += `?token=${encodeURIComponent(password)}`
      }
    }
  }
  if (!websocketUrl) {
    const wrapped = new Error('missing-websocketUrl')
    wrapped.status = response.status
    throw wrapped
  }
  return { websocketUrl, password }
}

function scheduleBackoff(endpoint, gen) {
  if (!still(gen)) return
  if (engine.reconnectAttempt >= BACKOFF_MS.length) {
    const wsUrl = engine.resolvedWsUrl || endpoint.wsUrl || endpoint.sessionUrl || ''
    let body = ERRORS.unreachable.body.replace('{wsUrl}', wsUrl)
    if (endpoint.mode === 'session-json') {
      body += ' Token may have expired/been rejected.'
    }
    setError('unreachable', body)
    return
  }
  const delay = BACKOFF_MS[engine.reconnectAttempt]
  const n = engine.reconnectAttempt + 1
  engine.reconnectAttempt = n
  patchState({
    phase: 'disconnected',
    code: null,
    detail: `Reconnecting (${n}/5)…`,
    attempt: n
  })
  engine.backoffTimer = setTimeout(() => {
    engine.backoffTimer = null
    if (!still(gen)) return
    if (!engine.paneVisible && !$ui.get().expanded) return
    void connect(endpoint)
  }, delay)
}

async function connectIframe(endpoint, gen) {
  teardownRfb()
  if (!endpoint.iframeUrl) {
    setError('unconfigured', ERRORS.unconfigured.body)
    return
  }
  patchState({ phase: 'connecting', code: null, detail: null, desktopName: null, fbW: 0, fbH: 0 })
  const frame = ensureIframeEl()
  frame.onload = () => {
    if (!still(gen)) return
    if (!frame.src || frame.src === 'about:blank') return
    engine.reconnectAttempt = 0
    patchState({ phase: 'connected', code: null, detail: null })
    bumpPlace()
  }
  if (frame.getAttribute('src') === endpoint.iframeUrl) frame.src = 'about:blank'
  frame.src = endpoint.iframeUrl
  bumpPlace()
  placeLive()
}

async function connect(endpoint) {
  rememberLastFrame(engine.currentEndpointId)
  const gen = bumpGen()
  engine.intentionalDisconnect = false
  engine.authLock = false
  if (endpoint) releaseDisconnect(endpoint.id)
  engine.endpoint = endpoint || null
  engine.endpointFingerprint = fingerprint(endpoint)

  if (!endpoint) {
    engine.currentEndpointId = null
    engine.resolvedWsUrl = ''
    teardownRfb()
    teardownIframe(true)
    engine.state.set({
      ...IDLE_STATE,
      phase: 'unconfigured',
      code: 'unconfigured',
      detail: ERRORS.unconfigured.body
    })
    bumpPlace()
    return
  }

  if (engine.currentEndpointId !== endpoint.id) engine.reconnectAttempt = 0
  engine.currentEndpointId = endpoint.id

  const probing = isProbeEndpoint(endpoint)
  if (!probing && endpoint.mode === 'iframe') {
    await connectIframe(endpoint, gen)
    return
  }

  teardownIframe(true)

  let wsUrl = endpoint.wsUrl
  let password = endpoint.password || ''
  const username = String(endpoint.username || '')
  let iframeFallbackUrl = ''

  if (probing) {
    const parsed = parseHostPort(String(endpoint.address || '').trim())
    if (!parsed) {
      setError('unconfigured', ERRORS.unconfigured.body)
      return
    }
    const urls = probeUrlsFromHostPort(parsed)
    wsUrl = urls.wsUrl
    iframeFallbackUrl = urls.iframeUrl
  } else if (endpoint.mode === 'session-json') {
    if (!endpoint.sessionUrl) {
      setError('session-failed', `GET ${endpoint.sessionUrl || '(empty)'} → HTTP network.`)
      return
    }
    patchState({ phase: 'resolving', code: null, detail: null, desktopName: null })
    try {
      const session = await fetchSession(endpoint, gen)
      if (!still(gen)) return
      wsUrl = session.websocketUrl
      if (session.password) password = session.password
    } catch (error) {
      if (!still(gen)) return
      if (error && error.name === 'AbortError') return
      if (error && error.sessionDetail) {
        setError('session-failed', error.sessionDetail)
        return
      }
      const status = error && error.status != null ? error.status : 'network'
      setError('session-failed', `GET ${endpoint.sessionUrl} → HTTP ${status}.`)
      return
    }
  }

  engine.resolvedWsUrl = wsUrl || ''

  if (isInsecurePublicWs(wsUrl)) {
    if (!still(gen)) return
    if (iframeFallbackUrl) {
      const next = normalizeEndpoint({
        ...endpoint,
        mode: 'iframe',
        iframeUrl: iframeFallbackUrl,
        probe: false
      })
      persistEndpointFields(next)
      await connectIframe(next, gen)
      return
    }
    setError('mixed-content', ERRORS['mixed-content'].body)
    return
  }

  patchState({ phase: 'loading-novnc', code: null, detail: null })
  let RfbCtor
  try {
    RfbCtor = await loadRFB()
  } catch {
    if (!still(gen)) return
    setError('cdn-blocked', ERRORS['cdn-blocked'].body)
    return
  }
  if (!still(gen)) return

  if (engine.appliedDefaultsFor !== endpoint.id) {
    setUi({
      viewOnly: Boolean(endpoint.viewOnlyDefault),
      scaleMode: endpoint.scaleMode === 'native' ? 'native' : 'fit'
    })
    engine.appliedDefaultsFor = endpoint.id
  }

  patchState({ phase: 'connecting', code: null, detail: null })
  const target = ensureSurfaceEl()
  let sawConnect = false
  let triedAlternate = false

  function openRfb(variant) {
    if (!still(gen)) return
    teardownRfb()
    target.replaceChildren()
    bumpPlace()
    placeLive()

    const options = {
      shared: true,
      credentials: rfbConstructorCredentials(username, password)
    }
    if (variant === 'binary') options.wsProtocols = ['binary']

    let rfb
    try {
      rfb = new RfbCtor(target, wsUrl, options)
    } catch {
      if (!still(gen)) return
      if (!triedAlternate) {
        triedAlternate = true
        openRfb(otherWsProtocol(variant))
        return
      }
      if (iframeFallbackUrl) {
        const fallback = iframeFallbackUrl
        iframeFallbackUrl = ''
        const next = normalizeEndpoint({
          ...endpoint,
          mode: 'iframe',
          iframeUrl: fallback,
          probe: false
        })
        persistEndpointFields(next)
        void connectIframe(next, gen)
        return
      }
      const body = ERRORS.unreachable.body.replace('{wsUrl}', wsUrl || endpoint.wsUrl || '')
      setError('unreachable', body)
      return
    }

    rfb.clipViewport = false
    rfb.resizeSession = false
    rfb.qualityLevel = clampInt(endpoint.qualityLevel, 0, 9, 7)
    rfb.compressionLevel = clampInt(endpoint.compressionLevel, 0, 9, 2)
    engine.rfb = rfb
    applyRfbDisplay()

    rfb.addEventListener('connect', () => {
      if (!still(gen) || engine.rfb !== rfb) return
      sawConnect = true
      persistWsProtocol(endpoint.id, variant)
      engine.reconnectAttempt = 0
      if (probing) {
        persistEndpointFields(
          normalizeEndpoint({
            ...endpoint,
            mode: 'websocket',
            wsUrl,
            probe: false
          })
        )
      }
      patchState({ phase: 'connected', code: null, detail: null, attempt: 0 })
      measureScreen()
      attachCanvasObserver()
      hiperfOnRfbConnected()
    })

    rfb.addEventListener('credentialsrequired', () => {
      if (!still(gen) || engine.rfb !== rfb) return
      if (username || password) {
        const creds = {}
        if (username) creds.username = username
        if (password) creds.password = password
        try {
          rfb.sendCredentials(creds)
        } catch {
          /* sendCredentials can throw if the socket already dropped */
        }
        return
      }
      engine.authLock = true
      setError('password-required', ERRORS['password-required'].body)
      openSettings({ highlightPassword: true })
    })

    rfb.addEventListener('securityfailure', event => {
      if (!still(gen) || engine.rfb !== rfb) return
      engine.authLock = true
      const reason = event && event.detail && event.detail.reason
      setError('vnc-auth-failed', reason || ERRORS['vnc-auth-failed'].body)
    })

    rfb.addEventListener('desktopname', event => {
      if (!still(gen) || engine.rfb !== rfb) return
      patchState({ desktopName: (event && event.detail && event.detail.name) || null })
    })

    rfb.addEventListener('clipboard', event => {
      if (!still(gen) || engine.rfb !== rfb) return
      const text = event && event.detail && event.detail.text
      if (text && pluginCtx && pluginCtx.os && pluginCtx.os.writeClipboard) {
        void pluginCtx.os.writeClipboard(text)
      }
    })

    rfb.addEventListener('serververification', () => {
      if (!still(gen) || engine.rfb !== rfb) return
      try {
        rfb.approveServer()
      } catch {
        /* older noVNC builds omit this */
      }
    })

    rfb.addEventListener('disconnect', event => {
      if (!still(gen) || engine.rfb !== rfb) return
      if (sawConnect) rememberLastFrame(endpoint.id, rfb)
      engine.rfb = null
      detachCanvasObserver()
      const clean = Boolean(event && event.detail && event.detail.clean) || engine.intentionalDisconnect
      if (engine.authLock) return
      if (clean) {
        patchState({ phase: 'disconnected', code: null, detail: null, attempt: 0 })
        return
      }
      if (!sawConnect && !triedAlternate) {
        triedAlternate = true
        queueMicrotask(() => {
          if (!still(gen)) return
          openRfb(otherWsProtocol(variant))
        })
        return
      }
      if (!sawConnect && iframeFallbackUrl) {
        const fallback = iframeFallbackUrl
        iframeFallbackUrl = ''
        const next = normalizeEndpoint({
          ...endpoint,
          mode: 'iframe',
          iframeUrl: fallback,
          probe: false
        })
        persistEndpointFields(next)
        void connectIframe(next, gen)
        return
      }
      const visible = engine.paneVisible || $ui.get().expanded
      if (visible) scheduleBackoff(endpoint, gen)
      else patchState({ phase: 'disconnected', code: null, detail: null })
    })
  }

  openRfb(rememberedWsProtocol(endpoint.id))
}

function disconnect() {
  rememberLastFrame(engine.currentEndpointId)
  bumpGen()
  engine.intentionalDisconnect = true
  engine.authLock = false
  engine.reconnectAttempt = 0
  teardownRfb()
  teardownIframe(true)
  const phase = engine.endpoint ? 'disconnected' : 'unconfigured'
  patchState({
    phase,
    code: phase === 'unconfigured' ? 'unconfigured' : null,
    detail: phase === 'unconfigured' ? ERRORS.unconfigured.body : null,
    attempt: 0
  })
}

function userDisconnect(endpointId) {
  const id =
    endpointId || (engine.endpoint && engine.endpoint.id) || engine.currentEndpointId
  if (id) userDisconnectIds.add(id)
  disconnect()
}

function reconnect() {
  engine.reconnectAttempt = 0
  const endpoint = engine.endpoint || resolveEndpoint()
  if (!endpoint) {
    void connect(null)
    return
  }
  void connect(endpoint)
}

function syncConnection() {
  const endpoint = resolveEndpoint()
  const phase = engine.state.get().phase
  if (!endpoint) {
    if (phase !== 'unconfigured') void connect(null)
    return
  }
  if (isHeldDisconnect(endpoint.id)) {
    const live =
      phase === 'connected' ||
      phase === 'connecting' ||
      phase === 'resolving' ||
      phase === 'loading-novnc' ||
      (phase === 'disconnected' && engine.reconnectAttempt > 0)
    if (live) disconnect()
    const fp = fingerprint(endpoint)
    if (fp !== engine.endpointFingerprint || engine.currentEndpointId !== endpoint.id) {
      engine.endpoint = endpoint
      engine.endpointFingerprint = fp
      engine.currentEndpointId = endpoint.id
    }
    if (!live) hiperfSyncFromSettings()
    return
  }
  const fp = fingerprint(endpoint)
  if (fp !== engine.endpointFingerprint) {
    if (!engine.paneVisible && !$ui.get().expanded) {
      engine.endpoint = endpoint
      engine.endpointFingerprint = fp
      engine.currentEndpointId = endpoint.id
      if (phase === 'connected' || phase === 'connecting' || phase === 'resolving' || phase === 'loading-novnc') {
        disconnect()
      }
      return
    }
    void connect(endpoint)
    return
  }
  hiperfSyncFromSettings()
  if (!engine.paneVisible && !$ui.get().expanded) return
  if (endpoint.autoConnect && (phase === 'idle' || phase === 'disconnected')) void connect(endpoint)
}

function reloadIframe() {
  const frame = engine.iframeEl
  if (!frame) return
  if (engine.endpoint) releaseDisconnect(engine.endpoint.id)
  const src = engine.endpoint && engine.endpoint.iframeUrl ? engine.endpoint.iframeUrl : frame.src
  frame.src = src
}

async function pasteClipboard() {
  const rfb = engine.rfb
  if (!rfb) return
  try {
    const text = await navigator.clipboard.readText()
    if (text) rfb.clipboardPasteFrom(text)
  } catch {
    host.notify({ kind: 'error', message: 'Clipboard is unavailable.' })
  }
}

function takeScreenshot() {
  if (hiperfIsStreaming()) {
    const canvas = hiperfGetCanvas()
    if (canvas && typeof canvas.toBlob === 'function') {
      canvas.toBlob(async blob => {
        if (!blob) return
        try {
          if (navigator.clipboard && typeof ClipboardItem === 'function') {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            host.notify({ kind: 'info', message: 'Screenshot copied to clipboard' })
            return
          }
        } catch {
          /* fall through to download */
        }
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `computer-${Date.now()}.png`
        anchor.click()
        URL.revokeObjectURL(url)
        if (pluginCtx && pluginCtx.os && pluginCtx.os.notify) {
          pluginCtx.os.notify({ title: 'Screenshot saved', body: 'Downloaded a PNG of the remote screen.' })
        }
      }, 'image/png')
      return
    }
  }
  const rfb = engine.rfb
  if (!rfb || typeof rfb.toBlob !== 'function') return
  rfb.toBlob(async blob => {
    if (!blob) return
    try {
      if (navigator.clipboard && typeof ClipboardItem === 'function') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        host.notify({ kind: 'info', message: 'Screenshot copied to clipboard' })
        return
      }
    } catch {
      /* fall through to download */
    }
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `computer-${Date.now()}.png`
    anchor.click()
    URL.revokeObjectURL(url)
    if (pluginCtx && pluginCtx.os && pluginCtx.os.notify) {
      pluginCtx.os.notify({ title: 'Screenshot saved', body: 'Downloaded a PNG of the remote screen.' })
    }
  }, 'image/png')
}

function sendCtrlAltDel() {
  if (engine.rfb && typeof engine.rfb.sendCtrlAltDel === 'function') engine.rfb.sendCtrlAltDel()
}

function teardownEngine() {
  rememberLastFrame(engine.currentEndpointId)
  bumpGen()
  teardownRfb()
  teardownIframe(true)
  if (engine.surfaceEl && engine.surfaceEl.parentNode) engine.surfaceEl.parentNode.removeChild(engine.surfaceEl)
  if (engine.iframeEl && engine.iframeEl.parentNode) engine.iframeEl.parentNode.removeChild(engine.iframeEl)
  engine.surfaceEl = null
  engine.iframeEl = null
  engine.slotEl = null
  engine.overlayMountEl = null
  engine.overlayRootEl = null
  engine.endpoint = null
  engine.currentEndpointId = null
  engine.endpointFingerprint = ''
  pluginCtx = null
}

function attachEngine(ctx) {
  pluginCtx = ctx
  loadSettingsFrom(ctx)
  const unsubs = []
  if (host.state.focusedSessionProfile && typeof host.state.focusedSessionProfile.listen === 'function') {
    unsubs.push(host.state.focusedSessionProfile.listen(() => syncConnection()))
  }
  if (host.state.profile && typeof host.state.profile.listen === 'function') {
    unsubs.push(host.state.profile.listen(() => syncConnection()))
  }
  unsubs.push($settings.listen(() => syncConnection()))
  if (typeof host.paneVisibility === 'function') {
    const vis = host.paneVisibility(PANE_CONTRIB_ID)
    if (vis && typeof vis.get === 'function') engine.paneVisible = Boolean(vis.get())
    if (vis && typeof vis.listen === 'function') {
      unsubs.push(
        vis.listen(value => {
          engine.paneVisible = Boolean(value)
          if (value) syncConnection()
          else {
            setExpanded(false)
            disconnect()
          }
        })
      )
    }
  }
  const dispose = () => {
    for (const stop of unsubs) {
      try {
        stop()
      } catch {
        /* already unbound */
      }
    }
    teardownEngine()
  }
  if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)
}

function hiperfApplies(endpoint) {
  return Boolean(endpoint && endpoint.hiperfEnabled && endpoint.mode === 'websocket')
}

function hiperfConfigured(endpoint) {
  if (!endpoint) return false
  if (String(endpoint.hiperfToken || '').trim()) return true
  return String(endpoint.hiperfUrl || '').trim() !== ''
}

function hiperfConfigKey(endpoint) {
  if (!endpoint) return ''
  return [endpoint.id, endpoint.hiperfEnabled ? '1' : '0', endpoint.hiperfUrl || '', endpoint.hiperfToken || ''].join('\0')
}

function hiperfStatusLine(h) {
  if (!h || h.phase === 'off') return ''
  if (h.phase === 'connecting') return 'Starting HD stream…'
  if (h.phase === 'streaming') {
    return `HD ${h.fps}fps · ${formatHiperfMbps(h.mbps)}Mbps · ${h.rtt}ms`
  }
  if (h.code === 'mixed-public') return MIXED_CONTENT_HINT
  if (h.code === 'hiperf-unreachable') {
    return String(HIPERF_LINES['hiperf-unreachable'] || '').replace('{hiperfUrl}', h.url || '')
  }
  if (h.code === 'decode-failed' || h.code === 'ffmpeg-died') {
    return `HD stream failed (${h.code}) — using VNC.`
  }
  return HIPERF_LINES[h.code] || (h.code ? `HD stream failed (${h.code}) — using VNC.` : '')
}

function formatHiperfMbps(n) {
  if (!Number.isFinite(n) || n <= 0) return '0.0'
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1)
}

function hiperfRetryable(code) {
  return code === 'hiperf-unreachable' || code === 'ffmpeg-died' || code === 'decode-failed'
}

const hiperf = {
  generation: 0,
  ws: null,
  decoder: null,
  canvas: null,
  ctx2d: null,
  runningKey: '',
  url: '',
  started: false,
  waitKey: true,
  useAvcc: false,
  sps: null,
  pps: null,
  codec: '',
  decoderReady: false,
  avccAttempted: false,
  decoderRetried: false,
  blackSince: 0,
  bytesWindow: 0,
  framesWindow: 0,
  statsTimer: null,
  pingTimer: null,
  retryTimer: null,
  retryAttempt: 0,
  raf: 0,
  qualityMutated: false,
  intentionalClose: false,
  lastErrorCode: null,
  resetting: false,
  configureInFlight: false
}

function hiperfIsStreaming() {
  return $hiperf.get().phase === 'streaming' && hiperf.canvas
}

function hiperfGetCanvas() {
  return hiperf.canvas
}

function hiperfToDataURL() {
  if (!hiperf.canvas) return null
  try {
    const url = hiperf.canvas.toDataURL('image/png')
    return typeof url === 'string' && url.startsWith('data:') ? url : null
  } catch {
    return null
  }
}

function hiperfPatch(partial) {
  $hiperf.set({ ...$hiperf.get(), ...partial })
}

function hiperfBuildUrl(endpoint) {
  let raw = String((endpoint && endpoint.hiperfUrl) || '').trim()
  if (!raw) {
    const resolved = engine.resolvedWsUrl
    if (!resolved) return { error: 'hiperf-unreachable', url: '' }
    try {
      const u = new URL(resolved)
      raw = `ws://${formatHostForUrl(u.hostname)}:6090/stream`
    } catch {
      return { error: 'hiperf-unreachable', url: '' }
    }
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return { error: 'hiperf-unreachable', url: raw }
  }
  if (isInsecurePublicWs(parsed.toString())) {
    return { error: 'mixed-public', url: parsed.toString() }
  }
  if (!parsed.searchParams.get('token')) {
    const token = String((endpoint && endpoint.hiperfToken) || '').trim()
    if (token) parsed.searchParams.set('token', token)
  }
  return { url: parsed.toString() }
}

function hiperfFindStartCodes(data) {
  const found = []
  const n = data.length
  for (let i = 0; i < n - 2; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue
    if (i + 3 < n && data[i + 2] === 0 && data[i + 3] === 1) {
      found.push({ index: i, len: 4 })
      i += 3
    } else if (data[i + 2] === 1) {
      found.push({ index: i, len: 3 })
      i += 2
    }
  }
  return found
}

function hiperfSplitNals(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const sc = hiperfFindStartCodes(bytes)
  const nals = []
  for (let i = 0; i < sc.length; i++) {
    const start = sc[i].index + sc[i].len
    const end = i + 1 < sc.length ? sc[i + 1].index : bytes.length
    if (end > start) nals.push(bytes.subarray(start, end))
  }
  return nals
}

function hiperfReadUe(data, bitpos) {
  let zeros = 0
  const nbits = data.length * 8
  while (bitpos < nbits) {
    const byteI = bitpos >> 3
    const bitI = 7 - (bitpos & 7)
    const bit = (data[byteI] >> bitI) & 1
    bitpos += 1
    if (bit === 1) break
    zeros += 1
    if (zeros > 31) return { value: null, bitpos }
  }
  if (bitpos > nbits && zeros) return { value: null, bitpos }
  let val = (1 << zeros) - 1
  for (let k = 0; k < zeros; k++) {
    if (bitpos >= nbits) return { value: null, bitpos }
    const byteI = bitpos >> 3
    const bitI = 7 - (bitpos & 7)
    const bit = (data[byteI] >> bitI) & 1
    bitpos += 1
    val = (val << 1) | bit
  }
  return { value: val, bitpos }
}

function hiperfIsISlice(nal) {
  if (!nal || nal.length < 2) return false
  const ntype = nal[0] & 0x1f
  if (ntype === 5) return true
  if (ntype !== 1) return false
  const payload = nal.subarray(1)
  const first = hiperfReadUe(payload, 0)
  if (first.value == null) return false
  const st = hiperfReadUe(payload, first.bitpos)
  if (st.value == null) return false
  return st.value === 2 || st.value === 4 || st.value === 7 || st.value === 9
}

function hiperfAuIsKey(au) {
  const nals = hiperfSplitNals(au)
  for (const nal of nals) {
    if (!nal.length) continue
    const ntype = nal[0] & 0x1f
    if (ntype === 5) return true
    if (ntype === 1 && hiperfIsISlice(nal)) return true
  }
  return false
}

function hiperfFindSpsPps(au) {
  let sps = null
  let pps = null
  for (const nal of hiperfSplitNals(au)) {
    if (!nal.length) continue
    const ntype = nal[0] & 0x1f
    if (ntype === 7) sps = nal.slice()
    else if (ntype === 8) pps = nal.slice()
  }
  return { sps, pps }
}

function hiperfCodecFromSps(sps) {
  if (!sps || sps.length < 4) return ''
  const hex = [sps[1], sps[2], sps[3]].map(b => b.toString(16).padStart(2, '0')).join('')
  return `avc1.${hex}`
}

function hiperfConcat(parts) {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function hiperfToAvcc(au) {
  const nals = hiperfSplitNals(au)
  const parts = []
  for (const nal of nals) {
    if (!nal.length) continue
    const ntype = nal[0] & 0x1f
    // AVCC samples should be VCL-only. SPS/PPS live in the description;
    // SEI/AUD make Electron's VideoDecoder throw EncodingError.
    if (ntype !== 1 && ntype !== 5) continue
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, nal.length)
    parts.push(len, nal)
  }
  return parts.length ? hiperfConcat(parts) : new Uint8Array(0)
}

function hiperfAvcC(sps, pps) {
  if (!sps || !pps) return null
  const out = new Uint8Array(11 + sps.length + pps.length)
  let i = 0
  out[i++] = 1
  out[i++] = sps[1]
  out[i++] = sps[2]
  out[i++] = sps[3]
  out[i++] = 0xff
  out[i++] = 0xe1
  out[i++] = (sps.length >> 8) & 0xff
  out[i++] = sps.length & 0xff
  out.set(sps, i)
  i += sps.length
  out[i++] = 1
  out[i++] = (pps.length >> 8) & 0xff
  out[i++] = pps.length & 0xff
  out.set(pps, i)
  return out
}

function hiperfRestoreQuality() {
  if (!hiperf.qualityMutated) return
  hiperf.qualityMutated = false
  const rfb = engine.rfb
  const ep = engine.endpoint
  if (!rfb || !ep) return
  try {
    rfb.qualityLevel = clampInt(ep.qualityLevel, 0, 9, 7)
    rfb.compressionLevel = clampInt(ep.compressionLevel, 0, 9, 2)
  } catch {
    /* rfb already dead */
  }
}

function hiperfEnterStreaming() {
  const rfb = engine.rfb
  if (rfb && !hiperf.qualityMutated) {
    try {
      rfb.qualityLevel = 0
      rfb.compressionLevel = 9
      hiperf.qualityMutated = true
    } catch {
      /* ignore */
    }
  }
  hiperf.retryAttempt = 0
  hiperfPatch({ phase: 'streaming', code: null })
}

function hiperfClearTimers(opts) {
  if (hiperf.statsTimer != null) {
    clearInterval(hiperf.statsTimer)
    hiperf.statsTimer = null
  }
  if (hiperf.pingTimer != null) {
    clearInterval(hiperf.pingTimer)
    hiperf.pingTimer = null
  }
  if (!(opts && opts.keepRetry) && hiperf.retryTimer != null) {
    clearTimeout(hiperf.retryTimer)
    hiperf.retryTimer = null
  }
  if (hiperf.raf) {
    cancelAnimationFrame(hiperf.raf)
    hiperf.raf = 0
  }
}

function hiperfCloseDecoder() {
  const dec = hiperf.decoder
  hiperf.decoder = null
  hiperf.decoderReady = false
  if (dec) {
    try {
      dec.close()
    } catch {
      /* already closed */
    }
  }
}

function hiperfRemoveCanvas() {
  const canvas = hiperf.canvas
  hiperf.canvas = null
  hiperf.ctx2d = null
  if (canvas && canvas.parentNode) {
    try {
      canvas.parentNode.removeChild(canvas)
    } catch {
      /* already gone */
    }
  }
}

function hiperfCloseSocket() {
  const ws = hiperf.ws
  hiperf.ws = null
  if (!ws) return
  hiperf.intentionalClose = true
  try {
    ws.close(1000)
  } catch {
    /* already closed */
  }
}

function hiperfTeardown(opts) {
  const keepAtom = opts && opts.keepAtom
  hiperf.generation += 1
  hiperf.runningKey = keepAtom ? hiperf.runningKey : ''
  hiperfClearTimers()
  hiperfRestoreQuality()
  hiperfCloseDecoder()
  hiperfCloseSocket()
  hiperfRemoveCanvas()
  hiperf.started = false
  hiperf.waitKey = true
  hiperf.useAvcc = false
  hiperf.sps = null
  hiperf.pps = null
  hiperf.codec = ''
  hiperf.avccAttempted = false
  hiperf.decoderRetried = false
  hiperf.blackSince = 0
  hiperf.bytesWindow = 0
  hiperf.framesWindow = 0
  hiperf.url = ''
  hiperf.lastErrorCode = null
  hiperf.resetting = false
  hiperf.configureInFlight = false
  if (!keepAtom) hiperfPatch({ ...HIPERF_IDLE })
}

function hiperfEnsureCanvas() {
  const surface = engine.surfaceEl
  if (!surface) return null
  let canvas = hiperf.canvas
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.setAttribute('data-hiperf-canvas', '')
    canvas.style.position = 'absolute'
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '2'
    canvas.style.visibility = 'hidden'
    canvas.style.left = '0'
    canvas.style.top = '0'
    hiperf.canvas = canvas
    try {
      hiperf.ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true })
    } catch {
      hiperf.ctx2d = canvas.getContext('2d')
    }
  }
  if (canvas.parentNode !== surface || surface.lastElementChild !== canvas) {
    surface.appendChild(canvas)
  }
  hiperfSyncGeometry()
  if (!hiperf.raf) hiperfLoopGeometry()
  return canvas
}

function hiperfSyncGeometry() {
  const canvas = hiperf.canvas
  const surface = engine.surfaceEl
  if (!canvas || !surface) return
  if (surface.lastElementChild !== canvas) surface.appendChild(canvas)
  const rfbC = surface.querySelector('canvas:not([data-hiperf-canvas])')
  if (!rfbC) return
  const sr = surface.getBoundingClientRect()
  const cr = rfbC.getBoundingClientRect()
  if (!(sr.width > 0 && sr.height > 0)) return
  const sx = surface.clientWidth / sr.width
  const sy = surface.clientHeight / sr.height
  canvas.style.left = `${(cr.left - sr.left) * sx}px`
  canvas.style.top = `${(cr.top - sr.top) * sy}px`
  canvas.style.width = `${cr.width * sx}px`
  canvas.style.height = `${cr.height * sy}px`
}

function hiperfLoopGeometry() {
  const tick = () => {
    if (!hiperf.canvas) {
      hiperf.raf = 0
      return
    }
    hiperfSyncGeometry()
    hiperf.raf = requestAnimationFrame(tick)
  }
  hiperf.raf = requestAnimationFrame(tick)
}

function hiperfSampleStats(ctx, w, h) {
  const sw = Math.min(48, w)
  const sh = Math.min(48, h)
  if (!(sw > 0 && sh > 0)) return { luma: 255, variance: 255 }
  const sx = Math.max(0, Math.floor((w - sw) / 2))
  const sy = Math.max(0, Math.floor((h - sh) / 2))
  let img
  try {
    img = ctx.getImageData(sx, sy, sw, sh)
  } catch {
    return { luma: 255, variance: 255 }
  }
  const d = img.data
  const values = []
  for (let i = 0; i < d.length; i += 16) {
    values.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])
  }
  if (!values.length) return { luma: 255, variance: 255 }
  let sum = 0
  for (const v of values) sum += v
  const luma = sum / values.length
  let acc = 0
  for (const v of values) {
    const dlt = v - luma
    acc += dlt * dlt
  }
  return { luma, variance: acc / values.length }
}

function hiperfResolutionMismatch(dw, dh) {
  const { fbW, fbH } = engine.state.get()
  if (!(fbW > 0 && fbH > 0)) return false
  return Math.abs(dw - fbW) / fbW > 0.01 || Math.abs(dh - fbH) / fbH > 0.01
}

function hiperfOnFrame(gen, frame) {
  try {
    if (gen !== hiperf.generation) return
    const dw = frame.displayWidth
    const dh = frame.displayHeight
    if (hiperfResolutionMismatch(dw, dh)) {
      hiperfFallback('resolution-mismatch')
      return
    }
    const canvas = hiperfEnsureCanvas()
    const ctx = hiperf.ctx2d
    if (!canvas || !ctx) return
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw
      canvas.height = dh
    }
    ctx.drawImage(frame, 0, 0, dw, dh)
    hiperf.framesWindow += 1
    if (canvas.style.visibility !== 'visible') {
      const { luma, variance } = hiperfSampleStats(ctx, dw, dh)
      // Dark real desktops (Hermes, Windows dark mode) are not capture
      // failures. Only keep HD hidden while the frame is essentially
      // uniform black; never abort the stream on a luma heuristic.
      const looksReal = luma >= 8 || variance >= 40
      if (looksReal) {
        hiperf.blackSince = 0
        canvas.style.visibility = 'visible'
        if ($hiperf.get().phase !== 'streaming') hiperfEnterStreaming()
      } else if (!hiperf.blackSince) {
        hiperf.blackSince = Date.now()
      }
    } else if ($hiperf.get().phase !== 'streaming') {
      hiperfEnterStreaming()
    }
  } finally {
    try {
      frame.close()
    } catch {
      /* already closed */
    }
  }
}

async function hiperfIsConfigSupported(config) {
  if (typeof VideoDecoder.isConfigSupported !== 'function') return true
  const result = await VideoDecoder.isConfigSupported(config)
  return Boolean(result && result.supported)
}

function hiperfStripAuxNals(au) {
  const nals = hiperfSplitNals(au)
  const kept = []
  for (const nal of nals) {
    if (!nal.length) continue
    const ntype = nal[0] & 0x1f
    if (ntype === 6 || ntype === 9 || ntype === 12) continue
    kept.push(nal)
  }
  if (!kept.length) return au
  const parts = []
  for (const nal of kept) {
    parts.push(new Uint8Array([0, 0, 0, 1]), nal)
  }
  return hiperfConcat(parts)
}

function hiperfMakeConfig() {
  const codec = hiperf.codec
  if (!codec) return null
  const config = { codec, optimizeForLatency: true }
  if (hiperf.useAvcc) {
    const description = hiperfAvcC(hiperf.sps, hiperf.pps)
    if (!description) return null
    config.description = description
  }
  return config
}

async function hiperfConfigureDecoder(gen) {
  if (gen !== hiperf.generation) return false
  const config = hiperfMakeConfig()
  if (!config) return false
  let supported = false
  try {
    supported = await hiperfIsConfigSupported(config)
  } catch {
    supported = false
  }
  if (gen !== hiperf.generation) return false
  if (!supported) {
    if (!hiperf.useAvcc && hiperf.sps && hiperf.pps) {
      hiperf.useAvcc = true
      hiperf.avccAttempted = true
      return hiperfConfigureDecoder(gen)
    }
    return false
  }
  hiperfCloseDecoder()
  const decoder = new VideoDecoder({
    output: frame => hiperfOnFrame(gen, frame),
    error: err => hiperfOnDecoderError(gen, err)
  })
  try {
    decoder.configure(config)
  } catch {
    if (!hiperf.useAvcc && hiperf.sps && hiperf.pps) {
      hiperf.useAvcc = true
      hiperf.avccAttempted = true
      return hiperfConfigureDecoder(gen)
    }
    return false
  }
  hiperf.decoder = decoder
  hiperf.decoderReady = true
  return true
}

function hiperfOnDecoderError(gen, _err) {
  if (gen !== hiperf.generation) return
  if (hiperf.resetting) return
  hiperfSoftRecover()
}

function hiperfSoftRecover() {
  // A bad P-frame or decoder.reset() must not kill the websocket.
  // Hide HD, keep VNC, wait for the next keyframe.
  hiperf.decoderReady = false
  hiperf.waitKey = true
  if (hiperf.canvas) hiperf.canvas.style.visibility = 'hidden'
  hiperf.resetting = true
  try {
    hiperf.decoder && hiperf.decoder.reset()
  } catch {
    /* ignore */
  }
  hiperf.resetting = false
  if ($hiperf.get().phase === 'streaming') {
    hiperfPatch({ phase: 'connecting', code: null })
  }
}

async function hiperfHandleDecodeFailure(gen) {
  if (gen !== hiperf.generation) return
  hiperfSoftRecover()
}

function hiperfPayloadForDecode(au) {
  const cleaned = hiperfStripAuxNals(au)
  return hiperf.useAvcc ? hiperfToAvcc(cleaned) : cleaned
}

async function hiperfOnBinary(gen, data) {
  if (gen !== hiperf.generation) return
  if (!(data instanceof ArrayBuffer) || data.byteLength < 10) return
  hiperf.bytesWindow += data.byteLength
  const view = new DataView(data)
  const flags = view.getUint8(0)
  const timestamp = Number(view.getBigUint64(1, false))
  const au = new Uint8Array(data.slice(9))
  const isKey = (flags & 1) === 1 || hiperfAuIsKey(au)
  if (hiperf.waitKey && !isKey) return
  const headers = hiperfFindSpsPps(au)
  if (headers.sps) hiperf.sps = headers.sps
  if (headers.pps) hiperf.pps = headers.pps
  if (isKey && hiperf.sps && !hiperf.codec) hiperf.codec = hiperfCodecFromSps(hiperf.sps)
  if (!hiperf.decoderReady) {
    if (!isKey || !hiperf.sps) return
    if (hiperf.configureInFlight) return
    if (!hiperf.codec) hiperf.codec = hiperfCodecFromSps(hiperf.sps)
    if (hiperf.sps && hiperf.pps) {
      hiperf.useAvcc = true
      hiperf.avccAttempted = true
    }
    hiperf.configureInFlight = true
    const ok = await hiperfConfigureDecoder(gen)
    hiperf.configureInFlight = false
    if (gen !== hiperf.generation) return
    if (!ok) return
  }
  const decoder = hiperf.decoder
  if (!decoder || decoder.state === 'closed' || decoder.state === 'unconfigured') return
  if (decoder.decodeQueueSize > 10) {
    hiperfSoftRecover()
    return
  }
  hiperf.waitKey = false
  const payload = hiperfPayloadForDecode(au)
  if (!payload.length) return
  try {
    decoder.decode(
      new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp,
        data: payload
      })
    )
  } catch {
    void hiperfHandleDecodeFailure(gen)
  }
}

function hiperfOnHello(gen, _msg) {
  if (gen !== hiperf.generation) return
  if (!hiperf.started) {
    hiperf.started = true
    try {
      hiperf.ws && hiperf.ws.send(JSON.stringify({ type: 'start' }))
    } catch {
      /* socket dying */
    }
    return
  }
  // Post-spawn hello is informational. Do not reset a live decoder —
  // that fires error → fallback → VNC every few seconds.
}

function hiperfOnControl(gen, msg) {
  if (gen !== hiperf.generation || !msg || typeof msg !== 'object') return
  if (msg.type === 'hello') {
    hiperfOnHello(gen, msg)
    return
  }
  if (msg.type === 'pong') {
    const t = Number(msg.t)
    if (Number.isFinite(t)) hiperfPatch({ rtt: Math.max(0, Math.round(Date.now() - t)) })
    return
  }
  if (msg.type === 'error') {
    const code = String(msg.code || 'ffmpeg-died')
    hiperf.lastErrorCode = code
    if (code === 'capture-failed' || code === 'no-encoder') hiperfFallback(code)
    else hiperfFallback(code === 'ffmpeg-died' ? 'ffmpeg-died' : code)
  }
}

function hiperfStartStats(gen) {
  hiperf.bytesWindow = 0
  hiperf.framesWindow = 0
  hiperf.statsTimer = setInterval(() => {
    if (gen !== hiperf.generation) return
    const fps = hiperf.framesWindow
    const mbps = (hiperf.bytesWindow * 8) / 1e6
    hiperf.framesWindow = 0
    hiperf.bytesWindow = 0
    if ($hiperf.get().phase === 'streaming') hiperfPatch({ fps, mbps })
  }, 1000)
  hiperf.pingTimer = setInterval(() => {
    if (gen !== hiperf.generation || !hiperf.ws || hiperf.ws.readyState !== 1) return
    try {
      hiperf.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }))
    } catch {
      /* ignore */
    }
  }, 5000)
}

function hiperfFallback(code, opts) {
  const genAtCall = hiperf.generation
  const fromClose = opts && opts.fromClose
  hiperfRestoreQuality()
  if (hiperf.canvas) hiperf.canvas.style.visibility = 'hidden'
  hiperfCloseDecoder()
  if (!fromClose) hiperfCloseSocket()
  hiperfClearTimers({ keepRetry: hiperfRetryable(code) })
  hiperfRemoveCanvas()
  hiperf.started = false
  hiperf.waitKey = true
  hiperf.decoderReady = false
  const url = hiperf.url
  hiperfPatch({ phase: 'fallback', code, fps: 0, mbps: 0, url })
  if (!hiperfRetryable(code)) return
  if (hiperf.retryTimer != null) return
  if (hiperf.retryAttempt >= HIPERF_BACKOFF_MS.length) return
  const delay = HIPERF_BACKOFF_MS[hiperf.retryAttempt]
  hiperf.retryAttempt += 1
  hiperf.retryTimer = setTimeout(() => {
    hiperf.retryTimer = null
    if (hiperf.generation !== genAtCall) return
    if ($hiperf.get().phase !== 'fallback') return
    const ep = engine.endpoint
    if (engine.state.get().phase === 'connected' && hiperfApplies(ep)) {
      hiperfStart(ep, { fromRetry: true })
    }
  }, delay)
}

function hiperfOnClose(gen, event) {
  if (gen !== hiperf.generation) return
  if (hiperf.intentionalClose) {
    hiperf.intentionalClose = false
    return
  }
  const code = event && event.code
  if (code === 4401) {
    hiperfFallback('hiperf-auth', { fromClose: true })
    return
  }
  if (code === 4409) {
    hiperfFallback('superseded', { fromClose: true })
    return
  }
  if (hiperf.lastErrorCode === 'capture-failed' || hiperf.lastErrorCode === 'no-encoder') {
    hiperfFallback(hiperf.lastErrorCode, { fromClose: true })
    return
  }
  if (hiperf.lastErrorCode === 'ffmpeg-died' || code === 1011) {
    hiperfFallback('ffmpeg-died', { fromClose: true })
    return
  }
  hiperfFallback('hiperf-unreachable', { fromClose: true })
}

function hiperfStart(endpoint, opts) {
  const fromRetry = Boolean(opts && opts.fromRetry)
  if (!fromRetry) hiperf.retryAttempt = 0
  if (!hiperfApplies(endpoint) || engine.state.get().phase !== 'connected') {
    if ($hiperf.get().phase !== 'off') hiperfTeardown()
    return
  }
  const key = hiperfConfigKey(endpoint)
  const phase = $hiperf.get().phase
  if (
    !fromRetry &&
    hiperf.runningKey === key &&
    (phase === 'connecting' || phase === 'streaming' || phase === 'fallback')
  ) {
    return
  }
  if (!('VideoDecoder' in window)) {
    hiperfTeardown({ keepAtom: true })
    hiperf.runningKey = key
    hiperfPatch({ phase: 'fallback', code: 'webcodecs-unsupported', fps: 0, mbps: 0, rtt: 0, url: '' })
    return
  }
  const built = hiperfBuildUrl(endpoint)
  if (built.error) {
    hiperfTeardown({ keepAtom: true })
    hiperf.runningKey = key
    hiperf.url = built.url || ''
    hiperfPatch({ phase: 'fallback', code: built.error, fps: 0, mbps: 0, rtt: 0, url: hiperf.url })
    return
  }

  hiperfTeardown({ keepAtom: true })
  const gen = hiperf.generation
  hiperf.runningKey = key
  hiperf.url = built.url
  hiperf.intentionalClose = false
  hiperf.lastErrorCode = null
  hiperfPatch({ phase: 'connecting', code: null, fps: 0, mbps: 0, rtt: 0, url: built.url })

  let ws
  try {
    ws = new WebSocket(built.url)
  } catch {
    hiperfFallback('hiperf-unreachable')
    return
  }
  ws.binaryType = 'arraybuffer'
  hiperf.ws = ws
  ws.onopen = () => {
    if (gen !== hiperf.generation) return
    hiperfStartStats(gen)
  }
  ws.onmessage = event => {
    if (gen !== hiperf.generation) return
    if (event.data instanceof ArrayBuffer) {
      void hiperfOnBinary(gen, event.data)
      return
    }
    if (typeof event.data === 'string') {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      hiperfOnControl(gen, msg)
    }
  }
  ws.onclose = event => hiperfOnClose(gen, event)
  ws.onerror = () => {
    /* onclose follows */
  }
}

function hiperfStopQuiet() {
  if ($hiperf.get().phase === 'off' && !hiperf.ws && !hiperf.canvas) return
  hiperfTeardown()
}

function hiperfOnRfbConnected() {
  const endpoint = engine.endpoint
  if (!hiperfApplies(endpoint)) {
    hiperfStopQuiet()
    return
  }
  hiperfStart(endpoint)
}

function hiperfSyncFromSettings() {
  const endpoint = engine.endpoint
  const phase = engine.state.get().phase
  if (phase !== 'connected' || !hiperfApplies(endpoint)) {
    hiperfStopQuiet()
    return
  }
  hiperfStart(endpoint)
}

function hiperfManualRetry() {
  hiperf.retryAttempt = 0
  const endpoint = engine.endpoint
  if (engine.state.get().phase === 'connected' && hiperfApplies(endpoint)) {
    hiperfStart(endpoint, { fromRetry: true })
  }
}

function persistHiperfFields(endpoint) {
  const next = normalizeEndpoint(endpoint)
  if (!next || !next.id) return
  const settings = $settings.get()
  if (!settings.endpoints.some(item => item.id === next.id)) return
  const endpoints = settings.endpoints.map(item => (item.id === next.id ? next : item))
  persistSettings({ ...settings, endpoints })
  if (engine.currentEndpointId === next.id) engine.endpoint = next
}

function toggleHiperfEnabled(endpoint) {
  if (!endpoint || endpoint.mode !== 'websocket') return
  if (!hiperfConfigured(endpoint) && !endpoint.hiperfEnabled) {
    openHiperfEditor()
    return
  }
  persistHiperfFields({ ...endpoint, hiperfEnabled: !endpoint.hiperfEnabled })
}

function hiperfSetupCommand(os) {
  if (os === 'windows') return `irm ${RAW_REPO_URL}/hiperf-windows.ps1 | iex`
  if (os === 'linux') return `curl -fsSL ${RAW_REPO_URL}/hiperf-linux.sh | bash`
  return `curl -fsSL ${RAW_REPO_URL}/hiperf-mac.sh | bash`
}

function HiperfSetupHint({ os }) {
  const command = hiperfSetupCommand(os)
  const intro =
    os === 'windows'
      ? 'On that PC (Administrator PowerShell):'
      : os === 'linux'
        ? 'On that Linux machine:'
        : 'On that Mac:'
  return el(
    'div',
    { className: 'grid gap-1.5' },
    el('p', { className: 'text-[0.64rem] leading-4 text-(--ui-text-secondary)' }, intro),
    el(
      'div',
      {
        className: 'flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-1.5 py-1'
      },
      el(
        'code',
        { className: 'min-w-0 flex-1 truncate font-mono text-[0.62rem] text-(--ui-text-secondary)' },
        command
      ),
      el(CopyButton, { appearance: 'icon', buttonSize: 'icon-xs', text: command })
    ),
    el(
      'p',
      { className: 'text-[0.64rem] leading-4 text-(--ui-text-secondary)' },
      'The script prints a token — paste it above. Leave Stream URL empty unless you need an override.'
    )
  )
}

function HiperfHdToggle({ endpoint }) {
  const hiperfState = useValue($hiperf)
  if (!endpoint || endpoint.mode !== 'websocket') return null
  const streaming = hiperfState.phase === 'streaming'
  const enabled = Boolean(endpoint.hiperfEnabled)
  return el(
    'button',
    {
      type: 'button',
      title: enabled ? 'Disable HD stream' : 'Enable HD stream',
      'aria-label': 'HD',
      'aria-pressed': streaming || enabled,
      className: cn(
        'shrink-0 rounded-sm border-0 px-1.5 py-0.5 text-[0.72rem] font-medium',
        streaming
          ? 'bg-(--ui-accent) text-white'
          : enabled
            ? 'bg-(--ui-surface-hover) text-(--ui-text-secondary)'
            : 'bg-transparent text-(--ui-text-secondary) hover:bg-(--ui-surface-hover)'
      ),
      onClick: () => toggleHiperfEnabled(endpoint)
    },
    'HD'
  )
}


function Field({ label, hint, warn, children }) {
  return el(
    'div',
    { className: 'grid gap-1.5 text-[0.68rem] text-(--ui-text-secondary)' },
    el('div', { className: 'font-medium' }, label),
    children,
    hint
      ? el('p', { className: 'text-[0.64rem] leading-4 text-(--ui-text-quaternary)' }, hint)
      : null,
    warn ? el('p', { className: 'text-[0.64rem] leading-4 text-(--ui-text-secondary)' }, warn) : null
  )
}

function OrgoComputerFinder({ bearer, sessionUrl, onPick }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [computers, setComputers] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const genRef = useRef(0)

  async function findComputers() {
    const token = String(bearer || '').trim()
    if (!token) return
    const gen = ++genRef.current
    setLoading(true)
    setError('')
    setComputers([])
    setSelectedId('')
    try {
      const found = await discoverOrgoComputers(orgoApiOrigin(sessionUrl), token, sessionUrl)
      if (gen !== genRef.current) return
      const list = found && Array.isArray(found.computers) ? found.computers : []
      setComputers(list)
      if (list.length === 0) {
        const n = found && typeof found.workspaceCount === 'number' ? found.workspaceCount : 0
        setError(
          n === 0
            ? 'No workspaces for this key.'
            : `Found ${n} workspace(s) but no computers.`
        )
      }
    } catch (err) {
      if (gen !== genRef.current) return
      if (err && err.kind === 'auth') setError('This API key was rejected.')
      else setError("Couldn't reach the API from the app — set the API address in Advanced.")
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }

  const tokenReady = String(bearer || '').trim() !== ''

  return el(
    'div',
    { className: 'grid gap-1.5' },
    el(
      Button,
      {
        type: 'button',
        size: 'sm',
        variant: 'secondary',
        disabled: !tokenReady || loading,
        onClick: () => void findComputers()
      },
      'Find my computers'
    ),
    error
      ? el('p', { className: 'text-[0.64rem] leading-4 text-(--ui-text-secondary)' }, error)
      : null,
    computers.length > 0
      ? el(
          Field,
          { label: 'Computer' },
          el(
            Select,
            {
              value: selectedId || undefined,
              onValueChange: value => {
                setSelectedId(value)
                const computer = computers.find(item => item.computerId === value)
                if (computer) onPick(computer)
              }
            },
            el(SelectTrigger, { className: 'w-full' }, el(SelectValue, { placeholder: 'Pick a computer' })),
            el(
              SelectContent,
              {},
              computers.map(item =>
                el(
                  SelectItem,
                  { key: `${item.workspaceName}:${item.computerId}`, value: item.computerId },
                  `${item.workspaceName} / ${item.computerName} (${item.status})`
                )
              )
            )
          )
        )
      : null
  )
}

function localSetupCommand(os) {
  if (os === 'windows') return `irm ${RAW_REPO_URL}/connect-windows.ps1 | iex`
  if (os === 'linux') return `curl -fsSL ${RAW_REPO_URL}/connect-linux.sh | bash`
  return `curl -fsSL ${RAW_REPO_URL}/connect-mac.sh | bash`
}

function LocalSetupHint({ os }) {
  const command = localSetupCommand(os)
  const intro =
    os === 'windows'
      ? 'On that PC: run our setup script in an Administrator PowerShell:'
      : os === 'linux'
        ? 'On that Linux machine: run our setup script:'
        : "On that Mac: System Settings → Sharing → turn on Screen Sharing, and enable 'VNC viewers may control screen with password'. Then run our setup script:"
  return el(
    'div',
    { className: 'grid gap-1.5' },
    el('p', { className: 'text-[0.64rem] leading-4 text-(--ui-text-secondary)' }, intro),
    el(
      'div',
      {
        className:
          'flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-1.5 py-1'
      },
      el(
        'code',
        { className: 'min-w-0 flex-1 truncate font-mono text-[0.62rem] text-(--ui-text-secondary)' },
        command
      ),
      el(CopyButton, { appearance: 'icon', buttonSize: 'icon-xs', text: command })
    ),
    el(
      'p',
      { className: 'text-[0.64rem] leading-4 text-(--ui-text-secondary)' },
      'The script prints an address — paste it below.'
    )
  )
}

function EndpointEditor({
  draft,
  setDraft,
  highlight,
  onBack,
  onConnect,
  isNew,
  addKind,
  setAddKind,
  addOs,
  setAddOs,
  focusHiperf
}) {
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(focusHiperf))
  const [hiperfOs, setHiperfOs] = useState(addOs === 'windows' || addOs === 'linux' ? addOs : 'mac')
  const hiperfSectionRef = useRef(null)
  const advancedTouchedRef = useRef(false)

  useLayoutEffect(() => {
    if (!focusHiperf) return undefined
    setAdvancedOpen(true)
    const t = setTimeout(() => {
      const node = hiperfSectionRef.current
      if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
    }, 0)
    return () => clearTimeout(t)
  }, [focusHiperf])
  const classified = classifyAddress(draft.address)
  const mixed =
    (draft.mode === 'websocket' || classified.kind === 'websocket') && isInsecurePublicWs(draft.wsUrl)
  const localOs = addOs === 'windows' || addOs === 'linux' ? addOs : 'mac'

  function touchAdvanced(patch) {
    advancedTouchedRef.current = true
    const next = { ...draft, ...patch }
    if (
      patch.mode != null ||
      patch.wsUrl != null ||
      patch.iframeUrl != null ||
      patch.sessionUrl != null
    ) {
      next.probe = false
    }
    setDraft(next)
  }

  function touchHiperf(patch) {
    touchAdvanced(patch)
    const next = { ...draft, ...patch }
    if ($settings.get().endpoints.some(item => item.id === next.id)) persistHiperfFields(next)
  }

  function pickComputer(computer) {
    setDraft(current => {
      if (!current) return current
      return {
        ...current,
        sessionUrl: `${orgoApiOrigin(current.sessionUrl)}/api/computers/${computer.computerId}`,
        name: isDefaultishName(current.name) ? computer.computerName : current.name
      }
    })
  }

  function submit() {
    const address = String(draft.address || '').trim()
    const next =
      !advancedTouchedRef.current && classified.connectEnabled
        ? { ...draft, address, ...classified.patch }
        : { ...draft, address }
    onConnect(next)
  }

  function goBack() {
    if (isNew && addKind) setAddKind(null)
    else onBack()
  }

  if (isNew && !addKind) {
    return el(
      'div',
      { className: 'grid gap-3' },
      el(
        'p',
        { className: 'text-[0.68rem] leading-4 text-(--ui-text-secondary)' },
        'Where is this computer?'
      ),
      el(SegmentedControl, {
        className: 'w-full',
        options: KIND_OPTIONS,
        value: '__pick__',
        onChange: id => setAddKind(id)
      }),
      el(
        'div',
        { className: 'flex justify-end gap-2' },
        el(Button, { type: 'button', variant: 'ghost', onClick: onBack }, 'Back')
      )
    )
  }

  return el(
    'div',
    { className: 'grid gap-3' },
    el(Field, { label: 'Name' },
      el(Input, {
        value: draft.name,
        onChange: event => setDraft({ ...draft, name: event.target.value })
      })
    ),
    isNew && addKind === 'local'
      ? el(
          'div',
          { className: 'grid gap-2' },
          el(SegmentedControl, {
            className: 'w-full',
            options: OS_OPTIONS,
            value: localOs,
            onChange: id => setAddOs(id)
          }),
          el(LocalSetupHint, { os: localOs })
        )
      : null,
    el(Field, {
      label: 'Computer address',
      hint: classified.line,
      warn: mixed ? MIXED_CONTENT_HINT : null
    },
      el(Input, {
        value: draft.address || '',
        placeholder: "Paste your computer's address or API key",
        onChange: event => {
          advancedTouchedRef.current = false
          setDraft(withClassifiedAddress(draft, event.target.value))
        }
      })
    ),
    el(Field, { label: 'Password', hint: PASSWORD_CAVEAT },
      el(Input, {
        type: 'password',
        value: draft.password,
        className: highlight ? 'ring-2 ring-(--ui-accent)' : undefined,
        onChange: event => setDraft({ ...draft, password: event.target.value })
      })
    ),
    isNew && addKind === 'local' && localOs === 'mac'
      ? el(
          Field,
          { label: 'Username', hint: 'Your Mac login name' },
          el(Input, {
            value: draft.username || '',
            onChange: event => setDraft({ ...draft, username: event.target.value })
          })
        )
      : null,
    classified.kind === 'api-key'
      ? el(OrgoComputerFinder, {
          bearer: draft.sessionBearer,
          sessionUrl: draft.sessionUrl,
          onPick: pickComputer
        })
      : null,
    el(
      'div',
      { className: 'flex justify-end gap-2' },
      el(Button, { type: 'button', variant: 'ghost', onClick: goBack }, 'Back'),
      el(
        Button,
        { type: 'button', disabled: !classified.connectEnabled, onClick: submit },
        'Connect'
      )
    ),
    el(
      'div',
      { className: 'grid gap-3' },
      el(
        'button',
        {
          type: 'button',
          className:
            'flex w-fit items-center gap-1 border-0 bg-transparent p-0 text-[0.7rem] font-medium text-(--ui-text-secondary)',
          'aria-expanded': advancedOpen,
          onClick: () => setAdvancedOpen(open => !open)
        },
        advancedOpen ? '▾ Advanced' : '▸ Advanced'
      ),
      advancedOpen
        ? el(
            'div',
            { className: 'grid gap-3' },
            el(Field, { label: 'Mode' },
              el(SegmentedControl, {
                className: 'w-full',
                options: MODE_OPTIONS,
                value: draft.mode,
                onChange: id => touchAdvanced({ mode: id })
              })
            ),
            el(Field, {
              label: 'WebSocket URL',
              hint: 'e.g. ws://localhost:6080/websockify',
              warn: mixed ? MIXED_CONTENT_HINT : null
            },
              el(Input, {
                value: draft.wsUrl,
                placeholder: 'ws://localhost:6080/websockify',
                onChange: event => touchAdvanced({ wsUrl: event.target.value })
              })
            ),
            el(Field, { label: 'noVNC page URL', hint: 'e.g. http://127.0.0.1:6080/vnc.html' },
              el(Input, {
                value: draft.iframeUrl,
                placeholder: 'http://127.0.0.1:6080/vnc.html',
                onChange: event => touchAdvanced({ iframeUrl: event.target.value })
              })
            ),
            el(Field, {
              label: 'Session URL',
              hint: 'GET must return { "websocketUrl": "wss://…", "password": "…" }'
            },
              el(Input, {
                value: draft.sessionUrl,
                placeholder: 'https://example/api/session',
                onChange: event => touchAdvanced({ sessionUrl: event.target.value })
              })
            ),
            el(Field, { label: 'Bearer token (optional)' },
              el(Input, {
                type: 'password',
                value: draft.sessionBearer,
                onChange: event => touchAdvanced({ sessionBearer: event.target.value })
              })
            ),
            el(Field, { label: 'Username (some computers, like Macs, need your login)' },
              el(Input, {
                value: draft.username || '',
                onChange: event => touchAdvanced({ username: event.target.value })
              })
            ),
            el(
              'div',
              { className: 'flex items-center justify-between gap-3' },
              el('span', { className: 'text-[0.7rem] text-(--ui-text-secondary)' }, 'View only by default'),
              el(Switch, {
                size: 'xs',
                checked: Boolean(draft.viewOnlyDefault),
                onCheckedChange: value => touchAdvanced({ viewOnlyDefault: value })
              })
            ),
            el(
              'div',
              { className: 'flex items-center justify-between gap-3' },
              el('span', { className: 'text-[0.7rem] text-(--ui-text-secondary)' }, 'Connect when pane is visible'),
              el(Switch, {
                size: 'xs',
                checked: draft.autoConnect !== false,
                onCheckedChange: value => touchAdvanced({ autoConnect: value })
              })
            ),
            el(
              'div',
              { className: 'grid gap-1' },
              el(
                'div',
                { className: 'flex items-center justify-between gap-3' },
                el('span', { className: 'text-[0.7rem] text-(--ui-text-secondary)' }, 'Crop remote panel bar in thumbnail'),
                el(Switch, {
                  size: 'xs',
                  checked: draft.cropPanel === true,
                  onCheckedChange: value => touchAdvanced({ cropPanel: value })
                })
              ),
              el('p', { className: 'text-[0.64rem] leading-4 text-(--ui-text-quaternary)' }, 'Off by default. Prefer hiding the panel in the VM; crop can clip dock icons.')
            ),
            el(Field, { label: 'Scale' },
              el(SegmentedControl, {
                options: SCALE_OPTIONS,
                value: draft.scaleMode === 'native' ? 'native' : 'fit',
                onChange: id => touchAdvanced({ scaleMode: id })
              })
            ),
            draft.mode !== 'iframe'
              ? el(
                  'div',
                  { className: 'grid grid-cols-2 gap-2' },
                  el(Field, { label: 'Quality (0–9)' },
                    el(Input, {
                      type: 'number',
                      min: 0,
                      max: 9,
                      value: String(draft.qualityLevel),
                      onChange: event =>
                        touchAdvanced({ qualityLevel: clampInt(event.target.value, 0, 9, 7) })
                    })
                  ),
                  el(Field, { label: 'Compression (0–9)' },
                    el(Input, {
                      type: 'number',
                      min: 0,
                      max: 9,
                      value: String(draft.compressionLevel),
                      onChange: event =>
                        touchAdvanced({ compressionLevel: clampInt(event.target.value, 0, 9, 2) })
                    })
                  )
                )
              : null,
            el(
              'div',
              { ref: hiperfSectionRef, className: 'grid gap-3', 'data-hiperf-section': '' },
              el(
                'div',
                { className: 'flex items-center justify-between gap-3' },
                el('span', { className: 'text-[0.7rem] text-(--ui-text-secondary)' }, 'High-performance stream (HD)'),
                el(Switch, {
                  size: 'xs',
                  checked: Boolean(draft.hiperfEnabled),
                  onCheckedChange: value => touchHiperf({ hiperfEnabled: value })
                })
              ),
              el(
                'p',
                { className: 'text-[0.64rem] leading-4 text-(--ui-text-quaternary)' },
                'WebSocket endpoints only. VNC stays connected underneath and keeps input. iframe and Session JSON ignore this.'
              ),
              el(Field, {
                label: 'HD stream URL (optional)',
                hint: 'Leave empty to use ws://<vnc-host>:6090/stream after connect.',
                warn:
                  draft.hiperfUrl && isInsecurePublicWs(draft.hiperfUrl) ? MIXED_CONTENT_HINT : null
              },
                el(Input, {
                  value: draft.hiperfUrl || '',
                  placeholder: 'ws://host:6090/stream',
                  onChange: event => touchHiperf({ hiperfUrl: event.target.value })
                })
              ),
              el(Field, {
                label: 'HD token',
                hint: 'Pasted from the hiperf installer. If the URL already has ?token=, that wins.'
              },
                el(Input, {
                  type: 'password',
                  value: draft.hiperfToken || '',
                  onChange: event => touchHiperf({ hiperfToken: event.target.value })
                })
              ),
              el(
                'div',
                { className: 'grid gap-2' },
                el(SegmentedControl, {
                  className: 'w-full',
                  options: OS_OPTIONS,
                  value: hiperfOs,
                  onChange: id => setHiperfOs(id)
                }),
                el(HiperfSetupHint, { os: hiperfOs })
              )
            )
          )
        : null
    )
  )
}

function SettingsDialog({ profileName }) {
  const settings = useValue($settings)
  const ui = useValue($ui)
  const conn = useValue(engine.state)
  const [draft, setDraft] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [addKind, setAddKind] = useState(null)
  const [addOs, setAddOs] = useState('mac')
  const highlight = ui.highlightPassword || conn.code === 'password-required'

  useLayoutEffect(() => {
    if (!ui.settingsOpen) {
      setDraft(null)
      setDeleteId(null)
      setAddKind(null)
      setAddOs('mac')
      return
    }
    if (ui.settingsIntent === 'add') {
      setDraft(blankEndpoint())
      setAddKind(null)
      setAddOs('mac')
      setDeleteId(null)
      return
    }
    if (ui.settingsIntent === 'edit-hiperf') {
      const ep = resolveEndpoint()
      setDraft(ep ? { ...ep } : blankEndpoint())
      setAddKind(null)
      setAddOs('mac')
      setDeleteId(null)
      return
    }
    setDraft(current => {
      if (!current) return current
      return settings.endpoints.some(item => item.id === current.id) ? current : null
    })
    setAddKind(null)
  }, [ui.settingsOpen, ui.settingsIntent])

  const editing = draft
  const perBotValue = settings.perBotEndpoint[profileName] || '__global__'

  function saveAndConnect(nextDraft) {
    if (!nextDraft) return
    const nextEp = normalizeEndpoint(nextDraft)
    const endpoints = settings.endpoints.some(item => item.id === nextEp.id)
      ? settings.endpoints.map(item => (item.id === nextEp.id ? nextEp : item))
      : [...settings.endpoints, nextEp]
    const globalEndpointId = settings.globalEndpointId || nextEp.id
    persistSettings({ ...settings, endpoints, globalEndpointId })
    setDraft(null)
    setAddKind(null)
    setAddOs('mac')
    setUi({ settingsOpen: false, settingsIntent: 'list', highlightPassword: false })
    engine.reconnectAttempt = 0
    void connect(nextEp)
  }

  function removeEndpoint(id) {
    const endpoints = settings.endpoints.filter(item => item.id !== id)
    const perBotEndpoint = { ...settings.perBotEndpoint }
    for (const key of Object.keys(perBotEndpoint)) {
      if (perBotEndpoint[key] === id) delete perBotEndpoint[key]
    }
    const globalEndpointId = settings.globalEndpointId === id ? (endpoints[0] ? endpoints[0].id : null) : settings.globalEndpointId
    persistSettings({ ...settings, endpoints, perBotEndpoint, globalEndpointId })
    setDeleteId(null)
    if (engine.currentEndpointId === id) syncConnection()
  }

  return el(
    Dialog,
    {
      open: ui.settingsOpen,
      onOpenChange: open =>
        setUi({
          settingsOpen: open,
          settingsIntent: open ? ui.settingsIntent : 'list',
          highlightPassword: open ? ui.highlightPassword : false
        })
    },
    el(
      DialogContent,
      { className: 'max-w-lg', bodyClassName: 'gap-4' },
      el(
        DialogHeader,
        {},
        el(DialogTitle, {}, 'Computer endpoints'),
        el(DialogDescription, {}, 'Paste a computer address to connect. Passwords stay in plugin storage.')
      ),
      el(Field, { label: `Endpoint for ${profileName}` },
        el(
          Select,
          {
            value: perBotValue,
            onValueChange: value => {
              const perBotEndpoint = { ...settings.perBotEndpoint }
              if (!value || value === '__global__') delete perBotEndpoint[profileName]
              else perBotEndpoint[profileName] = value
              persistSettings({ ...settings, perBotEndpoint })
            }
          },
          el(SelectTrigger, { className: 'w-full' }, el(SelectValue, { placeholder: 'Use global default' })),
          el(
            SelectContent,
            {},
            el(SelectItem, { key: '__global__', value: '__global__' }, 'Use global default'),
            settings.endpoints.map(item =>
              el(SelectItem, { key: item.id, value: item.id }, item.name || 'Untitled')
            )
          )
        )
      ),
      el(Separator, {}),
      editing
        ? el(EndpointEditor, {
            key: draft.id,
            draft,
            setDraft,
            highlight,
            onBack: () => {
              setDraft(null)
              setAddKind(null)
              setAddOs('mac')
            },
            onConnect: saveAndConnect,
            isNew: !settings.endpoints.some(item => item.id === draft.id),
            addKind,
            setAddKind,
            addOs,
            setAddOs,
            focusHiperf: ui.settingsIntent === 'edit-hiperf'
          })
        : el(
            'div',
            { className: 'grid gap-2' },
            el('div', { className: 'text-[0.65rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)' }, 'Endpoints'),
            settings.endpoints.length === 0
              ? el('p', { className: 'text-[0.68rem] text-(--ui-text-tertiary)' }, 'None yet. Add a computer to get started.')
              : settings.endpoints.map(item =>
                  el(
                    'div',
                    {
                      key: item.id,
                      className:
                        'flex items-center gap-2 rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5'
                    },
                    el(
                      'div',
                      { className: 'min-w-0 flex-1' },
                      el('div', { className: 'truncate text-[0.75rem] font-medium' }, item.name),
                      el(
                        'div',
                        { className: 'flex items-center gap-1.5' },
                        el(Badge, { variant: 'muted' }, item.mode),
                        settings.globalEndpointId === item.id
                          ? el('span', { className: 'text-[0.62rem] text-(--ui-text-tertiary)' }, 'Default')
                          : null
                      )
                    ),
                    el(Button, {
                      type: 'button',
                      size: 'xs',
                      variant: 'ghost',
                      disabled: settings.globalEndpointId === item.id,
                      onClick: () => persistSettings({ ...settings, globalEndpointId: item.id })
                    }, 'Default'),
                    el(Button, {
                      type: 'button',
                      size: 'xs',
                      variant: 'secondary',
                      onClick: () => setDraft({ ...item })
                    }, 'Edit'),
                    el(Button, {
                      type: 'button',
                      size: 'icon-xs',
                      variant: 'ghost',
                      onClick: () => setDeleteId(item.id)
                    }, el(icons.Trash2, { className: 'size-3.5' }))
                  )
                ),
            el(Button, {
              type: 'button',
              size: 'sm',
              variant: 'secondary',
              onClick: () => {
                setDraft(blankEndpoint())
                setAddKind(null)
                setAddOs('mac')
              }
            }, el(icons.Plus, { className: 'size-3.5' }), 'Add endpoint')
          ),
      el(ConfirmDialog, {
        open: Boolean(deleteId),
        onClose: () => setDeleteId(null),
        onConfirm: () => removeEndpoint(deleteId),
        title: 'Delete endpoint?',
        description: 'This removes the saved URL and password from plugin storage.',
        confirmLabel: 'Delete',
        destructive: true
      })
    )
  )
}

function CollapsePill() {
  const btnRef = useRef(null)

  useLayoutEffect(() => {
    const node = btnRef.current
    if (!node) return undefined
    const handler = e => {
      e.stopPropagation()
      e.preventDefault()
      setExpanded(false)
    }
    node.addEventListener('pointerup', handler)
    node.addEventListener('click', handler)
    return () => {
      node.removeEventListener('pointerup', handler)
      node.removeEventListener('click', handler)
    }
  }, [])

  return el(
    'div',
    {
      className: 'absolute z-20',
      style: { top: 12, right: 16, zIndex: 40, pointerEvents: 'auto' },
      onPointerDown: e => e.stopPropagation()
    },
    el(
      'button',
      {
        ref: btnRef,
        type: 'button',
        title: 'Collapse',
        className:
          'flex cursor-pointer items-center justify-center rounded-full border-0 bg-black/50 p-2 text-white backdrop-blur hover:bg-black/70',
        'aria-label': 'Collapse computer view',
        onClick: () => setExpanded(false)
      },
      collapseArrowsIcon()
    )
  )
}

function OverlayBar({ iframeMode, connected, viewOnly }) {
  const ui = useValue($ui)
  const hiperfState = useValue($hiperf)
  if (iframeMode) {
    return el(
      'div',
      { className: 'flex flex-wrap items-center gap-1' },
      el(Button, { size: 'xs', variant: 'ghost', className: 'text-white hover:bg-white/15 hover:text-white', onClick: reloadIframe },
        el(icons.RefreshCw, { className: 'size-3.5' }), 'Reload'),
      el(Button, {
        size: 'xs',
        variant: 'ghost',
        className: 'text-white hover:bg-white/15 hover:text-white',
        onClick: () => {
          const url = engine.endpoint && engine.endpoint.iframeUrl
          if (url && pluginCtx) void pluginCtx.os.openExternal(url)
        }
      }, el(icons.ExternalLink, { className: 'size-3.5' }), 'Open in browser'),
      el(Button, {
        size: 'xs',
        variant: 'ghost',
        className: 'text-white hover:bg-white/15 hover:text-white',
        onClick: () => setExpanded(false)
      }, el(icons.X, { className: 'size-3.5' }), 'Collapse')
    )
  }
  return el(
    'div',
    { className: 'flex flex-wrap items-center gap-1.5' },
    el(
      'div',
      { className: 'flex items-center gap-1.5 px-1' },
      el('span', { className: 'text-[0.68rem] text-white/80' }, 'View only'),
      el(Switch, {
        size: 'xs',
        checked: viewOnly,
        onCheckedChange: value => {
          setUi({ viewOnly: value })
          applyRfbDisplay()
        }
      })
    ),
    el(SegmentedControl, {
      options: SCALE_OPTIONS,
      value: ui.scaleMode,
      onChange: id => {
        setUi({ scaleMode: id })
        applyRfbDisplay()
      }
    }),
    el(Button, {
      size: 'xs',
      variant: 'ghost',
      className: 'text-white hover:bg-white/15 hover:text-white disabled:text-white/40',
      disabled: !connected || viewOnly,
      onClick: () => void pasteClipboard()
    }, el(icons.Clipboard, { className: 'size-3.5' }), 'Paste'),
    el(Tip, { label: 'Ctrl+Alt+Del' },
      el(Button, {
        size: 'icon-xs',
        variant: 'ghost',
        className: 'text-white hover:bg-white/15 hover:text-white disabled:text-white/40',
        disabled: !connected || viewOnly,
        onClick: sendCtrlAltDel,
        'aria-label': 'Ctrl+Alt+Del'
      }, el(icons.Keyboard, { className: 'size-3.5' }))
    ),
    el(Tip, { label: 'Screenshot' },
      el(Button, {
        size: 'icon-xs',
        variant: 'ghost',
        className: 'text-white hover:bg-white/15 hover:text-white disabled:text-white/40',
        disabled: !connected,
        onClick: takeScreenshot,
        'aria-label': 'Screenshot'
      }, el(icons.FileImage, { className: 'size-3.5' }))
    ),
    el(Button, {
      size: 'xs',
      variant: 'ghost',
      className: 'text-white hover:bg-white/15 hover:text-white',
      onClick: reconnect
    }, el(icons.RefreshCw, { className: 'size-3.5' }), 'Reconnect'),
    el(Button, {
      size: 'xs',
      variant: 'ghost',
      className: 'text-white hover:bg-white/15 hover:text-white',
      onClick: () => userDisconnect()
    }, 'Disconnect'),
    el(Button, {
      size: 'xs',
      variant: 'ghost',
      className: 'text-white hover:bg-white/15 hover:text-white',
      onClick: () => setExpanded(false)
    }, el(icons.X, { className: 'size-3.5' }), 'Collapse'),
    hiperfState.phase === 'streaming'
      ? el(
          'span',
          { className: 'px-1 text-[0.68rem] text-white/80' },
          `${hiperfState.fps}fps · ${formatHiperfMbps(hiperfState.mbps)}Mbps · ${hiperfState.rtt}ms`
        )
      : null
  )
}

function ComputerOverlay({ iframeMode }) {
  const ui = useValue($ui)
  const conn = useValue(engine.state)
  const overlayRef = useRef(null)
  const mountRef = useRef(null)

  useLayoutEffect(() => {
    engine.overlayRootEl = overlayRef.current
    engine.overlayMountEl = mountRef.current
    const node = overlayRef.current
    const portal = getSdkPortal()
    let reactParent = null
    if (!portal && node && node.parentNode !== document.body) {
      reactParent = node.parentNode
      document.body.appendChild(node)
    }
    placeLive()
    return () => {
      engine.overlayMountEl = null
      engine.overlayRootEl = null
      if (portal || !node || node.parentNode !== document.body) return
      try {
        if (reactParent && reactParent.isConnected) reactParent.appendChild(node)
        else document.body.removeChild(node)
      } catch (_) {
        // Parent already gone or React will throw removeChild; don't leak the body node.
      }
    }
  }, [])

  useLayoutEffect(() => {
    engine.overlayMountEl = mountRef.current
    placeLive()
  }, [ui.expanded, conn.phase])

  useLayoutEffect(() => {
    if (!ui.expanded) return undefined
    const top = measureTitlebarHeight()
    if ($ui.get().overlayTop !== top) setUi({ overlayTop: top })
    return undefined
  }, [ui.expanded])

  useEffect(() => {
    if (!ui.expanded) return undefined
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setExpanded(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui.expanded])

  useEffect(() => {
    if (!ui.expanded) return undefined
    const arm = () => {
      setUi({ chromeOn: true })
      if (engine.chromeTimer) clearTimeout(engine.chromeTimer)
      engine.chromeTimer = setTimeout(() => setUi({ chromeOn: false }), CHROME_IDLE_MS)
    }
    arm()
    return () => {
      if (engine.chromeTimer) clearTimeout(engine.chromeTimer)
    }
  }, [ui.expanded])

  const collapsePill = useMemo(() => el(CollapsePill), [])

  const overlay = el(
    'div',
    {
      ref: overlayRef,
      'data-overlay-surface': ui.expanded ? '' : undefined,
      className: cn(
        'fixed right-0 bottom-0 left-0 z-[9999] flex flex-col bg-black',
        ui.expanded ? 'pointer-events-auto' : 'hidden pointer-events-none'
      ),
      style: { top: `${ui.overlayTop || 40}px`, zIndex: 9999, background: '#000' },
      onMouseMove: () => {
        if (!ui.expanded) return
        setUi({ chromeOn: true })
        if (engine.chromeTimer) clearTimeout(engine.chromeTimer)
        engine.chromeTimer = setTimeout(() => setUi({ chromeOn: false }), CHROME_IDLE_MS)
      }
    },
    el('div', {
      ref: mountRef,
      className: 'min-h-0 min-w-0 flex-1',
      style: { overflow: ui.expanded && ui.scaleMode === 'native' ? 'auto' : 'hidden' }
    }),
    el(
      'div',
      {
        className: cn(
          'absolute inset-x-0 top-0 z-10 flex justify-center p-3 pr-16 transition-opacity duration-200',
          ui.chromeOn ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )
      },
      el(
        'div',
        { className: 'rounded-lg bg-black/70 p-1 backdrop-blur-sm' },
        el(OverlayBar, {
          iframeMode,
          connected: conn.phase === 'connected',
          viewOnly: ui.viewOnly
        })
      )
    ),
    collapsePill
  )

  const portal = getSdkPortal()
  return portal ? portal(overlay, document.body) : overlay
}

function chevronDownIcon() {
  const Icon = icons.ChevronDown || icons.ChevronsUpDown
  if (Icon) return el(Icon, { className: 'size-3 shrink-0 text-(--ui-text-tertiary)', 'aria-hidden': true })
  return el('span', { className: 'shrink-0 text-[0.65rem] text-(--ui-text-tertiary)', 'aria-hidden': true }, '▾')
}

function checkIcon() {
  const Icon = icons.Check
  if (Icon) return el(Icon, { className: 'ml-auto size-3.5 shrink-0', 'aria-hidden': true })
  return el('span', { className: 'ml-auto text-[0.62rem] text-(--ui-text-tertiary)' }, 'Active')
}

function ComputerSwitcher({ endpoints, current, conn }) {
  const hiperfState = useValue($hiperf)
  const nameLabel = current ? current.name : 'Computer'
  return el(
    DropdownMenu,
    {},
    el(
      DropdownMenuTrigger,
      {
        type: 'button',
        title: conn.desktopName || undefined,
        'aria-label': 'Switch computer',
        className:
          'flex min-w-0 flex-1 items-center gap-1 rounded-sm border-0 bg-transparent py-0.5 pl-0.5 pr-1 text-left text-[0.72rem] hover:bg-(--ui-surface-hover)'
      },
      el(StatusDot, { tone: toneFor(conn.phase, conn.attempt) }),
      el('span', { className: 'min-w-0 truncate font-medium' }, nameLabel),
      hiperfState.phase === 'streaming' ? el(Badge, { variant: 'muted', className: 'shrink-0' }, 'HD') : null,
      chevronDownIcon()
    ),
    el(
      DropdownMenuContent,
      { align: 'start', className: 'min-w-44' },
      endpoints.map(item => {
        const active = Boolean(current && item.id === current.id)
        return el(
          DropdownMenuItem,
          {
            key: item.id,
            onSelect: () => switchComputer(item.id)
          },
          el(StatusDot, { tone: active ? toneFor(conn.phase, conn.attempt) : 'muted' }),
          el('span', { className: 'min-w-0 flex-1 truncate' }, item.name || 'Untitled'),
          active ? checkIcon() : null
        )
      }),
      current
        ? el(DropdownMenuItem, { onSelect: () => userDisconnect(current.id) }, 'Disconnect')
        : null,
      endpoints.length > 0 || current ? el(DropdownMenuSeparator) : null,
      el(DropdownMenuItem, { onSelect: () => openAddComputer() }, '＋ Add computer'),
      el(DropdownMenuItem, { onSelect: () => openManageComputers() }, 'Manage computers…')
    )
  )
}

function PaneError({ code, detail }) {
  return el(
    ErrorState,
    {
      className: 'px-2 py-3',
      title: errorTitle(code),
      description: detail || (ERRORS[code] && ERRORS[code].body) || ''
    },
    el(
      'div',
      { className: 'flex justify-center gap-2' },
      el(Button, { size: 'xs', onClick: reconnect }, 'Reconnect'),
      el(Button, { size: 'xs', variant: 'secondary', onClick: () => openSettings() },
        el(icons.Settings, { className: 'size-3.5' }), 'Settings')
    )
  )
}

function ComputerPane() {
  const settings = useValue($settings)
  const ui = useValue($ui)
  const conn = useValue(engine.state)
  const hiperfState = useValue($hiperf)
  const lastFrames = useValue($lastFrames)
  const placeTick = useValue($placeTick)
  const focused = useValue(safeAtom(host.state.focusedSessionProfile))
  const profile = useValue(safeAtom(host.state.profile))
  const viewport = useValue(safeAtom(host.state.viewport))
  const profileName = focused || profile || 'default'
  const overrideId = settings.perBotEndpoint ? settings.perBotEndpoint[profileName] : null
  const endpointId = overrideId || settings.globalEndpointId
  const endpoint = endpointId ? settings.endpoints.find(item => item.id === endpointId) || null : null
  const slotRef = useRef(null)
  const iframeMode = Boolean(endpoint && endpoint.mode === 'iframe')
  const aspect = conn.fbW && conn.fbH ? `${conn.fbW} / ${conn.fbH}` : '16 / 10'
  const busy =
    conn.phase === 'connecting' || conn.phase === 'resolving' || conn.phase === 'loading-novnc'

  useEffect(() => {
    engine.paneVisible = true
    if ($settings.get().ui && $settings.get().ui.lastExpanded) setExpanded(true)
    syncConnection()
    return () => {
      engine.paneVisible = false
      setExpanded(false)
      disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    engine.slotEl = slotRef.current
    placeLive()
  }, [ui.expanded, conn.phase, conn.fbW, conn.fbH, placeTick, iframeMode, viewport, endpoint && endpoint.cropPanel])

  useEffect(() => {
    applyRfbDisplay()
    syncSurfacePointer()
  }, [ui.expanded, ui.viewOnly, ui.scaleMode, conn.phase, conn.fbW, conn.fbH, endpoint && endpoint.cropPanel])

  const unconfigured = !endpoint || conn.phase === 'unconfigured'
  const showError = conn.phase === 'error'
  const snapshot = endpoint && lastFrames[endpoint.id]
  const showSnapshot = Boolean(snapshot && conn.phase !== 'connected' && !unconfigured)
  const hiperfLine = hiperfStatusLine(hiperfState)

  return el(
    'div',
    { className: 'relative flex h-full min-h-0 flex-col overflow-auto' },
    el(
      'header',
      { className: 'flex h-8 shrink-0 items-center gap-1 px-2' },
      el(ComputerSwitcher, {
        endpoints: settings.endpoints,
        current: endpoint,
        conn
      }),
      el(HiperfHdToggle, { endpoint }),
      endpoint &&
        conn.phase !== 'unconfigured' &&
        conn.phase !== 'idle' &&
        !(conn.phase === 'disconnected' && !conn.attempt)
        ? el(
            Button,
            {
              type: 'button',
              size: 'xs',
              variant: 'ghost',
              className: 'shrink-0',
              title: 'Disconnect',
              'aria-label': 'Disconnect',
              onClick: () => userDisconnect(endpoint.id)
            },
            'Disconnect'
          )
        : null
    ),
    el(
      'div',
      { className: 'shrink-0 px-2.5 pb-2' },
      el(
        'div',
        {
          className: 'group relative w-full overflow-hidden rounded-[8px] border border-(--ui-stroke-secondary)',
          style: { aspectRatio: aspect }
        },
        el('div', { ref: slotRef, className: 'absolute inset-0 bg-black' }),
        showSnapshot
          ? el(
              'div',
              { className: 'pointer-events-none absolute inset-0' },
              el('img', {
                src: snapshot,
                alt: '',
                className: 'h-full w-full object-contain opacity-40'
              }),
              el(
                'div',
                { className: 'absolute inset-x-0 bottom-1.5 flex justify-center' },
                el(
                  'span',
                  {
                    className:
                      'rounded-full bg-black/55 px-2 py-0.5 text-[0.62rem] text-white'
                  },
                  'last seen'
                )
              )
            )
          : null,
        busy
          ? el(
              'div',
              { className: 'absolute inset-0 grid place-items-center bg-(--ui-editor-surface-background)/80' },
              el(Loader, { className: 'size-5', label: phaseLine(conn), type: 'lemniscate-bloom' })
            )
          : null,
        unconfigured
          ? el(
              'div',
              { className: 'absolute inset-0 flex flex-col items-center justify-center gap-2 bg-(--ui-editor-surface-background) px-3' },
              el(EmptyState, {
                className: 'min-h-0',
                title: 'No computer endpoint configured',
                description: ERRORS.unconfigured.body
              }),
              el(Button, { size: 'xs', onClick: () => openAddComputer() }, 'Add a computer')
            )
          : null,
        !unconfigured && !busy && conn.phase !== 'connected' && !showError && !showSnapshot
          ? el(
              'div',
              { className: 'pointer-events-none absolute inset-0 grid place-items-center' },
              el('p', { className: 'text-[0.68rem] text-(--ui-text-tertiary)' }, phaseLine(conn))
            )
          : null,
        !unconfigured
          ? el(
              'button',
              {
                type: 'button',
                className:
                  'absolute inset-0 flex cursor-pointer items-center justify-center border-0 bg-black/0 p-0 appearance-none text-white opacity-0 transition-[background-color,opacity] duration-150 group-hover:bg-black/40 group-hover:opacity-100',
                'aria-label': 'Expand computer view',
                onClick: () => setExpanded(true)
              },
              el(
                'span',
                {
                  className:
                    'pointer-events-none flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-[0.75rem] font-medium text-white shadow-sm backdrop-blur'
                },
                expandArrowsIcon(),
                'Open'
              )
            )
          : null
      ),
      el('p', { className: 'mt-1.5 truncate text-center text-[0.68rem] text-(--ui-text-tertiary)' }, phaseLine(conn)),
      hiperfLine
        ? el(
            'div',
            { className: 'mt-0.5 flex items-center justify-center gap-1.5' },
            el('p', { className: 'truncate text-center text-[0.64rem] text-(--ui-text-tertiary)' }, hiperfLine),
            hiperfState.phase === 'fallback'
              ? el(Button, { size: 'xs', variant: 'ghost', onClick: hiperfManualRetry }, 'Retry')
              : null
          )
        : null,
      showError ? el(PaneError, { code: conn.code, detail: conn.detail }) : null,
      iframeMode && !unconfigured
        ? el(
            'div',
            { className: 'mt-2 flex flex-wrap justify-center gap-1.5' },
            el(Button, { size: 'xs', variant: 'secondary', onClick: reloadIframe }, 'Reload'),
            el(Button, {
              size: 'xs',
              variant: 'secondary',
              onClick: () => {
                if (endpoint && pluginCtx) void pluginCtx.os.openExternal(endpoint.iframeUrl)
              }
            }, 'Open in browser'),
            el(Button, { size: 'xs', variant: 'secondary', onClick: toggleExpanded }, 'Expand')
          )
        : null,
      !unconfigured && (conn.phase === 'idle' || conn.phase === 'disconnected')
        ? el(
            'div',
            { className: 'mt-2 flex justify-center' },
            el(Button, { size: 'xs', variant: 'secondary', onClick: reconnect }, 'Connect')
          )
        : null
    ),
    el(SettingsDialog, { profileName }),
    el(ComputerOverlay, { iframeMode })
  )
}

function ComputerStatusItem() {
  const conn = useValue(engine.state)
  return el(
    'button',
    {
      type: 'button',
      className: 'flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs hover:bg-(--ui-surface-hover)',
      'aria-label': 'Computer',
      onClick: togglePane
    },
    el(StatusDot, { tone: toneFor(conn.phase, conn.attempt) }),
    el('span', {}, 'Computer')
  )
}

export default {
  id: PLUGIN_ID,
  name: 'Computer',
  defaultEnabled: true,
  description: 'Live remote desktop viewer (VNC / noVNC) docked on the right.',
  register(ctx) {
    attachEngine(ctx)
    ctx.registerMany([
      {
        id: 'pane',
        area: PANES_AREA,
        title: 'Computer',
        data: {
          placement: 'right',
          width: '320px',
          dock: { pane: 'cronjobs', pos: 'top' },
          height: '260px'
        },
        render: () => el(ComputerPane, { ctx })
      },
      {
        id: 'status',
        area: STATUSBAR_AREAS.right,
        order: 120,
        render: () => el(ComputerStatusItem, { ctx })
      },
      {
        id: 'palette-toggle',
        area: PALETTE_AREA,
        data: {
          id: 'computer-viewer.toggle',
          label: 'Computer: Toggle Pane',
          keywords: ['computer', 'desktop', 'vnc', 'screen'],
          run: () => togglePane()
        }
      },
      {
        id: 'palette-reconnect',
        area: PALETTE_AREA,
        data: {
          id: 'computer-viewer.reconnect',
          label: 'Computer: Reconnect',
          keywords: ['computer', 'reconnect', 'vnc'],
          run: () => reconnect()
        }
      },
      {
        id: 'palette-disconnect',
        area: PALETTE_AREA,
        data: {
          id: 'computer-viewer.disconnect',
          label: 'Computer Viewer: Disconnect current',
          keywords: ['computer', 'disconnect', 'vnc', 'viewer'],
          run: () => userDisconnect()
        }
      },
      {
        id: 'kb-expand',
        area: KEYBINDS_AREA,
        data: {
          id: 'computer-viewer.expand',
          label: 'Expand computer view',
          category: 'Computer',
          defaults: ['mod+shift+d'],
          run: () => toggleExpanded()
        }
      }
    ])
  }
}
