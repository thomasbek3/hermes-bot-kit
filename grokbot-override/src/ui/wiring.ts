// Cross-branch wiring: the roster-side parity surfaces (R12, R13, R15, R6)
// call into the chat-side parity code (C3, C26, R14) through the seams the
// roster side left open. Kept in one place so neither side imports the other's
// internals directly.
//
//  - R13 kickoff  → setBotChatCreator: the new bot's Bot Chat is born through
//    the open chat controller's C3 create (stock createCanonicalChat with
//    `kickoff`, create-dialog.tsx:715), so the lease, adopt-on-conflict and
//    in-flight dedupe are the same as a roster click.
//  - R12 "Open in new tab" → setNewTabOpener: C26's side-by-side override tab.
//  - "New group chat…" in the roster's + menu → setNewGroupOpener: R14's New
//    group form, offered only while the active source lists gateway rooms.
//  - R14 group-turn failures → noteAttention (R15 badge), cleared by the
//    member's next reply (stock group-round-members.ts:255 / :271).

import { attentionFromRoomEvent, clearAttention, noteAttention } from '../core/attention.js'
import { rowKey } from '../core/roster.js'
import { app, currentController, onRoomState, openBotInNewTab, selectBot } from './app'
import { botFor, openNewGroupForm } from './Rooms'
import { setNewGroupOpener } from './RosterMenus'
import { setBotChatCreator, setNewTabOpener } from './rosterActions'
import { roster2 } from './rosterStores'

/** R13 → C3: open the new bot in the main chat and create its Bot Chat with
 *  the intro turn. Throws when the chat could not be started, so the create
 *  dialog reports it (the bot itself exists either way). */
export async function createBotChat(bot: any, { kickoff }: { kickoff: boolean }) {
  // selectBot is idempotent for the bot already shown (createBot selects it
  // first); the explicit create below supersedes the click path's own
  // resolve-then-create, so only one createCanonicalChat runs, with kickoff.
  selectBot(bot)
  const controller = currentController()
  if (!controller || typeof controller.create !== 'function') throw new Error('The Bot Chat could not be opened')
  const state = await controller.create({ kickoff })
  if (state?.phase === 'error') throw new Error(String(state.error || 'The Bot Chat could not be started'))
  return state
}

/** Last room-log seq applied to the badge, per room tab. */
const roomSeen = new Map<string, number>()

export function applyRoomAttention(id: string, route: any, state: any) {
  const events: any[] = Array.isArray(state?.events) ? state.events : []
  if (!events.length) return
  const members = state?.room?.members
  let seen = roomSeen.get(id) ?? -Infinity
  let map = roster2.attention.get()
  for (const event of events) {
    const seq = Number(event?.seq)
    if (!Number.isFinite(seq) || seq <= seen) continue
    seen = seq
    const verdict = attentionFromRoomEvent(event, members)
    if (!verdict?.profile) continue
    const bot = botFor(verdict.profile, route)
    const key = bot ? rowKey(bot) : ''
    if (!key) continue
    map = verdict.kind === 'fail' ? noteAttention(map, key, verdict.text) : clearAttention(map, key)
  }
  roomSeen.set(id, seen)
  if (map !== roster2.attention.get()) roster2.attention.set(map)
}

let offs: Array<() => void> = []

export function wireParity() {
  unwireParity()
  setBotChatCreator(createBotChat)
  setNewTabOpener(bot => openBotInNewTab(bot))
  const syncGroupOpener = () => {
    const rooms = app.rooms.get()
    setNewGroupOpener(rooms.loaded && rooms.route ? openNewGroup : null)
  }
  syncGroupOpener()
  offs.push(app.rooms.subscribe(syncGroupOpener))
  offs.push(onRoomState(applyRoomAttention))
  return unwireParity
}

function openNewGroup() {
  // A "Bots only" filter would hide the Group chats section the form lives in.
  if (roster2.filters.get().kind === 'bots') roster2.filters.set({ ...roster2.filters.get(), kind: 'all' })
  openNewGroupForm()
}

export function unwireParity() {
  for (const off of offs) {
    try {
      off()
    } catch {
      /* already off */
    }
  }
  offs = []
  roomSeen.clear()
  setBotChatCreator(null)
  setNewTabOpener(null)
  setNewGroupOpener(null)
}
