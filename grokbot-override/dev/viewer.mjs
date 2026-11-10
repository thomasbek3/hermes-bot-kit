// Write a live browser page for the file viewer into a folder:
//   node dev/viewer.mjs [out-dir]   (default dev/.out/viewer, git-ignored)
// Open <out-dir>/viewer.html; ?theme=dark for the dark theme, ?open=<name>
// opens that file at once (pricing.xlsx, big.csv, report.pdf, chart.svg,
// notes.md, bundle.zip). Demo content only; nothing is fetched.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import * as X from 'xlsx'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.argv[2] || join(root, 'dev/.out/viewer'))
mkdirSync(outDir, { recursive: true })

const b64 = data => Buffer.from(data).toString('base64')
const book = X.utils.book_new()
const rows = [['Item', 'Code', 'Size', 'Detail', 'Weight per roll', 'Width', 'Delivered price']]
const items = ['Plush grass 80', 'Plush grass 65', 'Plush grass 50', 'Meadow 80', 'Meadow 65', 'Meadow 50', 'Starter kit', 'Mow-free turf', 'Porcelain paver 24x24', 'Porcelain paver 24x48', 'Seam tape', 'Turf glue (1 gal)', 'Turf glue (5 gal)', 'Infill sand', 'Glue tube', 'Turf nails']
items.forEach((item, i) =>
  rows.push([
    item,
    `D-${510 + i}`,
    i < 6 ? "20'-100' x 15' (roll)" : '1 unit',
    i % 3 === 0 ? `Pile height: ${(1 + i / 10).toFixed(2)}"\nFace weight: ${80 - i} oz` : `A demo description for ${item.toLowerCase()} that is long enough to be cut off in its cell`,
    `${100 - i * 3} oz.`,
    i < 8 ? '15ft' : '',
    `$${(2.5 + i * 0.25).toFixed(2)}`
  ])
)
X.utils.book_append_sheet(book, X.utils.aoa_to_sheet(rows), 'Pricing')
X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['Note'], ['All prices are demo values.'], ['Contact: sales@example.com']]), 'Notes')
const xlsx = Buffer.from(X.write(book, { type: 'array', bookType: 'xlsx' }))
const big = ['n,label,value', ...Array.from({ length: 50_000 }, (_, i) => `${i + 1},row ${i + 1},${(i * 7) % 1000}`)].join('\n')

// A one-page PDF ("Demo report"), offsets computed.
function pdf() {
  const text = 'BT /F1 28 Tf 72 700 Td (Demo report) Tj /F1 14 Tf 0 -36 Td (A one-page PDF for the file viewer.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}
const bars = Array.from({ length: 12 }, (_, i) => `<rect x="${120 + i * 115}" y="${800 - ((i * 47) % 600) - 100}" width="80" height="${((i * 47) % 600) + 100}" rx="8"/>`).join('')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#eef4ff"/><g fill="#5b8def">${bars}</g><text x="120" y="110" font-size="56" font-family="sans-serif" fill="#1c1c1c">Demo chart</text></svg>`

const FILES = {
  '/workspace/demo/pricing.xlsx': `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsx.toString('base64')}`,
  '/workspace/demo/big.csv': `data:text/csv;base64,${b64(big)}`,
  '/workspace/demo/report.pdf': `data:application/pdf;base64,${b64(pdf())}`,
  '/workspace/demo/chart.svg': `data:image/svg+xml;base64,${b64(svg)}`,
  '/workspace/demo/notes.md': `data:text/markdown;base64,${b64('# Demo notes\n\n- The viewer opens from the card.\n- Escape closes it.\n')}`,
  '/workspace/demo/bundle.zip': `data:application/zip;base64,${b64('PK demo')}`
}

const result = await build({
  entryPoints: [join(root, 'dev/viewer-entry.tsx')],
  absWorkingDir: root,
  bundle: true,
  // A classic script, so the page also opens from file://.
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  alias: { '@hermes/plugin-sdk': join(root, 'dev/fake-sdk.ts') },
  define: { __GBO_PROBE__: 'false', 'process.env.NODE_ENV': '"production"', __VIEWER_FILES__: JSON.stringify(FILES) },
  write: false,
  logLevel: 'error'
})
writeFileSync(join(outDir, 'viewer.js'), result.outputFiles[0].text)
writeFileSync(join(outDir, 'viewer.html'), '<!doctype html><html><head><meta charset="utf-8"><title>File viewer (dev)</title></head><body><div id="root"></div><script src="viewer.js"></script></body></html>\n')
console.log(`wrote ${join(outDir, 'viewer.html')}`)
