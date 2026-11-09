// PARITY C13 (tool detail) and C15 (owner-safe media).

import assert from 'node:assert/strict'
import test from 'node:test'

import { historyToItems } from '../src/core/history.js'
import { extractMedia, mediaReadRequest } from '../src/core/media.js'
import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { diffLines } from '../src/core/tools.js'
import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

test('C15 media are lifted out of the text like parts.ts renderMediaTags', () => {
  const { text, media } = extractMedia(
    'Here you go:\nMEDIA:/tmp/chart.png\nAlso see MEDIA:/home/me/report.pdf. And MEDIA:"/tmp/my song.mp3"\n\n![shot](/Users/me/shot.webp) and ![web](https://example.com/a.png)\nNot media: MEDIA:...'
  )
  assert.deepEqual(media.map(m => [m.path, m.kind, m.remote]), [
    ['/tmp/chart.png', 'image', false],
    ['/home/me/report.pdf', 'file', false],
    ['/tmp/my song.mp3', 'audio', false],
    ['/Users/me/shot.webp', 'image', false],
    ['https://example.com/a.png', 'image', true]
  ])
  assert.ok(!text.includes('MEDIA:/tmp/chart.png'))
  assert.ok(text.includes('Also see report.pdf.'), 'an inline tag becomes the file name; sentence punctuation stays')
  assert.ok(text.includes('MEDIA:...'), 'a non-path is left as prose')
  assert.ok(!text.includes('/Users/me/shot.webp'))
})

test('C15 a media read is pinned to the bot\'s own connection and profile', () => {
  assert.deepEqual(mediaReadRequest('file:///tmp/a%20b.png', { connectionId: 'home-server', profile: 'scholar' }), {
    path: `/api/fs/read-data-url?path=${encodeURIComponent('/tmp/a b.png')}`,
    connectionId: 'home-server',
    profile: 'scholar'
  })
})

test('C13 tool.start / tool.complete keep arguments, result, diff and image', () => {
  let s = initialChatState()
  s = applyEvent(s, { type: 'message.start', payload: {} })
  s = applyEvent(s, { type: 'tool.start', payload: { tool_id: 't1', name: 'patch', args: { path: '/a.py' } } })
  s = applyEvent(s, { type: 'tool.complete', payload: { tool_id: 't1', name: 'patch', result_text: 'ok', inline_diff: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y', image_path: '/tmp/out.png', duration_s: 2 } })
  const tool = s.items.find(i => i.kind === 'tools').tools[0]
  assert.equal(tool.args, JSON.stringify({ path: '/a.py' }, null, 2))
  assert.equal(tool.result, 'ok')
  assert.ok(tool.diff.includes('+y'))
  assert.equal(tool.image, '/tmp/out.png')
  assert.deepEqual(diffLines('@@ -1 +1 @@\n-x\n+y').map(l => l.kind), ['hunk', 'del', 'add'])
})

test('C13 stored rows give the same detail: tool_calls arguments and the tool row result', () => {
  const items = historyToItems(history('x').messages)
  const tool = items.find(i => i.kind === 'tools').tools[0]
  assert.equal(tool.args, JSON.stringify({ path: '/tmp/a.txt' }, null, 2))
  assert.equal(tool.result, 'file body')
})

test('C13/C15 loader-faithful: a remote bot\'s image is read from its own backend; tool detail renders', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const withMedia = profile => {
    const base = history(profile)
    base.messages.push({ id: 15, role: 'assistant', content: `Chart for ${profile}:\nMEDIA:/tmp/chart.png`, timestamp: 1762560010 })
    return base
  }
  const { panes, workspaces, mount, errors, calls } = await bootPlugin(t, {
    showWork: true,
    historyFor: withMedia,
    api: request => (String(request.path).startsWith('/api/fs/read-data-url') ? { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } : undefined)
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')
  row.click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  const img = await waitFor(() => chatEl.querySelector('.gbo-media-image img'), 'the owner-read image')
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=')
  const read = calls.find(c => c.method === 'REST' && String(c.params.path).startsWith('/api/fs/read-data-url'))
  assert.equal(read.params.connectionId, 'home-server', 'read on the bot\'s connection, never the active gateway')
  assert.equal(read.params.profile, 'scholar')
  assert.ok(!chatEl.textContent.includes('MEDIA:/tmp/chart.png'))
  assert.ok(chatEl.querySelector('.gbo-tool-detail'), 'the tool opens to its detail')
  assert.ok(chatEl.textContent.includes('Arguments') && chatEl.textContent.includes('file body'))
  assert.deepEqual(errors, [])
})
