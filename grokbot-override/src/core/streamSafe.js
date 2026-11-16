// Live formatting of a streaming bot reply (Grok/ChatGPT style). A partial
// reply goes through the same prose renderer as a finished one (ui/Media.tsx
// BotProse), so it has to be render-stable at every tick: nothing half-typed
// may flash as raw markdown and then snap into formatting.
//
// streamSafeParts(text) returns the text to draw now. It is always a PREFIX of
// the streamed text plus, at most, temporary closers:
// - an open ``` / ~~~ fence is closed (the code block shows and grows), also
//   one inside a blockquote or list item (closed with the same container
//   prefix); a half-typed opening fence line (its language still coming) or
//   closing fence line is held back. Nothing inside a fence, or inside an
//   indented code block, is ever repaired: code shows exactly as sent;
// - an unmatched `**` / `*` / `_` / backtick that already has text after it
//   is closed at the end (bold, italics, inline code show as they type); one
//   at the very end, with nothing after it yet, is held back. A closing run
//   closes every delimiter it can (`**a *b***` closes both). A backtick run
//   at the end of open inline code is held (an added closer would merge
//   with it into a longer run that closes nothing);
// - a half link or image (`[text`, `[text]`, `[text](url`) is held back;
// - tables: a header row (leading `|`) waits for its separator line; a
//   separator shows once it has every column; a body row shows once it has
//   every column (its last cell may keep growing, which only adds text);
// - a bare list marker, heading marker or rule/underline line at the very
//   end is held back;
// - a `MEDIA:` tag (a line or inline, spaced or quoted) is held from its
//   start until its path is terminated (whitespace after it, its closing
//   quote, or the end of the line for a MEDIA line): a truncated path is
//   never drawn or read;
// - a half `::card{…}` / `::preview{…}` directive is held back and reported
//   (`directive: true`, `pending: {name, attrs}`) so the chat draws a
//   placeholder of the right kind and size in its place.
// Held text shows on a later tick, once complete. The finished reply is
// always drawn from its full text, untouched: nothing here touches it.

const BLOCK_START = /^ {0,3}(?:[-*+] |\d{1,9}[.)] |#{1,6} |> ?|\|)/
const LIST_MARK = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/
/** Blockquote markers, an optional list marker, the indentation, then a fence. */
const CONTAINER_FENCE = /^((?: {0,3}>[ ]?)*)( {0,3}(?:[-*+]|\d{1,9}[.)])[ ]+)?([ ]*)(`{3,}|~{3,})(.*)$/
const QUOTES = /^(?: {0,3}>[ ]?)*/
/** A held link or directive body longer than this is plain text after all. */
export const HOLD_MAX = 500
const DIRECTIVE_BODY_MAX = 2048

const isSpace = ch => ch === undefined || /\s/.test(ch)
const isWord = ch => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
const oddBackticks = s => (s.match(/`/g) || []).length % 2 === 1

// ---- fences (top level, in blockquotes and in list items) ----

/** The fence a line opens, or null. Indented 4+ only inside a list item. */
function fenceOpen(line, inList) {
  const m = CONTAINER_FENCE.exec(line.replace(/\r$/, ''))
  if (!m) return null
  const [, quotes, marker = '', indent, mark, info] = m
  if (!quotes && !marker && indent.length > 3 && !inList) return null
  if (mark[0] === '`' && info.includes('`')) return null
  return {
    char: mark[0],
    len: mark.length,
    // The prefix a temporary closing line takes: the same quotes, the list
    // marker as spaces, the same indentation.
    prefix: quotes + ' '.repeat(marker.length + indent.length)
  }
}

/** The line without its blockquote markers and indentation. */
const fenceBody = line => line.replace(/\r$/, '').replace(QUOTES, '').replace(/^[ \t]*/, '')

function fenceCloses(line, fence) {
  const body = fenceBody(line)
  let n = 0
  while (body[n] === fence.char) n += 1
  return n >= fence.len && !body.slice(n).trim()
}

// ---- tables ----

const hasPipe = line => /(^|[^\\])\|/.test(line)
const leadingPipe = line => /^ {0,3}\|/.test(line)
function cells(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/)
}
const separatorish = line => /^[ \t]*[|:\- \t]+$/.test(line) && /[|-]/.test(line)
function isSeparator(line, cols) {
  if (!separatorish(line) || !line.includes('|') && cols > 1) return false
  const parts = cells(line)
  return parts.length === cols && parts.every(cell => /^\s*:?-+:?\s*$/.test(cell))
}

// ---- MEDIA tags (grammar of core/media.js MEDIA_TAG_RE) ----

/** The start of the first MEDIA: tag in `line` whose path is not terminated yet, or -1. */
function openMediaTag(line) {
  for (const match of line.matchAll(/[`"']?MEDIA:/g)) {
    const rest = line.slice(match.index + match[0].length).replace(/^\s*/, '')
    if (!rest) return match.index
    const q = rest[0]
    if (q === '`' || q === '"' || q === "'") {
      if (rest.indexOf(q, 1) < 0) return match.index
      continue
    }
    const path = /^[^\s`"]+/.exec(rest)
    if (!path || path[0].length === rest.length) return match.index
  }
  return -1
}

// ---- directives ----

/** The attributes of a half-typed directive body that are already complete. */
function settledAttrs(body) {
  const done = /["'\s]$/.test(body) ? body : body.replace(/\S*$/, '')
  const attrs = {}
  for (const pair of done.matchAll(/([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)'|([^\s"'{}]+))/gi)) {
    attrs[pair[1].toLowerCase()] = pair[2] ?? pair[3] ?? pair[4] ?? ''
  }
  return attrs
}

/** The cut point (an index into `line`) for the partial last line, or -1;
 *  `pending` when what is held is a directive on its way. */
function holdLastLine(line) {
  if (!line) return { at: -1, pending: null }
  // Whole-line holds: the line is still deciding what block it is. A fence
  // opener (in a quote or list item too) waits for its language.
  const stripped = fenceBody(line).replace(/^(?:[-*+]|\d{1,9}[.)])[ ]+/, '')
  if (/^(?:`{1,3}|~{1,3})/.test(stripped) && !/^`{1,2}[^`]/.test(stripped)) return { at: 0, pending: null }
  if (/^[\t ]*[`"']?(?:M|ME|MED|MEDI|MEDIA|MEDIA:.*)$/.test(line)) return { at: 0, pending: null }
  if (/^ {0,3}#{1,6}\s*$/.test(line)) return { at: 0, pending: null }
  if (/^\s*(?:[-*+]|\d{1,9}[.)]?)\s*$/.test(line)) return { at: 0, pending: null }
  if (/^ {0,3}([-=*_])(?:\s*\1)*\s*$/.test(line)) return { at: 0, pending: null }

  // A directive on its way: `::card{…` (placeholder), or `:`, `::`, `::ca`.
  const dir = new RegExp(String.raw`(^|\s)::(card|preview)\{([^{}\n]{0,${DIRECTIVE_BODY_MAX}})$`).exec(line)
  if (dir) {
    const at = dir.index + dir[1].length
    if (!oddBackticks(line.slice(0, at))) return { at, pending: { name: dir[2], attrs: settledAttrs(dir[3]) } }
  }
  const head = /(^|\s)(::?[a-z]{0,7})$/.exec(line)
  if (head) {
    const word = head[2].replace(/^::?/, '')
    const at = head.index + head[1].length
    if ((head[2] === ':' || 'card'.startsWith(word) || 'preview'.startsWith(word)) && !oddBackticks(line.slice(0, at))) {
      return { at, pending: null }
    }
  }

  let at = -1
  const pick = index => {
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  pick(openMediaTag(line))
  const tagHead = /(^|\W)[`"']?(?:M|ME|MED|MEDI|MEDIA)$/.exec(line)
  if (tagHead) pick(tagHead.index + tagHead[1].length)
  // A half link or image: `[text`, `[text]`, `[text](url`.
  const link = new RegExp(String.raw`!?\[[^\[\]\n]{0,${HOLD_MAX}}(?:\](?:\([^)\n]{0,${HOLD_MAX}})?)?$`).exec(line)
  if (link && !oddBackticks(line.slice(0, link.index))) pick(link.index)
  return { at, pending: null }
}

// ---- inline code and emphasis ----

/** Inline code and emphasis in the tail block: where to cut a trailing
 *  delimiter with nothing after it, and the closers for the open ones. */
function inlineTail(tail) {
  const stack = []
  let code = null
  let cut = -1
  let i = 0
  let lineStart = true
  while (i < tail.length) {
    const ch = tail[i]
    if (lineStart) {
      lineStart = false
      // A new list item, heading, quote or row: emphasis never crosses it.
      if (BLOCK_START.test(tail.slice(i, i + 16))) {
        stack.length = 0
        code = null
      }
    }
    if (ch === '\n') {
      lineStart = true
      i += 1
      continue
    }
    if (ch === '\\' && !code) {
      i += 2
      continue
    }
    if (ch === '`') {
      let j = i
      while (tail[j] === '`') j += 1
      const len = j - i
      if (!code) {
        if (j >= tail.length) {
          cut = i
          break
        }
        code = { len, at: i }
      } else if (len === code.len) code = null
      else if (j >= tail.length) {
        // A literal run at the end of open code: an added closer would
        // join it into a longer run that closes nothing. Hold it.
        cut = i
        break
      }
      i = j
      continue
    }
    if (code) {
      i += 1
      continue
    }
    if (ch === '*' || ch === '_') {
      let j = i
      while (tail[j] === ch) j += 1
      const len = j - i
      const prev = tail[i - 1]
      const next = tail[j]
      if (ch === '_' && isWord(prev) && isWord(next)) {
        i = j
        continue
      }
      let rest = len
      if (!isSpace(prev)) {
        // Closes as many open runs of this character as it covers; any
        // other delimiter opened inside them stays literal.
        while (rest > 0) {
          let k = stack.length - 1
          while (k >= 0 && stack[k].ch !== ch) k -= 1
          if (k < 0) break
          stack.length = k + 1
          const top = stack[k]
          if (rest >= top.len) {
            rest -= top.len
            stack.pop()
          } else {
            top.len -= rest
            rest = 0
          }
        }
      }
      if (next === undefined) {
        if (rest > 0) cut = j - rest
        break
      }
      if (rest > 0 && !isSpace(next)) stack.push({ ch, len: Math.min(rest, 3) })
      i = j
      continue
    }
    i += 1
  }
  let closers = ''
  if (code && cut < 0) closers += '`'.repeat(code.len)
  for (let k = stack.length - 1; k >= 0; k -= 1) closers += stack[k].ch.repeat(stack[k].len)
  return { cut, closers, code: Boolean(code && cut < 0) }
}

/**
 * `{ text, held, directive, pending }`: `text` is safe to render now (a
 * prefix of the input plus temporary closers), `held` the part waiting for
 * the next tick, `directive` true when the held part is a `::card{` /
 * `::preview{` still streaming, `pending` its `{name, attrs}` (the
 * attributes already complete), for a placeholder of the right kind.
 */
export function streamSafeParts(input) {
  const source = String(input ?? '')
  if (!source) return { text: '', held: '', directive: false, pending: null }
  const lastStart = source.lastIndexOf('\n') + 1
  let fence = null
  let blockStart = 0
  let inList = false
  let prevBlank = true
  let prev = null // the last complete non-blank line outside a fence: {line, offset}
  let table = null // {cols} while a table runs through the complete lines
  let offset = 0
  while (offset < lastStart) {
    const end = source.indexOf('\n', offset)
    const line = source.slice(offset, end)
    if (fence) {
      if (fenceCloses(line, fence)) {
        fence = null
        blockStart = end + 1
      }
      offset = end + 1
      continue
    }
    const opened = fenceOpen(line, inList)
    if (opened) {
      fence = opened
      table = null
      prev = null
      prevBlank = false
    } else if (!line.trim()) {
      blockStart = end + 1
      table = null
      prev = null
      prevBlank = true
    } else {
      if (LIST_MARK.test(line)) inList = true
      else if (prevBlank && !/^\s/.test(line)) inList = false
      if (table && !hasPipe(line)) table = null
      if (!table && prev && hasPipe(prev.line) && isSeparator(line, cells(prev.line).length)) table = { cols: cells(prev.line).length }
      prev = { line, offset }
      prevBlank = false
    }
    offset = end + 1
  }
  const lastLine = source.slice(lastStart)

  if (fence) {
    let cut = source.length
    const body = fenceBody(lastLine)
    const partialClose = new RegExp(`^\\${fence.char}+\\s*$`).test(body)
    if (lastLine && (partialClose || /^[\t ]*[`"']?(?:M|ME|MED|MEDI|MEDIA|MEDIA:.*)$/.test(body))) cut = lastStart
    else {
      const tag = openMediaTag(lastLine)
      if (tag >= 0) cut = lastStart + tag
    }
    const safe = source.slice(0, cut)
    const text = `${safe}${safe.endsWith('\n') ? '' : '\n'}${fence.prefix}${fence.char.repeat(fence.len)}`
    return { text, held: source.slice(cut), directive: false, pending: null }
  }

  let cut = source.length
  const hold = holdLastLine(lastLine)
  if (hold.at >= 0) cut = lastStart + hold.at
  // Tables.
  if (table) {
    if (lastLine && hasPipe(lastLine) && cells(lastLine).length < table.cols) cut = Math.min(cut, lastStart)
  } else if (!lastLine) {
    // A header waiting for its separator line.
    if (prev && leadingPipe(prev.line)) cut = Math.min(cut, prev.offset)
  } else if (prev && hasPipe(prev.line) && separatorish(lastLine)) {
    if (!isSeparator(lastLine, cells(prev.line).length)) cut = Math.min(cut, leadingPipe(prev.line) ? prev.offset : lastStart)
    else if (cut === lastStart && hold.at === 0) cut = source.length // a complete separator, not a rule
  } else if (leadingPipe(lastLine)) {
    // Maybe a header: held until its separator arrives.
    cut = Math.min(cut, lastStart)
  }

  const pending = hold.pending && cut === lastStart + hold.at ? hold.pending : null
  let safe = source.slice(0, cut)
  let closers = ''
  // An indented code block at the tail: shown as typed, never repaired.
  const tailHead = source.slice(blockStart, source.indexOf('\n', blockStart) < 0 ? source.length : source.indexOf('\n', blockStart))
  const indentedCode = /^(?: {4}|\t)/.test(tailHead) && !inList
  // Cutting a trailing delimiter can leave another at the end ("a **_"):
  // scan again until the tail is stable (each pass only shortens it).
  for (let pass = 0; pass < 8 && !indentedCode && blockStart < safe.length; pass += 1) {
    const inline = inlineTail(safe.slice(blockStart))
    if (inline.cut < 0) {
      closers = inline.closers
      // A closer must touch the text it closes ("**bold **" stays raw).
      if (closers && !inline.code) safe = safe.replace(/\s+$/, '')
      break
    }
    safe = safe.slice(0, blockStart + inline.cut)
  }
  return { text: safe + closers, held: source.slice(safe.length), directive: Boolean(pending), pending }
}

/** The text a streaming reply draws now (streamSafeParts(text).text). */
export function streamSafe(text) {
  return streamSafeParts(text).text
}
