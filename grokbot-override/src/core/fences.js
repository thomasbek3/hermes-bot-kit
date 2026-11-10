// Fenced code blocks in a bot's message, drawn by the override (ui/
// CodeBlock.tsx) instead of the SDK renderer: in its inert mode Hermes's
// markdown draws a fence in a box capped at 7.5rem with only a bare chevron
// to open it (shiki-highlighter Expandable, `max-h-[7.5rem]`) and no copy
// button, so a handoff the user is meant to copy was clipped. Here every
// fence has a Copy button, shows in full up to CODE_FOLD_LINES lines and
// folds longer ones behind "Show more".
//
// Top-level fences only, CommonMark rules: an opening line of 0-3 spaces and
// at least three backticks or tildes (a backtick fence's info string has no
// backtick), closed by the same character at least as long with only
// whitespace after; an unclosed fence runs to the end. The opening line's
// indentation is taken off the content lines, up to that many spaces.

export const CODE_FOLD_LINES = 60
export const CODE_FOLDED_LINES = 40

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/

/** `[{kind:'text', text}, {kind:'code', code, lang}]` in order; text
 *  segments never blank. A message with no fence is one text segment. */
export function splitFences(text) {
  const source = String(text ?? '')
  if (!source.includes('```') && !source.includes('~~~')) return source.trim() ? [{ kind: 'text', text: source }] : []
  const lines = source.split('\n')
  const out = []
  let prose = []
  const flushProse = () => {
    const joined = prose.join('\n')
    if (joined.trim()) out.push({ kind: 'text', text: joined })
    prose = []
  }
  for (let i = 0; i < lines.length; i += 1) {
    const m = OPEN.exec(lines[i])
    if (!m || (m[2][0] === '`' && m[3].includes('`'))) {
      prose.push(lines[i])
      continue
    }
    const indent = m[1].length
    const fence = m[2]
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
    const body = []
    let j = i + 1
    for (; j < lines.length; j += 1) {
      if (close.test(lines[j])) break
      body.push(lines[j].replace(new RegExp(`^ {0,${indent}}`), ''))
    }
    flushProse()
    out.push({ kind: 'code', code: body.join('\n'), lang: m[3].trim().split(/\s+/)[0] || '' })
    i = j
  }
  flushProse()
  return out
}

/** How many lines a block has (a trailing newline adds none). */
export function codeLineCount(code) {
  const text = String(code ?? '')
  if (!text) return 0
  return text.replace(/\n$/, '').split('\n').length
}

/** Whether a block is long enough to fold behind "Show more". */
export function codeFolds(code) {
  return codeLineCount(code) > CODE_FOLD_LINES
}
