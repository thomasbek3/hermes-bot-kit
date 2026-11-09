// The row's unread / working dot (PARITY R16): Hermes's own SessionStatusDot,
// keyed by the bot's Bot Chat id exactly as Bot Mode's row draws it
// (hermes-bots/bot-row.tsx:270-273), so the override and stock show the same
// state from core's unread store. Missing on an older desktop: nothing drawn.

import * as React from 'react'

import { botCanonicalSessionId } from '../core/activity.js'
import { sdk } from './sdk'

export function UnreadDot({ bot }: { bot: any }) {
  const Dot = (sdk as any).SessionStatusDot
  const id = botCanonicalSessionId(bot)
  if (!id || !(typeof Dot === 'function' || (Dot && typeof Dot === 'object'))) return null
  return (
    <span className="gbo-row-dot">
      {React.createElement(Dot, { storedSessionId: id })}
    </span>
  )
}
