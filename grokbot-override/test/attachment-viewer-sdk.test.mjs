// Attachment viewer on a Desktop with the SDK's Radix dialog parts: the
// overlay is the SDK Dialog (focus trap, portal, Escape), sized to the window,
// with the file name as its DialogTitle pill. Demo content only.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

const skip = !READY && 'dev dependencies not installed'

test('loader (SDK dialog): the viewer is the SDK Dialog, full size, titled by the file name', { skip }, async t => {
  const text = '# Demo notes\n\nOne line.\n'
  const booted = await bootPlugin(t, {
    primitives: true,
    historyFor: profile => {
      const page = history(profile)
      page.messages = [...page.messages, { id: 50, role: 'assistant', content: 'MEDIA:/workspace/demo/notes.md', timestamp: 1762560300 }]
      return page
    },
    api: request => {
      const path = String(request.path)
      if (!path.startsWith('/api/fs/read-data-url')) return undefined
      return { dataUrl: `data:text/markdown;base64,${Buffer.from(text).toString('base64')}` }
    }
  })
  const written = []
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async value => void written.push(value) } })
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = booted.mount((await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')).render)
  const card = await waitFor(() => chatEl.querySelector('.gbo-file-card'), 'card')
  card.querySelector('button.gbo-file-card-main').click()
  const viewer = await waitFor(() => document.querySelector('[aria-label="Preview of notes.md"]'), 'viewer')
  const dialog = viewer.closest('[role="dialog"]')
  assert.ok(dialog, 'inside the SDK DialogContent')
  assert.equal(dialog.classList.contains('gbo-modal-fallback'), false)
  assert.equal(dialog.style.width, 'calc(100vw - 32px)')
  assert.equal(dialog.style.height, 'calc(100vh - 32px)')
  assert.equal(viewer.querySelector('h2.gbo-viewer-name').textContent, 'notes.md')
  await waitFor(() => viewer.querySelector('.md.gbo-file-preview .aui-md'), 'markdown')
  viewer.querySelector('button.gbo-file-preview-copy').click()
  await waitFor(() => written.length === 1, 'Copy all')
  assert.equal(written[0], text)
  viewer.querySelector('button.gbo-viewer-close').click()
  await waitFor(() => !document.querySelector('[aria-label="Preview of notes.md"]'), 'closed')
  assert.deepEqual(booted.errors, [])
})
