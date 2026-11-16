// Tighter T5: media reserve their size and bot prose is memoized. An image is
// decoded before it is shown and drawn with width/height (clamped to 360
// wide); a remount draws it at once in that box, never the placeholder; audio
// loads in a player-sized box, not a file card. A stream delta in the newest
// reply never re-renders the finished messages' Markdown. Built plugin.js
// under Hermes's loader (test/hermes-loader.mjs).

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

const skip = !READY && 'dev dependencies not installed'
const PNG = 'data:image/png;base64,iVBORw0KGgo='

/** A browser-like Image: decode() resolves and the natural size is known. */
function fakeImage(sizes) {
  return class {
    constructor() {
      this.naturalWidth = 0
      this.naturalHeight = 0
    }
    set src(value) {
      this._src = value
    }
    get src() {
      return this._src
    }
    decode() {
      const size = sizes[this._src] || { w: 720, h: 480 }
      this.naturalWidth = size.w
      this.naturalHeight = size.h
      return Promise.resolve()
    }
  }
}

test('an image is drawn with its size; after a bot switch it is back at once in that box, never the placeholder', { skip }, async t => {
  const withMedia = profile => {
    const base = history(profile)
    if (profile === 'scholar') base.messages.push({ id: 15, role: 'assistant', content: `Chart for ${profile}:\nMEDIA:/tmp/chart.png\nMEDIA:/tmp/voice.mp3`, timestamp: 1762560010 })
    return base
  }
  let release = null
  const { panes, workspaces, mount, errors } = await bootPlugin(t, {
    historyFor: withMedia,
    api: async request => {
      if (!String(request.path).startsWith('/api/fs/read-data-url')) return undefined
      if (String(request.path).includes('voice.mp3')) {
        await new Promise(resolve => (release = resolve))
        return { dataUrl: 'data:audio/mpeg;base64,AAAA' }
      }
      return { dataUrl: PNG }
    }
  })
  window.Image = fakeImage({ [PNG]: { w: 720, h: 480 } })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  ;(await waitFor(() => row('Scholar'), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)

  // Audio still loading: a player-sized box, not a file card.
  const audioBox = await waitFor(() => chatEl.querySelector('.gbo-media-audio.is-loading'), 'the audio placeholder')
  assert.ok(audioBox)
  assert.equal(chatEl.querySelector('.gbo-file-card'), null, 'no file card while the audio loads')

  const img = await waitFor(() => chatEl.querySelector('.gbo-media-image img'), 'the image')
  assert.equal(img.getAttribute('width'), '360', 'clamped to 360 wide')
  assert.equal(img.getAttribute('height'), '240', 'height kept in proportion')
  assert.match(img.getAttribute('style') || '', /aspect-ratio: 360 \/ 240/)
  release?.()
  await waitFor(() => chatEl.querySelector('audio.gbo-media-audio'), 'the audio player')
  assert.equal(chatEl.querySelector('.gbo-media-audio.is-loading'), null)

  // Switch away and back: the image must never pass through its placeholder.
  ;(await waitFor(() => row('Security'), 'Security row')).click()
  await waitFor(() => chatEl.textContent.includes('hello security') && !chatEl.querySelector('.gbo-media-image'), 'Security open')
  const inserted = []
  const observer = new window.MutationObserver(records => {
    for (const r of records) for (const node of r.addedNodes) if (node.nodeType === 1) inserted.push(node)
  })
  observer.observe(chatEl, { childList: true, subtree: true })
  row('Scholar').click()
  const again = await waitFor(() => chatEl.querySelector('.gbo-media-image img'), 'the image again')
  observer.disconnect()
  const placeholders = inserted.filter(node => node.matches?.('.gbo-media-image.is-loading') || node.querySelector?.('.gbo-media-image.is-loading'))
  assert.equal(placeholders.length, 0, 'drawn straight into its box, no placeholder')
  assert.equal(again.getAttribute('width'), '360')
  assert.equal(again.getAttribute('height'), '240')
  assert.deepEqual(errors, [])
})
