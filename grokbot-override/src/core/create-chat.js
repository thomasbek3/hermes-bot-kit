// Create a bot's ONE forever chat (PARITY C3).
//
// Port of apps/desktop/src/plugins/hermes-bots/canonical-chat.ts
// `createCanonicalChat` (Hermes Agent, MIT, (c) Nous Research, commit
// 2bd378ed1b, lines 413-605), the same gateway calls in the same order, so the
// override and stock Bot Mode can never mint two Bot Chats for one bot:
//
//  1. Registry lookup first (findCanonicalChat, fail-closed): an existing
//     "Bot Chat" row is adopted, never re-created (:459-469).
//  2. `session.create { profile, title: 'Bot Chat', hidden: true,
//     follow_profile_config: true, source: 'desktop' }` on the bot's own route,
//     foreground (:473-493). An `invalid_params` refusal naming keys is resent
//     once without them.
//  3. Eager `session.title { session_id: <runtime>, title: 'Bot Chat' }` so the
//     lazy row exists and holds the canonical title at once (:508-516). A
//     title-uniqueness refusal ("already in use") means another writer took the
//     title meanwhile: re-consult the registry and ADOPT the winner (:518-540);
//     the stray lazy session holds nothing and is pruned by the gateway.
//  4. Kickoff (`prompt.submit` of the bot's intro, after 400 ms) only for a
//     genuinely new agent (`kickoff`), or as the compat persistence write when
//     the eager title failed on an older gateway (:559-582). Never on the
//     ordinary click path: a resolution miss must not re-fire the intro.
//     Deviation (review override-v2-r3 H1 principle): stock kicks off after
//     ANY title failure. Here only a documented refusal (outcomes.js
//     titleFailure: nothing was titled) authorizes that extra write; a title
//     whose outcome is unknown (timeout, storage error, unknown code) may
//     already hold, so no intro is sent into it. The user's first message
//     persists the row either way.
//
// One creation per bot at a time (stock's `canonicalCreations` map, :38-40):
// a double click joins the flight in progress. Stock keeps its own map in its
// own module; across the two surfaces the canonical title's UNIQUE index plus
// adopt-on-conflict is what keeps it to one chat, exactly as between two
// machines.

import { CANONICAL_CHAT_TITLE, findCanonicalChat } from './canonical.js'
import { titleFailure, withoutRefusedParams } from './outcomes.js'
import { backendTargetProfile, botConnectionRoute, botRouteKey } from './routing.js'

export const KICKOFF_TEXT = 'Hey, tell me about yourself!'
// Stock Desktop's create source (use-session-actions/session-create-request.ts):
// the bot is told it is on the desktop chat surface, not the terminal UI.
export const CREATE_SOURCE = 'desktop'
const KICKOFF_DELAY_MS = 400

const creations = new Map()

function creationKey(bot) {
  const route = botConnectionRoute(bot)
  return route ? botRouteKey(route) : `active::${String(bot?.name || 'default')}`
}

/**
 * Resolves { row, runtimeId, created, adopted }:
 *   row       the registry row to open ({ id, resolved_id?, title })
 *   runtimeId the live runtime session.create minted ('' when adopted)
 *   created   a new chat was minted
 *   adopted   an existing "Bot Chat" (found first, or won a race) is used
 * Throws when the registry cannot be consulted (never mints then).
 */
export function createCanonicalChat(requestForBot, bot, { kickoff = false, kickoffText = KICKOFF_TEXT, wait } = {}) {
  const key = creationKey(bot)
  const inflight = creations.get(key)
  if (inflight) return inflight
  const pause = wait || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const name = String(bot?.name || '').trim() || 'default'

  const run = (async () => {
    const existing = await findCanonicalChat(requestForBot, bot)
    if (existing?.id) return { row: existing, runtimeId: '', created: false, adopted: true }

    const route = botConnectionRoute(bot)
    const params = {
      profile: backendTargetProfile(route, name),
      title: CANONICAL_CHAT_TITLE,
      hidden: true,
      follow_profile_config: true,
      source: CREATE_SOURCE
    }
    const create = body => requestForBot(bot, 'session.create', body, { spawnPriority: 'foreground' })
    let res
    try {
      res = await create(params)
    } catch (error) {
      // A gateway whose create contract refuses a key we sent (the session
      // authority's closed set takes no 'desktop' source): its dispatcher
      // refused before the handler ran, nothing was minted, so resend once
      // without the named keys (never the profile).
      const corrected = withoutRefusedParams(error, params, ['profile'])
      if (!corrected) throw error
      res = await create(corrected)
    }
    const sid = String(res?.stored_session_id || '')
    const runtime = String(res?.session_id || '')

    let titled = false
    let titleRefused = false
    if (runtime) {
      try {
        await requestForBot(bot, 'session.title', { session_id: runtime, title: CANONICAL_CHAT_TITLE })
        titled = true
      } catch (error) {
        const verdict = titleFailure(error)
        if (verdict === 'conflict') {
          const winner = await findCanonicalChat(requestForBot, bot)
          if (winner?.id) return { row: winner, runtimeId: '', created: false, adopted: true }
        }
        /* compatibility fallback: the kickoff below persists the lazy row,
           only when the title was definitely not written */
        titleRefused = verdict === 'refused'
      }
    }

    if (runtime && (kickoff || (!titled && titleRefused))) {
      await pause(KICKOFF_DELAY_MS)
      try {
        await requestForBot(bot, 'prompt.submit', { session_id: runtime, text: kickoffText })
      } catch {
        /* the chat exists under the canonical title; the next open finds it by name */
      }
    }

    if (!sid) return { row: null, runtimeId: runtime, created: false, adopted: false }
    return { row: { id: sid, title: CANONICAL_CHAT_TITLE, message_count: kickoff || !titled ? 1 : 0 }, runtimeId: runtime, created: true, adopted: false }
  })().finally(() => {
    if (creations.get(key) === run) creations.delete(key)
  })
  creations.set(key, run)
  return run
}
