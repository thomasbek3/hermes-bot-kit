// The row's unread dot (PARITY R16), Grok Bot's look: a small blue dot at
// the right edge of an unread row. The state is Hermes's own: the row draws
// Hermes's SessionStatusDot, keyed by the bot's Bot Chat id exactly as Bot
// Mode's row draws it (hermes-bots/bot-row.tsx:270-273), and the CSS shows
// only its "finished, unread" state (painted blue) and its "needs input"
// state. So the override and stock show the same state from core's unread
// store, and there is no second record of read / unread. Missing on an older
// desktop: nothing drawn.
//
// Hermes's running cue (the same dot in its working / stalled / background
// states) is its own element, RunningDot, on the avatar: independent of the
// unread dot, which never draws those states.

import * as React from 'react'

import { botCanonicalSessionId } from '../core/activity.js'
import { sdk } from './sdk'

/** Hermes's dot in its unread state (session-status-dot.tsx: the `unread`
 *  variant, `bg-(--ui-success)` with role="status"). */
export const UNREAD_STATE_SELECTOR = '[role="status"][class*="ui-success"]'
/** An unread dot the override draws (rows and pinned tiles). */
export const UNREAD_DOT_SELECTOR = `.gbo-unread-dot ${UNREAD_STATE_SELECTOR}`

/** Hermes's status dot for the bot's Bot Chat, in a wrapper `className`. */
function StatusDot({ bot, className }: { bot: any; className: string }) {
  const Dot = (sdk as any).SessionStatusDot
  const id = botCanonicalSessionId(bot)
  if (!id || !(typeof Dot === 'function' || (Dot && typeof Dot === 'object'))) return null
  return <span className={className}>{React.createElement(Dot, { storedSessionId: id })}</span>
}

/** The unread dot: drawn by the CSS only in the unread and needs-input states. */
export function UnreadDot({ bot }: { bot: any }) {
  return <StatusDot bot={bot} className="gbo-unread-dot" />
}

/** Hermes's running cue on the avatar: drawn by the CSS only in the working,
 *  stalled and background states. */
export function RunningDot({ bot }: { bot: any }) {
  return <StatusDot bot={bot} className="gbo-run-dot" />
}
