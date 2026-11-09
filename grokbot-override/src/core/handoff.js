// Handing an override draft to the stock Hermes composer (slash commands and
// @mentions belong there). The SDK's composer surface (apps/desktop/src/sdk/
// composer.ts) can read a session's draft (getDraft), append to it
// (insertText, 'block' mode) or replace it whole (setDraft). A handoff must
// never silently replace an unsent stock draft, and the override keeps its
// own draft until the stock composer took the text (review r2 #6).
//
// Attachments cannot travel: the SDK has no attachment transfer, so a draft
// that carries files is not handed off at all (handoffBlocked).

export const HANDOFF_TRIES = 12
export const HANDOFF_STEP_MS = 250

/** A draft with attachments stays in the override: only text can move. */
export function handoffBlocked(files) {
  return Array.isArray(files) && files.length > 0
}

const same = (a, b) => String(a || '').trim() === String(b || '').trim()

/**
 * Put `text` into the stock composer of `sessionId`. `mode`:
 *   'ask'     (default) report an existing different draft as a conflict
 *   'append'  add the text as a new paragraph after the existing draft
 *   'replace' replace the existing draft (only after the user said so)
 * Resolves { status: 'landed' | 'conflict' | 'failed', existing? }.
 * The composer mounts a moment after the chat opens, so a few tries.
 * A host that cannot read drafts gets an append (never a blind replace),
 * or nothing when it cannot append either.
 */
export async function placeDraft({ composer, sessionId, text, mode = 'ask', tries = HANDOFF_TRIES, step = HANDOFF_STEP_MS, wait }) {
  const pause = wait || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  if (!composer || !sessionId || !String(text || '').trim()) return { status: 'failed' }
  const canRead = typeof composer.getDraft === 'function'
  const canAppend = typeof composer.insertText === 'function'
  const canSet = typeof composer.setDraft === 'function'
  for (let i = 0; i < tries; i += 1) {
    let existing = ''
    if (canRead) {
      try {
        existing = String((await composer.getDraft(sessionId)) ?? '')
      } catch {
        existing = ''
      }
    }
    if (existing.trim() && same(existing, text)) return { status: 'landed' }
    if (mode === 'ask' && existing.trim()) return { status: 'conflict', existing }
    let ok = false
    try {
      if (mode === 'replace' || (canRead && !existing.trim())) {
        ok = canSet ? Boolean(await composer.setDraft(sessionId, text)) : false
      } else if (canAppend) {
        ok = Boolean(await composer.insertText(sessionId, text, { mode: 'block' }))
      } else if (canRead && canSet && mode === 'append') {
        ok = Boolean(await composer.setDraft(sessionId, `${existing.replace(/\s+$/, '')}\n\n${text}`))
      }
    } catch {
      ok = false // not mounted yet
    }
    if (ok) return { status: 'landed' }
    if (!canRead && !canAppend) return { status: 'failed' }
    await pause(step)
  }
  return { status: 'failed' }
}
