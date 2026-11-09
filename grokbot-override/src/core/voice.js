// Voice input (PARITY C29): the app records in the renderer and transcribes
// on the recording owner's backend, never `voice.record` (that captures on the
// gateway's machine, wrong for a remote bot). Ported from Hermes Agent (MIT,
// (c) Nous Research, 2bd378ed1b): app/chat/composer/hooks/use-mic-recorder.ts
// (requestMicrophoneAccess, getUserMedia, MediaRecorder; `micError` copy) and
// api/system.ts `transcribeAudio` / `audioTranscribeRequestTimeoutMs`
// (POST /api/audio/transcribe {data_url, mime_type} pinned to the owner).
// The transcript goes into the composer for the user to send.

export const TRANSCRIBE_MIN_MS = 180_000
export const TRANSCRIBE_MAX_MS = 600_000
const MS_PER_CHAR = 0.1

export function transcribeTimeoutMs(dataUrl) {
  return Math.min(TRANSCRIBE_MAX_MS, Math.max(TRANSCRIBE_MIN_MS, Math.ceil(String(dataUrl || '').length * MS_PER_CHAR)))
}

/** The REST request that transcribes a recording on the bot's own backend. */
export function transcribeRequest(dataUrl, mimeType, scope) {
  return {
    ...(scope?.connectionId ? { connectionId: scope.connectionId } : {}),
    ...(scope?.profile ? { profile: scope.profile } : {}),
    path: '/api/audio/transcribe',
    method: 'POST',
    body: { data_url: dataUrl, mime_type: mimeType || undefined },
    timeoutMs: transcribeTimeoutMs(dataUrl)
  }
}

/** use-mic-recorder.ts micError: friendly copy for a DOMException name. */
export function micErrorMessage(error) {
  const name = error && typeof error === 'object' ? String(error.name || '') : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission was denied.'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found.'
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'The microphone is in use by another app.'
  if (name === 'OverconstrainedError') return 'The microphone does not support the requested settings.'
  return String(error?.message || error || 'Could not start the microphone.')
}
