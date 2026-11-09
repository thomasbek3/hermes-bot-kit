// A stand-in for @hermes/plugin-sdk used by the render test and the preview
// page. Only what the override touches; no network, no app.

import * as React from 'react'

const atom = (value: any) => ({ get: () => value, subscribe: (fn: any) => (fn(value), () => undefined) })

export const calls: any[] = []

export const host: any = {
  state: { connectionId: atom(null), profile: atom('default') },
  request: async (method: string, params: any) => (calls.push({ method, params }), {}),
  requestProfile: async (_route: any, method: string, params: any) => (calls.push({ method, params }), {}),
  revealPane: (id: string) => calls.push({ method: 'revealPane', params: id }),
  paneVisibility: () => atom(false),
  notify: () => undefined,
  notifyError: () => undefined,
  warmAgent: () => undefined
}

export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'
export const BOT_CHAT_SESSION_HYDRATION_TIMEOUT_MS = 60_000
export const queryClient = { getQueryCache: () => ({ findAll: () => [] }) }

const COLORS = ['#ff6b35', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#eab308', '#14b8a6', '#ec4899']
export function profileColor(name: string) {
  let h = 0
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

/** Hermes's markdown surface classes (markdown-text.tsx's container), so a
 *  preview that loads the real Hermes stylesheet sizes bot text the way the
 *  live app does: `.aui-md` takes --conversation-text-font-size (13px) unless
 *  the override sets it. */
export const MARKDOWN_CLASSES = [
  'aui-md prose w-full min-w-0 max-w-none overflow-hidden',
  'text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground',
  'prose-p:leading-(--dt-line-height) prose-li:leading-(--dt-line-height)',
  'prose-code:rounded-[0.25rem] prose-code:px-[0.1875rem] prose-code:py-px prose-code:font-mono prose-code:text-[0.9em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*+*]:mt-(--paragraph-gap)'
].join(' ')
const PARAGRAPH_CLASSES = 'wrap-anywhere leading-(--dt-line-height)'

/** `code`, **bold** and [label](url) only: enough to preview their look in
 *  a bubble. */
function inline(text: string): any[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/).map((part, i) => {
    if (/^`[^`]+`$/.test(part)) return React.createElement('code', { key: i }, part.slice(1, -1))
    if (/^\*\*[^*]+\*\*$/.test(part)) return React.createElement('strong', { key: i }, part.slice(2, -2))
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) return React.createElement('a', { key: i, href: link[2], className: 'wrap-anywhere' }, link[1])
    return part
  })
}

export function MessageTextContent({ text, media, previewOnly }: { text: string; media?: boolean; previewOnly?: boolean }) {
  const blocks = String(text).split(/\n{2,}/)
  return React.createElement(
    'div',
    { className: MARKDOWN_CLASSES, 'data-media': String(media !== false), 'data-preview-only': String(Boolean(previewOnly)) },
    blocks.map((block, i) => {
      const lines = block.split('\n')
      const heading = block.match(/^(#{1,4}) (.*)$/)
      if (heading) return React.createElement(`h${heading[1].length}`, { key: i }, inline(heading[2]))
      if (lines.every(line => /^[-*] /.test(line))) {
        return React.createElement('ul', { key: i, className: 'my-1 gap-0' }, lines.map((line, j) => React.createElement('li', { key: j, className: 'leading-(--dt-line-height)' }, inline(line.slice(2)))))
      }
      return React.createElement('p', { key: i, className: PARAGRAPH_CLASSES }, inline(block))
    })
  )
}
