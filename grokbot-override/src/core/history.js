// Stored transcript rows -> chat items.
//
// Two row shapes reach the override and both are normalised here:
//  - REST `/api/sessions/{id}/messages` rows (`SessionMessage`: content,
//    display_content, tool_calls, tool_call_id, numeric `id`, reasoning…);
//  - the gateway projection in a `session.resume` snapshot
//    (`TranscriptMessage`: text, name, context, args, `row_id`).
//
// Item kinds the UI draws:
//   user      { id, text, at, attachments }
//   assistant { id, text, at, reasoning }
//   tools     { id, at, tools: [{ id, name, label, status, summary, duration }] }
//   notice    { id, text, at }

import { shownReplyText } from './silence.js'
import { argsText, clip } from './tools.js'

export function toMillis(value) {
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text'])
const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image'])

export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part && TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

function contentImages(content) {
  if (!Array.isArray(content)) return 0
  return content.filter(part => part && IMAGE_PART_TYPES.has(part.type)).length
}

function parseMetadata(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function rowText(row) {
  if (row?.display_content !== undefined && row?.display_content !== null) {
    const text = contentText(row.display_content)
    if (text) return text
  }
  if (typeof row?.text === 'string') return row.text
  return contentText(row?.content)
}

function rowReasoning(row) {
  const value = row?.display_reasoning || row?.reasoning || row?.reasoning_content
  return typeof value === 'string' ? value.trim() : ''
}

function rowId(row, index, prefix) {
  const durable = row?.row_id ?? row?.id
  return durable !== undefined && durable !== null && durable !== '' ? `${prefix}${durable}` : `${prefix}i${index}`
}

/** The durable row id (REST `id`, gateway `row_id`): what edit / regenerate
 *  truncate before (C22) and reactions address (C23). */
export function durableRowId(row) {
  const value = row?.id ?? row?.row_id
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** Reactions persisted in a row's display metadata (lib/chat-messages/
 *  hydration.ts messageReactions). */
export function rowReactions(row) {
  const meta = parseMetadata(row?.display_metadata)
  const list = Array.isArray(meta?.reactions) ? meta.reactions : Array.isArray(row?.reactions) ? row.reactions : []
  return list.filter(r => r && typeof r.emoji === 'string' && r.emoji && (r.author === 'user' || r.author === 'agent'))
}

function rowExtras(row) {
  const rowId = durableRowId(row)
  const reactions = rowReactions(row)
  return { ...(rowId ? { rowId } : {}), ...(reactions.length ? { reactions } : {}) }
}

/** Human line for a tool call: the backend's own label, else context, else name. */
export function toolLabel({ name, labels, context, preview }) {
  const label = Array.isArray(labels) && labels.length ? labels.map(l => l?.text).filter(Boolean).join(', ') : ''
  if (label) return label
  const detail = typeof context === 'string' && context.trim() ? context.trim() : typeof preview === 'string' ? preview.trim() : ''
  const pretty = String(name || 'tool').replace(/_/g, ' ')
  return detail ? `${pretty}: ${detail}` : pretty
}

function parseToolCalls(row) {
  const calls = Array.isArray(row?.tool_calls) ? row.tool_calls : []
  const storedLabels = row?.tool_call_labels && typeof row.tool_call_labels === 'object' ? row.tool_call_labels : {}
  return calls
    .map((call, index) => {
      const id = String(call?.id || call?.call_id || `${rowId(row, index, 'call-')}-${index}`)
      const name = String(call?.function?.name || call?.name || 'tool')
      let args = call?.function?.arguments ?? call?.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          /* keep the string */
        }
      }
      const labels = storedLabels[id]
      const context = args && typeof args === 'object' ? firstArgPreview(args) : ''
      const text = argsText(args)
      return { id, name, label: toolLabel({ name, labels, context }), status: 'done', ...(text ? { args: text } : {}) }
    })
    .filter(Boolean)
}

function firstArgPreview(args) {
  for (const key of ['command', 'query', 'url', 'path', 'file_path', 'name', 'prompt']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim().slice(0, 80)
  }
  return ''
}

/** Normalise stored rows (oldest first) into chat items. */
/** Backend-authored rows that are runtime metadata, not conversation, by
 *  their `display_kind` (Hermes Agent @2bd378ed1b):
 *   - model_switch: the role=user "[System: The active model for this chat
 *     has changed to …]" pivot (tui_gateway/server.py
 *     _append_model_switch_marker);
 *   - personality_switch: the same kind of pivot for a personality change
 *     (tui_gateway/agent_callbacks.py:331);
 *   - failed_turn: Hermes's boundary row closing a turn that ended without a
 *     reply, "Your request was not processed…" / "This turn did not
 *     complete…" (agent/turn_failure_copy.py; legacy untyped rows are typed
 *     by the REST and resume readers, web_routers/sessions.py:709,
 *     session_history.py:270). Its error card is NOT hidden, nor is the
 *     partial-turn boundary ("…verify their effects…"), a muted notice line;
 *   - auto_continue: the injected "resume the interrupted turn" prompt
 *     (tui_gateway/session_auto_continue.py);
 *   - internal_notification: a self-injected machinery turn's user row
 *     (gateway/response_filters.py:33).
 *  Their notices carry `system` and are hidden with the work rows
 *  (core/workRows.js visibleItems). Never decided from message text. */
export const SYSTEM_NOTICE_KINDS = new Set(['model_switch', 'personality_switch', 'failed_turn', 'auto_continue', 'internal_notification'])

/** The one failed-turn boundary that stays visible: it asks the user to
 *  verify what may already have run (agent/turn_failure_copy.py
 *  PARTIAL_FAILED_TURN_NOTICE). Matched exactly, on a Hermes-authored
 *  failed_turn row only, the way Hermes's own reader types these rows
 *  (untyped_failed_turn_display_kind); never on user or model text. */
export const PARTIAL_FAILED_TURN_NOTICE = 'This turn did not complete. Some actions may already have run; verify their effects before resending.'

function isSystemNotice(kind, role, text) {
  if (!SYSTEM_NOTICE_KINDS.has(kind)) return false
  return !(kind === 'failed_turn' && role === 'assistant' && text === PARTIAL_FAILED_TURN_NOTICE)
}

/** Producer cards for background work finishing, by `display_kind`
 *  (gateway/response_filters.py PRODUCER_NOTICE_DISPLAY_KINDS):
 *   - process_complete: "Background Process Finished: <command>" and its
 *     Failed / Terminated / Lost / "N Background Processes Finished" forms
 *     (tools/process_registry_notifications.py
 *     process_completion_display_text), whose command is often an absolute
 *     path;
 *   - async_delegation_complete: "Subagent Task Completed: <goal>"
 *     (async_delegation_display_text).
 *  Stock Desktop draws them as a background-result card
 *  (lib/chat-messages hydration: asyncResult). Here they are work rows:
 *  hidden by default, and when shown a short label with the full line in the
 *  tooltip only, so a path is never printed in the chat. */
export const BACKGROUND_NOTICE_KINDS = new Set(['process_complete', 'async_delegation_complete'])

const PROCESS_OUTCOMES = [
  [/^\s*(\d+) background processes finished/i, m => `${m[1]} background tasks finished`],
  [/^\s*background process failed to start/i, () => 'Background task failed to start'],
  [/^\s*background process failed/i, () => 'Background task failed'],
  [/^\s*background process terminated/i, () => 'Background task stopped'],
  [/^\s*background process lost/i, () => 'Background task lost'],
  [/^\s*background process finished/i, () => 'Background task finished']
]

/** The short label a background card shows (never its command or path). */
export function backgroundNoticeLabel(kind, text) {
  if (kind === 'async_delegation_complete') return 'Background agent work finished'
  const line = String(text || '')
  for (const [re, label] of PROCESS_OUTCOMES) {
    const m = re.exec(line)
    if (m) return label(m)
  }
  return kind === 'process_complete' ? 'Background task finished' : 'Background task update'
}

const TITLE_MAX = 300

/** A background card as a chat notice: label, full line as its tooltip. */
export function backgroundNotice(kind, text, fields) {
  const full = String(text || '').replace(/\s+/g, ' ').trim()
  return { kind: 'notice', ...fields, text: backgroundNoticeLabel(kind, full), ...(full ? { title: full.length > TITLE_MAX ? `${full.slice(0, TITLE_MAX - 1)}…` : full } : {}), system: kind }
}

/** A failed turn's error text from its boundary row's display_metadata
 *  ({error, error_surface: {code, message, …}}), or ''. */
function failedTurnError(meta) {
  if (!meta) return ''
  if (typeof meta.error === 'string' && meta.error.trim()) return meta.error.trim()
  const surface = meta.error_surface && typeof meta.error_surface === 'object' ? meta.error_surface : null
  const text = surface && (typeof surface.message === 'string' && surface.message.trim() ? surface.message : typeof surface.code === 'string' ? surface.code : '')
  return text ? text.trim() : ''
}

export function historyToItems(rows, { idPrefix = 'h:' } = {}) {
  const items = []
  let tools = null

  // A tool group is named after its first call, so the same rows give the
  // same id however many pages are loaded around them.
  const flushTools = () => {
    if (tools && tools.tools.length) items.push({ ...tools, id: `${idPrefix}tools-${tools.tools[0].id}` })
    tools = null
  }
  const toolGroup = at => {
    if (!tools) tools = { kind: 'tools', id: '', at, tools: [] }
    return tools
  }

  ;(Array.isArray(rows) ? rows : []).forEach((row, index) => {
    if (!row || typeof row !== 'object') return
    const role = row.role
    const at = toMillis(row.timestamp)
    const kind = typeof row.display_kind === 'string' ? row.display_kind : ''
    if (kind === 'hidden' || role === 'system') return

    if (kind && kind !== 'steer' && role !== 'tool') {
      const meta = parseMetadata(row.display_metadata)
      // A failed turn's error card rides its boundary row's metadata
      // (agent/conversation_loop.py _failed_turn_display_metadata): a real
      // error the user may need to act on, always shown.
      const failure = kind === 'failed_turn' ? failedTurnError(meta) : ''
      if (failure) {
        flushTools()
        items.push({ kind: 'error', id: `${rowId(row, index, idPrefix)}-error`, text: failure, at })
      }
      const text = (meta && typeof meta.display_text === 'string' && meta.display_text) || rowText(row)
      if (BACKGROUND_NOTICE_KINDS.has(kind)) {
        flushTools()
        items.push(backgroundNotice(kind, text, { id: rowId(row, index, idPrefix), at }))
        return
      }
      if (text.trim()) {
        flushTools()
        items.push({ kind: 'notice', id: rowId(row, index, idPrefix), text: text.trim(), at, ...(isSystemNotice(kind, role, text.trim()) ? { system: kind } : {}), ...(kind === 'failed_turn' && role === 'assistant' ? { failedTurn: true } : {}) })
      }
      return
    }

    if (role === 'tool') {
      const group = toolGroup(at)
      const id = String(row.tool_call_id || rowId(row, index, 'tool-'))
      const existing = group.tools.find(tool => tool.id === id)
      const label = toolLabel({ name: row.name || row.tool_name, labels: row.labels, context: row.context })
      const result = rowText(row)
      if (existing) {
        if (row.labels || row.context) existing.label = label
        if (result) existing.result = clip(result)
      } else {
        group.tools.push({ id, name: String(row.name || row.tool_name || 'tool'), label, status: 'done', ...(result ? { result: clip(result) } : {}) })
      }
      return
    }

    if (role === 'assistant') {
      const calls = parseToolCalls(row)
      // A reply that is only the silence sentinel ("[SILENT]") is no reply.
      const text = shownReplyText(rowText(row).trim())
      const reasoning = rowReasoning(row)
      if (text || reasoning) {
        flushTools()
        items.push({ kind: 'assistant', id: rowId(row, index, idPrefix), text, at, ...(reasoning ? { reasoning } : {}), ...rowExtras(row) })
      }
      if (calls.length) {
        const group = toolGroup(at)
        for (const call of calls) if (!group.tools.some(tool => tool.id === call.id)) group.tools.push(call)
      }
      return
    }

    if (role === 'user') {
      flushTools()
      const text = rowText(row)
      const images = contentImages(row.display_content ?? row.content)
      if (!text.trim() && !images) return
      items.push({
        kind: 'user',
        id: rowId(row, index, idPrefix),
        text,
        at,
        ...(images ? { attachments: Array.from({ length: images }, () => ({ kind: 'image', name: 'image' })) } : {}),
        ...rowExtras(row)
      })
    }
  })

  flushTools()
  return items
}

/** The newest item's preview line (for the roster). */
export function lastPreview(items) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if ((item.kind === 'assistant' || item.kind === 'user') && item.text.trim()) {
      return item.text.replace(/\s+/g, ' ').trim()
    }
  }
  return ''
}

// ── merging pages ────────────────────────────────────────────────────────
// The controller keeps the stored rows it has loaded (oldest first, one
// contiguous run ending at the newest row) and derives the persisted chat
// items from them. Pages are read with order=latest, so `offset` counts back
// from the newest row: the next older page starts at `rows.length`.

/** A stored row's durable identity (REST `id`, gateway `row_id`). */
export function rowIdentity(row, index = 0) {
  const durable = row?.id ?? row?.row_id
  if (durable !== undefined && durable !== null && durable !== '') return `id:${durable}`
  return `t:${row?.timestamp ?? ''}:${row?.role ?? ''}:${index}`
}

/** Which sent (optimistic) user bubbles the stored rows now hold, so the
 *  local bubble can give way to the stored copy without a duplicate, and
 *  never earlier (a transcript read before the gateway stored the turn shows
 *  no copy yet: the bubble stays).
 *
 *  `sends`, oldest first: { id, text, submitted, known, byOrder }
 *    text      what the bubble shows
 *    submitted what prompt.submit carried ('' before the submit)
 *    known     row identities loaded when it was sent (never its copy)
 *    byOrder   it may also claim a new user row whose text differs (the
 *              gateway stores an expanded skill or an @mention note); only
 *              when the send was accepted and the turn has ended.
 *  Each stored user row is claimed once, so two identical sends need two
 *  stored rows. Returns the Set of confirmed send ids. */
export function confirmedSends(sends, rows) {
  const users = []
  ;(Array.isArray(rows) ? rows : []).forEach((row, index) => {
    if (row?.role !== 'user' || row.display_kind === 'hidden') return
    users.push({ key: rowIdentity(row, index), text: rowText(row).trim() })
  })
  const claimed = new Set()
  const done = new Set()
  const fresh = send => users.filter(user => !claimed.has(user.key) && !(send.known && send.known.has(user.key)))
  const claim = (send, user) => {
    claimed.add(user.key)
    done.add(send.id)
  }
  const list = Array.isArray(sends) ? sends : []
  for (const send of list) {
    const texts = [send.text, send.submitted].map(t => String(t || '').trim()).filter(Boolean)
    const hit = texts.length ? fresh(send).find(user => texts.includes(user.text)) : undefined
    if (hit) claim(send, hit)
  }
  for (const send of list) {
    if (done.has(send.id) || !send.byOrder) continue
    const hit = fresh(send)[0]
    if (hit) claim(send, hit)
  }
  return done
}

/** Fold a fresh newest page into the loaded rows. Rows older than the page
 *  are kept; rows the page covers are replaced by it. When the page does not
 *  reach back to anything loaded (more new rows than one page), the older
 *  rows can no longer be joined without a gap and are dropped, so the
 *  pagination offset stays exact. */
export function mergeTailRows(loaded, tail) {
  const page = Array.isArray(tail) ? tail : []
  const rows = Array.isArray(loaded) ? loaded : []
  if (!page.length) return page
  const first = rowIdentity(page[0], 0)
  const at = rows.findIndex((row, index) => rowIdentity(row, index) === first)
  if (at < 0) return page
  return [...rows.slice(0, at), ...page]
}

/** Put an older page in front of the loaded rows (dropping any overlap). */
export function mergeOlderRows(older, loaded) {
  const rows = Array.isArray(loaded) ? loaded : []
  const known = new Set(rows.map(rowIdentity))
  const fresh = (Array.isArray(older) ? older : []).filter((row, index) => !known.has(rowIdentity(row, index)))
  return [...fresh, ...rows]
}

const PERSISTED_PREFIX = 'h:'

export function isPersistedItem(item) {
  return typeof item?.id === 'string' && item.id.startsWith(PERSISTED_PREFIX)
}

/** Items for the loaded rows. */
export function rowsToItems(rows) {
  return historyToItems(rows, { idPrefix: PERSISTED_PREFIX })
}

/** Replace the persisted items of `current` with `persisted`, keeping the
 *  items `keep` selects (live or local-only) where they were: each kept item
 *  goes right after the persisted item that preceded it before, or, when
 *  that one is gone, after the last persisted item not newer than it. */
export function rebuildItems(current, persisted, keep) {
  const kept = []
  let anchor = null
  for (const item of Array.isArray(current) ? current : []) {
    if (isPersistedItem(item)) anchor = item.id
    else if (keep(item)) kept.push({ item, anchor })
  }
  if (!kept.length) return persisted
  const ids = new Set(persisted.map(item => item.id))
  const after = new Map()
  const tail = []
  for (const { item, anchor: id } of kept) {
    let target = id && ids.has(id) ? id : null
    if (!target && id === null) target = '^'
    if (!target && Number.isFinite(item.at)) {
      for (const p of persisted) if (Number.isFinite(p.at) && p.at <= item.at) target = p.id
    }
    if (!target) {
      tail.push(item)
      continue
    }
    if (!after.has(target)) after.set(target, [])
    after.get(target).push(item)
  }
  const out = [...(after.get('^') || [])]
  for (const item of persisted) {
    out.push(item)
    if (after.has(item.id)) out.push(...after.get(item.id))
  }
  return [...out, ...tail]
}
