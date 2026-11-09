// Rewinds and the row identities they rewrite (review override-v2-r1 #3, #4).
//
// Ports of Hermes Agent 2bd378ed1b (MIT, (c) Nous Research):
//  - apps/desktop/src/app/session/hooks/use-prompt-actions/slash-session-commands.ts
//    isUserTurn / retryText / userTurnFromEnd / truncateRewoundMessages: a
//    canonical /undo or /retry derives its target from the owner's resume
//    snapshot and runs `session.rewind` (canonical-protocol.ts:450 turns it
//    into the revision-fenced `session.mutate rewind`; a reply that was lost
//    is retained and replayed by the `replay_only` probe, :378-386).
//  - use-prompt-actions/rewind.ts survivorRowIdsFrom / rebindSurvivorRowIds /
//    durableRowIdsForRebind: a legacy truncating prompt.submit rewrites the
//    surviving rows and answers with their new ids (tui_gateway/
//    methods_prompt.py:581-595), which every cached row id must follow.

import { durableRowId, isPersistedItem } from './history.js'

const COMPACTION_MARKERS = ['[CONTEXT COMPACTION', '[CONTEXT SUMMARY]:', '[END OF PRIOR CONTEXT']
const TEXT_PARTS = new Set(['input_text', 'output_text', 'text'])

/** A human-authored user turn of a resume snapshot (`split_user_originated_turn`). */
function isUserTurn(row) {
  return (
    row?.role === 'user' &&
    (!row.display_kind || row.display_kind === 'steer') &&
    Number.isSafeInteger(row.row_id) &&
    !row.archived &&
    !(typeof row.content === 'string' && COMPACTION_MARKERS.some(marker => row.content.includes(marker)))
  )
}

/** Lossless /retry text: '' when the turn has no text, null when it carries
 *  media or unknown parts (no replay protocol: fail closed). */
export function retryText(content) {
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content : [null]
  let text = ''
  for (const part of parts) {
    if (typeof part === 'string') text += part
    else if (part && typeof part === 'object' && TEXT_PARTS.has(part.type) && typeof part.text === 'string' && Object.keys(part).length === 2) text += part.text
    else return null
  }
  return text.trim() ? text : ''
}

/** The Nth newest user turn of the owner's snapshot, or null. */
export function userTurnFromEnd(rows, turnsBack) {
  const turns = (Array.isArray(rows) ? rows : []).filter(isUserTurn)
  return turns.length >= turnsBack ? turns[turns.length - turnsBack] : null
}

/** Chat items without the rewound ones: everything from the first item bound
 *  to a durable row at or after `rowId`; failing that, the Nth newest user
 *  bubble (truncateRewoundMessages). */
export function cutRewoundItems(items, rowId, turnsBack) {
  const list = Array.isArray(items) ? items : []
  let cut = Number.isSafeInteger(rowId) ? list.findIndex(item => Number.isSafeInteger(item?.rowId) && item.rowId >= rowId) : -1
  if (cut < 0) {
    const users = list.flatMap((item, index) => (item?.kind === 'user' ? [index] : []))
    cut = users[users.length - turnsBack] ?? -1
  }
  return cut < 0 ? list : list.slice(0, cut)
}

/** Loaded stored rows without the rewound ones (ids at or after `rowId`). */
export function cutRewoundRows(rows, rowId) {
  const list = Array.isArray(rows) ? rows : []
  if (!Number.isSafeInteger(rowId)) return list
  const cut = list.findIndex(row => (durableRowId(row) ?? -1) >= rowId)
  return cut < 0 ? list : list.slice(0, cut)
}

/** The survivors' new ids from a truncating prompt.submit receipt: a Map
 *  old -> new|null (newer gateways), a positional list of visible user ids
 *  (older ones), or undefined. */
export function survivorRowIdsFrom(result) {
  const rawMap = result?.survivor_row_id_map
  if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    const parsed = new Map()
    for (const [oldId, newId] of Object.entries(rawMap)) {
      const previous = Number(oldId)
      if (!Number.isInteger(previous)) continue
      if (newId === null) parsed.set(previous, null)
      else if (typeof newId === 'number' && Number.isInteger(newId)) parsed.set(previous, newId)
    }
    return parsed
  }
  const raw = result?.survivor_user_row_ids
  if (!Array.isArray(raw)) return undefined
  return raw.map(entry => (typeof entry === 'number' && Number.isInteger(entry) ? entry : null))
}

/** Every durable id the chat has loaded (the `rebind_survivor_row_ids` ask). */
export function durableRowIdsForRebind(rows, items) {
  const ids = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = durableRowId(row)
    if (id) ids.add(id)
  }
  for (const item of Array.isArray(items) ? items : []) if (Number.isSafeInteger(item?.rowId)) ids.add(item.rowId)
  return [...ids]
}

const rebound = (item, next) => {
  if (next === null || next === undefined) {
    const { rowId: _stale, ...rest } = item
    return rest
  }
  if (item.rowId === next) return item
  return { ...item, rowId: next, ...(item.id === `h:${item.rowId}` ? { id: `h:${next}` } : {}) }
}

/** Rebind chat items to their survivors' ids. Returns { items, mapping }
 *  (mapping: old -> new|null, what was applied, for the backing rows). */
export function rebindItems(items, survivors) {
  const list = Array.isArray(items) ? items : []
  const mapping = new Map()
  if (survivors instanceof Map) {
    for (const [from, to] of survivors) mapping.set(from, to)
    // Requested rows outside the active tip (compacted history) are not in
    // the map: they were not rewritten and keep their identity.
    return { items: list.map(item => (Number.isSafeInteger(item?.rowId) && survivors.has(item.rowId) ? rebound(item, survivors.get(item.rowId)) : item)), mapping }
  }
  if (!Array.isArray(survivors)) return { items: list, mapping }
  let ordinal = 0
  const next = list.map(item => {
    if (item?.kind !== 'user' || !isPersistedItem(item)) return item
    const to = ordinal < survivors.length ? survivors[ordinal] : null
    ordinal += 1
    if (Number.isSafeInteger(item.rowId)) mapping.set(item.rowId, to)
    return rebound(item, to)
  })
  return { items: next, mapping }
}

/** Apply an old -> new|null mapping to loaded stored rows. A row whose id the
 *  gateway dropped loses it (it addresses an archived row now). */
export function rebindRows(rows, mapping) {
  const list = Array.isArray(rows) ? rows : []
  if (!mapping?.size) return list
  return list.map(row => {
    const id = durableRowId(row)
    if (!id || !mapping.has(id)) return row
    const to = mapping.get(id)
    const { id: _id, row_id: _rowId, ...rest } = row
    if (to === null || to === undefined) return rest
    return { ...rest, ...('id' in row ? { id: to } : {}), ...('row_id' in row ? { row_id: to } : {}) }
  })
}
