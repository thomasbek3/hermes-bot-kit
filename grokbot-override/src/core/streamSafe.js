// Live formatting of a streaming bot reply (Grok/ChatGPT style). A partial
// reply goes through the same prose renderer as a finished one (ui/Media.tsx
// BotProse), so it has to be render-stable at every tick: nothing half-typed
// may flash as raw markdown and then snap into formatting.
//
// streamSafeParts(text) returns the text to draw now: always a PREFIX of the
// streamed text plus, at most, temporary closers. The finished reply is
// always drawn from its full text, untouched: nothing here touches it.
//
// How: the complete lines are read as CommonMark blocks (a small block
// parser: blockquote and list-item containers, fenced and indented code,
// headings, tables, link reference definitions, paragraphs with lazy
// continuation), then the last, still-growing line is placed in that
// structure. Only the open leaf block at the end is ever changed:
// - an open fence (at top level or inside quotes / list items, matched under
//   its own containers) is closed temporarily with the same container
//   prefix, so the code block shows and grows; its content, and an indented
//   code block, is never repaired. A half-typed opening fence line or
//   closing fence, or a whitespace-only line, waits;
// - in a paragraph, heading or table row, an inline tokenizer skips code
//   spans, link destinations and titles, autolinks, bare URLs, `MEDIA:` tags
//   and `::card{…}` directives (none of them is prose), then: an unmatched
//   `**` / `*` / `_` / backtick with text after it is closed at the end; one
//   at the very end is held; a closing run closes every open run it covers;
//   a literal backtick run at the end of open inline code is held (an added
//   closer would merge with it); emphasis opened inside a completed link's
//   label never gets a closer outside it;
// - links: an inline link waits until its destination (balanced
//   parentheses, `<…>`) and title are closed; `[label]`, `[label][ref]` and
//   `[label][]` show at once when the reference is defined in the message,
//   otherwise a trailing `[label]` waits for what follows (it may become an
//   inline link); an unclosed `[` waits (up to HOLD_MAX characters);
// - tables (GFM): a header row with a leading pipe waits for its separator;
//   a separator shows once it has every column; body rows show as they type
//   (GFM fills omitted cells), so a finished table never gains a row at
//   completion;
// - a line that is still only a list marker, heading marker, quote marker,
//   rule / setext underline, or a link reference definition (invisible
//   anyway) waits;
// - a `MEDIA:` tag (a line or inline, spaced or quoted) is held from its
//   start until its path is terminated, so a truncated path is never drawn
//   or read;
// - a half `::card{…}` / `::preview{…}` directive is held and reported
//   (`directive: true`, `pending: {name, attrs}` with the attributes typed so
//   far, a bare value provisional) so the chat draws a placeholder of the
//   right kind and size.
// Held text shows on a later tick, once complete.

/** A held link or bracket longer than this is plain text after all. */
export const HOLD_MAX = 500
const DIRECTIVE_BODY_MAX = 2048

const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const LIST_RE = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)/
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/
const DEF = /^ {0,3}\[((?:[^\]\\\n]|\\.){1,999})\]:/
const MEDIA_WHOLE = /^[\t ]*[`"']?(?:M|ME|MED|MEDI|MEDIA|MEDIA:.*)$/
const MEDIA_TOKEN = /^[`"']?MEDIA:\s*(?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s`"]+)[`"']?/
const DIRECTIVE_TOKEN = /^::(?:card|preview)\{[^{}\n]*\}/
const AUTOLINK = /^<(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)(>?)/

const isSpace = ch => ch === undefined || /\s/.test(ch)
const isWord = ch => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
const oddBackticks = s => (s.match(/`/g) || []).length % 2 === 1
const spaces = s => /^ */.exec(s)[0].length
const normLabel = s => s.trim().replace(/\s+/g, ' ').toLowerCase()

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
  if (!separatorish(line) || (!line.includes('|') && cols > 1)) return false
  const parts = cells(line)
  return parts.length === cols && parts.every(cell => /^\s*:?-+:?\s*$/.test(cell))
}

// ---- blocks ----

/** A paragraph may be interrupted by these (lazy continuation stops). */
const interrupts = rest =>
  /^ {0,3}(?:>|`{3}|~{3}|#{1,6}(?:[ \t]|$)|[-*+][ \t]+\S|1[.)][ \t]+\S)/.test(rest) || RULE.test(rest)

function closesFence(rest, fence) {
  const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(rest)
  return Boolean(m && m[1][0] === fence.char && m[1].length >= fence.len)
}

function cloneState(st) {
  return {
    source: st.source,
    defs: st.defs,
    containers: [...st.containers],
    leaf: st.leaf && st.leaf.ranges ? { ...st.leaf, ranges: [...st.leaf.ranges] } : st.leaf
  }
}

/** The line with its tabs expanded to CommonMark's tab stops (every 4
 *  columns), and a map from each expanded position back to the raw line. */
function expandTabs(line) {
  if (!line.includes('\t')) return { text: line, at: pos => pos }
  let text = ''
  const map = []
  for (let k = 0; k < line.length; k += 1) {
    if (line[k] === '\t') {
      const width = 4 - (text.length % 4)
      for (let x = 0; x < width; x += 1) map.push(k)
      text += ' '.repeat(width)
    } else {
      map.push(k)
      text += line[k]
    }
  }
  map.push(line.length)
  return { text, at: pos => map[Math.min(pos, map.length - 1)] }
}

/** Place one line (`raw`, starting at `offset`) in the block structure.
 *  Indentation is measured in columns (tabs to tab stops), as CommonMark
 *  does; ranges point back into the raw text. */
function scanLine(st, raw, offset) {
  const plain = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const { text: line, at } = expandTabs(plain)
  const span = pos => [offset + at(pos), offset + plain.length, offset]
  const { containers } = st
  let leaf = st.leaf
  if (leaf && (leaf.type === 'heading' || leaf.type === 'def')) st.leaf = leaf = null
  let pos = 0
  let matched = 0
  for (const c of containers) {
    const rest = line.slice(pos)
    if (c.type === 'quote') {
      const m = /^ {0,3}>/.exec(rest)
      if (!m) break
      pos += m[0].length
      if (line[pos] === ' ') pos += 1
    } else if (rest.trim()) {
      if (spaces(rest) < c.indent) break
      pos += c.indent
    }
    matched += 1
  }
  const info = { pos, matched, opened: 0, rest: line.slice(pos), leaf: null, lineStart: offset }
  if (leaf && leaf.type === 'fence') {
    if (matched === containers.length) {
      if (closesFence(info.rest, leaf)) {
        st.leaf = null
        info.closedFence = true
      } else info.inFence = leaf
      return info
    }
    st.leaf = leaf = null // its container ended: so did the fence
  }
  let rest = line.slice(pos)
  if (!rest.trim()) {
    containers.length = matched
    st.leaf = null
    info.blank = true
    return info
  }
  if (matched < containers.length && leaf && leaf.type === 'para' && !interrupts(rest)) {
    leaf.ranges.push(span(pos))
    info.leaf = leaf
    return info
  }
  if (matched < containers.length) {
    containers.length = matched
    st.leaf = leaf = null
  }
  // New containers opened on this line.
  for (;;) {
    if (spaces(rest) >= 4) break
    const q = /^ {0,3}> ?/.exec(rest)
    if (q) {
      containers.push({ type: 'quote' })
      pos += q[0].length
      rest = line.slice(pos)
      info.opened += 1
      st.leaf = leaf = null
      continue
    }
    if (RULE.test(rest)) break
    const l = LIST_RE.exec(rest)
    if (l) {
      const after = rest.slice(l[0].length)
      const blankItem = !after.trim()
      // An empty item or an ordered list not starting at 1 cannot interrupt a paragraph.
      if (leaf && leaf.type === 'para' && (blankItem || (/\d/.test(l[2][0]) && !/^1[.)]$/.test(l[2])))) break
      let n = l[3].length
      if (blankItem || n >= 5) n = 1
      containers.push({ type: 'list', indent: l[1].length + l[2].length + n })
      pos += Math.min(l[0].length, l[1].length + l[2].length + n)
      rest = line.slice(pos)
      info.opened += 1
      st.leaf = leaf = null
      if (blankItem) break
      continue
    }
    break
  }
  info.pos = pos
  info.rest = rest
  if (!rest.trim()) {
    st.leaf = null
    info.blank = true
    return info
  }
  const range = span(pos)
  if (spaces(rest) >= 4) {
    if (leaf && leaf.type === 'para') {
      leaf.ranges.push(range)
      info.leaf = leaf
    } else info.leaf = st.leaf = { type: 'indented' }
    return info
  }
  const f = FENCE_OPEN.exec(rest)
  if (f && !(f[2][0] === '`' && f[3].includes('`'))) {
    const prefix = containers.map(c => (c.type === 'quote' ? '> ' : ' '.repeat(c.indent))).join('') + f[1]
    info.leaf = st.leaf = { type: 'fence', char: f[2][0], len: f[2].length, prefix }
    info.openedFence = true
    return info
  }
  if (ATX.test(rest)) {
    info.leaf = st.leaf = { type: 'heading', ranges: [range] }
    return info
  }
  if (leaf && leaf.type === 'table') {
    leaf.ranges = [range]
    info.leaf = leaf
    return info
  }
  if (leaf && leaf.type === 'para') {
    const head = leaf.ranges[leaf.ranges.length - 1]
    const header = st.source.slice(head[0], head[1]).replace(/\r$/, '')
    if (hasPipe(header) && isSeparator(rest, cells(header).length)) {
      info.leaf = st.leaf = { type: 'table', cols: cells(header).length, ranges: [] }
      info.separator = true
      return info
    }
  }
  if (RULE.test(rest) || (leaf && leaf.type === 'para' && /^ {0,3}(?:=+|-+)[ \t]*$/.test(rest))) {
    st.leaf = null
    info.rule = true
    return info
  }
  const def = DEF.exec(rest)
  if (def && !(leaf && leaf.type === 'para')) {
    const label = normLabel(def[1])
    const hasDest = /^\s*\S/.test(rest.slice(def[0].length))
    if (label.startsWith('^')) {
      // A footnote definition is visible: its text is a paragraph.
      st.defs.add(label)
      info.leaf = st.leaf = { type: 'para', ranges: [range] }
      return info
    }
    if (hasDest) st.defs.add(label)
    info.leaf = st.leaf = { type: 'def' }
    info.defComplete = hasDest
    return info
  }
  if (leaf && leaf.type === 'para') leaf.ranges.push(range)
  else st.leaf = { type: 'para', ranges: [range] }
  info.leaf = st.leaf
  return info
}

// ---- MEDIA tags and directives on the last line ----

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

/** The start of a `MEDIA:` tag anywhere in the text whose path is not
 *  terminated yet, or -1. The grammar is core/media.js MEDIA_TAG_RE: any
 *  whitespace after the colon, newlines included, then a quoted path (one
 *  line) or a bare one ended by whitespace or a quote. Only the last tag can
 *  still be open. */
function openMediaTagIn(text) {
  const at = text.lastIndexOf('MEDIA:')
  if (at < 0) return -1
  const start = at > 0 && '`"\''.includes(text[at - 1]) ? at - 1 : at
  const rest = text.slice(at + 6).replace(/^\s*/, '')
  if (!rest) return start
  const q = rest[0]
  if (q === '`' || q === '"' || q === "'") {
    const close = rest.indexOf(q, 1)
    const nl = rest.indexOf('\n')
    return close < 0 && nl < 0 ? start : -1
  }
  const path = /^[^\s`"]+/.exec(rest)
  return path && path[0].length === rest.length ? start : -1
}

/** The attributes typed so far in a half directive body; a value still
 *  being typed counts as it stands (the placeholder is provisional). */
function typedAttrs(body) {
  let text = body
  if ((text.match(/"/g) || []).length % 2) text += '"'
  else if ((text.match(/'/g) || []).length % 2) text += "'"
  const attrs = {}
  for (const pair of text.matchAll(/([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)'|([^\s"'{}]+))/gi)) {
    attrs[pair[1].toLowerCase()] = pair[2] ?? pair[3] ?? pair[4] ?? ''
  }
  return attrs
}

/** Holds inside the last line that do not depend on block structure. */
function holdTokens(line) {
  const dir = new RegExp(String.raw`(^|\s)::(card|preview)\{([^{}\n]{0,${DIRECTIVE_BODY_MAX}})$`).exec(line)
  if (dir) {
    const at = dir.index + dir[1].length
    if (!oddBackticks(line.slice(0, at))) return { at, pending: { name: dir[2], attrs: typedAttrs(dir[3]) } }
  }
  const head = /(^|\s)(::?[a-z]{0,7})$/.exec(line)
  if (head) {
    const word = head[2].replace(/^::?/, '')
    const at = head.index + head[1].length
    if ((head[2] === ':' || 'card'.startsWith(word) || 'preview'.startsWith(word)) && !oddBackticks(line.slice(0, at))) {
      return { at, pending: null }
    }
  }
  let at = openMediaTag(line)
  const tagHead = /(^|\W)[`"']?(?:M|ME|MED|MEDI|MEDIA)$/.exec(line)
  if (tagHead) {
    const start = tagHead.index + tagHead[1].length
    if (at < 0 || start < at) at = start
  }
  return { at, pending: null }
}

// ---- inline ----

/** The end of an inline link's `(destination "title")` starting at `k`
 *  (just after `(`), 'open' when the text ends inside it, or -1 when it is
 *  not a link destination. */
function linkTail(t, k) {
  const n = t.length
  while (k < n && (t[k] === ' ' || t[k] === '\t' || t[k] === '\n')) k += 1
  if (k >= n) return 'open'
  if (t[k] === '<') {
    k += 1
    while (k < n && t[k] !== '>' && t[k] !== '\n' && t[k] !== '<') k += t[k] === '\\' ? 2 : 1
    if (k >= n) return 'open'
    if (t[k] !== '>') return -1
    k += 1
  } else {
    let depth = 0
    while (k < n) {
      const c = t[k]
      if (c === '\\') {
        k += 2
        continue
      }
      if (c === '(') depth += 1
      else if (c === ')') {
        if (depth === 0) break
        depth -= 1
      } else if (/\s/.test(c)) break
      k += 1
    }
    if (k >= n) return 'open'
  }
  while (k < n && /\s/.test(t[k])) k += 1
  if (k >= n) return 'open'
  if (t[k] === '"' || t[k] === "'" || t[k] === '(') {
    const close = t[k] === '(' ? ')' : t[k]
    k += 1
    while (k < n && t[k] !== close) k += t[k] === '\\' ? 2 : 1
    if (k >= n) return 'open'
    k += 1
    while (k < n && /\s/.test(t[k])) k += 1
    if (k >= n) return 'open'
  }
  return t[k] === ')' ? k + 1 : -1
}

const isWS = ch => ch === undefined || /\s/u.test(ch)
const isPunct = ch => ch !== undefined && /[\p{P}\p{S}]/u.test(ch)

/** A `*` / `_` / `~` delimiter run at `i..j` with CommonMark's flanking
 *  rules (the end of the text counts as whitespace). */
function delimiterRun(t, i, j) {
  const ch = t[i]
  const prev = t[i - 1]
  const next = t[j]
  const left = !isWS(next) && (!isPunct(next) || isWS(prev) || isPunct(prev))
  const right = !isWS(prev) && (!isPunct(prev) || isWS(next) || isPunct(next))
  const canOpen = ch === '_' ? left && (!right || isPunct(prev)) : left
  const canClose = ch === '_' ? right && (!left || isPunct(next)) : right
  return { ch, start: i, end: j, count: j - i, rem: j - i, canOpen, canClose, removed: false }
}

/** CommonMark's "process emphasis" over delimiter runs, in order: each
 *  closer pairs with the nearest eligible opener of its character (the
 *  multiple-of-3 rule; GFM strikethrough pairs equal runs of one or two
 *  tildes), consuming from both and removing every delimiter between them.
 *
 *  Linear in the number of runs (INT-03): runs that can no longer take part
 *  (removed, or nothing left) are skipped through a path-compressed link to
 *  the nearest live run below, and a failed opener search remembers its
 *  bottom per kind of closer (CommonMark's `openers_bottom`: character,
 *  whether the closer can also open, its length mod 3; tildes by length),
 *  since an opener that was not eligible never becomes eligible later. */
/** Work counter for the scaling tests (runs visited by processEmphasis). */
export const scanStats = { emphasisSteps: 0 }

function processEmphasis(list) {
  const n = list.length
  // up[i] === i: run i is live; otherwise a link toward the next live run
  // below it (-1: none).
  const up = new Int32Array(n)
  for (let i = 0; i < n; i += 1) up[i] = list[i].removed || list[i].rem === 0 ? i - 1 : i
  const live = from => {
    let r = from
    while (r >= 0 && up[r] !== r) r = up[r]
    while (from >= 0 && up[from] !== from) {
      const next = up[from]
      up[from] = r
      from = next
    }
    return r
  }
  const bottoms = new Map()
  for (let ci = 0; ci < n; ci += 1) {
    const c = list[ci]
    while (!c.removed && c.canClose && c.rem > 0) {
      const kind = c.ch === '~' ? `~${c.count}` : `${c.ch}${c.canOpen ? 1 : 0}${c.count % 3}`
      const bottom = bottoms.get(kind) ?? 0
      let oi = live(ci - 1)
      for (; oi >= bottom; oi = live(oi - 1)) {
        scanStats.emphasisSteps += 1
        const d = list[oi]
        if (d.ch !== c.ch || !d.canOpen) continue
        if (c.ch === '~') {
          if (d.count !== c.count) continue
        } else if ((d.canClose || c.canOpen) && (d.count + c.count) % 3 === 0 && !(d.count % 3 === 0 && c.count % 3 === 0)) continue
        break
      }
      if (oi < bottom) {
        bottoms.set(kind, ci)
        break
      }
      const o = list[oi]
      if (c.firstOpener === undefined) c.firstOpener = oi
      const use = c.ch === '~' ? Math.min(o.rem, c.rem) : o.rem >= 2 && c.rem >= 2 ? 2 : 1
      o.rem -= use
      c.rem -= use
      if (o.rem === 0) up[oi] = oi - 1
      for (let k = live(ci - 1); k > oi; k = live(k - 1)) {
        scanStats.emphasisSteps += 1
        list[k].removed = true
        up[k] = k - 1
      }
      if (c.rem === 0) up[ci] = ci - 1
    }
  }
}

/** Inline structure of the open leaf's text `t`: where to cut (a trailing
 *  delimiter or an unfinished construct), and closers for open runs. */
function inlineScan(t, defs) {
  const delims = []
  const brackets = []
  let code = null
  let cut = -1
  let i = 0
  const n = t.length
  const hold = at => {
    if (n - at <= HOLD_MAX) cut = at
    return n - at <= HOLD_MAX
  }
  scan: while (i < n) {
    const ch = t[i]
    if (code) {
      if (ch !== '`') {
        i += 1
        continue
      }
    } else {
      if (ch === '\\') {
        if (i + 1 >= n) {
          cut = i // an escape whose character has not arrived
          break
        }
        i += 2
        continue
      }
      if (ch === '!' && i + 1 >= n) {
        cut = i // may start an image
        break
      }
      const tail = t.slice(i, i + 4096)
      if (ch === '<' && /^<\/?[A-Za-z0-9+.@-]*$/.test(tail) && n - i <= 40) {
        cut = i // may become an autolink or an HTML tag
        break
      }
      if (ch === '&' && /^&#?[A-Za-z0-9]{0,32}$/.test(tail)) {
        cut = i // an entity still being typed (`&am` before `&amp;`)
        break
      }
      if (ch === 'M' || ((ch === '`' || ch === '"' || ch === "'") && t.startsWith('MEDIA:', i + 1))) {
        const m = MEDIA_TOKEN.exec(tail)
        if (m && (ch !== 'M' || i === 0 || !isWord(t[i - 1]))) {
          i += m[0].length
          continue
        }
      }
      if (ch === ':' && t[i + 1] === ':') {
        const m = DIRECTIVE_TOKEN.exec(tail)
        if (m) {
          i += m[0].length
          continue
        }
      }
      if (ch === '<') {
        const m = AUTOLINK.exec(tail)
        if (m) {
          if (m[1]) {
            i += m[0].length
            continue
          }
          if (i + m[0].length >= n && hold(i)) break
        }
      }
      // A bare http(s) URL still typing (it autolinks into a source chip,
      // ui/SourceLink.tsx, whose label and icon depend on the whole URL)
      // waits from its start until a space or the line end arrives; so does
      // a scheme still being typed (`https:`, `https:/`). Inside inline code
      // this branch is never reached: code shows as it types.
      if (ch === 'h' && (i === 0 || /[\s*_~(]/.test(t[i - 1])) && /^https?:\/{0,2}$/.test(tail) && hold(i)) break
      if ((ch === 'h' || ch === 'w') && (i === 0 || /[\s*_~(]/.test(t[i - 1])) && /^(?:https?:\/\/|www\.)/.test(tail)) {
        let j = i
        while (j < n && !/[\s<]/.test(t[j])) j += 1
        if (j >= n && ch === 'h' && hold(i)) break
        if (j >= n) {
          // GFM leaves trailing punctuation out of a bare URL: at the very
          // end it may still be the middle of the URL, so it waits.
          let k = j
          while (k > i && '?!.,:*_~'.includes(t[k - 1])) k -= 1
          if (k < j) {
            cut = k
            break
          }
        }
        i = j
        continue
      }
    }
    if (ch === '`') {
      let j = i
      while (t[j] === '`') j += 1
      const len = j - i
      if (!code) {
        if (j >= n) {
          cut = i
          break
        }
        code = { len, at: i, content: j }
      } else if (len === code.len) code = null
      else if (j >= n) {
        // A literal run at the end of open code: an added closer would
        // join it into a longer run that closes nothing. Hold it.
        cut = i
        break
      }
      i = j
      continue
    }
    if (ch === '[' || (ch === '!' && t[i + 1] === '[')) {
      brackets.push({ at: i, depth: delims.length })
      i += ch === '!' ? 2 : 1
      continue
    }
    if (ch === ']' && brackets.length) {
      const b = brackets.pop()
      const label = t.slice(t[b.at] === '!' ? b.at + 2 : b.at + 1, i)
      const next = t[i + 1]
      // A finished link's label is its own inline scope: its delimiters
      // pair among themselves and never with anything outside it.
      const confine = () => {
        const inner = delims.slice(b.depth)
        processEmphasis(inner)
        for (const d of inner) d.removed = true
      }
      if (next === '(') {
        const end = linkTail(t, i + 2)
        if (end === 'open') {
          if (hold(b.at)) break scan
          i += 1
          continue
        }
        if (end > 0) {
          confine()
          i = end
          continue
        }
        i += 1
        continue
      }
      if (next === '[') {
        let j = i + 2
        while (j < n && t[j] !== ']' && t[j] !== '[') j += t[j] === '\\' ? 2 : 1
        if (j >= n) {
          if (hold(b.at)) break scan
          i += 1
          continue
        }
        if (t[j] === ']') {
          const ref = t.slice(i + 2, j)
          if (defs.has(normLabel(ref || label))) {
            confine()
            i = j + 1
            continue
          }
        }
        i += 1
        continue
      }
      if (next === undefined && !defs.has(normLabel(label))) {
        // `[label]` at the very end may still become an inline link.
        if (hold(b.at)) break
      }
      if (defs.has(normLabel(label))) confine()
      i += 1
      continue
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let j = i
      while (t[j] === ch) j += 1
      // A run of 3+ tildes is literal (GFM strikethrough takes one or two).
      if (!(ch === '~' && j - i > 2)) delims.push(delimiterRun(t, i, j))
      i = j
      continue
    }
    i += 1
  }
  // An unclosed `[` near the end waits for its `]`.
  for (const b of brackets) {
    if (n - b.at <= HOLD_MAX) {
      if (cut < 0 || b.at < cut) cut = b.at
      break
    }
  }
  // Open code whose content is still only spaces: CommonMark strips that
  // padding once the span closes, so it waits.
  if (cut < 0 && code && !t.slice(code.content).trim()) cut = code.at
  // A delimiter run at the very end is paired as it stands, unless one
  // more character of the same kind would pair it with a different opener
  // (`**2*3*` closes the inner star now, `**2*3**` the outer pair): then
  // its pairing is not settled and the whole run waits. A settled run is
  // kept, and only its unused part waits.
  let open = delims.filter(d => !d.removed && d.end <= (cut < 0 ? n : cut))
  let paired = false
  const last = open[open.length - 1]
  if (cut < 0 && !code && last && last.end === n) {
    const now = open.map(d => ({ ...d }))
    processEmphasis(now)
    const grown = open.map(d => ({ ...d }))
    const tip = grown[grown.length - 1]
    tip.count += 1
    tip.rem += 1
    processEmphasis(grown)
    const settled = now[now.length - 1].firstOpener === tip.firstOpener
    if (!settled) cut = last.start
    else if (now[now.length - 1].rem > 0) cut = n - now[now.length - 1].rem
    else {
      open = now
      paired = true
    }
  }
  if (cut >= 0) return { cut, closers: '', code: false }
  if (!paired) processEmphasis(open)
  let closers = ''
  if (code) closers += '`'.repeat(code.len)
  // Close only runs that can only open. A run that could also close (a `*`
  // between two letters, as in 2*3) is ambiguous and stays as typed.
  for (let k = open.length - 1; k >= 0; k -= 1) {
    const d = open[k]
    if (!d.removed && d.rem > 0 && d.canOpen && !d.canClose) closers += d.ch.repeat(d.ch === '~' ? d.rem : Math.min(d.rem, 3))
  }
  return { cut: -1, closers, code: Boolean(code) }
}

/** The leaf's text up to `limit`, lines joined by `\n`, with a map back. */
function leafText(source, ranges, limit) {
  const parts = []
  let text = ''
  for (const [s, e0] of ranges) {
    if (s >= limit) break
    const e = Math.min(e0, limit)
    if (parts.length) text += '\n'
    parts.push({ s, e, v: text.length })
    text += source.slice(s, e)
  }
  const toSource = v => {
    for (let k = parts.length - 1; k >= 0; k -= 1) {
      if (v >= parts[k].v) return Math.min(parts[k].s + (v - parts[k].v), parts[k].e)
    }
    return parts.length ? parts[0].s : limit
  }
  return { text, toSource }
}

/**
 * `{ text, held, directive, pending }`: `text` is safe to render now (a
 * prefix of the input plus temporary closers), `held` the part waiting for
 * the next tick, `directive` true when the held part is a `::card{` /
 * `::preview{` still streaming, `pending` its `{name, attrs}` for a
 * placeholder of the right kind and size.
 */
export function streamSafeParts(input) {
  const raw = String(input ?? '')
  // The renderer trims the message (core/media.js extractMedia), so leading
  // whitespace is not structure (four spaces at the very start are not an
  // indented code block): read the text as it will be rendered.
  const lead = /^\s*/.exec(raw)[0]
  if (!lead) return safeParts(raw)
  const parts = safeParts(raw.slice(lead.length))
  return { ...parts, text: parts.text ? lead + parts.text : '', held: parts.text ? parts.held : raw }
}

function safeParts(input) {
  const source = input
  const none = { text: '', held: source, directive: false, pending: null }
  if (!source) return { ...none, held: '' }
  const lastStart = source.lastIndexOf('\n') + 1
  const st = { source, defs: new Set(), containers: [], leaf: null }
  let offset = 0
  while (offset < lastStart) {
    const end = source.indexOf('\n', offset)
    scanLine(st, source.slice(offset, end), offset)
    offset = end + 1
  }
  const lastRaw = source.slice(lastStart)
  const before = st.leaf
  let cut = source.length
  let closeFence = null
  let region = null
  let pending = null

  if (!lastRaw.trim()) {
    // Nothing yet on the last line (or only its indentation): it waits,
    // and the block before it is still open.
    cut = lastStart
    if (before && before.type === 'fence') closeFence = before
    else if (before && before.ranges) region = before
    if (before && before.type === 'para' && !lastRaw) {
      const head = before.ranges[before.ranges.length - 1]
      if (hasPipe(source.slice(head[0], head[1]))) cut = head[2] // maybe a table header: waits for the next line
    }
  } else {
    const after = cloneState(st)
    const info = scanLine(after, lastRaw, lastStart)
    const rest = info.rest.replace(/\r$/, '')
    if (info.inFence) {
      closeFence = info.inFence
      const partial = new RegExp(`^ {0,3}\\${info.inFence.char}+[ \\t]*$`)
      // Only its container prefix so far, a half closer, or a MEDIA line: waits.
      if (!rest.trim() || partial.test(rest) || MEDIA_WHOLE.test(rest)) cut = lastStart
      else {
        const tag = openMediaTag(lastRaw)
        if (tag >= 0) cut = lastStart + tag
      }
    } else if (info.closedFence) {
      // The closing fence is complete: shown as it is.
    } else if (info.leaf && info.leaf.type === 'indented') {
      // Indented code is shown exactly as typed: no structural holds and no
      // inline repair (only directive and MEDIA tokens, which the renderer
      // lifts out of code too).
      const tokens = holdTokens(lastRaw)
      if (tokens.at >= 0) {
        cut = lastStart + tokens.at
        pending = tokens.pending
      }
    } else if (
      info.openedFence ||
      info.blank ||
      /^ {0,3}#{1,6}[ \t]*$/.test(rest) ||
      /^\d{1,9}[.)]?$/.test(rest.trim()) ||
      /^ {0,3}(?:`{1,2}|~{1,2})$/.test(rest) ||
      info.rule ||
      // A reference definition is invisible once it has a destination
      // (it only resolves links); before that it would show as text.
      (info.leaf && info.leaf.type === 'def' && !info.defComplete) ||
      MEDIA_WHOLE.test(rest) ||
      MEDIA_WHOLE.test(lastRaw)
    ) {
      cut = lastStart
      if (before && before.ranges) region = before
    } else if (!info.separator && before && before.type === 'para' && info.leaf && info.leaf.type === 'para' && separatorish(rest) && hasPipe(source.slice(before.ranges[before.ranges.length - 1][0], before.ranges[before.ranges.length - 1][1]))) {
      // A separator still short of columns: it waits, and so does its header.
      cut = before.ranges[before.ranges.length - 1][2]
      region = before
    } else if (info.leaf && info.leaf.type === 'para' && hasPipe(rest)) {
      // Any paragraph line with a pipe may be a table header (GFM): it waits
      // for the next line, so its pipes never flash as raw text.
      cut = lastStart
      region = before && before.type === 'para' ? before : null
    } else {
      if (info.leaf && info.leaf.ranges) region = info.leaf
      const tokens = holdTokens(lastRaw)
      if (tokens.at >= 0) {
        cut = lastStart + tokens.at
        pending = tokens.pending
      }
    }
  }

  // A MEDIA tag whose path is still arriving (also across a line break,
  // which extractMedia accepts) waits from its start: no marker, no
  // truncated path reaches the media reader.
  const media = openMediaTagIn(source)
  if (media >= 0 && media < cut) {
    cut = media
    pending = null
  }
  // A held last line may still turn into a table separator: a paragraph
  // line with a pipe above it (a possible header) waits with it.
  if (cut === lastStart && before && before.type === 'para') {
    const head = before.ranges[before.ranges.length - 1]
    if (hasPipe(source.slice(head[0], head[1]))) cut = head[2]
  }
  let safe = source.slice(0, cut)
  if (closeFence) {
    const text = `${safe}${safe.endsWith('\n') ? '' : '\n'}${closeFence.prefix}${closeFence.char.repeat(closeFence.len)}`
    return { text, held: source.slice(cut), directive: false, pending: null }
  }
  let closers = ''
  if (region && region.type !== 'indented' && region.ranges.length) {
    // Cutting can leave another delimiter at the end ("a **_"): scan again
    // until the tail is stable (each pass only shortens it).
    for (let pass = 0; pass < 8; pass += 1) {
      const { text, toSource } = leafText(source, region.ranges, safe.length)
      if (!text) break
      if (/^\[[ xX]?\]?[ \t]*$/.test(text) && region.ranges[0][0] > region.ranges[0][2]) {
        // A task-list marker with no text yet would show as a literal "[ ]".
        safe = safe.slice(0, region.ranges[0][2])
        pending = null
        break
      }
      // A table row's cells are split on its pipes before inline parsing
      // (GFM): only the last, growing cell is repaired.
      let from = 0
      if (region.type === 'table') {
        const pipe = /(?:^|[^\\])\|(?!.*(?:^|[^\\])\|)/.exec(text)
        if (pipe) from = pipe.index + pipe[0].length
      }
      const inline = inlineScan(text.slice(from), st.defs)
      if (inline.cut >= 0) inline.cut += from
      if (inline.cut < 0) {
        closers = inline.closers
        // A closer must touch the text it closes ("**bold **" stays raw).
        if (closers && !inline.code) safe = safe.replace(/\s+$/, '')
        break
      }
      let at = toSource(inline.cut)
      if (at >= safe.length) break
      // A line whose content is all held keeps no bare container markers
      // ("- ", "> - "): the whole line waits.
      const line = region.ranges.find(r => at >= r[2] && at <= r[0])
      if (line) at = line[2]
      safe = safe.slice(0, at)
      pending = null
    }
  }
  return { text: safe + closers, held: source.slice(safe.length), directive: Boolean(pending), pending }
}

/** The text a streaming reply draws now (streamSafeParts(text).text). */
export function streamSafe(text) {
  return streamSafeParts(text).text
}
