// Attachment viewer: a file card opens the file in a large overlay
// (ui/FileViewer.tsx): spreadsheets as a selectable, virtualised grid with
// sheet tabs (core/sheetGrid.js, core/sheetRead.js on the bundled SheetJS
// CE), PDFs in the platform viewer on a blob: URL, images fit/zoom, text with
// Copy all, a "No preview" panel and a size cap with Download; Escape closes
// and focus returns to the card. Demo content only.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { dataUrlToBytes, fileIconKind, looksLikePdf, VIEWER_MAX_BYTES, viewerKind } from '../src/core/media.js'
import { boxTsv, cellName, columnName, columnWidths, moveSelection, ROW_PX, rowCountLabel, rowNumberWidth, rowWindow, scrollLeftFor, scrollTopFor, selectionBox, tsvField } from '../src/core/sheetGrid.js'
import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

const HAS_XLSX = existsSync(new URL('../node_modules/xlsx/package.json', import.meta.url))
const skip = !READY && 'dev dependencies not installed'
const skipXlsx = !HAS_XLSX && 'dev dependencies not installed'

const b64 = data => Buffer.from(data).toString('base64')
const HEADER = ['Item', 'Code', 'Size', 'Detail', 'Weight', 'Price']
const PRICING = [
  HEADER,
  ...Array.from({ length: 20 }, (_, i) => [
    `Widget ${i + 1}`,
    `W-${101 + i}`,
    '20 x 15',
    i === 1 ? 'Line one of the detail\nline two' : `A fairly long description of demo item number ${i + 1}`,
    `${(i + 1) * 3} oz.`,
    `$${((i + 1) * 1.25).toFixed(2)}`
  ])
]

async function workbookBytes() {
  const X = await import('xlsx')
  const book = X.utils.book_new()
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet(PRICING), 'Pricing')
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['Note'], ['Prices are demo values.'], ['Second note']]), 'Notes')
  return Buffer.from(X.write(book, { type: 'array', bookType: 'xlsx' }))
}

// ── pure helpers ──────────────────────────────────────────────────────────

test('viewerKind / fileIconKind: sheets, PDF, images, text, the rest', () => {
  for (const name of ['a.xlsx', 'a.XLS', 'a.csv', 'a.tsv', 'a.ods', 'a.xlsm']) assert.equal(viewerKind(name), 'sheet', name)
  assert.equal(viewerKind('plan.pdf'), 'pdf')
  for (const name of ['a.png', 'a.avif', 'a.svg']) assert.equal(viewerKind(name), 'image', name)
  assert.equal(viewerKind('notes.md'), 'markdown')
  assert.equal(viewerKind('data.json'), 'text')
  for (const name of ['a.zip', 'README', 'a.docx']) assert.equal(viewerKind(name), 'none', name)
  assert.equal(fileIconKind('a.xlsx'), 'sheet')
  assert.equal(fileIconKind('a.csv'), 'sheet')
  assert.equal(fileIconKind('a.pdf'), 'pdf')
  assert.equal(fileIconKind('a.jpg'), 'image')
  assert.equal(fileIconKind('a.docx'), 'doc')
  assert.equal(fileIconKind('a.txt'), 'text')
  assert.equal(fileIconKind('a.zip'), 'file')
  assert.equal(VIEWER_MAX_BYTES, 25_000_000)
})

test('dataUrlToBytes and looksLikePdf', () => {
  assert.deepEqual([...dataUrlToBytes(`data:application/pdf;base64,${b64('%PDF-1.4')}`)], [...Buffer.from('%PDF-1.4')])
  assert.deepEqual([...dataUrlToBytes('data:text/plain,a%20b')], [97, 32, 98])
  assert.equal(dataUrlToBytes('nope'), null)
  assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n')), true)
  assert.equal(looksLikePdf(Buffer.alloc(10, 7)), false)
  assert.equal(looksLikePdf(null), false)
})

test('sheetGrid: names, moves, Shift extends, ⌘ jumps, edges clamp', () => {
  assert.deepEqual([0, 25, 26, 701, 702].map(columnName), ['A', 'Z', 'AA', 'ZZ', 'AAA'])
  assert.equal(cellName(2, 1), 'B3')
  const dims = { rows: 10, cols: 4 }
  const at = (r, c) => ({ anchor: { r, c }, focus: { r, c } })
  assert.deepEqual(moveSelection(null, 'ArrowDown', dims), at(1, 0))
  assert.deepEqual(moveSelection(at(0, 0), 'ArrowUp', dims), at(0, 0), 'clamped at the top')
  assert.deepEqual(moveSelection(at(2, 1), 'ArrowRight', dims), at(2, 2))
  assert.deepEqual(moveSelection(at(2, 1), 'ArrowDown', { ...dims, shift: true }), { anchor: { r: 2, c: 1 }, focus: { r: 3, c: 1 } })
  assert.deepEqual(moveSelection(at(2, 1), 'ArrowDown', { ...dims, jump: true }), at(9, 1))
  assert.deepEqual(moveSelection(at(2, 1), 'End', dims), at(2, 3))
  assert.deepEqual(moveSelection(at(2, 1), 'PageDown', { ...dims, page: 5 }), at(7, 1))
  assert.equal(moveSelection(at(2, 1), 'a', dims), null)
  assert.equal(moveSelection(at(0, 0), 'ArrowDown', { rows: 0, cols: 0 }), null)
  assert.deepEqual(selectionBox({ anchor: { r: 3, c: 2 }, focus: { r: 1, c: 0 } }), { top: 1, bottom: 3, left: 0, right: 2 })
})

test('sheetGrid: TSV copy quotes tabs, line breaks and quotes the Excel way', () => {
  assert.equal(tsvField('plain'), 'plain')
  assert.equal(tsvField('two\nlines'), '"two\nlines"')
  assert.equal(tsvField('say "hi"'), '"say ""hi"""')
  assert.equal(tsvField(null), '')
  const rows = [['a', 'b', 'c'], ['1', 'x\ty', '3']]
  assert.equal(boxTsv(rows, { top: 0, bottom: 1, left: 1, right: 2 }), 'b\tc\n"x\ty"\t3')
  assert.equal(boxTsv(rows, null), '')
})

test('sheetGrid: the virtual window, scrolling a cell into view, widths, labels', () => {
  assert.equal(ROW_PX, 28)
  assert.deepEqual(rowWindow(0, 280, 50_000), { start: 0, end: 21 })
  assert.deepEqual(rowWindow(28 * 1000, 280, 50_000), { start: 990, end: 1021 })
  assert.deepEqual(rowWindow(28 * 49_990, 280, 50_000), { start: 49_980, end: 50_000 })
  assert.equal(scrollTopFor(1, 500, 280), 0, 'up to the first body row')
  assert.equal(scrollTopFor(40, 0, 280), 39 * 28 + 28 - (280 - 28), 'down: the row sits on the bottom edge')
  assert.equal(scrollTopFor(5, 0, 280), 0, 'already visible')
  assert.equal(scrollLeftFor(2, [100, 100, 100], 0, 144), 200 + 100 - 100)
  assert.equal(scrollLeftFor(0, [100, 100, 100], 150, 400), 0)
  const widths = columnWidths([['id', 'a much longer header than the others'], ['1', 'x']], 2)
  assert.ok(widths[0] === 64 && widths[1] > 200 && widths[1] <= 380, String(widths))
  assert.equal(rowNumberWidth(21), 44)
  assert.equal(rowNumberWidth(50_001), 60, 'five digits fit')
  const tail = columnWidths([['label'], ...Array.from({ length: 999 }, (_, i) => [i < 600 ? 'x' : 'a much longer value near the end'])], 1)
  assert.ok(tail[0] > 200, 'the last rows count too')
  assert.equal(rowCountLabel(20), '20 rows')
  assert.equal(rowCountLabel(1), '1 row')
  assert.equal(rowCountLabel(50_000), '50,000 rows')
  assert.equal(rowCountLabel(0), 'Empty')
})

test('sheetRead: xlsx sheets, CSV kept as typed, TSV, the row and column caps', { skip: skipXlsx }, async () => {
  const { readWorkbook } = await import('../src/core/sheetRead.js')
  const book = readWorkbook(new Uint8Array(await workbookBytes()), 'pricing.xlsx')
  assert.deepEqual(book.names, ['Pricing', 'Notes'])
  const first = book.sheet(0)
  assert.equal(first.rows.length, 21)
  assert.equal(first.cols, 6)
  assert.deepEqual(first.rows[0], HEADER)
  assert.equal(first.rows[2][3], 'Line one of the detail\nline two')
  assert.equal(first.capped, false)
  assert.equal(book.sheet(1).rows[1][0], 'Prices are demo values.')

  const csv = readWorkbook(new TextEncoder().encode('﻿zip,name\n0012,"Ünïcode, ok"\n'), 'a.csv').sheet(0)
  assert.deepEqual(csv.rows, [['zip', 'name'], ['0012', 'Ünïcode, ok']])
  const tsv = readWorkbook(new TextEncoder().encode('a\tb,c\n1\t2'), 'a.tsv').sheet(0)
  assert.deepEqual(tsv.rows, [['a', 'b,c'], ['1', '2']])

  const big = ['n,v', ...Array.from({ length: 3000 }, (_, i) => `${i},v${i}`)].join('\n')
  const capped = readWorkbook(new TextEncoder().encode(big), 'big.csv', { rowCap: 1000 }).sheet(0)
  assert.equal(capped.rows.length, 1000)
  assert.equal(capped.capped, true)
  assert.equal(capped.total, null, 'a CSV does not say how many rows were cut')
  const X = await import('xlsx')
  const bookBig = X.utils.book_new()
  X.utils.book_append_sheet(bookBig, X.utils.aoa_to_sheet(Array.from({ length: 3000 }, (_, i) => [i])), 'Big')
  const cappedBook = readWorkbook(new Uint8Array(X.write(bookBig, { type: 'array', bookType: 'xlsx' })), 'big.xlsx', { rowCap: 1000 }).sheet(0)
  assert.deepEqual([cappedBook.rows.length, cappedBook.capped, cappedBook.total], [1000, true, 3000], 'a workbook does')
  const wide = readWorkbook(new TextEncoder().encode(Array.from({ length: 12 }, (_, i) => `c${i}`).join(',')), 'w.csv', { colCap: 5 }).sheet(0)
  assert.equal(wide.cols, 5)
  assert.equal(wide.colsCapped, true)
})

test('CSS: the green sheet tile, the viewer shell, the sticky grid; light and dark tokens', { skip }, async () => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  try {
    const { CSS } = await import(pathToFileURL(file).href)
    const scope = ':where([data-gbo-root], [data-gbo-root] *)'
    const block = sel => {
      const start = CSS.indexOf(`${sel}${scope} {`)
      return start < 0 ? '' : CSS.slice(start, CSS.indexOf('}', start))
    }
    assert.match(block('.gbo-ftile-page'), /fill: var\(--g-color-ftile-page\);/)
    assert.match(block('.gbo-viewer'), /flex-direction: column;[\s\S]*border-radius: 17\.86px;[\s\S]*background: var\(--g-color-bg-elevated\);/)
    assert.match(block('.gbo-viewer-name'), /left: 50%;[\s\S]*border-radius: var\(--g-radius-full\);/)
    assert.match(CSS, /\.gbo-sheet-table:where\(\[data-gbo-root\], \[data-gbo-root\] \*\) thead[^{]*\{[^}]*position: sticky; top: 0;/)
    assert.match(CSS, /\.gbo-sheet-table:where\(\[data-gbo-root\], \[data-gbo-root\] \*\) \.gbo-sheet-num[^{]*\{[^}]*position: sticky; left: 0;/)
    // Row height comes from the grid's inline variable (unscaled), so the
    // virtual window's maths and the drawn rows agree.
    assert.match(CSS, /height: var\(--gbo-sheet-row\);/)
    assert.match(CSS, /\[data-gbo-root\] \{[^}]*--g-color-ftile-page: #FFFFFF;/)
    assert.match(CSS, /\.dark \[data-gbo-root\], \[data-gbo-root\]\[data-gbo-theme="dark"\] \{[^}]*--g-color-ftile-page: #2A2A2A;/)
    assert.match(CSS, /\.dark \[data-gbo-root\], \[data-gbo-root\]\[data-gbo-theme="dark"\] \{[^}]*--g-color-sheet-head: #1C1C1C;/)
  } finally {
    rmSync(dirname(file), { recursive: true, force: true })
  }
})

// ── the viewer in the loaded plugin ─────────────────────────────────────

test('loader: cards by type; the viewer for a workbook, a 50k-row CSV, PDF, image, other, too large; Esc returns focus', { skip: skip || skipXlsx }, async t => {
  const xlsx = await workbookBytes()
  const bigCsv = ['n,label', ...Array.from({ length: 50_000 }, (_, i) => `${i + 1},row ${i + 1}`)].join('\n')
  const FILES = {
    '/workspace/demo/pricing.xlsx': `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsx.toString('base64')}`,
    '/workspace/demo/big.csv': `data:text/csv;base64,${b64(bigCsv)}`,
    '/workspace/demo/report.pdf': `data:application/pdf;base64,${b64('%PDF-1.4\n% demo\n')}`,
    '/workspace/demo/photo.avif': 'data:image/avif;base64,AAAAHGZ0eXBhdmlm',
    '/workspace/demo/bundle.zip': `data:application/zip;base64,${b64('PK demo')}`,
    '/workspace/demo/huge.zip': `data:application/zip;base64,${Buffer.alloc(VIEWER_MAX_BYTES + 3, 1).toString('base64')}`
  }
  const names = [...Object.keys(FILES), '/workspace/demo/gone.xlsx']
  const reads = []
  const booted = await bootPlugin(t, {
    historyFor: profile => {
      const page = history(profile)
      page.messages = [...page.messages, { id: 40, role: 'assistant', content: ['Here are the files.', ...names.map(p => `MEDIA:${p}`)].join('\n'), timestamp: 1762560200 }]
      return page
    },
    api: request => {
      const path = String(request.path)
      if (!path.startsWith('/api/fs/read-data-url')) return undefined
      const file = decodeURIComponent(path.split('path=')[1])
      reads.push(file)
      if (!FILES[file]) throw new Error('No such file')
      return { dataUrl: FILES[file] }
    }
  })
  const written = []
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => void written.push(text) } })
  const saved = []
  window.HTMLAnchorElement.prototype.click = function () {
    saved.push(this.download)
  }
  const blobs = []
  const revoked = []
  for (const host of [globalThis.URL, window.URL]) {
    host.createObjectURL = blob => {
      blobs.push(blob)
      return `blob:demo/${blobs.length}`
    }
    host.revokeObjectURL = url => void revoked.push(url)
  }

  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = booted.mount((await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')).render)
  const cards = await waitFor(() => {
    const found = chatEl.querySelectorAll('.gbo-file-card')
    return found.length === names.length ? [...found] : null
  }, 'the cards')
  const card = name => cards.find(el => el.dataset.path.endsWith(`/${name}`))
  const main = el => el.querySelector('button.gbo-file-card-main')
  const key = (el, k, extra = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }))
  const viewerOf = name => document.querySelector(`[aria-label="Preview of ${name}"]`)

  // Tiles by type; nothing read before a card is pointed at.
  assert.ok(card('pricing.xlsx').querySelector('.gbo-file-card-icon.is-sheet svg.gbo-ftile.is-sheet'))
  assert.ok(card('big.csv').querySelector('.gbo-file-card-icon.is-sheet'))
  assert.ok(card('report.pdf').querySelector('.gbo-file-card-icon.is-pdf svg.gbo-ftile.is-pdf'))
  assert.ok(card('photo.avif').querySelector('.gbo-file-card-icon.is-image'))
  assert.ok(card('bundle.zip').querySelector('.gbo-file-card-icon.is-file'))
  assert.ok(card('pricing.xlsx').querySelector('button.gbo-file-card-save'), 'a download button on the card')
  assert.equal(main(card('pricing.xlsx')).getAttribute('aria-label'), 'Open pricing.xlsx')
  assert.deepEqual(reads, [])

  // ── the workbook ──
  main(card('pricing.xlsx')).click()
  const viewer = await waitFor(() => viewerOf('pricing.xlsx'), 'workbook viewer')
  assert.equal(viewer.querySelector('.gbo-viewer-name').textContent, 'pricing.xlsx', 'the name in the pill')
  assert.ok(viewer.querySelector('.gbo-viewer-head > button.gbo-viewer-close:first-child'), 'close X top left')
  const table = await waitFor(() => viewer.querySelector('table.gbo-sheet-table'), 'the grid')
  assert.equal(viewer.querySelector('.gbo-viewer-meta').textContent, '20 rows', 'the header row is not counted')
  assert.ok(viewer.querySelector('button.gbo-viewer-save[aria-label="Download pricing.xlsx"]'))
  assert.match(viewer.querySelector('.gbo-sheet-hint').textContent, /Click a cell to select it\. Move with the arrow keys, extend with Shift, copy with (⌘C|Ctrl\+C)\./)
  assert.deepEqual([...table.querySelectorAll('thead th.gbo-sheet-cell')].map(th => th.textContent), HEADER)
  const bodyRows = [...table.querySelectorAll('tbody tr:not(.gbo-sheet-spacer)')]
  assert.equal(bodyRows.length, 20)
  assert.deepEqual(bodyRows.slice(0, 2).map(tr => tr.querySelector('.gbo-sheet-num').textContent), ['2', '3'], 'row numbers are the sheet rows')
  assert.equal(table.querySelector('thead .gbo-sheet-num').textContent, '1')
  const longCell = table.querySelector('td[data-r="2"][data-c="3"]')
  assert.equal(longCell.getAttribute('title'), 'Line one of the detail\nline two', 'long cells carry the full value')
  const tabs = [...viewer.querySelectorAll('.gbo-sheet-tabs [role="tab"]')]
  assert.deepEqual(tabs.map(b => b.textContent), ['Pricing', 'Notes'])
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true')

  // Click selects; arrows move; Shift extends; ⌘C copies TSV.
  const scroller = viewer.querySelector('.gbo-sheet-scroll')
  table.querySelector('td[data-r="1"][data-c="0"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
  await waitFor(() => table.querySelector('td[data-r="1"][data-c="0"].is-focus'), 'selected A2')
  assert.equal(viewer.querySelector('.gbo-sheet-ref').textContent, 'A2')
  assert.equal(viewer.querySelector('.gbo-sheet-value').textContent, 'Widget 1')
  key(scroller, 'ArrowRight')
  await waitFor(() => table.querySelector('td[data-r="1"][data-c="1"].is-focus'), 'moved to B2')
  key(scroller, 'ArrowDown', { shiftKey: true })
  key(scroller, 'ArrowRight', { shiftKey: true })
  await waitFor(() => table.querySelectorAll('.gbo-sheet-cell.is-sel').length === 4, 'B2:C3 selected')
  assert.ok(table.querySelector('td[data-r="2"][data-c="2"].is-focus'))
  key(scroller, 'c', { metaKey: true })
  await waitFor(() => written.length === 1, 'copied')
  assert.equal(written[0], 'W-101\t20 x 15\nW-102\t20 x 15')
  await waitFor(() => viewer.querySelector('.gbo-sheet-hint').textContent.includes('Copied'), 'Copied shown')
  // Shift-click extends from the anchor; a multi-line cell copies quoted.
  table.querySelector('td[data-r="2"][data-c="3"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
  key(scroller, 'c', { ctrlKey: true })
  await waitFor(() => written.length === 2, 'copied one cell')
  assert.equal(written[1], '"Line one of the detail\nline two"')
  // The selected cell's whole value, expanded in the strip.
  const expand = await waitFor(() => viewer.querySelector('button.gbo-sheet-expand'), 'expand')
  expand.click()
  await waitFor(() => viewer.querySelector('.gbo-sheet-hint.is-open'), 'expanded')
  assert.equal(viewer.querySelector('.gbo-sheet-value').textContent, 'Line one of the detail\nline two')
  table.querySelector('td[data-r="1"][data-c="0"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
  table.querySelector('td[data-r="3"][data-c="1"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey: true }))
  await waitFor(() => table.querySelectorAll('.gbo-sheet-cell.is-sel').length === 6, 'A2:B4 by Shift-click')
  key(scroller, 'a', { metaKey: true })
  await waitFor(() => table.querySelectorAll('.gbo-sheet-cell.is-sel').length === 21 * 6, 'select all')

  // Sheet tabs.
  tabs[1].click()
  await waitFor(() => viewer.querySelector('thead th.gbo-sheet-cell')?.textContent === 'Note', 'Notes sheet')
  assert.equal(viewer.querySelector('.gbo-viewer-meta').textContent, '2 rows')
  assert.equal(viewer.querySelectorAll('.gbo-sheet-cell.is-sel').length, 0, 'a new sheet starts unselected')

  // Escape closes; focus returns to the card.
  key(viewer.querySelector('.gbo-sheet-scroll'), 'Escape')
  await waitFor(() => !viewerOf('pricing.xlsx'), 'closed by Escape')
  await waitFor(() => document.activeElement === main(card('pricing.xlsx')), 'focus back on the card')
  await waitFor(() => card('pricing.xlsx').querySelector('.gbo-file-card-size').textContent.endsWith('kB'), 'size known after the read')

  // ── 50,000 rows: virtualised ──
  main(card('big.csv')).click()
  const bigViewer = await waitFor(() => viewerOf('big.csv'), 'csv viewer')
  const bigTable = await waitFor(() => bigViewer.querySelector('table.gbo-sheet-table'), 'csv grid', 15_000)
  assert.equal(bigViewer.querySelector('.gbo-viewer-meta').textContent, '50,000 rows')
  const drawn = () => bigTable.querySelectorAll('tbody tr:not(.gbo-sheet-spacer)').length
  assert.ok(drawn() < 60, `only the visible rows are drawn (${drawn()})`)
  const spacer = bigTable.querySelector('tbody tr.gbo-sheet-spacer:last-child')
  assert.ok(Number.parseFloat(spacer.style.height) > 28 * 49_000, 'a spacer stands in for the rest')
  const bigScroller = bigViewer.querySelector('.gbo-sheet-scroll')
  let top = 0
  Object.defineProperty(bigScroller, 'scrollTop', { configurable: true, get: () => top, set: v => void (top = v) })
  Object.defineProperty(bigScroller, 'clientHeight', { configurable: true, get: () => 280 })
  top = 28 * 30_000
  bigScroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
  await waitFor(() => [...bigTable.querySelectorAll('.gbo-sheet-num')].some(th => th.textContent === '30001'), 'rows around 30,000 drawn')
  assert.ok(drawn() < 60)
  // ⌘↓ jumps to the last row and scrolls it into view.
  bigTable.querySelector('td[data-c="0"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
  key(bigScroller, 'ArrowDown', { metaKey: true })
  await waitFor(() => bigTable.querySelector('td[data-r="50000"][data-c="0"].is-focus'), 'last row selected and drawn')
  assert.equal(top, 49_999 * 28 + 28 - (280 - 28))
  bigViewer.querySelector('button.gbo-viewer-close').click()
  await waitFor(() => !viewerOf('big.csv'), 'csv closed')

  // ── PDF: the platform viewer on a blob: URL, revoked on close ──
  main(card('report.pdf')).click()
  const pdfViewer = await waitFor(() => viewerOf('report.pdf'), 'pdf viewer')
  const frame = await waitFor(() => pdfViewer.querySelector('iframe.gbo-viewer-pdf'), 'pdf frame')
  assert.equal(frame.getAttribute('src'), 'blob:demo/1')
  assert.equal(frame.getAttribute('title'), 'report.pdf')
  assert.equal(blobs[0].type, 'application/pdf')
  pdfViewer.querySelector('button.gbo-viewer-save').click()
  await waitFor(() => saved.includes('report.pdf'), 'pdf downloaded')
  pdfViewer.querySelector('button.gbo-viewer-close').click()
  await waitFor(() => !viewerOf('report.pdf'), 'pdf closed')
  assert.deepEqual(revoked, ['blob:demo/1'])

  // ── image: fit, click to zoom ──
  main(card('photo.avif')).click()
  const imageViewer = await waitFor(() => viewerOf('photo.avif'), 'image viewer')
  const hit = await waitFor(() => imageViewer.querySelector('button.gbo-viewer-image-hit'), 'image')
  assert.equal(hit.querySelector('img').getAttribute('src'), FILES['/workspace/demo/photo.avif'])
  assert.equal(imageViewer.querySelector('.gbo-viewer-image.is-zoomed'), null)
  hit.click()
  await waitFor(() => imageViewer.querySelector('.gbo-viewer-image.is-zoomed'), 'zoomed')
  assert.equal(hit.getAttribute('aria-label'), 'Fit to view')
  imageViewer.querySelector('button.gbo-viewer-close').click()
  await waitFor(() => !viewerOf('photo.avif'), 'image closed')

  // ── anything else: no preview, Download ──
  main(card('bundle.zip')).click()
  const zipViewer = await waitFor(() => viewerOf('bundle.zip'), 'zip viewer')
  await waitFor(() => zipViewer.textContent.includes('No preview for this file type'), 'no preview')
  zipViewer.querySelector('button.gbo-viewer-panel-save').click()
  await waitFor(() => saved.includes('bundle.zip'), 'zip downloaded')
  zipViewer.querySelector('button.gbo-viewer-close').click()
  await waitFor(() => !viewerOf('bundle.zip'), 'zip closed')

  // ── over the size cap: Download only ──
  main(card('huge.zip')).click()
  const hugeViewer = await waitFor(() => viewerOf('huge.zip'), 'huge viewer', 10_000)
  await waitFor(() => hugeViewer.textContent.includes('Too large to preview'), 'too large', 10_000)
  assert.ok(hugeViewer.textContent.includes('25MB'))
  assert.ok(hugeViewer.querySelector('button.gbo-viewer-panel-save'))
  hugeViewer.querySelector('button.gbo-viewer-close').click()
  await waitFor(() => !viewerOf('huge.zip'), 'huge closed')

  // ── a file the bot's machine cannot read ──
  main(card('gone.xlsx')).click()
  const goneViewer = await waitFor(() => viewerOf('gone.xlsx'), 'gone viewer')
  await waitFor(() => goneViewer.textContent.includes('Could not read gone.xlsx'), 'read error')
  assert.equal(goneViewer.querySelector('button.gbo-viewer-save'), null, 'no download for a missing file')
  goneViewer.querySelector('button.gbo-viewer-close').click()
  await waitFor(() => !viewerOf('gone.xlsx'), 'gone closed')
  assert.ok(card('gone.xlsx').classList.contains('is-error'))

  // Every read went to the bot's own backend.
  const pinned = booted.calls.filter(c => c.method === 'REST' && String(c.params.path).startsWith('/api/fs/read-data-url'))
  assert.ok(pinned.length >= 6)
  assert.ok(pinned.every(c => c.params.connectionId === 'home-server' && c.params.profile === 'scholar'))
  assert.deepEqual(booted.errors, [])
})
