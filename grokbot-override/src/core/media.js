// Owner-safe media in a bot's messages (PARITY C15, C13 tool images).
//
// The app's renderer resolves `MEDIA:` paths and local image links against
// the ACTIVE gateway (lib/chat-messages/parts.ts renderMediaTags ->
// lib/media.ts), which is the wrong machine for a bot on another connection.
// So the text still goes through the SDK renderer in its inert mode, and the
// media it names are lifted out here and read from the bot's OWN backend, the
// way the app reads a tile owned by another gateway: lib/media.ts
// resolveMediaDisplaySrc (:113-165) pins `/api/fs/read-data-url?path=` to the
// owner's connection and profile, and an explicit local owner reads through
// the native file bridge. Parsing follows parts.ts (MEDIA_LINE_RE /
// MEDIA_TAG_RE, unquoteMediaPath, splitTrailingPunctuation,
// isPlausibleMediaPath) and media.ts MEDIA_BY_EXT (Hermes Agent, MIT,
// (c) Nous Research, commit 2bd378ed1b).

const MEDIA_BY_EXT = {
  avi: 'video', bmp: 'image', flac: 'audio', gif: 'image', jpeg: 'image', jpg: 'image', m4a: 'audio',
  mkv: 'video', mov: 'video', mp3: 'audio', mp4: 'video', ogg: 'audio', opus: 'audio', png: 'image',
  svg: 'image', wav: 'audio', webm: 'video', webp: 'image'
}

export function mediaKind(path) {
  const ext = String(path || '').split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase()
  return (ext && MEDIA_BY_EXT[ext]) || 'file'
}

export function mediaName(path) {
  const clean = String(path || '').split(/[?#]/, 1)[0].replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).pop() || clean
}

const TRAILING = '.,;:!?'
const plausible = value => value.includes('/') || value.includes('\\') || /\.[^.]/.test(value)

function unquote(value) {
  const trimmed = String(value || '').trim()
  const q = trimmed[0]
  if (q && q === trimmed.at(-1) && ['"', "'", '`'].includes(q) && trimmed.length > 1) return { path: trimmed.slice(1, -1), quoted: true }
  const last = trimmed.at(-1)
  return { path: last === '`' || last === '"' ? trimmed.slice(0, -1) : trimmed, quoted: false }
}

function splitPunctuation(value) {
  let end = value.length
  while (end > 0 && TRAILING.includes(value[end - 1]) && plausible(value.slice(0, end - 1))) end -= 1
  return { path: value.slice(0, end), punctuation: value.slice(end) }
}

const MEDIA_LINE_RE = /(^|\n)[\t ]*[`"']?MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s`"]+)[`"']?[\t ]*(?=\n|$)/g
const MEDIA_TAG_RE = /[`"']?MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s`"]+)[`"']?/g
const MD_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const FILE_PATH_RE = /^(?:file:|\/|~\/|[A-Za-z]:[\\/]|\\\\)/

/** A local `file:` URL becomes the path the owner's fs routes open. */
export function filePath(path) {
  const value = String(path || '')
  if (!/^file:/i.test(value)) return value
  try {
    const url = new URL(value)
    const decoded = decodeURIComponent(url.pathname)
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return value.replace(/^file:\/\//i, '')
  }
}

/**
 * Lift media out of a message. Returns `{ text, media }`: `text` with each
 * `MEDIA:` line removed, an inline `MEDIA:` tag replaced by the file's name,
 * and a local-path markdown image replaced by its alt text; `media` lists
 * `{ path, kind, name, remote }` in order (deduplicated), `remote` = an
 * http(s) image the text linked.
 */
export function extractMedia(text) {
  const media = []
  const seen = new Set()
  const add = (path, remote = false) => {
    const clean = remote ? path : filePath(path)
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    media.push({ path: clean, kind: remote ? 'image' : mediaKind(clean), name: mediaName(clean), remote })
  }
  const take = raw => {
    const { path: unq, quoted } = unquote(raw)
    const { path, punctuation } = quoted ? { path: unq, punctuation: '' } : splitPunctuation(unq)
    return plausible(path) ? { path, punctuation } : null
  }
  let out = String(text || '').replace(MEDIA_LINE_RE, (whole, lead, value) => {
    const hit = take(value)
    if (!hit) return whole
    add(hit.path)
    return lead
  })
  out = out.replace(MEDIA_TAG_RE, (whole, value) => {
    const hit = take(value)
    if (!hit) return whole
    add(hit.path)
    return `${mediaName(hit.path)}${hit.punctuation}`
  })
  out = out.replace(MD_IMAGE_RE, (whole, alt, src) => {
    if (/^https?:\/\//i.test(src)) {
      add(src, true)
      return alt ? `*${alt}*` : ''
    }
    if (FILE_PATH_RE.test(src)) {
      add(src)
      return alt ? `*${alt}*` : ''
    }
    return whole
  })
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), media }
}

/** The host a remote image would be fetched from, as the user should see it
 *  before choosing to load it ('' when the URL does not parse). */
export function remoteImageHost(url) {
  try {
    return new URL(String(url)).host
  } catch {
    return ''
  }
}

/** The REST request that reads `path` from the bot's own backend
 *  (resolveMediaDisplaySrc's owner-pinned branch). `scope` = botRestScope. */
export function mediaReadRequest(path, scope) {
  return {
    path: `/api/fs/read-data-url?path=${encodeURIComponent(filePath(path))}`,
    ...(scope?.connectionId ? { connectionId: scope.connectionId } : {}),
    ...(scope?.profile ? { profile: scope.profile } : {})
  }
}

// ── file cards (a non-media file the bot sends: ui/Media.tsx FileCard) ──

/** "240 B", "1.8kB", "24kB", "3.1MB" (decimal units, as Finder shows). */
export function formatBytes(bytes) {
  const n = Math.max(0, Math.round(Number(bytes) || 0))
  if (n < 1000) return `${n} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = n / 1000
  let unit = 0
  for (;;) {
    const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
    if (shown < 1000 || unit === units.length - 1) return `${String(shown)}${units[unit]}`
    value /= 1000
    unit += 1
  }
}

/** A long file name cut in the middle, keeping its extension:
 *  "hermes-handoff-notes.md" -> "hermes-ha….md". */
export function middleTruncate(name, max = 14) {
  const value = String(name || '')
  if (value.length <= max) return value
  const dot = value.lastIndexOf('.')
  const ext = dot > 0 && value.length - dot <= 8 ? value.slice(dot) : ''
  const head = Math.max(1, max - ext.length - 1)
  return `${value.slice(0, head)}…${ext}`
}

const TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'xml',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'css', 'scss', 'html', 'htm', 'vue', 'svelte', 'lua', 'r', 'diff', 'patch'
])

/** 'markdown' (rendered), 'text' (monospace) or '' (not previewed: click saves). */
export function previewKind(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || ''
  if (!String(name || '').includes('.')) return ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  return TEXT_EXT.has(ext) ? 'text' : ''
}

function dataUrlParts(url) {
  const value = String(url || '')
  const comma = value.indexOf(',')
  if (!value.startsWith('data:') || comma < 0) return null
  return { base64: /;base64$/i.test(value.slice(0, comma)), body: value.slice(comma + 1) }
}

/** The byte size of a data: URL's payload (null when it is not one). */
export function dataUrlBytes(url) {
  const parts = dataUrlParts(url)
  if (!parts) return null
  if (parts.base64) {
    const clean = parts.body.replace(/\s+/g, '')
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad)
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(parts.body)).length
  } catch {
    return parts.body.length
  }
}

/** A data: URL's payload as UTF-8 text ('' when it is not one). */
export function dataUrlText(url) {
  const parts = dataUrlParts(url)
  if (!parts) return ''
  try {
    if (!parts.base64) return decodeURIComponent(parts.body)
    const binary = atob(parts.body.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}
