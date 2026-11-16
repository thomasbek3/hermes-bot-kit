// Live formatting of a streaming bot reply (Grok/ChatGPT style). A partial
// reply goes through the same prose renderer as a finished one (ui/Media.tsx
// BotProse), so it has to be render-stable at every tick: nothing half-typed
// may flash as raw markdown and then snap into formatting.
//
// streamSafeParts(text) returns the text to draw now. It is always a PREFIX of
// the streamed text plus, at most, temporary closers:
// - an open ``` / ~~~ fence is closed (the code block shows and grows); a
//   half-typed opening fence line (its language still coming) or closing
//   fence line is held back;
// - an unmatched `**` / `*` / `_` / backtick that already has text after it
//   is closed at the end (bold, italics, inline code show as they type); one
//   at the very end, with nothing after it yet, is held back;
// - a half link or image (`[text`, `[text]`, `[text](url`) is held back;
// - a half table (a row still typing, or a header row whose separator line
//   has not arrived), a bare list marker, heading marker or rule/underline
//   line at the very end is held back;
// - a half `MEDIA:` line or tag is held back (a truncated path is never read);
// - a half `::card{…}` / `::preview{…}` directive is held back and reported
//   (`directive: true`) so the chat draws a placeholder in its place.
// Held text shows on a later tick, once complete. The finished reply is
// always drawn from its full text, untouched: nothing here touches it.

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const BLOCK_START = /^ {0,3}(?:[-*+] |\d{1,9}[.)] |#{1,6} |> ?|\|)/
const PIPE_LINE = /^ {0,3}\|/
/** A held link or directive body longer than this is plain text after all. */
export const HOLD_MAX = 500
const DIRECTIVE_BODY_MAX = 2048

const isSpace = ch => ch === undefined || /\s/.test(ch)
const isWord = ch => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
const oddBackticks = s => (s.match(/`/g) || []).length % 2 === 1

/** The cut point (an index into `line`) for the partial last line, or -1;
 *  `directive` when what is held is a directive on its way. */
function holdLastLine(line) {
  if (!line) return { at: -1, directive: false }
  // Whole-line holds: the line is still deciding what block it is.
  if (/^ {0,3}(?:`{3}|~{3})/.test(line)) return { at: 0, directive: false } // fence opener, language still typing
  if (/^ {0,3}(?:`{1,2}|~{1,2})$/.test(line)) return { at: 0, directive: false }
  if (/^[\t ]*[`"']?(?:M|ME|MED|MEDI|MEDIA|MEDIA:.*)$/.test(line)) return { at: 0, directive: false }
  if (/^ {0,3}#{1,6}\s*$/.test(line)) return { at: 0, directive: false }
  if (/^\s*(?:[-*+]|\d{1,9}[.)]?)\s*$/.test(line)) return { at: 0, directive: false }
  if (/^ {0,3}([-=*_])(?:\s*\1)*\s*$/.test(line)) return { at: 0, directive: false }
  if (PIPE_LINE.test(line)) return { at: 0, directive: false }

  // A directive on its way: `::card{…` (placeholder), or `:`, `::`, `::ca`.
  const dir = new RegExp(String.raw`(^|\s)::(?:card|preview)\{[^{}\n]{0,${DIRECTIVE_BODY_MAX}}$`).exec(line)
  if (dir) {
    const at = dir.index + dir[1].length
    if (!oddBackticks(line.slice(0, at))) return { at, directive: true }
  }
  const head = /(^|\s)(::?[a-z]{0,7})$/.exec(line)
  if (head) {
    const word = head[2].replace(/^::?/, '')
    const at = head.index + head[1].length
    if ((head[2] === ':' || 'card'.startsWith(word) || 'preview'.startsWith(word)) && !oddBackticks(line.slice(0, at))) {
      return { at, directive: false }
    }
  }

  let at = -1
  const pick = index => {
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  // An inline MEDIA: tag still typing its path (or the word itself).
  const tag = /[`"']?MEDIA:\S*$/.exec(line)
  if (tag) pick(tag.index)
  const tagHead = /(^|\s)[`"']?(?:M|ME|MED|MEDI|MEDIA)$/.exec(line)
  if (tagHead) pick(tagHead.index + tagHead[1].length)
  // A half link or image: `[text`, `[text]`, `[text](url`.
  const link = new RegExp(String.raw`!?\[[^\[\]\n]{0,${HOLD_MAX}}(?:\](?:\([^)\n]{0,${HOLD_MAX}})?)?$`).exec(line)
  if (link && !oddBackticks(line.slice(0, link.index))) pick(link.index)
  // A bare URL still typing (it autolinks into a source chip, ui/SourceLink.tsx,
  // whose label and icon depend on the whole URL): shown once a space or the
  // line end arrives. An angle autolink `<https://…` is held from its `<`
  // until the closing `>` arrives (then it is complete). A link's own
  // `](https://…)` target is the half-link rule's, above. Reported as `url`,
  // not cut here: streamSafeParts drops it when the URL is inside inline code.
  let url = -1
  const angle = new RegExp(String.raw`<(?:h|ht|htt|https?|https?:|https?:/{1,2}[^\s<>]{0,${HOLD_MAX}})?$`).exec(line)
  const bare = new RegExp(String.raw`(^|[\s(])https?:(?:/{0,2}|//\S{1,${HOLD_MAX}})$`).exec(line)
  if (angle) url = angle.index
  else if (bare) {
    const start = bare.index + bare[1].length
    if (line.slice(start - 2, start) !== '](') url = start
  }
  return { at, directive: false, url }
}

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
    if (ch === '\\') {
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
      const top = stack[stack.length - 1]
      if (next === undefined) {
        // At the very end: it closes the open run, or it is held back.
        if (top && top.ch === ch && len >= top.len && !isSpace(prev)) stack.pop()
        else cut = i
        break
      }
      if (ch === '_' && isWord(prev) && isWord(next)) {
        i = j
        continue
      }
      if (!isSpace(prev) && top && top.ch === ch) {
        if (len < top.len) top.len -= len
        else stack.pop()
      } else if (!isSpace(next)) {
        stack.push({ ch, len: Math.min(len, 3) })
      }
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
 * `{ text, held, directive }`: `text` is safe to render now (a prefix of the
 * input plus temporary closers), `held` the part waiting for the next tick,
 * `directive` true when the held part is a `::card{` / `::preview{` still
 * streaming (draw a placeholder for it).
 */
export function streamSafeParts(input) {
  const source = String(input ?? '')
  if (!source) return { text: '', held: '', directive: false }
  const lastStart = source.lastIndexOf('\n') + 1
  // Fence state and the start of the tail block, over the complete lines.
  let fence = null
  let blockStart = 0
  let offset = 0
  let pipeRun = 0
  let pipeStart = 0
  while (offset < lastStart) {
    const end = source.indexOf('\n', offset)
    const line = source.slice(offset, end)
    if (fence) {
      if (fence.close.test(line)) {
        fence = null
        blockStart = end + 1
      }
      pipeRun = 0
    } else {
      const m = OPEN.exec(line)
      if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
        fence = { mark: m[2][0].repeat(m[2].length), close: new RegExp(`^ {0,3}${m[2][0] === '`' ? '`' : '~'}{${m[2].length},}\\s*$`) }
        pipeRun = 0
      } else if (!line.trim()) {
        blockStart = end + 1
        pipeRun = 0
      } else if (PIPE_LINE.test(line)) {
        if (!pipeRun) pipeStart = offset
        pipeRun += 1
      } else pipeRun = 0
    }
    offset = end + 1
  }
  const lastLine = source.slice(lastStart)

  if (fence) {
    let cut = source.length
    const mark = fence.mark[0] === '`' ? /^ {0,3}`+\s*$/ : /^ {0,3}~+\s*$/
    if (lastLine && (mark.test(lastLine) || /^[\t ]*[`"']?(?:M|ME|MED|MEDI|MEDIA|MEDIA:.*)$/.test(lastLine))) cut = lastStart
    const safe = source.slice(0, cut)
    return { text: `${safe}${safe.endsWith('\n') ? '' : '\n'}${fence.mark}`, held: source.slice(cut), directive: false }
  }

  let cut = source.length
  const hold = holdLastLine(lastLine)
  if (hold.at >= 0) cut = lastStart + hold.at
  // A URL still typing, unless it is inside inline code (the code state of
  // the tail block up to it, delimiter runs and earlier lines included):
  // code shows as it types.
  if (hold.url >= 0 && !inlineTail(`${source.slice(blockStart, lastStart + hold.url)}x`).code) cut = Math.min(cut, lastStart + hold.url)
  // A table header whose separator line has not arrived yet.
  if (pipeRun === 1 && (!lastLine || PIPE_LINE.test(lastLine))) cut = Math.min(cut, pipeStart)
  const directive = hold.directive && cut === lastStart + hold.at
  let safe = source.slice(0, cut)
  let closers = ''
  // Cutting a trailing delimiter can leave another at the end ("a **_"):
  // scan again until the tail is stable (each pass only shortens it).
  for (let pass = 0; pass < 8 && blockStart < safe.length; pass += 1) {
    const inline = inlineTail(safe.slice(blockStart))
    if (inline.cut < 0) {
      closers = inline.closers
      // A closer must touch the text it closes ("**bold **" stays raw).
      if (closers && !inline.code) safe = safe.replace(/\s+$/, '')
      break
    }
    safe = safe.slice(0, blockStart + inline.cut)
  }
  return { text: safe + closers, held: source.slice(safe.length), directive }
}

/** The text a streaming reply draws now (streamSafeParts(text).text). */
export function streamSafe(text) {
  return streamSafeParts(text).text
}
