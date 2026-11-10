// Inbound activity on bots whose chat is not on screen (PARITY R16 unread
// dot, R17 activity toasts). Port of hermes-bots/roster-actions.ts
// `trackInboundActivity` (:55-133) with data.ts `botActivitySession`
// (:1755-1774) and row-helpers.ts `botCanonicalSessionId` (:70-80)
// (Hermes Agent, MIT, (c) Nous Research, 2bd378ed1b).
//
// Every roster refresh: a bot whose activity watermark (`last_active` of its
// Bot Chat or newest session) moved while its chat is not the one on screen
// is marked unread in core's own unread store (the same id the row's
// SessionStatusDot reads), and, when the user turned activity toasts on in
// Bot Mode, toasts once per distinct preview. The first refresh only seeds the
// watermarks, so history is never replayed. Hidden bots are marked but never
// toast. The bot on screen is refreshed instead of marked.

import { rowKey } from './roster.js'
import { isSilenceReply } from './silence.js'

export function botActivitySession(bot) {
  const preferred = bot?.canonical_session
  const last = bot?.last_session
  if (!preferred || !last) return preferred || last || null
  return (preferred.last_active || 0) >= (last.last_active || 0) ? preferred : last
}

export function botCanonicalSessionId(bot) {
  return bot?.canonical_session?.resolved_id ?? bot?.canonical_session?.id ?? null
}

/**
 * deps: { selectedKey(): string, isHidden(bot): boolean, label(bot): string,
 *         markUnread(sessionId, profile), toastsEnabled(): boolean,
 *         notify({kind,title,message}), refreshOpen(bot) }
 */
export function createActivityTracker(deps) {
  const watermarks = new Map()
  const lastToasted = new Map()
  let seeded = false

  function track(roster) {
    const seeding = !seeded
    seeded = true
    for (const bot of Array.isArray(roster) ? roster : []) {
      const key = rowKey(bot)
      const activity = botActivitySession(bot)
      const ts = Number(activity?.last_active || 0)
      const prev = watermarks.get(key) || 0
      watermarks.set(key, Math.max(prev, ts))
      if (seeding || ts <= prev) {
        lastToasted.set(key, String(activity?.preview || '').trim())
        continue
      }
      if (deps.selectedKey() === key) {
        deps.refreshOpen?.(bot)
        continue
      }
      // The newest message is the bot's silence sentinel: it chose not to
      // reply, so nothing is unread and nothing toasts.
      if (isSilenceReply(String(activity?.preview || ''))) continue
      const canonical = botCanonicalSessionId(bot)
      if (canonical) deps.markUnread?.(canonical, bot.name)
      if (deps.isHidden?.(bot)) continue
      const preview = String(activity?.preview || '').trim()
      if (lastToasted.get(key) === preview) continue
      lastToasted.set(key, preview)
      if (deps.toastsEnabled?.()) {
        const label = deps.label ? deps.label(bot) : String(bot.name)
        const inbound = /^Message from/i.test(preview)
        deps.notify?.({
          kind: 'info',
          title: inbound ? `🤖 New message for ${label}` : `${label} has new activity`,
          message: preview.slice(0, 140) || 'Open the chat to see it.'
        })
      }
    }
  }

  /** Forget the watermarks: the next refresh seeds again (used after stock
   *  Bot Mode was on screen, whose own tracker covered that time). */
  function reseed() {
    seeded = false
    watermarks.clear()
    lastToasted.clear()
  }

  return { track, reseed }
}
