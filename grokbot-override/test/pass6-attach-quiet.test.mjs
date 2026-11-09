// Pass 6 B, on screen: a refused attach never shows the gateway's raw error
// ("Live updates are paused (invalid_params)"); the history stays and the
// chat is usable. "Reconnecting…" is the only attach state ever drawn, after
// 10 s (core: test/pass6-resume.test.mjs).

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

test('loader: a refused session.resume stays silent in the chat', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount, calls } = await bootPlugin(t, {
    answers: {
      'session.resume': () => {
        throw Object.assign(new Error('invalid_params'), { code: 4001, data: { reason: 'invalid_params', fields: ['something_else'] } })
      }
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Security')), 'rows')).click()
  const mainEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat tab')).render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'the history')
  await waitFor(() => calls.some(c => c.method === 'session.resume'), 'the attach was tried')
  await new Promise(r => setTimeout(r, 50))
  assert.ok(!mainEl.textContent.includes('invalid_params'))
  assert.ok(!mainEl.textContent.includes('Live updates are paused'))
  assert.ok(!mainEl.textContent.includes('Reconnecting'), 'not before 10 s')
  assert.ok(mainEl.querySelector('textarea, [contenteditable]'), 'the composer is there')
})
