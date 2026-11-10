// Bots pinned to the top of the sidebar: a big round avatar with the name
// under it, up to four in one even row. Display only. The pins are the
// override's own (plugin storage key `pinnedBots`): a list of exact route
// keys (roster rowKey), in the order they were pinned, so a local and a
// remote bot with the same name never share a pin. Nothing is written to
// Bot Mode's metadata or any gateway.
//
// Stores checked first (2026-11-09): `bot-pinned-tabs` pins a bot's Sessions
// as tabs (Hermes's pinned-session keys), and the retired `bot-sections`
// stored section names and assignments only; neither holds pinned bots. Bot Mode's own
// `meta.pinned` is a ui_meta write on the bot's gateway that orders a row
// first in its section (PARITY R11), which this must not touch.
//
// A pin whose bot is not in the roster right now is kept but not shown. The
// cap counts shown pins, so a pin left by a removed bot never blocks a new one.

export const PINS_KEY = 'pinnedBots'
export const MAX_PINS = 4

/** The stored list read back: unique non-empty strings, order kept. */
export function pinsFrom(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/** Which rows show pinned at the top (pin order, at most four, only bots in
 *  the roster now), the keys they use, and whether one more fits. */
export function pinState(pins, rows, keyOf) {
  const byKey = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = keyOf(row)
    if (!byKey.has(key)) byKey.set(key, row)
  }
  const shown = []
  for (const key of pinsFrom(pins)) {
    if (shown.length >= MAX_PINS) break
    const row = byKey.get(key)
    if (row) shown.push(row)
  }
  return { shown, keys: new Set(shown.map(row => keyOf(row))), canPin: shown.length < MAX_PINS }
}

/** Pin or unpin one route key. Unpinning always works; pinning is refused
 *  (changed: false) while four pins already show. */
export function togglePin(pins, key, rows, keyOf) {
  const list = pinsFrom(pins)
  const state = pinState(list, rows, keyOf)
  if (state.keys.has(key)) return { pins: list.filter(entry => entry !== key), changed: true, pinned: false }
  if (!state.canPin) return { pins: list, changed: false, pinned: false }
  return { pins: [...list.filter(entry => entry !== key), key], changed: true, pinned: true }
}

/** The section list's rows without the ones shown pinned on top. */
export function withoutPinned(rows, state, keyOf) {
  if (!state?.keys?.size) return rows
  return rows.filter(row => !state.keys.has(keyOf(row)))
}
