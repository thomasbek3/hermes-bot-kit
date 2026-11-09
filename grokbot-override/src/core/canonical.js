// The canonical Bot Chat lookup: one bot, one forever-chat, identified by
// NAME — the profile's session titled exactly "Bot Chat".
//
// Port of the LOOKUP half of apps/desktop/src/plugins/hermes-bots/
// canonical-chat.ts (Hermes Agent, MIT, (c) Nous Research). The override
// opens the row Bot Mode would open; creating one is core/create-chat.js, a
// port of stock's createCanonicalChat (PARITY.md C3).

import { backendTargetProfile, botConnectionRoute } from './routing.js'

export const CANONICAL_CHAT_TITLE = 'Bot Chat'
export const PROFILE_SESSION_LIST_LIMIT = 200

/** A session summary IS the registry row: lineage-root title when the gateway
 *  reports it, plain title for windowed listings. */
export function isCanonicalBotChatRow(row) {
  const rootTitle = String(row?.root_title || '').trim()
  const title = String(row?.title || '').trim()
  return rootTitle === CANONICAL_CHAT_TITLE || (!rootTitle && title === CANONICAL_CHAT_TITLE)
}

/** Ids a chat is known by: the durable registry row and its lineage tip. */
export function canonicalIds(row) {
  return [...new Set([row?.id, row?.resolved_id].filter(Boolean).map(String))]
}

/** The id to open: the compression-lineage tip, else the registry row. */
export function openedSessionId(row) {
  return String(row?.resolved_id || row?.id || '')
}

/** Resolve a bot's Bot Chat. Returns the registry row or null ("this bot has
 *  never had a Bot Chat"). Throws — never returns null — when the registry
 *  could not be consulted, or answered empty although the roster had already
 *  confirmed a Bot Chat for this profile (a backend mid-restart): both are
 *  "try again", never "no chat". Same rules as findExistingCanonicalChat. */
export async function findCanonicalChat(requestForBot, bot, { preferRoster = false } = {}) {
  const name = String(bot?.name || '').trim() || 'default'
  const known = bot?.canonical_session

  if (preferRoster && known?.id) return { ...known, source: 'roster' }

  const route = botConnectionRoute(bot)
  let res
  try {
    res = await requestForBot(
      bot,
      'session.list',
      {
        profile: backendTargetProfile(route, name),
        title: CANONICAL_CHAT_TITLE,
        limit: PROFILE_SESSION_LIST_LIMIT,
        include_hidden: true
      },
      { spawnPriority: 'foreground' }
    )
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : ''
    throw new Error(`Could not check ${name}'s Bot Chat registry${message ? ` (${message})` : ''}`)
  }

  const rows = Array.isArray(res?.sessions) ? res.sessions : []
  const match = rows.find(isCanonicalBotChatRow)
  if (match) return { ...match, source: 'registry' }

  if (known?.id) throw new Error(`Could not confirm ${name}'s Bot Chat registry`)
  return null
}

/** Paintable rows decide whether an empty transcript is suspicious (same rule
 *  as resolveExpectHistory). */
export function expectHistory(summary) {
  if (Number.isFinite(summary?.live_message_count)) return summary.live_message_count > 0
  if (Number.isFinite(summary?.message_count)) return summary.message_count > 0
  return true
}
