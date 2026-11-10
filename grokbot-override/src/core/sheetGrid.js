// The spreadsheet grid in the file viewer (ui/FileViewer.tsx): pure helpers
// for cell selection, keyboard moves, copying as TSV and the virtual row
// window. No DOM, no parser (core/sheetRead.js parses).

/** Rows parsed per sheet; beyond this the viewer says "first N rows". */
export const SHEET_ROW_CAP = 100_000
/** Columns shown per sheet. */
export const SHEET_COL_CAP = 200
/** Every grid row is this tall (CSS px), so the window can be computed. */
export const ROW_PX = 28
/** The row-number column's narrowest width. */
export const ROWNUM_PX = 44

/** The row-number column's width for a sheet of `rows` rows (wide enough
 *  for its largest number). */
export function rowNumberWidth(rows) {
  return Math.max(ROWNUM_PX, String(Math.max(1, Number(rows) || 0)).length * 8 + 20)
}

/** "A", "B", … "Z", "AA", "AB", … for a 0-based column index. */
export function columnName(index) {
  let n = Math.max(0, Math.floor(Number(index) || 0))
  let name = ''
  do {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return name
}

/** "B3" for row 2, column 1 (both 0-based; rows are the sheet's own). */
export function cellName(row, col) {
  return `${columnName(col)}${row + 1}`
}

/** A selection `{ anchor: {r, c}, focus: {r, c} }` as its box. */
export function selectionBox(sel) {
  if (!sel) return null
  const { anchor, focus } = sel
  return {
    top: Math.min(anchor.r, focus.r),
    bottom: Math.max(anchor.r, focus.r),
    left: Math.min(anchor.c, focus.c),
    right: Math.max(anchor.c, focus.c)
  }
}

export function inBox(box, r, c) {
  return Boolean(box) && r >= box.top && r <= box.bottom && c >= box.left && c <= box.right
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/**
 * The selection after a key press, or null when the key is not a grid move.
 * Arrows move one cell (⌘/Ctrl + arrow: to the edge), Home/End to the row's
 * ends, PageUp/PageDown by `page` rows; Shift extends from the anchor
 * instead of moving it.
 */
export function moveSelection(sel, key, { shift = false, jump = false, rows, cols, page = 20 }) {
  if (!rows || !cols) return null
  const start = sel || { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } }
  const { r, c } = start.focus
  let next
  switch (key) {
    case 'ArrowUp': next = { r: jump ? 0 : r - 1, c }; break
    case 'ArrowDown': next = { r: jump ? rows - 1 : r + 1, c }; break
    case 'ArrowLeft': next = { r, c: jump ? 0 : c - 1 }; break
    case 'ArrowRight': next = { r, c: jump ? cols - 1 : c + 1 }; break
    case 'Home': next = { r: jump ? 0 : r, c: 0 }; break
    case 'End': next = { r: jump ? rows - 1 : r, c: cols - 1 }; break
    case 'PageUp': next = { r: r - page, c }; break
    case 'PageDown': next = { r: r + page, c }; break
    default: return null
  }
  next = { r: clamp(next.r, 0, rows - 1), c: clamp(next.c, 0, cols - 1) }
  if (!sel) return { anchor: next, focus: next }
  return shift ? { anchor: start.anchor, focus: next } : { anchor: next, focus: next }
}

/** One cell as a TSV field: quoted (Excel style) only when it holds a tab,
 *  a line break or a quote. */
export function tsvField(value) {
  const text = value == null ? '' : String(value)
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The box's cells as TSV (what ⌘C puts on the clipboard). */
export function boxTsv(rows, box) {
  if (!box) return ''
  const lines = []
  for (let r = box.top; r <= box.bottom; r += 1) {
    const row = rows[r] || []
    const cells = []
    for (let c = box.left; c <= box.right; c += 1) cells.push(tsvField(row[c]))
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

/**
 * The body rows to draw for a scroll position: `{ start, end }` (end
 * exclusive), body row i being sheet row i + 1 (row 0 is the sticky header).
 */
export function rowWindow(scrollTop, viewport, bodyRows, overscan = 10) {
  const first = Math.floor(Math.max(0, scrollTop) / ROW_PX)
  const count = Math.ceil(Math.max(0, viewport) / ROW_PX) + 1
  return {
    start: clamp(first - overscan, 0, bodyRows),
    end: clamp(first + count + overscan, 0, bodyRows)
  }
}

/** The scrollTop that brings sheet row `row` fully into view under the
 *  sticky header (unchanged when it already is). */
export function scrollTopFor(row, scrollTop, viewport) {
  if (row <= 0) return scrollTop
  const top = (row - 1) * ROW_PX
  const visible = Math.max(ROW_PX, viewport - ROW_PX)
  if (top < scrollTop) return top
  if (top + ROW_PX > scrollTop + visible) return top + ROW_PX - visible
  return scrollTop
}

/** The scrollLeft that brings column `col` into view right of the sticky
 *  row numbers (`widths` = each column's width, `rownum` = their column's). */
export function scrollLeftFor(col, widths, scrollLeft, viewport, rownum = ROWNUM_PX) {
  let left = 0
  for (let i = 0; i < col; i += 1) left += widths[i] || 0
  const width = widths[col] || 0
  const visible = Math.max(width, viewport - rownum)
  if (left < scrollLeft) return left
  if (left + width > scrollLeft + visible) return left + width - visible
  return scrollLeft
}

/** Column widths (CSS px) sized to their content in the first and last
 *  rows (`sample` of each). */
export function columnWidths(rows, cols, sample = 300) {
  const picks = []
  for (let r = 0; r < Math.min(rows.length, sample); r += 1) picks.push(r)
  for (let r = Math.max(sample, rows.length - sample); r < rows.length; r += 1) picks.push(r)
  const widths = []
  for (let c = 0; c < cols; c += 1) {
    let longest = 0
    for (const r of picks) {
      const value = rows[r]?.[c]
      if (value == null || value === '') continue
      const line = String(value).split('\n', 1)[0]
      if (line.length > longest) longest = line.length
      if (longest >= 48) break
    }
    widths.push(Math.round(clamp(longest * 8.2 + 26, 64, 380)))
  }
  return widths
}

/** "20 rows" (the header row is not counted); "1 row"; "Empty". */
export function rowCountLabel(dataRows) {
  const n = Math.max(0, Number(dataRows) || 0)
  if (!n) return 'Empty'
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`
}
