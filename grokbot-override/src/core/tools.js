// Tool call detail (PARITY C13): the arguments, the result, an inline diff and
// an image a tool produced, kept on each tool entry so the transcript can show
// them the way the app's tool row does (components/assistant-ui/tool/
// fallback.tsx: `technicalTrace` Arguments / Result, FileDiffPanel for
// `inline_diff`, MarkdownImage for the produced image). Payloads follow
// tui_gateway/contracts/events.py ToolStartPayload / ToolCompletePayload and
// the stored rows (assistant `tool_calls[].function.arguments`, `role: tool`
// content). Very large payloads are clipped, as the app's view also caps them.

export const TOOL_TEXT_MAX = 64_000

export function clip(text, max = TOOL_TEXT_MAX) {
  const value = typeof text === 'string' ? text : text == null ? '' : safeJson(text)
  return value.length > max ? `${value.slice(0, max)}\n… (${value.length - max} more characters)` : value
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Arguments as text: an object is pretty JSON, a JSON string is parsed. */
export function argsText(args) {
  if (args == null || args === '') return ''
  if (typeof args === 'string') {
    try {
      return clip(JSON.stringify(JSON.parse(args), null, 2))
    } catch {
      return clip(args)
    }
  }
  if (typeof args === 'object' && !Object.keys(args).length) return ''
  return clip(args)
}

/** The detail fields a tool.start frame carries. */
export function startDetail(payload) {
  const args = payload?.args && typeof payload.args === 'object' ? payload.args : typeof payload?.args_text === 'string' ? payload.args_text : null
  return { ...(args != null ? { args: argsText(args) } : {}) }
}

/** The detail fields a tool.complete frame carries. */
export function completeDetail(payload) {
  const out = {}
  const args = payload?.args && typeof payload.args === 'object' ? argsText(payload.args) : ''
  if (args) out.args = args
  const result = typeof payload?.result_text === 'string' && payload.result_text ? payload.result_text : payload?.result
  if (result != null && result !== '') out.result = clip(result)
  if (typeof payload?.inline_diff === 'string' && payload.inline_diff.trim()) out.diff = clip(payload.inline_diff)
  if (typeof payload?.image_path === 'string' && payload.image_path) out.image = payload.image_path
  return out
}

/** Unified-diff lines with a kind for colouring. */
export function diffLines(diff) {
  return String(diff || '')
    .split('\n')
    .map(line => ({
      text: line,
      kind: /^(\+\+\+|---)/.test(line) ? 'file' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
    }))
}

export function hasDetail(tool) {
  return Boolean(tool?.args || tool?.result || tool?.diff || tool?.image)
}
