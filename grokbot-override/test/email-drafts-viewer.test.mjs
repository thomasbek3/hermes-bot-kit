// Email draft card in the running plugin (ui/EmailDraft.tsx): its attachments are the chat's own file cards
// (ui/Media.tsx FileCard), so clicking one opens the attachment viewer (ui/FileViewer.tsx), here as a grid.
// One boot per file (test/email-drafts-fixture.mjs). Demo content only; nothing is sent anywhere.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { fakePlugin, openScholar } from './email-drafts-fixture.mjs'

const HAS_XLSX = existsSync(new URL('../node_modules/xlsx/package.json', import.meta.url))
const skip = (!READY || !HAS_XLSX) && 'dev dependencies not installed'

test('loader: a draft attachment is a file card; clicking it opens the viewer; Escape returns focus', { skip }, async t => {
  const plugin = fakePlugin()
  const PATH = '/workspace/demo/price-sheet.csv'
  const reads = []
  const { chatEl, card } = await openScholar(t, plugin, {
    api: request => {
      const path = String(request.path)
      if (!path.startsWith('/api/fs/read-data-url')) return undefined
      const file = decodeURIComponent(path.split('path=')[1])
      reads.push(file)
      if (file !== PATH) throw new Error('No such file')
      return { dataUrl: `data:text/csv;base64,${Buffer.from('item,price\nWidget,1.25\nGadget,2.50').toString('base64')}` }
    }
  })
  const fileCard = await waitFor(() => card.querySelector(`.gbo-files .gbo-file-card[data-path="${PATH}"]`), 'the attachment as a file card')
  assert.ok(fileCard.querySelector('.gbo-file-card-icon.is-sheet'), 'the sheet tile, as in the chat')
  assert.ok(fileCard.querySelector('button.gbo-file-card-save[aria-label="Download price-sheet.csv"]'))
  const main = fileCard.querySelector('button.gbo-file-card-main')
  assert.equal(main.getAttribute('aria-label'), 'Open price-sheet.csv')
  assert.equal(main.getAttribute('aria-haspopup'), 'dialog')

  main.click()
  const viewer = await waitFor(() => document.querySelector('[aria-label="Preview of price-sheet.csv"]'), 'the viewer')
  assert.equal(viewer.querySelector('.gbo-viewer-name').textContent, 'price-sheet.csv')
  const table = await waitFor(() => viewer.querySelector('table.gbo-sheet-table'), 'the grid')
  assert.deepEqual([...table.querySelectorAll('thead th.gbo-sheet-cell')].map(th => th.textContent), ['item', 'price'])
  assert.equal(table.querySelectorAll('tbody tr:not(.gbo-sheet-spacer)').length, 2)
  assert.ok(reads.includes(PATH), 'read through the bot’s own file route')
  assert.equal(plugin.ops.filter(o => o.op === 'send').length, 0, 'opening an attachment sends nothing')

  viewer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await waitFor(() => !document.querySelector('[aria-label="Preview of price-sheet.csv"]'), 'closed')
  await waitFor(() => document.activeElement === main, 'focus back on the card')
  assert.equal(card.dataset.status, 'pending', 'the draft is untouched')
  assert.ok(chatEl.contains(card))
})
