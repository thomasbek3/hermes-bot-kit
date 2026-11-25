// The row's unread dot (Spec 106), Grok Bot's look: a small blue dot at
// the right edge of an unread row (and on the avatar of a pinned tile).
//
// Driven exclusively by the plugin's own unread store (core/unreadStore.js,
// roster2.unread) for EVERY bot row, local and remote. Hermes's native unread
// dot is hidden/ignored in bot rows so bare-id native markers can never stick
// or collide across machines, and the "More unreads" pill (UnreadPill.tsx)
// counts only plugin dots.
//
// Hermes's running cue (SessionStatusDot in its working / stalled / background
// states) stays on the avatar via RunningDot, independent of the unread dot.

import * as React from 'react'

import { botCanonicalSessionId } from '../core/activity.js'
import { app, botIsUnread } from './app'
import { roster2 } from './rosterStores'
import { sdk } from './sdk'
import { useStore } from './store'

/** Plugin's own unread dot inner element. */
export const UNREAD_STATE_SELECTOR = '[role="status"][data-gbo-unread="true"]'
/** An unread dot the override draws (rows and pinned tiles). */
export const UNREAD_DOT_SELECTOR = `.gbo-unread-dot ${UNREAD_STATE_SELECTOR}`

/** Hermes's status dot for the bot's Bot Chat (used ONLY for the running cue). */
function StatusDot({ bot, className }: { bot: any; className: string }) {
  const Dot = (sdk as any).SessionStatusDot
  const id = botCanonicalSessionId(bot)
  if (!id || !(typeof Dot === 'function' || (Dot && typeof Dot === 'object'))) return null
  return <span className={className}>{React.createElement(Dot, { storedSessionId: id })}</span>
}

/** The plugin's own unread dot: blue, at the row's right edge (or on a pinned
 *  avatar). Renders only when the plugin's own store marks this bot unread. */
export function UnreadDot({ bot }: { bot: any }) {
  const unread = useStore(roster2.unread)
  const roster = useStore(app.roster)
  if (!botIsUnread(bot, unread, roster.sources)) return null
  return (
    <span className="gbo-unread-dot">
      <span role="status" data-gbo-unread="true" className="gbo-unread-dot-inner" aria-label="Unread" />
    </span>
  )
}

/** Hermes's running cue on the avatar: drawn by the CSS only in the working,
 *  stalled and background states. */
export function RunningDot({ bot }: { bot: any }) {
  return <StatusDot bot={bot} className="gbo-run-dot" />
}
