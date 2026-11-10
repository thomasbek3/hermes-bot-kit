// File cards (17): a non-media file a bot sends with a `MEDIA:` line is a
// card of its own under the bubble (ui/Media.tsx FileCard): a document tile,
// the name cut in the middle (full name in the title), the size read lazily
// from the bot's own backend on first hover, a download button on hover, a
// preview of text files with Copy all, "Not available" when the bot's machine
// cannot read it. Images, audio and video are unchanged. Demo content only.

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { dataUrlBytes, dataUrlText, extractMedia, formatBytes, middleTruncate, previewKind } from '../src/core/media.js'
import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

const skip = !READY && 'dev dependencies not installed'

const MD_HEAD = '# Demo handoff\n\n- Move the demo bots over.\n- Keep their `config` & <notes> — exactly.\n\n'
const MD = MD_HEAD + 'x'.repeat(1800 - Buffer.byteLength(MD_HEAD))
const PDF_BYTES = Buffer.alloc(240, 7)
const b64 = text => Buffer.from(text).toString('base64')
const FILES = {
  '/workspace/demo/demo-handoff-notes.md': `data:text/markdown;base64,${b64(MD)}`,
  '/workspace/demo/plan.pdf': `data:application/pdf;base64,${PDF_BYTES.toString('base64')}`,
  '/workspace/demo/data.json': `data:application/json;base64,${b64('{\n  "demo": true\n}\n')}`,
  '/tmp/chart.png': 'data:image/png;base64,iVBORw0KGgo='
}
const MESSAGE = [
  'A file is cleaner than a code box for this. Here it is.',
  'MEDIA:/workspace/demo/demo-handoff-notes.md',
  'MEDIA:/workspace/demo/plan.pdf',
  'MEDIA:/workspace/demo/data.json',
  'MEDIA:/workspace/demo/gone.txt',
  'MEDIA:/tmp/chart.png'
].join('\n')

test('formatBytes: B under 1000, one decimal under 10 units, whole numbers above', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(240), '240 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1000), '1kB')
  assert.equal(formatBytes(1800), '1.8kB')
  assert.equal(formatBytes(24_400), '24kB')
  assert.equal(formatBytes(999_600), '1MB')
  assert.equal(formatBytes(3_100_000), '3.1MB')
})

test('middleTruncate keeps the extension; short names are untouched', () => {
  assert.equal(middleTruncate('notes.md'), 'notes.md')
  assert.equal(middleTruncate('demo-handoff-notes.md'), 'demo-hando….md')
  assert.equal(middleTruncate('demo-handoff-notes.md').length, 14)
  assert.equal(middleTruncate('a-very-long-name-without-ext'), 'a-very-long-n…')
})

test('previewKind: markdown rendered, text and code in monospace, the rest not previewed', () => {
  assert.equal(previewKind('a.md'), 'markdown')
  for (const name of ['a.txt', 'a.json', 'a.csv', 'a.py', 'a.ts', 'a.sh']) assert.equal(previewKind(name), 'text', name)
  for (const name of ['a.pdf', 'a.zip', 'README', 'a.docx']) assert.equal(previewKind(name), '', name)
})

test('dataUrlBytes / dataUrlText read the payload exactly (UTF-8 kept)', () => {
  assert.equal(dataUrlBytes(FILES['/workspace/demo/demo-handoff-notes.md']), 1800)
  assert.equal(dataUrlBytes(FILES['/workspace/demo/plan.pdf']), 240)
  assert.equal(dataUrlText(FILES['/workspace/demo/demo-handoff-notes.md']), MD)
  assert.equal(dataUrlText('data:text/plain,a%20b'), 'a b')
  assert.equal(dataUrlBytes('not a data url'), null)
  assert.equal(dataUrlText(''), '')
})

test('extractMedia still lists files as kind "file" and lifts their lines', () => {
  const { text, media } = extractMedia(MESSAGE)
  assert.equal(text, 'A file is cleaner than a code box for this. Here it is.')
  assert.deepEqual(media.map(m => m.kind), ['file', 'file', 'file', 'file', 'image'])
})

test('CSS: the card, its hover download button and the preview; tokens exist for light and dark', { skip }, async () => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  try {
    const { CSS } = await import(pathToFileURL(file).href)
    // Rules are scoped and scaled to Hermes's zoom (refCss): 8px is 8.93px.
    const scope = ':where([data-gbo-root], [data-gbo-root] *)'
    const rule = sel => CSS.split('\n').find(line => line.startsWith(`${sel}${scope} {`))
    const block = sel => {
      const start = CSS.indexOf(`${sel}${scope} {`)
      return start < 0 ? '' : CSS.slice(start, CSS.indexOf('}', start))
    }
    assert.match(rule('.gbo-files'), /flex-direction: column;.*gap: 8\.93px;/)
    assert.match(block('.gbo-file-card'), /width: 245\.54px;[\s\S]*border-radius: 17\.86px;[\s\S]*background: var\(--g-color-bg-elevated\);[\s\S]*box-shadow: var\(--g-shadow-card\);/)
    assert.match(block('.gbo-file-card-save'), /border-radius: var\(--g-radius-full\);[\s\S]*opacity: 0;/)
    assert.ok(CSS.includes(`.gbo-file-card:hover${scope} .gbo-file-card-save, .gbo-file-card:focus-within${scope} .gbo-file-card-save { opacity: 1; }`))
    assert.match(rule('.gbo-file-card-name'), /font-weight: 500;.*text-overflow: ellipsis;/)
    assert.match(rule('.gbo-file-card-size'), /color: var\(--g-color-text-tertiary\);/)
    // Light and dark both define the card's surface and ring.
    assert.match(CSS, /\[data-gbo-root\] \{[^}]*--g-color-bg-elevated: #FFFFFF;/)
    assert.match(CSS, /\.dark \[data-gbo-root\], \[data-gbo-root\]\[data-gbo-theme="dark"\] \{[^}]*--g-color-bg-elevated: #1F1F1F;/)
    assert.match(CSS, /\.dark \[data-gbo-root\], \[data-gbo-root\]\[data-gbo-theme="dark"\] \{[^}]*--g-shadow-card: /)
  } finally {
    rmSync(dirname(file), { recursive: true, force: true })
  }
})

test('loader: files are cards under the bubble; hover reads the size; download, preview and Copy all; missing file; image unchanged', { skip }, async t => {
  const withFiles = profile => {
    const page = history(profile)
    page.messages = [
      ...page.messages,
      { id: 30, role: 'assistant', content: MESSAGE, timestamp: 1762560100 },
      { id: 31, role: 'assistant', content: 'MEDIA:/workspace/demo/plan.pdf', timestamp: 1762560110 }
    ]
    return page
  }
  const reads = []
  const booted = await bootPlugin(t, {
    historyFor: withFiles,
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
    saved.push({ href: this.href, download: this.download })
  }

  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = booted.mount((await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')).render)
  const lists = await waitFor(() => {
    const found = chatEl.querySelectorAll('.gbo-files')
    return found.length === 2 ? [...found] : null
  }, 'two file lists')
  const cards = [...lists[0].querySelectorAll('.gbo-file-card')]
  assert.equal(cards.length, 4, 'one card per file, stacked in one list')
  assert.equal(lists[0].closest('.bubble'), null, 'the cards sit under the bubble, not in it')
  assert.ok(lists[0].previousElementSibling?.querySelector('.bubble.is-agent'), 'right after the text bubble')
  assert.ok(chatEl.textContent.includes('A file is cleaner than a code box'))
  assert.ok(!chatEl.textContent.includes('MEDIA:'))

  // A message that is only a file draws no empty bubble.
  assert.equal(lists[1].querySelectorAll('.gbo-file-card').length, 1)
  assert.equal(lists[1].parentElement.querySelector('.bubble'), null, 'no empty bubble for a file-only message')

  // Name cut in the middle, the full name in the title; nothing read yet.
  const [md, pdf, json, gone] = cards
  const main = card => card.querySelector('button.gbo-file-card-main')
  assert.equal(md.querySelector('.gbo-file-card-name').textContent, 'demo-hando….md')
  assert.equal(main(md).getAttribute('title'), 'demo-handoff-notes.md')
  assert.equal(pdf.querySelector('.gbo-file-card-name').textContent, 'plan.pdf')
  assert.equal(md.querySelector('.gbo-file-card-size').textContent, ' ', 'no size before the card is pointed at')
  assert.ok(md.querySelector('.gbo-file-card-icon svg'))

  // The image is unchanged: inside the bubble, read on render.
  const img = await waitFor(() => chatEl.querySelector('.bubble.is-agent .gbo-media-image img'), 'the image in the bubble')
  assert.equal(img.getAttribute('src'), FILES['/tmp/chart.png'])
  assert.deepEqual(reads, ['/tmp/chart.png'], 'files are not read while the transcript renders')

  const hover = el => el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))

  // Hover reads the size lazily; the read is pinned to the bot's backend.
  hover(md)
  await waitFor(() => md.querySelector('.gbo-file-card-size').textContent === '1.8kB', 'md size')
  hover(pdf)
  await waitFor(() => pdf.querySelector('.gbo-file-card-size').textContent === '240 B', 'pdf size')
  const read = booted.calls.find(c => c.method === 'REST' && String(c.params.path).includes(encodeURIComponent('/workspace/demo/plan.pdf')))
  assert.equal(read.params.connectionId, 'home-server')
  assert.equal(read.params.profile, 'scholar')

  // The hover download button saves through the owner read, name kept.
  const save = pdf.querySelector('button.gbo-file-card-save')
  assert.equal(save.getAttribute('aria-label'), 'Download plan.pdf')
  save.click()
  await waitFor(() => saved.length === 1, 'saved')
  assert.deepEqual(saved[0], { href: FILES['/workspace/demo/plan.pdf'], download: 'plan.pdf' })

  // Clicking a non-text file's body downloads it too.
  main(pdf).click()
  await waitFor(() => saved.length === 2, 'saved by click')
  assert.equal(chatEl.querySelector('.gbo-file-preview'), null, 'no preview for a pdf')

  // Clicking a markdown file opens the preview; Copy all copies the exact text.
  main(md).click()
  const dialog = await waitFor(() => document.querySelector('[aria-label="Preview of demo-handoff-notes.md"]'), 'preview')
  assert.ok(dialog.querySelector('.md.gbo-file-preview .aui-md'), 'markdown through the SDK renderer')
  assert.ok(dialog.textContent.includes('# Demo handoff'))
  const copy = dialog.querySelector('button.gbo-file-preview-copy')
  assert.equal(copy.textContent, 'Copy all')
  copy.click()
  await waitFor(() => copy.textContent === 'Copied', 'Copied')
  assert.deepEqual(written, [MD], 'exactly the file text')
  dialog.querySelector('button.gbo-file-preview-save').click()
  await waitFor(() => saved.length === 3, 'Download from the preview')
  assert.equal(saved[2].download, 'demo-handoff-notes.md')
  ;[...dialog.querySelectorAll('button')].find(b => b.textContent === 'Close').click()
  await waitFor(() => !document.querySelector('[aria-label="Preview of demo-handoff-notes.md"]'), 'closed')

  // Other text types preview in monospace.
  main(json).click()
  const jsonDialog = await waitFor(() => document.querySelector('[aria-label="Preview of data.json"]'), 'json preview')
  const pre = jsonDialog.querySelector('pre.gbo-file-preview.is-mono')
  assert.equal(pre.textContent, '{\n  "demo": true\n}\n')
  ;[...jsonDialog.querySelectorAll('button')].find(b => b.textContent === 'Close').click()
  await waitFor(() => !document.querySelector('[aria-label="Preview of data.json"]'), 'json closed')

  // A file the bot's machine cannot read: "Not available", no download button.
  hover(gone)
  await waitFor(() => gone.querySelector('.gbo-file-card-size').textContent === 'Not available', 'not available')
  assert.ok(gone.classList.contains('is-error'))
  assert.equal(gone.querySelector('button.gbo-file-card-save'), null)
  main(gone).click()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(document.querySelector('[aria-label="Preview of gone.txt"]'), null, 'nothing opens')
  assert.deepEqual(booted.errors, [])
})
