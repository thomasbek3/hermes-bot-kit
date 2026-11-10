// The file viewer (Grok Bot's attachment viewer): a file card opens it as a
// large overlay over the chat (the SDK's Radix Dialog: focus trap, portal,
// Escape; focus returns to the card). Close X top left, the file name in a
// pill top centre, a row count and Download top right. The body by type
// (core/media.js viewerKind):
//  - spreadsheets (xlsx, xls, ods, csv, tsv): a grid with row numbers and a
//    sticky header row, cells selectable (click, Shift-click, drag, arrow
//    keys, Shift extends, ⌘C copies TSV), sheet tabs, rows virtualised and
//    capped at SHEET_ROW_CAP ("first N rows"); parsed in the renderer by the
//    bundled SheetJS CE (core/sheetRead.js, loaded on first use);
//  - PDF: the platform's PDF viewer in an iframe on a blob: URL (what
//    Hermes's own file preview does: preview-file.tsx);
//  - images: fit to the view, click to zoom to full size;
//  - text and markdown: #38's preview with Copy all;
//  - anything else, or a file over VIEWER_MAX_BYTES: a panel with Download.
// Nothing is fetched: the bytes are the data: URL the card read from the
// bot's own backend (app.ts readBotMedia).

import * as React from 'react'

import { dataUrlText, dataUrlToBytes, fileIconKind, formatBytes, looksLikePdf, VIEWER_MAX_BYTES, viewerKind } from '../core/media.js'
import { boxTsv, cellName, columnWidths, inBox, moveSelection, ROW_PX, rowCountLabel, rowNumberWidth, rowWindow, scrollLeftFor, scrollTopFor, selectionBox } from '../core/sheetGrid.js'
import { COPIED_MS } from './CodeBlock'
import { FileTile } from './FileIcons'
import { IconChevronDown, IconDownload, IconX } from './icons'
import { sdkHasDialog } from './kit'
import { copyText } from './MessageActions'
import { Markdown, sdk } from './sdk'

const S: any = sdk
const TEXT_SHOWN_MAX = 500_000

const isMac = () => {
  try {
    const nav: any = (globalThis as any).navigator
    return /mac/i.test(String(nav?.userAgentData?.platform || nav?.platform || ''))
  } catch {
    return false
  }
}

export type ViewerFile = { url: string | null; error?: string }

/** The overlay. `file.url` null = still reading. */
export function FileViewer({ name, file, onSave, onClose }: { name: string; file: ViewerFile; onSave: () => void; onClose: () => void }) {
  const [meta, setMeta] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<any>(null)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const kind = viewerKind(name)
  const bytes = React.useMemo(() => (file.url ? dataUrlToBytes(file.url) : null), [file.url])
  const size = bytes ? bytes.length : 0
  const tooBig = size > VIEWER_MAX_BYTES
  const text = React.useMemo(() => (file.url && !tooBig && (kind === 'markdown' || kind === 'text') ? dataUrlText(file.url) : ''), [file.url, kind, tooBig])
  const copyAll = () => {
    void copyText(text).then(ok => {
      if (!ok) return
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }

  let body: React.ReactNode
  if (file.error || (file.url !== null && !bytes)) {
    body = <ViewerPanel kind={fileIconKind(name)} title={`Could not read ${name}`} text={file.error || 'The bot’s machine did not return this file.'} />
  } else if (file.url === null || !bytes) {
    body = <div className="gbo-viewer-loading" role="status">Reading {name}…</div>
  } else if (tooBig) {
    body = <ViewerPanel kind={fileIconKind(name)} title="Too large to preview" text={`${name} is ${formatBytes(size)}. Files over ${formatBytes(VIEWER_MAX_BYTES)} are not previewed: download it to open it.`} onSave={onSave} />
  } else if (kind === 'sheet') {
    body = <SheetView name={name} bytes={bytes} onMeta={setMeta} onSave={onSave} />
  } else if (kind === 'pdf') {
    body = <PdfView name={name} bytes={bytes} onSave={onSave} />
  } else if (kind === 'image') {
    body = <ImageView name={name} url={file.url} />
  } else if (kind === 'markdown' || kind === 'text') {
    body = <TextView text={text} markdown={kind === 'markdown'} />
  } else {
    body = <ViewerPanel kind={fileIconKind(name)} title="No preview for this file type" text={`${name}${size ? ` · ${formatBytes(size)}` : ''}`} onSave={onSave} />
  }
  const textual = (kind === 'markdown' || kind === 'text') && Boolean(file.url) && !tooBig && !file.error
  const shownMeta = kind === 'sheet' && file.url && !tooBig ? meta : ''

  const panel = (
    <div data-gbo-root="" className={`gbo-viewer is-${kind}`} aria-label={`Preview of ${name}`}>
      <div className="gbo-viewer-head">
        <button type="button" className="gbo-viewer-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <IconX />
        </button>
        {sdkHasDialog() && typeof S.DialogTitle === 'function' ? (
          <S.DialogTitle className="gbo-viewer-name" title={name}>
            {name}
          </S.DialogTitle>
        ) : (
          <h2 className="gbo-viewer-name" title={name}>
            {name}
          </h2>
        )}
        <div className="gbo-viewer-tools">
          {shownMeta ? <span className="gbo-viewer-meta">{shownMeta}</span> : null}
          {textual ? (
            <button type="button" className="gbo-viewer-pill gbo-file-preview-copy" onClick={copyAll}>
              {copied ? 'Copied' : 'Copy all'}
            </button>
          ) : null}
          {file.error ? null : (
            <button type="button" className="gbo-viewer-save" aria-label={`Download ${name}`} title="Download" onClick={onSave}>
              <IconDownload />
            </button>
          )}
        </div>
      </div>
      <div className="gbo-viewer-main">{body}</div>
    </div>
  )

  if (sdkHasDialog()) {
    return (
      <S.Dialog open onOpenChange={(value: boolean) => !value && onClose()}>
        <S.DialogContent
          className="gbo-viewer-content"
          bodyClassName="p-0 gap-0"
          showCloseButton={false}
          aria-describedby={undefined}
          style={{
            width: 'calc(100vw - 32px)',
            maxWidth: 'none',
            height: 'calc(100vh - 32px)',
            maxHeight: 'none',
            padding: 0,
            border: 0,
            background: 'transparent',
            boxShadow: 'none',
            borderRadius: 16,
            overflow: 'hidden'
          }}
        >
          {panel}
        </S.DialogContent>
      </S.Dialog>
    )
  }
  return <FallbackOverlay onClose={onClose}>{panel}</FallbackOverlay>
}

/** Without the SDK dialog (an older Desktop): an in-place fixed overlay
 *  that takes focus and closes on Escape. */
function FallbackOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const close = ref.current?.querySelector('.gbo-viewer-close') as HTMLElement | null
    close?.focus()
  }, [])
  return (
    <div
      ref={ref}
      className="gbo-modal-fallback is-viewer"
      role="dialog"
      aria-modal="true"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {children}
    </div>
  )
}

function ViewerPanel({ kind, title, text, onSave }: { kind: string; title: string; text: string; onSave?: () => void }) {
  return (
    <div className="gbo-viewer-panel">
      <span className={`gbo-viewer-panel-tile is-${kind}`}>
        <FileTile kind={kind} />
      </span>
      <div className="gbo-viewer-panel-title">{title}</div>
      <div className="gbo-viewer-panel-text">{text}</div>
      {onSave ? (
        <button type="button" className="gbo-btn is-primary is-small gbo-viewer-panel-save" onClick={onSave}>
          Download
        </button>
      ) : null}
    </div>
  )
}

function TextView({ text, markdown }: { text: string; markdown: boolean }) {
  const cut = text.length > TEXT_SHOWN_MAX
  const shown = cut ? text.slice(0, TEXT_SHOWN_MAX) : text
  return (
    <div className="gbo-viewer-text">
      {cut ? <div className="gbo-viewer-note">Showing the first {TEXT_SHOWN_MAX.toLocaleString('en-US')} characters. Copy all copies the whole file.</div> : null}
      {markdown ? (
        <div className="md gbo-file-preview">
          <Markdown text={shown} />
        </div>
      ) : (
        <pre className="gbo-file-preview is-mono">{shown}</pre>
      )}
    </div>
  )
}

function ImageView({ name, url }: { name: string; url: string }) {
  const [zoomed, setZoomed] = React.useState(false)
  return (
    <div className={`gbo-viewer-image${zoomed ? ' is-zoomed' : ''}`}>
      <button type="button" className="gbo-viewer-image-hit" aria-label={zoomed ? 'Fit to view' : 'Zoom to full size'} onClick={() => setZoomed(value => !value)}>
        <img alt={name} src={url} draggable={false} />
      </button>
    </div>
  )
}

function PdfView({ name, bytes, onSave }: { name: string; bytes: Uint8Array; onSave: () => void }) {
  const [state, setState] = React.useState<{ src?: string; error?: string }>({})
  React.useEffect(() => {
    if (!looksLikePdf(bytes)) {
      setState({ error: 'This file does not start like a PDF.' })
      return undefined
    }
    const make = (globalThis as any).URL?.createObjectURL
    if (typeof make !== 'function' || typeof Blob !== 'function') {
      setState({ error: 'This Hermes build cannot show PDFs inline.' })
      return undefined
    }
    let src = ''
    try {
      src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
    } catch (error: any) {
      setState({ error: String(error?.message || error) })
      return undefined
    }
    setState({ src })
    return () => URL.revokeObjectURL(src)
  }, [bytes])
  if (state.error) return <ViewerPanel kind="pdf" title="No preview for this PDF" text={state.error} onSave={onSave} />
  if (!state.src) return <div className="gbo-viewer-loading" role="status">Opening {name}…</div>
  return <iframe className="gbo-viewer-pdf" src={state.src} title={name} />
}

// ── spreadsheets ─────────────────────────────────────────────────────────

type SheetData = { rows: string[][]; cols: number; total: number | null; capped: boolean; colsCapped: boolean }
type Book = { names: string[]; sheet: (index: number) => SheetData }
type Sel = { anchor: { r: number; c: number }; focus: { r: number; c: number } } | null

function SheetView({ name, bytes, onMeta, onSave }: { name: string; bytes: Uint8Array; onMeta: (text: string) => void; onSave: () => void }) {
  const [book, setBook] = React.useState<{ book?: Book; error?: string }>({})
  const [index, setIndex] = React.useState(0)
  React.useEffect(() => {
    let live = true
    setBook({})
    // Let the overlay paint "Reading…" before the parser runs.
    const timer = setTimeout(() => {
      import('../core/sheetRead.js')
        .then(mod => {
          const parsed = mod.readWorkbook(bytes, name) as Book
          if (live) setBook({ book: parsed })
        })
        .catch(error => {
          if (live) setBook({ error: String(error?.message || error) })
        })
    }, 0)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [bytes, name])
  const data = React.useMemo(() => {
    if (!book.book) return null
    try {
      return book.book.sheet(index)
    } catch {
      return null
    }
  }, [book.book, index])
  React.useEffect(() => {
    onMeta(!data ? '' : data.capped && !data.total ? `${rowCountLabel(data.rows.length - 1)}+` : rowCountLabel(Math.max(0, data.total - 1)))
  }, [data, onMeta])

  if (book.error) return <ViewerPanel kind="sheet" title="Could not read this spreadsheet" text={book.error} onSave={onSave} />
  if (!book.book) return <div className="gbo-viewer-loading" role="status">Reading {name}…</div>
  const names = book.book.names
  return (
    <div className="gbo-sheet">
      {data ? <SheetGrid key={index} data={data} /> : <ViewerPanel kind="sheet" title="Could not read this sheet" text={names[index] || ''} onSave={onSave} />}
      {names.length > 1 ? (
        <div className="gbo-sheet-tabs" role="tablist" aria-label="Sheets">
          {names.map((sheetName, i) => (
            <button key={`${i}:${sheetName}`} type="button" role="tab" aria-selected={i === index} className={`gbo-sheet-tab${i === index ? ' is-active' : ''}`} onClick={() => setIndex(i)}>
              {sheetName}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SheetGrid({ data }: { data: SheetData }) {
  const { rows, cols } = data
  const bodyRows = Math.max(0, rows.length - 1)
  const scroller = React.useRef<HTMLDivElement>(null)
  const dragging = React.useRef(false)
  const [sel, setSelState] = React.useState<Sel>(null)
  // The latest selection, for key and mouse events that arrive before a
  // re-render (a held arrow key, a fast Shift-click).
  const selRef = React.useRef<Sel>(null)
  const setSel = (next: Sel) => {
    selRef.current = next
    setSelState(next)
  }
  const [view, setView] = React.useState({ top: 0, height: 600 })
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<any>(null)
  const widths = React.useMemo(() => columnWidths(rows, cols), [rows, cols])
  const numWidth = rowNumberWidth(rows.length)
  const tableWidth = numWidth + widths.reduce((sum, w) => sum + w, 0)
  const box = selectionBox(sel)
  const single = box && box.top === box.bottom && box.left === box.right ? box : null
  const cellValue = single ? rows[single.top]?.[single.left] ?? '' : ''

  React.useEffect(() => () => clearTimeout(timer.current), [])
  React.useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return undefined
    const measure = () => setView(v => (v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight || 600 }))
    measure()
    const RO = (globalThis as any).ResizeObserver
    const observer = typeof RO === 'function' ? new RO(measure) : null
    observer?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])
  React.useEffect(() => {
    const up = () => {
      dragging.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const reveal = (r: number, c: number) => {
    const el = scroller.current
    if (!el) return
    const top = scrollTopFor(r, el.scrollTop, el.clientHeight)
    const left = scrollLeftFor(c, widths, el.scrollLeft, el.clientWidth, numWidth)
    if (top !== el.scrollTop) el.scrollTop = top
    if (left !== el.scrollLeft) el.scrollLeft = left
    setView(v => ({ ...v, top: el.scrollTop }))
  }
  const copy = () => {
    const current = selectionBox(selRef.current)
    if (!current) return
    void copyText(boxTsv(rows, current)).then(ok => {
      if (!ok) return
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }
  const cellAt = (target: EventTarget | null) => {
    const td = (target as HTMLElement | null)?.closest?.('[data-r]') as HTMLElement | null
    if (!td) return null
    return { r: Number(td.dataset.r), c: Number(td.dataset.c) }
  }
  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    const cell = cellAt(event.target)
    if (!cell) return
    event.preventDefault()
    dragging.current = true
    scroller.current?.focus({ preventScroll: true } as any)
    const current = selRef.current
    setSel(event.shiftKey && current ? { anchor: current.anchor, focus: cell } : { anchor: cell, focus: cell })
  }
  const onMouseOver = (event: React.MouseEvent) => {
    if (!dragging.current || !(event.buttons & 1)) return
    const cell = cellAt(event.target)
    const current = selRef.current
    if (cell && (current?.focus.r !== cell.r || current?.focus.c !== cell.c)) setSel(current ? { anchor: current.anchor, focus: cell } : { anchor: cell, focus: cell })
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey
    if (mod && !event.altKey && (event.key === 'c' || event.key === 'C')) {
      if (!selRef.current) return
      event.preventDefault()
      copy()
      return
    }
    if (mod && !event.altKey && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault()
      if (rows.length && cols) setSel({ anchor: { r: 0, c: 0 }, focus: { r: rows.length - 1, c: cols - 1 } })
      return
    }
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight || 600) / ROW_PX) - 2)
    const next = moveSelection(selRef.current, event.key, { shift: event.shiftKey, jump: mod, rows: rows.length, cols, page })
    if (!next) return
    event.preventDefault()
    setSel(next)
    reveal(next.focus.r, next.focus.c)
  }
  const onCopy = (event: React.ClipboardEvent) => {
    const current = selectionBox(selRef.current)
    if (!current) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', boxTsv(rows, current))
  }

  const { start, end } = rowWindow(view.top, view.height, bodyRows)
  const rowStyle = { height: ROW_PX } as React.CSSProperties
  const cell = (r: number, c: number, value: string, head: boolean) => {
    const selected = inBox(box, r, c)
    const focus = sel ? sel.focus.r === r && sel.focus.c === c : false
    const long = value.length > 24 || value.includes('\n')
    const props = {
      key: c,
      'data-r': r,
      'data-c': c,
      className: `gbo-sheet-cell${selected ? ' is-sel' : ''}${focus ? ' is-focus' : ''}`,
      title: long ? value : undefined,
      'aria-selected': selected || undefined
    }
    return head ? (
      <th {...props} scope="col">
        {value}
      </th>
    ) : (
      <td {...props}>{value}</td>
    )
  }
  const rowNum = (r: number) => {
    const on = Boolean(box) && r >= (box as any).top && r <= (box as any).bottom
    return (
      <th className={`gbo-sheet-num${on ? ' is-on' : ''}`} scope="row">
        {r + 1}
      </th>
    )
  }
  const notes: string[] = []
  if (data.capped) notes.push(data.total ? `Showing the first ${rows.length.toLocaleString('en-US')} of ${data.total.toLocaleString('en-US')} rows.` : `Showing the first ${rows.length.toLocaleString('en-US')} rows.`)
  if (data.colsCapped) notes.push(`Showing the first ${cols} columns.`)
  const key = isMac() ? '⌘C' : 'Ctrl+C'

  if (!rows.length) return <div className="gbo-viewer-panel"><div className="gbo-viewer-panel-title">This sheet is empty</div></div>

  return (
    <>
      <div className={`gbo-sheet-hint${open && single ? ' is-open' : ''}`}>
        <span className="gbo-sheet-hint-text">
          {single && cellValue ? (
            <>
              <b className="gbo-sheet-ref">{cellName(single.top, single.left)}</b>
              <span className="gbo-sheet-value">{cellValue}</span>
            </>
          ) : (
            `Click a cell to select it. Move with the arrow keys, extend with Shift, copy with ${key}.`
          )}
        </span>
        <span className="gbo-sheet-copied" aria-live="polite">{copied ? 'Copied' : ''}</span>
        {notes.length ? <span className="gbo-sheet-cap">{notes.join(' ')}</span> : null}
        {single && cellValue ? (
          <button type="button" className="gbo-sheet-expand" aria-expanded={open} aria-label={open ? 'Show less of the cell' : 'Show the whole cell'} onClick={() => setOpen(value => !value)}>
            <IconChevronDown />
          </button>
        ) : null}
      </div>
      <div
        ref={scroller}
        className="gbo-sheet-scroll"
        tabIndex={0}
        role="grid"
        aria-label="Spreadsheet"
        aria-rowcount={rows.length}
        aria-colcount={cols}
        onScroll={event => {
          const top = (event.currentTarget as HTMLDivElement).scrollTop
          setView(v => (v.top === top ? v : { ...v, top }))
        }}
        onKeyDown={onKeyDown}
        onFocus={event => {
          // Tabbing in with nothing picked selects the first cell, so the
          // keyboard has a place to start (the cell outline is the focus mark).
          if (event.target === event.currentTarget && !selRef.current && !dragging.current && rows.length && cols) setSel({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } })
        }}
        onCopy={onCopy}
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
      >
        <table className="gbo-sheet-table" style={{ width: tableWidth, ['--gbo-sheet-row' as any]: `${ROW_PX}px` }}>
          <colgroup>
            <col style={{ width: numWidth }} />
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr style={rowStyle}>
              {rowNum(0)}
              {Array.from({ length: cols }, (_, c) => cell(0, c, rows[0][c] ?? '', true))}
            </tr>
          </thead>
          <tbody>
            {start > 0 ? (
              <tr className="gbo-sheet-spacer" aria-hidden="true" style={{ height: start * ROW_PX }}>
                <td colSpan={cols + 1} />
              </tr>
            ) : null}
            {Array.from({ length: end - start }, (_, i) => {
              const r = start + i + 1
              const row = rows[r]
              return (
                <tr key={r} style={rowStyle} aria-rowindex={r + 1}>
                  {rowNum(r)}
                  {Array.from({ length: cols }, (_, c) => cell(r, c, row[c] ?? '', false))}
                </tr>
              )
            })}
            {end < bodyRows ? (
              <tr className="gbo-sheet-spacer" aria-hidden="true" style={{ height: (bodyRows - end) * ROW_PX }}>
                <td colSpan={cols + 1} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  )
}
