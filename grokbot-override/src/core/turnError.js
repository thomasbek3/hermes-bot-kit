// A failed turn as one calm card, and the /undo echo as one muted line.
// Display only: the chat keeps every item, this returns the drawn view.
//
// Real markers, Hermes Agent @2bd378ed1b:
//  - `kind: 'error'` items: a failed turn's error card from its boundary
//    row's display_metadata (history.js, `display_kind: 'failed_turn'`,
//    agent/conversation_loop.py _failed_turn_display_metadata), a live
//    `message.complete {status: 'error'}` or `error` event (reducer.js), or a
//    retained failed inflight turn (session.js).
//  - `failedTurn` notices: the boundary row's own text, "Your request was not
//    processed…" / "This turn did not complete…" (agent/turn_failure_copy.py),
//    stamped by history.js from `display_kind`, never from text.
//  - the /undo echo: a local command card (session.js runSlash) whose output
//    is the rewind receipt, "↶ Undid N turn(s) (M message(s))…"
//    (tui_gateway/methods_tools.py:882) or the canonical one session.js
//    writes. Matched on the exact receipt shape after an `/undo` command.
//
// The card's Try again is the supported /retry (session.js retryTurn): only
// the newest failed turn offers it, and only while nothing runs.

export const FAILED_TITLE = 'That reply didn’t go through.'
export const STILL_FAILING_TITLE = 'Still failing. Start a new chat'
export const UNDO_NOTE = 'Removed the failed reply'

const UNDO_COMMAND = /^\/undo(?:\s+\d+)?$/
const UNDO_RECEIPT = /^↶ Undid \d+ (?:turns?|messages?)\b/

/** An `/undo` command card whose output is the rewind receipt. */
export function isUndoEcho(item) {
  return (
    item?.kind === 'command' &&
    !item.running &&
    !item.error &&
    UNDO_COMMAND.test(String(item.command || '').trim()) &&
    UNDO_RECEIPT.test(String(item.output || '').trim())
  )
}

/** The user text a failed card follows (the turn it would retry), or ''. */
function userTextBefore(list, index) {
  for (let i = index - 1; i >= 0; i -= 1) if (list[i]?.kind === 'user') return String(list[i].text || '')
  return ''
}

/**
 * Items as drawn: each failed turn's error (and its boundary line) becomes one
 * `turn-error` item `{ id, at, detail, prompt, canRetry, retrying, stillFailing }`;
 * an /undo echo becomes `{ kind: 'undo-note', text }`. Everything else is
 * returned as it is.
 *
 * `busy`: a turn runs (no Try again). `retry`: the controller's
 * `turnRetry` state, `{ running, from, text, failed }` or null: `from` is the
 * card a Try again started from; a newer failed card after the same message
 * (or that card when its retry itself failed) is "still failing".
 */
export function withTurnCards(items, { busy = false, retry = null } = {}) {
  const list = Array.isArray(items) ? items : []
  const out = []
  let changed = false
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    if (isUndoEcho(item)) {
      changed = true
      out.push({ kind: 'undo-note', id: item.id, at: item.at, text: UNDO_NOTE })
      continue
    }
    // A boundary line on its own is a card only when it is the visible
    // partial-turn one (the "not processed" one is runtime metadata, shown
    // with the work rows as it was).
    const boundary = item?.kind === 'notice' && item.failedTurn && !item.system
    if (item?.kind !== 'error' && !boundary) {
      out.push(item)
      continue
    }
    changed = true
    const detail = [String(item.text || '').trim()]
    // The boundary row right after its own error card folds into it.
    if (item.kind === 'error' && list[i + 1]?.kind === 'notice' && list[i + 1].failedTurn) {
      i += 1
      detail.push(String(list[i].text || '').trim())
    }
    out.push({ kind: 'turn-error', id: item.id, at: item.at, detail: detail.filter(Boolean).join('\n') })
  }
  if (!changed) return items
  // Only the newest failed card, with no message sent after it, retries.
  let last = -1
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]?.kind === 'user') break
    if (out[i]?.kind === 'turn-error') {
      last = i
      break
    }
  }
  return out.map((entry, index) => {
    if (entry?.kind !== 'turn-error') return entry
    const newest = index === last
    const from = retry?.from || ''
    const prompt = userTextBefore(out, index)
    const stillFailing = Boolean(
      newest && retry && !retry.running && (retry.failed ? entry.id === from : entry.id !== from && prompt.trim() === retry.text)
    )
    return { ...entry, prompt, canRetry: newest && !busy, retrying: Boolean(newest && retry?.running), stillFailing }
  })
}
