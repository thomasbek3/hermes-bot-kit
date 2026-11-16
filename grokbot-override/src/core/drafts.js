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

/** After a send failed: put the draft back in the composer? Only when Hermes
 *  definitely refused it (`not-sent`, see core/delivery.js), the composer
 *  still belongs to the same bot, and nothing newer was typed or attached
 *  since (review r2 #7). An `unknown` delivery is never re-armed: it may have
 *  reached the bot (review r3 #1). */
export function restoreAfterFailure({ result, sentOwner, currentOwner, currentText, currentFiles }) {
  if (!result || result.ok || result.delivery !== 'not-sent') return false
  if (!sentOwner || sentOwner !== currentOwner) return false
  return !String(currentText || '').trim() && !(Array.isArray(currentFiles) && currentFiles.length)
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
// disk, up to 20 bots (the oldest bot's entry goes first). A draft is kept
// whole, however long: nothing is persisted, so there is no size cap, and an
// accepted draft is never dropped (review C-R1-01). A successful send empties
// the composer, which clears the entry.

export const DRAFT_OWNERS_MAX = 20

export function createDraftTexts({ maxOwners = DRAFT_OWNERS_MAX } = {}) {
  const map = new Map()
  // A refused send restored while no composer of that bot was on screen:
  // owner → { text, clientId, note }, consumed by the next composer that
  // mounts with exactly that text (review C-R2-01).
  const pending = new Map()
  // Live composers per owner: (text, info) → true when it took the text.
  const listeners = new Map()
  const api = {
    get(owner) {
      return (owner && map.get(owner)) || ''
    },
    set(owner, text) {
      if (!owner) return
      const value = typeof text === 'string' ? text : ''
      if (pending.has(owner) && pending.get(owner).text !== value) pending.delete(owner)
      map.delete(owner)
      if (!value.trim()) return
      map.set(owner, value)
      while (map.size > maxOwners) {
        const oldest = map.keys().next().value
        map.delete(oldest)
        pending.delete(oldest)
      }
    },
    clear(owner) {
      map.delete(owner)
      pending.delete(owner)
    },
    size: () => map.size,
    /** Give a definitely refused send's text back to `owner`'s draft: to a
     *  live composer of that bot if one takes it (an empty one), else into the
     *  store with a pending record for the next composer that mounts. Never
     *  over a newer draft. Returns true when the text found a home. */
    restore(owner, text, info = {}) {
      const value = typeof text === 'string' ? text : ''
      if (!owner || !value.trim() || api.get(owner).trim()) return false
      const live = listeners.get(owner)
      if (live && live.size) {
        for (const fn of [...live]) {
          try {
            if (fn(value, info)) return true
          } catch {
            /* next */
          }
        }
        return false
      }
      api.set(owner, value)
      pending.set(owner, { text: value, ...info })
      return true
    },
    /** The pending restore for `owner` if the composer now shows `text`;
     *  consumed either way. */
    take(owner, text) {
      const record = pending.get(owner)
      pending.delete(owner)
      return record && record.text === text ? record : null
    },
    /** A live composer for `owner`; returns the unsubscribe. */
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
