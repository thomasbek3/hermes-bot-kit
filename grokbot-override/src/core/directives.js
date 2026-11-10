// Live `::card{…}` and `::preview{…}` directives in the open Bot Chat
// (Cards 7, part 3). Pure helpers; the UI is src/ui/Directives.tsx.
//
// Stock draws both through its transcript-directive slot, which takes the
// session and the machine from the ACTIVE chat (agent-cards reads
// host.state.cwd / connectionId / profile; the preview directive reads the
// focused session view), so it cannot be pointed at a bot this screen shows
// without activating it. These helpers let the override draw them from the
// bot's OWN session instead, on the same contracts:
//
//  - grammar: `::name{key="value" …}` where a word can start, brace body on
//    one line (apps/desktop/src/lib/transcript-directives.ts, Hermes Agent,
//    MIT); unquoted `key=value` is accepted too. Only `card` and `preview`
//    are claimed; any other name, and anything inside a code fence or inline
//    code, stays the prose it was.
//  - card files: `card.v1` JSON at a workspace-relative path, validated as
//    the agent-cards skill and plugin define it (kinds task / draft-email /
//    approval, at most 3 actions, `send` up to 500 chars, file up to 32 KB).
//  - preview: a workspace HTML file shown in a sandboxed frame
//    (`sandbox="allow-scripts"`, no same-origin), with a size report and the
//    `window.hermes.send` / `data-hermes-send` voice, as stock's
//    inline-preview-directive.tsx does: token-gated, 500 chars, one per
//    second, every intent acked.
//
// Files are read from the bot's machine by REST relative to its session
// (`/api/fs/read-text?path=<rel>&session_id=<stored id>`, which resolves
// against that session's own working directory), and button clicks and
// widget intents go back to the bot's chat as a hidden user turn
// (`prompt.submit {display_kind: 'hidden'}`, stock submit.ts).

export const DIRECTIVE_NAMES = Object.freeze(['card', 'preview'])
const BODY_MAX = 2048
const DIRECTIVE_RE = new RegExp(String.raw`(^|\s)::(card|preview)\{([^{}\n]{0,${BODY_MAX}})\}`, 'g')
const ATTR_RE = /([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)'|([^\s"'{}]+))/gi
const FENCE_RE = /^\s{0,3}(```+|~~~+)/

/** `key="value"` pairs (single quotes and bare values too); keys lowercased. */
export function parseDirectiveAttrs(body) {
  const attrs = {}
  for (const pair of String(body || '').matchAll(ATTR_RE)) {
    attrs[pair[1].toLowerCase()] = (pair[2] ?? pair[3] ?? pair[4] ?? '').replace(/^<(https?:\/\/[^<>\s]+)>$/i, '$1')
  }
  return attrs
}

/** Split a finished message into prose and claimed directives, in order:
 *  `[{ kind: 'prose', text } | { kind: 'directive', name, attrs, source }]`.
 *  Null when it holds none (render the text as it always was). */
export function splitDirectives(text) {
  const raw = String(text || '')
  if (!raw.includes('::')) return null
  const out = []
  let prose = ''
  let found = false
  let fence = ''
  const push = chunk => {
    prose += chunk
  }
  const flush = () => {
    if (prose.trim()) out.push({ kind: 'prose', text: prose.replace(/^\n+|\s+$/g, '') })
    prose = ''
  }
  const lines = raw.split('\n')
  lines.forEach((line, index) => {
    const nl = index < lines.length - 1 ? '\n' : ''
    const fenceMark = FENCE_RE.exec(line)
    if (fence) {
      if (fenceMark && fenceMark[1][0] === fence[0] && fenceMark[1].length >= fence.length) fence = ''
      push(line + nl)
      return
    }
    if (fenceMark) {
      fence = fenceMark[1]
      push(line + nl)
      return
    }
    let last = 0
    let hit = false
    for (const match of line.matchAll(DIRECTIVE_RE)) {
      const start = match.index + match[1].length
      // Inside inline code (an odd number of backticks before it): prose.
      if ((line.slice(0, start).match(/`/g) || []).length % 2 === 1) continue
      push(line.slice(last, start))
      flush()
      out.push({ kind: 'directive', name: match[2], attrs: parseDirectiveAttrs(match[3]), source: line.slice(start, match.index + match[0].length) })
      last = match.index + match[0].length
      hit = true
      found = true
    }
    push(hit ? line.slice(last).trim() ? line.slice(last) + nl : nl : line + nl)
  })
  flush()
  return found ? out : null
}

/** A workspace-relative path, normalised; null for anything absolute, a URL,
 *  a home path, or one that climbs out with `..` (agent-cards
 *  normalizeWorkspaceRel). */
export function workspaceRelPath(file) {
  if (typeof file !== 'string') return null
  const raw = file.trim()
  if (!raw) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null
  if (raw.startsWith('/') || raw.startsWith('\\') || raw.startsWith('~')) return null
  const parts = []
  for (const part of raw.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return parts.length ? parts.join('/') : null
}

/** The REST read of a workspace file of the bot's session. */
export function workspaceReadRequest(rel, sessionId, scope) {
  return {
    path: `/api/fs/read-text?path=${encodeURIComponent(rel)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ''}`,
    timeoutMs: 5000,
    ...(scope?.connectionId ? { connectionId: scope.connectionId } : {}),
    ...(scope?.profile ? { profile: scope.profile } : {})
  }
}

// ── card.v1 ───────────────────────────────────────────────────────────────

export const CARD_KINDS = Object.freeze(['task', 'draft-email', 'approval'])
const CARD_STATES = ['pending', 'running', 'done', 'error', 'awaiting-approval']
export const MAX_SEND_CHARS = 500
export const MAX_CARD_CHARS = 32768
const MAX_ACTIONS = 3
const ACTION_STYLES = ['primary', 'danger']

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const filled = value => typeof value === 'string' && value.trim().length > 0
const text = value => (typeof value === 'string' ? value : '')

function bodyItem(item) {
  if (!isObject(item)) return null
  if (item.type === 'text') return typeof item.text === 'string' ? { type: 'text', text: item.text } : null
  if (item.type === 'kv' && Array.isArray(item.rows)) {
    return { type: 'kv', rows: item.rows.filter(r => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string').map(r => [r[0], r[1]]) }
  }
  if (item.type === 'fields' && Array.isArray(item.items)) {
    return { type: 'fields', items: item.items.filter(f => isObject(f) && typeof f.label === 'string' && typeof f.value === 'string').map(f => ({ label: f.label, value: f.value })) }
  }
  return null
}

/** A `card.v1` object as the card draws it, or null when it is not one. */
export function validateCard(value) {
  if (!isObject(value) || value.schema !== 'card.v1' || !CARD_KINDS.includes(value.kind) || !filled(value.title)) return null
  if (!isObject(value.status) || !CARD_STATES.includes(value.status.state)) return null
  if (value.body !== undefined && !Array.isArray(value.body)) return null
  if (value.email !== undefined && !isObject(value.email)) return null
  if (value.actions !== undefined && !Array.isArray(value.actions)) return null
  if (value.resolved !== undefined && value.resolved !== null && (!isObject(value.resolved) || !filled(value.resolved.action))) return null
  const actions = []
  for (const action of value.actions || []) {
    if (actions.length >= MAX_ACTIONS) break
    if (!isObject(action) || !filled(action.label) || typeof action.send !== 'string') continue
    const send = action.send.trim().slice(0, MAX_SEND_CHARS)
    if (send) actions.push({ label: action.label.trim(), style: ACTION_STYLES.includes(action.style) ? action.style : 'default', send })
  }
  return {
    schema: 'card.v1',
    kind: value.kind,
    title: value.title.trim(),
    status: { state: value.status.state, label: filled(value.status.label) ? value.status.label.trim() : null },
    body: (value.body || []).map(bodyItem).filter(Boolean),
    email: value.email ? { to: text(value.email.to), cc: text(value.email.cc), subject: text(value.email.subject), bodyText: text(value.email.bodyText) } : null,
    actions,
    resolved: isObject(value.resolved) ? { action: value.resolved.action.trim(), at: text(value.resolved.at) } : null
  }
}

/** Parse a read-text reply into `{ ok: true, card }` or `{ ok: false, reason }`. */
export function cardFromRead(result) {
  if (!result || result.binary || typeof result.text !== 'string' || !result.text) return { ok: false, reason: 'unreadable' }
  if (result.truncated || result.text.length > MAX_CARD_CHARS) return { ok: false, reason: 'too-large' }
  let parsed
  try {
    parsed = JSON.parse(result.text)
  } catch {
    return { ok: false, reason: 'json' }
  }
  const card = validateCard(parsed)
  return card ? { ok: true, card } : { ok: false, reason: 'schema' }
}

/** Nothing more will change: resolved, done or failed (polling stops). */
export function isFinalCard(card) {
  return Boolean(card && (card.resolved || card.status.state === 'done' || card.status.state === 'error'))
}

export function statusLabel(status) {
  if (status?.label) return status.label
  return { pending: 'Pending', running: 'Running', done: 'Done', error: 'Error', 'awaiting-approval': 'Awaiting approval' }[status?.state] || String(status?.state || '')
}

/** The chip a card shows, or null: only states that say something (running,
 *  done, error). Approval cards and waiting states (pending,
 *  awaiting-approval) show none; the rows are the question. */
export function cardChip(card) {
  const state = card?.status?.state
  if (!card || card.kind === 'approval' || !['running', 'done', 'error'].includes(state)) return null
  return { state, label: statusLabel(card.status) }
}

export const LEAD_MAX_CHARS = 200

/** The card's question line: its body when that is one short text line under
 *  a title (drawn at body size, not as small grey text); null otherwise. */
export function cardLead(card) {
  if (!card || !filled(card.title) || card.body?.length !== 1 || card.body[0].type !== 'text') return null
  const line = card.body[0].text.trim()
  return line && !line.includes('\n') && line.length <= LEAD_MAX_CHARS ? line : null
}

// ── preview frames ────────────────────────────────────────────────────────

export const PREVIEW_MIN_HEIGHT = 120
export const PREVIEW_MAX_HEIGHT = 1200
export const PREVIEW_DEFAULT_HEIGHT = 280
export const INTENT_THROTTLE_MS = 1000
const SIZE_TYPE = 'hermes-inline-preview-size'
const INTENT_TYPE = 'hermes-inline-preview-intent'
const ACK_TYPE = 'hermes-inline-preview-intent-ack'

export const isHtmlFile = rel => /\.html?$/i.test(String(rel || ''))

/** The frame's first height: the directive's `height`, clamped, else the default. */
export function previewStartHeight(raw) {
  const n = Number(raw)
  return Number.isInteger(n) ? Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_MIN_HEIGHT, n)) : PREVIEW_DEFAULT_HEIGHT
}

/** The theme prelude: friendly tokens (--foreground, --muted-foreground,
 *  --accent, --border, --card), the color scheme, the app font, no margins
 *  and a transparent background; the page's own styles win. */
export function previewPrelude(vars, font, colorScheme) {
  const tokens = Object.entries(vars || {})
    .filter(([name, value]) => /^--[a-z-]+$/.test(name) && typeof value === 'string' && value && !/[<>{};]/.test(value))
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  const safeFont = typeof font === 'string' && font && !/[<>{};]/.test(font) ? `font-family:${font};` : ''
  const scheme = colorScheme === 'dark' ? 'dark' : 'light'
  return `<style>:root{color-scheme:${scheme};${tokens}}html,body{margin:0;padding:0;background:transparent;color:var(--foreground,inherit);${safeFont}}</style>`
}

/** The script that reports the document's height to the parent and gives the
 *  page `window.hermes.send(prompt)` plus `data-hermes-send` clicks. */
export function previewScript(token) {
  const t = JSON.stringify(String(token))
  return (
    '<script>(function(){var t=' + t + ';var lastH=0;' +
    'function post(){var d=document.documentElement,b=document.body;var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);' +
    'if(Math.abs(h-lastH)>1){lastH=h;parent.postMessage({type:' + JSON.stringify(SIZE_TYPE) + ',token:t,height:h},"*")}}' +
    'if(typeof ResizeObserver==="function"){var ro=new ResizeObserver(post);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}' +
    'addEventListener("load",post);post();' +
    'var n=0,w={};addEventListener("message",function(e){var m=e.data;if(e.source!==parent||!m||m.type!==' + JSON.stringify(ACK_TYPE) + '||m.token!==t||!w[m.id])return;var r=w[m.id];delete w[m.id];r(m.ack)});' +
    'function send(p){if(typeof p!=="string"||!p.trim())return Promise.resolve({ok:false,error:"invalid"});var id=++n;return new Promise(function(res){' +
    'var k=setTimeout(function(){if(w[id]){delete w[id];res({ok:false,error:"undelivered"})}},5000);w[id]=function(a){clearTimeout(k);res(a)};' +
    'parent.postMessage({type:' + JSON.stringify(INTENT_TYPE) + ',token:t,id:id,prompt:p},"*")})}' +
    'window.hermes={send:send,maxLength:' + MAX_SEND_CHARS + '};' +
    'addEventListener("click",function(e){var el=e.target&&e.target.closest?e.target.closest("[data-hermes-send]"):null;if(el)send(el.getAttribute("data-hermes-send")||"")},true)})()</script>'
  )
}

/** The frame's srcdoc: prelude first, the script before `</body>` (or at the end). */
export function previewDocument(html, token, prelude) {
  const doc = String(html || '')
  const script = previewScript(token)
  const close = /<\/body\s*>/i.exec(doc)
  return prelude + (close ? doc.slice(0, close.index) + script + doc.slice(close.index) : doc + script)
}

/** A size report from OUR frame (type and token), clamped; null otherwise. */
export function previewHeightFrom(data, token) {
  if (!isObject(data) || data.type !== SIZE_TYPE || data.token !== token) return null
  const h = data.height
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return null
  return Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_MIN_HEIGHT, Math.ceil(h)))
}

/** The intent gate: null unless OUR type and token; then accept (trimmed,
 *  never truncated) or reject with a reason the frame is told. */
export function previewIntentFrom(data, token, now, lastAcceptedAt) {
  if (!isObject(data) || data.type !== INTENT_TYPE || data.token !== token) return null
  const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) ? data.id : null
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : ''
  if (!prompt) return { kind: 'reject', id, ack: { ok: false, error: 'invalid' } }
  if (prompt.length > MAX_SEND_CHARS) return { kind: 'reject', id, ack: { ok: false, error: 'too_long', maxLength: MAX_SEND_CHARS } }
  const elapsed = now - lastAcceptedAt
  if (lastAcceptedAt > 0 && elapsed < INTENT_THROTTLE_MS) return { kind: 'reject', id, ack: { ok: false, error: 'throttled', retryAfterMs: INTENT_THROTTLE_MS - elapsed } }
  return { kind: 'accept', id, prompt }
}

export function previewAck(token, id, ack) {
  return { type: ACK_TYPE, token, id, ack }
}
