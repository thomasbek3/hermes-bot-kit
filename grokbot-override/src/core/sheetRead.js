// Read a spreadsheet the bot sent (xlsx, xlsm, xlsb, xls, ods, csv, tsv) into
// rows of display text for the file viewer's grid (ui/FileViewer.tsx), in the
// renderer, with SheetJS Community Edition 0.20.3 (Apache-2.0, bundled from
// its official tarball; see NOTICE.md). Nothing is fetched: the bytes are the
// ones the card read from the bot's own backend. The viewer loads this module
// on first use (a lazy chunk inside plugin.js), so the parser does not run at
// plugin load.

import { read, utils } from 'xlsx'

import { SHEET_COL_CAP, SHEET_ROW_CAP } from './sheetGrid.js'

const TEXT_EXT = new Set(['csv', 'tsv'])

function extension(name) {
  const value = String(name || '')
  const dot = value.lastIndexOf('.')
  return dot > 0 ? value.slice(dot + 1).toLowerCase() : ''
}

/**
 * Parse `bytes` (Uint8Array) named `name`. Returns
 * `{ names, sheet(index) }`; `sheet(i)` returns
 * `{ rows, cols, total, capped, colsCapped }`: rows of strings (the values as
 * the workbook formats them), at most `rowCap` rows and SHEET_COL_CAP
 * columns; `total` = the sheet's real row count.
 */
export function readWorkbook(bytes, name, { rowCap = SHEET_ROW_CAP, colCap = SHEET_COL_CAP } = {}) {
  const ext = extension(name)
  const options = { sheetRows: rowCap + 1, dense: true, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, WTF: false }
  let book
  if (TEXT_EXT.has(ext)) {
    // Plain text: decode as UTF-8 and keep every value as typed ("0012"
    // stays "0012"); a .tsv splits on tabs.
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
    book = read(text, { ...options, type: 'string', raw: true, ...(ext === 'tsv' ? { FS: '\t' } : {}) })
  } else {
    book = read(bytes, { ...options, type: 'array' })
  }
  const names = Array.isArray(book.SheetNames) ? book.SheetNames.slice() : []
  const cache = new Map()
  const sheet = index => {
    if (cache.has(index)) return cache.get(index)
    const ws = book.Sheets[names[index]]
    const result = sheetRows(ws, rowCap, colCap)
    cache.set(index, result)
    return result
  }
  return { names, sheet }
}

function sheetRows(ws, rowCap, colCap) {
  if (!ws || !ws['!ref']) return { rows: [], cols: 0, total: 0, capped: false, colsCapped: false }
  const raw = utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true })
  // A workbook records its full range (`!fullref`) when rows were cut; a CSV
  // does not, so its total is unknown (null) once capped.
  let total = null
  try {
    if (ws['!fullref']) total = Math.max(raw.length, utils.decode_range(ws['!fullref']).e.r + 1)
  } catch {
    /* unknown */
  }
  const capped = raw.length > rowCap || (total ?? 0) > rowCap
  const kept = raw.slice(0, rowCap)
  let width = 0
  for (const row of kept) if (row.length > width) width = row.length
  const cols = Math.min(width, colCap)
  const rows = kept.map(row => {
    const out = new Array(cols)
    for (let c = 0; c < cols; c += 1) {
      const value = row[c]
      out[c] = value == null ? '' : String(value)
    }
    return out
  })
  return { rows, cols, total: capped ? total : rows.length, capped, colsCapped: width > colCap }
}
