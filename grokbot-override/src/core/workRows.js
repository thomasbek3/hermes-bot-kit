// Work rows (a reply's "Thought" disclosure and its "N tools" rows) are
// hidden in the Bot Chat by default, the way the chat look shows only the
// conversation. Display only: the transcript keeps every item, this returns a
// filtered view of it. Runtime metadata notices (history.js
// SYSTEM_NOTICE_KINDS: the "[System: …model has changed…]" pivot, Hermes's
// "Your request was not processed…" boundary) and background-work cards
// (history.js BACKGROUND_NOTICE_KINDS: "Background task finished") are
// hidden and come back with them. Approvals, questions, other notices, errors (a failed turn's error
// card included), commands and the working indicator are never hidden.
//
// The setting is the override's own: the palette command "Grokbot Override:
// show work rows" toggles `showWork` in its plugin storage (hidden by
// default). It used to be the retired Bubble Mode's "toggle work rows"
// preference; on the first run without a stored value of its own, that
// preference is copied once (Bubble Mode's storage is only read).

import { backgroundNoticeLabel } from './history.js'

export const SHOW_WORK_KEY = 'showWork'
export const LEGACY_SHOW_WORK_PLUGIN = 'bubble-mode'
export const LEGACY_SHOW_WORK_KEY = 'showWork'

/** The stored preference read back: only an explicit `true` shows them. */
export function showWorkFrom(value) {
  return value === true
}

/** The setting on start, and whether to store it: the override's own value
 *  when it has one, else Bubble Mode's old preference, copied once. */
export function loadShowWork(stored, legacy) {
  if (typeof stored === 'boolean') return { value: stored, write: false }
  return { value: showWorkFrom(legacy), write: true }
}

/** The transcript as drawn: with work rows hidden, tool groups go, a reply's
 *  reasoning goes, and a reply that was only reasoning goes too. */
export function visibleItems(items, showWork) {
  const list = Array.isArray(items) ? items : []
  if (showWork) return list
  const out = []
  for (const item of list) {
    if (item?.kind === 'tools') continue
    if (item?.kind === 'notice' && item.system) continue
    if (item?.kind === 'assistant' && item.reasoning) {
      if (!item.text && !(Array.isArray(item.reactions) && item.reactions.length)) continue
      const { reasoning: _reasoning, ...rest } = item
      out.push(rest)
      continue
    }
    out.push(item)
  }
  return out
}

/** What the working indicator says while a turn runs. With work rows shown,
 *  a running tool row or a streaming reply is the activity itself; with them
 *  hidden, the indicator stands in for both until reply text arrives. */
export function activityLabel(chat, showWork) {
  if (!chat || chat.waiting) return ''
  const status = chat.status
  if (status?.text) {
    if (status.kind === 'compacting') return 'Summarizing earlier messages'
    // A background process's status line names its command (often an
    // absolute path): the indicator says what happened, never the path.
    if (status.kind === 'process') return backgroundNoticeLabel('', status.text)
    return status.text
  }
  const items = Array.isArray(chat.items) ? chat.items : []
  const last = items[items.length - 1]
  if (last?.kind === 'tools' && Array.isArray(last.tools) && last.tools.some(tool => tool?.status === 'running')) return showWork ? '' : 'Working'
  if (last?.kind === 'assistant' && last.streaming) return showWork || last.text ? '' : 'Thinking'
  if (last?.kind === 'approval' && last.status === 'pending') return ''
  return 'Thinking'
}
