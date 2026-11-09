// The profile panel's width: dragged from the hairline between the chat and
// the panel, clamped so the chat column always keeps room, remembered in the
// override's own plugin storage, and reset by a double-click. Pure numbers
// here; ui/app.ts owns the store and the storage.

export const PANEL_WIDTH_KEY = 'panelWidth'
export const PANEL_WIDTH = Object.freeze({ default: 360, min: 260, max: 480 })
/** The chat column never gets narrower than this beside the panel. */
export const CHAT_MIN_WIDTH = 360

/** Clamp a panel width to 260-480 px and, when the workspace width is known,
 *  to what leaves the chat column its 360 px (never below the 260 floor). */
export function clampPanelWidth(width, workspaceWidth = Infinity) {
  const value = Number(width)
  if (!Number.isFinite(value)) return PANEL_WIDTH.default
  const total = Number(workspaceWidth)
  const room = Number.isFinite(total) && total > 0 ? total - CHAT_MIN_WIDTH : Infinity
  const max = Math.max(PANEL_WIDTH.min, Math.min(PANEL_WIDTH.max, room))
  return Math.round(Math.min(max, Math.max(PANEL_WIDTH.min, value)))
}

/** The width while dragging: the panel sits on the right, so moving the
 *  pointer left widens it. */
export function dragPanelWidth(startWidth, startX, x, workspaceWidth = Infinity) {
  return clampPanelWidth(Number(startWidth) + (Number(startX) - Number(x)), workspaceWidth)
}

/** A stored value read back: anything unusable is the default width. */
export function storedPanelWidth(value) {
  return value === null || value === undefined || value === '' ? PANEL_WIDTH.default : clampPanelWidth(value)
}
