// Composer attachments belong to the bot they were picked for. Reading a file
// is asynchronous; the user can switch bots while it runs. Every draft file is
// stamped with its owner (the bot's immutable route identity), a read that
// finishes after the owner changed is dropped, and the chat controller
// refuses to send a file stamped for another bot (review r1 #4).

import { botWorkspaceOwnerKey } from './routing.js'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** The immutable identity a draft belongs to (`bot:<connection>::<profile>`). */
export function draftOwnerKey(bot) {
  return bot ? botWorkspaceOwnerKey(bot) : ''
}

export function attachmentKind(file) {
  const type = String(file?.type || '')
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf' || /\.pdf$/i.test(String(file?.name || ''))) return 'pdf'
  return 'file'
}

/** Read picked files into draft attachments for `owner`. `read(file)` returns
 *  a data URL; `isCurrent(owner)` says whether the composer still belongs to
 *  that owner. Returns `{ files, notes, stale }`; a stale read returns no
 *  files at all. */
export async function readDraftFiles(list, { owner, isCurrent, read, maxBytes = MAX_ATTACHMENT_BYTES, signal } = {}) {
  const files = []
  const notes = []
  for (const file of Array.from(list || [])) {
    if (signal?.aborted || !isCurrent(owner)) return { files: [], notes: [], stale: true }
    if (file.size > maxBytes) {
      notes.push(`${file.name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`)
      continue
    }
    try {
      const data = await read(file)
      if (signal?.aborted || !isCurrent(owner)) return { files: [], notes: [], stale: true }
      files.push({
        id: `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 7)}`,
        kind: attachmentKind(file),
        name: file.name,
        data,
        owner
      })
    } catch (error) {
      if (signal?.aborted || !isCurrent(owner)) return { files: [], notes: [], stale: true }
      notes.push(String(error?.message || error))
    }
  }
  return { files, notes, stale: false }
}

/** A failed send whose text goes back to the composer: only a definite
 *  refusal (`not-sent`, see core/delivery.js: nothing was admitted). An
 *  `unknown` delivery is never re-armed: it may have reached the bot (review
 *  r3 #1). Where it goes and how is `draftTexts.recover` (below). */
export function isRecoverableRefusal(result) {
  return Boolean(result && !result.ok && result.delivery === 'not-sent')
}

/** `text` added to a draft without ever replacing it: below what is there,
 *  separated by a blank line (the rewind rule, review override-v2-r1 #3). */
export function appendDraft(current, text) {
  const add = typeof text === 'string' ? text : ''
  const cur = typeof current === 'string' ? current : ''
  if (!add.trim()) return cur
  return cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${add}` : add
}

/** The composer's note after a failed send (`restored`: the draft came back).
 *  "Delivery unknown" never invites a resend (review r3 #1, #2). */
export function failureNote(result, restored) {
  if (!result || result.ok) return ''
  const why = result.error ? `: ${result.error}` : ''
  if (result.delivery === 'not-sent') {
    return restored ? `Not sent${why}. Your message is back in the composer.` : `Not sent${why}. Retry it from the chat.`
  }
  return 'Delivery unknown: it may already have reached the bot, so it will not be sent again from here. Check the chat, or open it in Hermes Bot Mode.'
}

// ── typed text kept per bot (T8) ─────────────────────────────────────────
//
// Switching bots used to clear the composer. Hermes's own composer keeps a
// draft per session; the override keeps the typed TEXT per bot (draft owner
// key), in memory for this app session only: never files, never written to
// disk, any length, up to 20 bots (the oldest bot's entry goes first).
//
// Two operations, nothing else:
//  - the composer writes its text on every change (`set`) and reads it on
//    mount (`get`); an empty composer (a send) clears the entry;
//  - `recover(owner, text, note)` gives back text that Hermes did NOT take (a
//    definitely refused send, a failed free-text answer). It is synchronous
//    and only ever APPENDS: the store gets the text below whatever it holds,
//    and every live composer of that bot appends it to its own text with a
//    functional update, so two recoveries before a render, a newer draft, or
//    a composer that is not on screen can never lose either text (reviews
//    C-R1-02, C-R2-01, C-R3-01..03). The note is shown by the live composer,
//    or by the next one to mount.

export const DRAFT_OWNERS_MAX = 20

export function createDraftTexts({ maxOwners = DRAFT_OWNERS_MAX } = {}) {
  const map = new Map()
  const notes = new Map()
  const listeners = new Map()
  const api = {
    get(owner) {
      return (owner && map.get(owner)) || ''
    },
    set(owner, text) {
      if (!owner) return
      const value = typeof text === 'string' ? text : ''
      map.delete(owner)
      if (!value.trim()) return
      map.set(owner, value)
      while (map.size > maxOwners) map.delete(map.keys().next().value)
    },
    clear(owner) {
      map.delete(owner)
      notes.delete(owner)
    },
    size: () => map.size,
    recover(owner, text, note = '') {
      if (!owner) return
      api.set(owner, appendDraft(api.get(owner), text))
      const live = listeners.get(owner)
      if (live && live.size) {
        for (const fn of [...live]) {
          try {
            fn(typeof text === 'string' ? text : '', note)
          } catch {
            /* the store already holds it */
          }
        }
      } else if (note) notes.set(owner, note)
    },
    /** The note of a recovery that happened while no composer of `owner`
     *  was on screen; consumed. */
    takeNote(owner) {
      const note = notes.get(owner) || ''
      notes.delete(owner)
      return note
    },
    /** A live composer of `owner`: `fn(text, note)` on each recovery. */
    subscribe(owner, fn) {
      if (!owner || typeof fn !== 'function') return () => undefined
      let set = listeners.get(owner)
      if (!set) listeners.set(owner, (set = new Set()))
      set.add(fn)
      return () => {
        set.delete(fn)
        if (!set.size && listeners.get(owner) === set) listeners.delete(owner)
      }
    }
  }
  return api
}

/** The composer's shared draft texts (one per app session). */
export const draftTexts = createDraftTexts()
