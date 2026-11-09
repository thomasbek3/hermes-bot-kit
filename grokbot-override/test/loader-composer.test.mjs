// Loader-faithful composer (PARITY C19, C20, C29): the built plugin.js under
// Hermes's loader, a real DOM, typed like a user.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('loader-faithful composer: / and @ completions, a slash command runs here, the mic transcribes on the bot\'s backend', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const transcribed = []
  class FakeRecorder {
    constructor() {
      this.state = 'inactive'
      this.mimeType = 'audio/webm'
    }
    start() {
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new window.Blob(['abc'], { type: 'audio/webm' }) })
      this.onstop?.()
    }
  }
  const { panes, workspaces, mount, errors, calls } = await bootPlugin(t, {
    tweak: () => {
      globalThis.MediaRecorder = FakeRecorder
      Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true })
      globalThis.Blob = window.Blob
    },
    answers: {
      'complete.slash': () => ({ items: [{ text: '/compress', display: '/compress', meta: 'Compress this conversation' }], replace_from: 0 }),
      'session.compress': () => ({ status: 'compressed', summary: { headline: 'Compressed 9 → 3 messages' } })
    },
    api: request => {
      if (request.path === '/api/audio/transcribe') {
        transcribed.push(request)
        return { ok: true, transcript: 'hello from my voice' }
      }
      return undefined
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'transcript')
  // Under a loaded runner the composer can still be committing its enabled
  // state when the first keystroke lands; type once it is live.
  const box = await waitFor(() => {
    const el = chatEl.querySelector('textarea')
    return el && !el.disabled ? el : null
  }, 'an enabled composer')
  await new Promise(resolve => setTimeout(resolve, 50))

  type(box, '/comp')
  const row = await waitFor(() => chatEl.querySelector('.gbo-popover-row'), 'slash completions')
  assert.match(row.textContent, /\/compress/)
  assert.ok(calls.some(c => c.method === 'complete.slash' && c.via === 'home-server::scholar'))

  type(box, 'ask @sec')
  await waitFor(() => [...chatEl.querySelectorAll('.gbo-popover-row')].some(r => r.textContent.includes('@security')), 'mention completions')

  type(box, '/compr')
  await waitFor(() => chatEl.querySelector('.gbo-popover-row')?.textContent.includes('/compress'), 'slash completions again')
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => box.value === '/compress ' && !chatEl.querySelector('.gbo-popover-row'), 'Enter picks the completion')
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => chatEl.textContent.includes('Compressed 9 → 3 messages'), 'the command ran in this chat')
  assert.ok(calls.some(c => c.method === 'session.compress' && c.via === 'home-server::scholar'))
  assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 0, 'a command is never sent as a message')

  const mic = chatEl.querySelector('button[aria-label="Voice input"]')
  mic.click()
  const stop = await waitFor(() => chatEl.querySelector('button[aria-label="Stop recording"]'), 'recording')
  stop.click()
  await waitFor(() => box.value.includes('hello from my voice'), 'the transcript lands in the draft')
  assert.equal(transcribed[0].connectionId, 'home-server', 'transcribed on the bot\'s own backend')
  assert.equal(transcribed[0].profile, 'scholar')
  assert.match(transcribed[0].body.data_url, /^data:audio\/webm/)
  assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 0, 'voice never sends by itself')
  assert.deepEqual(errors, [])
})
