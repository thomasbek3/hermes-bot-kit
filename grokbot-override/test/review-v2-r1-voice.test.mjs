// Review override-v2-r1 #1 (src/ui/Voice.tsx): the mic never records without
// a visible Stop control and stops on any chat leave. The built plugin.js
// under Hermes's loader (test/hermes-loader.mjs), a jsdom DOM, real clicks;
// permission, getUserMedia and transcription are deferred so a bot switch can
// land in between, as the reviewer reproduced it.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

test('v2-r1 #1 mic: leaving the chat during permission, during getUserMedia or during transcription never records, never leaks the stream, never moves text; a double click acquires once', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const recorders = []
  class FakeRecorder {
    constructor(stream) {
      this.stream = stream
      this.state = 'inactive'
      this.mimeType = 'audio/webm'
      recorders.push(this)
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
  const streams = []
  const media = []
  const makeStream = () => {
    const tracks = [{ stopped: false, stop() { this.stopped = true } }]
    const stream = { getTracks: () => tracks, tracks }
    streams.push(stream)
    return stream
  }
  let transcribe = null
  const { panes, workspaces, mount, errors } = await bootPlugin(t, {
    tweak: () => {
      globalThis.MediaRecorder = FakeRecorder
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        value: {
          getUserMedia: () => {
            const d = deferred()
            media.push(d)
            return d.promise
          }
        },
        configurable: true
      })
      globalThis.Blob = window.Blob
    },
    api: request => (request.path === '/api/audio/transcribe' ? (transcribe = deferred()).promise : undefined)
  })
  const permissions = []
  window.hermesDesktop.requestMicrophoneAccess = () => {
    const d = deferred()
    permissions.push(d)
    return d.promise
  }

  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const openBot = async (name, text) => {
    ;(await waitFor(() => row(name), `${name} row`)).click()
    await waitFor(() => chatEl().textContent.includes(text), `${name} transcript`)
    return waitFor(() => {
      const el = chatEl().querySelector('textarea')
      return el && !el.disabled ? el : null
    }, `${name} composer`)
  }
  let chatRoot = null
  const chatEl = () => chatRoot
  ;(await waitFor(() => row('Scholar'), 'row')).click()
  chatRoot = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await openBot('Scholar', 'hello scholar')
  const mic = () => chatEl().querySelector('button[aria-label="Voice input"], button[aria-label="Starting the microphone…"], button[aria-label="Stop recording"]')
  const stopButton = () => chatEl().querySelector('button[aria-label="Stop recording"]')
  const anyTrackLive = () => streams.some(s => s.tracks.some(track => !track.stopped))
  const recording = () => recorders.filter(r => r.state === 'recording').length

  // A. Leave while the permission prompt is open.
  mic().click()
  mic().click() // a double click while acquisition is pending
  await tick()
  assert.equal(permissions.length, 1, 'a double click acquires once')
  await openBot('Security', 'hello security')
  permissions[0].resolve(true)
  await tick()
  for (const d of media) d.resolve(makeStream())
  await tick()
  assert.equal(recording(), 0, 'A: no recorder started after leaving the chat')
  assert.equal(anyTrackLive(), false, 'A: no live microphone track')
  assert.equal(stopButton(), null)

  // B. Leave while getUserMedia is pending.
  const mediaBefore = media.length
  mic().click()
  await waitFor(() => permissions.length === 2, 'second permission request')
  permissions[1].resolve(true)
  await waitFor(() => media.length === mediaBefore + 1, 'getUserMedia called')
  await openBot('Scholar', 'hello scholar')
  media.at(-1).resolve(makeStream())
  await tick()
  assert.equal(recording(), 0, 'B: no recorder started after leaving the chat')
  assert.equal(anyTrackLive(), false, 'B: the late stream was stopped at once')
  assert.equal(stopButton(), null)

  // C. Record normally (the visible Stop exists exactly while recording), stop,
  //    then leave while the transcription is in flight.
  mic().click()
  await waitFor(() => permissions.length === 3, 'third permission request')
  permissions[2].resolve(true)
  await waitFor(() => media.length === mediaBefore + 2, 'getUserMedia called again')
  media.at(-1).resolve(makeStream())
  await waitFor(() => stopButton(), 'a visible Stop while recording')
  assert.equal(recording(), 1)
  stopButton().click()
  await waitFor(() => transcribe, 'transcription requested')
  assert.equal(anyTrackLive(), false, 'stopping releases the mic')
  const box = await openBot('Security', 'hello security')
  transcribe.resolve({ ok: true, transcript: 'words for scholar' })
  await tick(60)
  assert.ok(!box.value.includes('words for scholar'), 'C: the transcript never lands in another bot’s draft')
  const back = await openBot('Scholar', 'hello scholar')
  assert.ok(!back.value.includes('words for scholar'), 'C: nor in a remounted composer after the chat was left')
  assert.equal(anyTrackLive(), false)
  assert.deepEqual(errors, [])
})
