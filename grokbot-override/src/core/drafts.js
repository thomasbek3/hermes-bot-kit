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
