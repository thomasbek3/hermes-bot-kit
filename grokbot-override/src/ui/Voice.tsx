// The composer's mic (PARITY C29): click to record in this window, click
// again to stop; the recording is transcribed on the bot's own backend and the
// words go into the draft (core/voice.js names the stock sources). Nothing is
// sent by voice alone.
//
// Lifetime (review override-v2-r1 #1): the mic records only while the Stop
// button is on screen. Every click starts one acquisition, guarded before the
// first await; each async step checks it still owns the button (a generation
// bumped by stop, unmount or a bot change) and a stream that arrives after it
// lost ownership has every track stopped at once. A transcript that arrives
// after the chat was left is dropped.

import * as React from 'react'

import { draftOwnerKey } from '../core/drafts.js'
import { micErrorMessage } from '../core/voice.js'
import { transcribeForBot } from './app'
import { IconMic, IconStop } from './icons'

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Could not read the recording'))
    reader.readAsDataURL(blob)
  })
}

function stopTracks(stream: any) {
  try {
    for (const track of stream?.getTracks?.() || []) track.stop()
  } catch {
    /* already stopped */
  }
}

export function VoiceButton({
  bot,
  disabled,
  onTranscript,
  onError
}: {
  bot: any
  disabled?: boolean
  onTranscript: (text: string) => void
  onError: (message: string) => void
}) {
  const [phase, setPhase] = React.useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle')
  const recorder = React.useRef<any>(null)
  const stream = React.useRef<any>(null)
  const chunks = React.useRef<any[]>([])
  // Ownership: bumped whenever the button stops owning the mic (leave,
  // unmount, bot change). Async work captured an older value is stale.
  const generation = React.useRef(0)
  const acquiring = React.useRef(false)
  const owner = draftOwnerKey(bot)
  const ownerRef = React.useRef(owner)
  ownerRef.current = owner
  const botRef = React.useRef(bot)
  botRef.current = bot

  const release = () => {
    stopTracks(stream.current)
    stream.current = null
    recorder.current = null
  }

  // Leaving the chat (unmount) or switching bots stops the mic, discards the
  // recording and abandons any acquisition or transcription in flight.
  React.useEffect(() => {
    generation.current += 1
    acquiring.current = false
    setPhase('idle')
    return () => {
      generation.current += 1
      acquiring.current = false
      try {
        if (recorder.current) recorder.current.onstop = null
        if (recorder.current?.state === 'recording') recorder.current.stop?.()
      } catch {
        /* gone */
      }
      release()
    }
  }, [owner])

  const start = async () => {
    if (acquiring.current || recorder.current || stream.current) return
    const w = (globalThis as any).window
    const media = (globalThis as any).navigator?.mediaDevices
    const Recorder = (globalThis as any).MediaRecorder
    if (!media?.getUserMedia || typeof Recorder !== 'function') return onError('This window cannot record audio.')
    const mine = generation.current
    const current = () => generation.current === mine
    acquiring.current = true
    setPhase('starting')
    let local: any = null
    try {
      const allowed = await w?.hermesDesktop?.requestMicrophoneAccess?.()
      if (!current()) return
      if (allowed === false) {
        setPhase('idle')
        return onError('Microphone permission was denied.')
      }
      local = await media.getUserMedia({ audio: true })
      if (!current()) {
        stopTracks(local)
        return
      }
      const rec = new Recorder(local)
      chunks.current = []
      rec.ondataavailable = (event: any) => {
        if (event?.data?.size) chunks.current.push(event.data)
      }
      const recordedFor = botRef.current
      const ownerKey = ownerRef.current
      rec.onstop = async () => {
        const type = rec.mimeType || 'audio/webm'
        const blob = new Blob(chunks.current, { type })
        release()
        if (!current()) return
        if (!blob.size) return setPhase('idle')
        setPhase('transcribing')
        try {
          const transcript = await transcribeForBot(recordedFor, await blobToDataUrl(blob), type)
          if (!current() || ownerRef.current !== ownerKey) return
          if (transcript) onTranscript(transcript)
          else onError('Nothing was heard.')
        } catch (error: any) {
          if (current()) onError(`Could not transcribe: ${String(error?.message || error)}`)
        } finally {
          if (current()) setPhase('idle')
        }
      }
      stream.current = local
      recorder.current = rec
      rec.start()
      setPhase('recording')
    } catch (error) {
      stopTracks(local)
      if (!current()) return
      release()
      setPhase('idle')
      onError(micErrorMessage(error))
    } finally {
      if (current()) acquiring.current = false
    }
  }

  const stop = () => {
    try {
      recorder.current?.stop?.()
    } catch {
      release()
      setPhase('idle')
    }
  }

  const recording = phase === 'recording'
  const starting = phase === 'starting'
  return (
    <button
      type="button"
      className={`composer__btn gbo-round${recording ? ' is-recording' : ''}`}
      title={recording ? 'Stop recording' : starting ? 'Starting the microphone…' : phase === 'transcribing' ? 'Transcribing…' : 'Voice input'}
      aria-label={recording ? 'Stop recording' : starting ? 'Starting the microphone…' : 'Voice input'}
      aria-pressed={recording}
      aria-busy={starting || phase === 'transcribing'}
      // Stop stays clickable whatever else the composer is doing.
      disabled={!recording && (disabled || starting || phase === 'transcribing')}
      onClick={() => void (recording ? stop() : start())}
    >
      {recording ? <IconStop /> : <IconMic />}
    </button>
  )
}
