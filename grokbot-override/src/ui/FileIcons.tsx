// File tiles for the file card and the viewer (ui/Media.tsx FileCard,
// ui/FileViewer.tsx): a page with a coloured band by type, drawn like Grok
// Bot's card (a white sheet with grid lines and a green band for a
// spreadsheet). Plain text and unknown files keep #38's grey document glyph.

import * as React from 'react'

import { IconDocument } from './icons'

const PAGE = 'M6.5 .5h23a6 6 0 0 1 6 6v31a6 6 0 0 1-6 6h-23a6 6 0 0 1-6-6v-31a6 6 0 0 1 6-6Z'
const BAND = 'M.5 30h35v7.5a6 6 0 0 1-6 6h-23a6 6 0 0 1-6-6Z'
const BAND_COLOR: Record<string, string> = { sheet: '#4FAE5C', pdf: '#E5484D', doc: '#3B7BE8' }
const BAND_TEXT: Record<string, string> = { pdf: 'PDF', doc: 'DOC' }

/** The tile for `kind` (core/media.js fileIconKind). */
export function FileTile({ kind }: { kind: string }) {
  if (kind !== 'sheet' && kind !== 'pdf' && kind !== 'image' && kind !== 'doc') return <IconDocument lines={kind === 'text'} />
  return (
    <svg className={`gbo-ftile is-${kind}`} viewBox="0 0 36 44" aria-hidden="true" focusable="false">
      <path className="gbo-ftile-page" d={PAGE} />
      {kind === 'sheet' ? <path className="gbo-ftile-line" d="M.5 10.5h35M.5 20.5h35M12.5 .5v29.5M24.5 .5v29.5" /> : null}
      {kind === 'pdf' || kind === 'doc' ? <path className="gbo-ftile-line" d="M8 9.5h20M8 15.5h20M8 21.5h13" /> : null}
      {kind === 'image' ? (
        <>
          <circle cx="24" cy="12" r="3.5" fill="#F5B83D" />
          <path d="M4 34l9.5-12 7 8.5 4-4.5L32 34Z" fill="#5B8DEF" />
        </>
      ) : (
        <path d={BAND} fill={BAND_COLOR[kind]} />
      )}
      {BAND_TEXT[kind] ? (
        <text x="18" y="40" textAnchor="middle" fontSize="8" fontWeight="700" fill="#FFFFFF" fontFamily="inherit" letterSpacing=".4">
          {BAND_TEXT[kind]}
        </text>
      ) : null}
      <path className="gbo-ftile-edge" d={PAGE} />
    </svg>
  )
}
