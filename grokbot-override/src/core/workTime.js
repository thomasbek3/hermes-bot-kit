// How long a turn took, on its work fold: "Worked for 3m 12s · 12 tools".
// Display only, from timestamps the transcript items already carry: the
// turn starts at its user message (`at`) and ends at its reply's completion
// (`completedAt`, stamped by the reducer on message.complete, else the last
// reply / error item's `at`, which is the stored row's timestamp for
// history). Hermes's own turns for finished background work (the
// process_complete / async_delegation_complete prompts, drawn as notices)
// start a turn too, at the notice's time. A turn whose start is not on
// screen (an earlier page) or has no time, whose latest reply has no time,
// whose end is before its last tools ran, or that is still running gets no
// time: the fold keeps its old "N tools" line.

import { BACKGROUND_NOTICE_KINDS } from './history.js'

const END_KINDS = new Set(['assistant', 'error', 'turn-error'])

/** A user message, or a synthetic prompt Hermes ran a turn for. */
const startsTurn = item => item?.kind === 'user' || (item?.kind === 'notice' && BACKGROUND_NOTICE_KINDS.has(item.system))

/** 41s, 3m 12s, 1h 4m (under a second reads 1s). */
export function formatWorked(ms) {
  const secs = Math.max(1, Math.round(Number(ms) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

const time = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)

/**
 * The items with `workedMs` on the last tool group of every finished turn.
 * `busy`: the newest turn is still running (no time for it yet). Returns the
 * same array when nothing changes.
 */
export function withWorkTimes(items, { busy = false } = {}) {
  const list = Array.isArray(items) ? items : []
  const patches = new Map()
  let start = -1
  const close = (from, to, last) => {
    if (from < 0) return
    const began = time(list[from].at)
    if (began === null) return
    let tools = -1
    let end = null
    for (let i = from + 1; i < to; i += 1) {
      const item = list[i]
      if (item?.kind === 'tools') {
        tools = i
        if (time(item.completedAt) !== null) end = time(item.completedAt)
      } else if (END_KINDS.has(item?.kind)) {
        // The latest reply decides: one without a time means no time, never
        // an earlier interim reply's.
        end = time(item.completedAt) ?? time(item.at)
      }
    }
    if (tools < 0 || end === null || (last && busy) || end < began) return
    const toolsAt = time(list[tools].at)
    if (toolsAt !== null && end < toolsAt) return
    patches.set(tools, end - began)
  }
  for (let i = 0; i < list.length; i += 1) {
    if (!startsTurn(list[i])) continue
    close(start, i, false)
    start = i
  }
  close(start, list.length, true)
  if (!patches.size && !list.some(item => item?.kind === 'tools' && 'workedMs' in item)) return items
  let changed = false
  const out = list.map((item, i) => {
    if (patches.has(i)) {
      if (item.workedMs === patches.get(i)) return item
      changed = true
      return { ...item, workedMs: patches.get(i) }
    }
    if (item?.kind === 'tools' && 'workedMs' in item) {
      changed = true
      const { workedMs: _drop, ...rest } = item
      return rest
    }
    return item
  })
  return changed ? out : items
}

/** The fold's line: "Worked for 3m 12s · 12 tools" when the turn's time is
 *  known, else the old "12 tools · 40s" (the tools' own run time). */
export function foldLabel({ done, workedMs, toolSecs = 0 }) {
  const count = done === 1 ? '1 tool' : `${done} tools`
  if (typeof workedMs === 'number' && Number.isFinite(workedMs) && workedMs >= 0) return `Worked for ${formatWorked(workedMs)} · ${count}`
  return toolSecs >= 1 ? `${count} · ${Math.round(toolSecs)}s` : count
}
