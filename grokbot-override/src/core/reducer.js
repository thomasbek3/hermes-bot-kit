// Live gateway events -> chat items. Pure: (state, event, now) -> state.
//
// Event shapes follow tui_gateway/contracts/events.py and the fixtures the
// desktop's own stream tests send (see test/fixtures/stream-events.json).
//
// State: { items, busy, status, live }
//   live = { turnId, cursor, bubbleId, toolsId, reasoning, streamed, sealed }
//   bubbleId: the assistant bubble deltas currently extend (null = next delta
//   opens a new one). toolsId: the tool group of the current run of tools.
//   sealed: this turn's reply text already shown in closed bubbles (earlier
//   segments). The gateway's resume snapshot carries the whole turn's text
//   (`inflight.assistant`, tui_gateway/session_history.py
//   _append_inflight_delta), so a snapshot repair subtracts it (review r3 #4).

import { admitSegmentDelta, admitSegmentSeal, segmentStamp } from './segments.js'
import { BACKGROUND_NOTICE_KINDS, backgroundNotice, toolLabel } from './history.js'
import { approvalFromPayload, upsertApproval, cancelApprovals, settleApprovals } from './approvals.js'
import { applyConnectionUpdate, inputRequestFrom, keepCardProgress } from './prompts.js'
import { completeDetail, startDetail } from './tools.js'
import { isSilenceReply } from './silence.js'

export function emptyLive() {
  return { turnId: '', cursor: undefined, bubbleId: null, toolsId: null, reasoning: '', streamed: false, sealed: '' }
}

const sealText = (live, text) => ({ ...live, sealed: `${live.sealed || ''}${text || ''}` })

/** The part of a whole-turn snapshot text that no closed bubble of this turn
 *  shows yet, or null when the snapshot does not start with what is shown
 *  (then nothing is guessed: the turn's completion settles the text).
 *  Whitespace is ignored when matching: a sealed segment may be trimmed. */
export function unshownTurnText(full, shown) {
  const text = String(full || '')
  const seen = String(shown || '')
  if (!seen.trim()) return text
  let i = 0
  for (let j = 0; j < seen.length; j += 1) {
    if (/\s/.test(seen[j])) continue
    while (i < text.length && /\s/.test(text[i])) i += 1
    if (i >= text.length || text[i] !== seen[j]) return null
    i += 1
  }
  return text.slice(i).replace(/^\s+/, '')
}

export function initialChatState(items = []) {
  return { items, busy: false, status: null, live: emptyLive(), waiting: null }
}

// Blocking prompts (clarify, sudo, secret, vault, connection): core/prompts.js.
export { inputRequestFrom }

let counter = 0
const liveId = prefix => `live:${prefix}:${Date.now().toString(36)}:${(counter += 1)}`

function replaceItem(items, id, patch) {
  return items.map(item => (item.id === id ? { ...item, ...(typeof patch === 'function' ? patch(item) : patch) } : item))
}

function findItem(items, id) {
  return id ? items.find(item => item.id === id) : undefined
}

function closeBubble(state) {
  if (!state.live.bubbleId) return state
  const bubble = findItem(state.items, state.live.bubbleId)
  return {
    ...state,
    items: replaceItem(state.items, state.live.bubbleId, { streaming: false }),
    live: { ...sealText(state.live, bubble?.text), bubbleId: null }
  }
}

function appendToBubble(state, text, at) {
  const bubble = findItem(state.items, state.live.bubbleId)
  if (bubble) {
    return {
      ...state,
      items: replaceItem(state.items, bubble.id, item => ({ text: item.text + text, streaming: true })),
      live: { ...state.live, streamed: true, toolsId: null }
    }
  }
  const id = liveId('a')
  const reasoning = state.live.reasoning
  return {
    ...state,
    items: [...state.items, { kind: 'assistant', id, text, at, streaming: true, ...(reasoning ? { reasoning } : {}) }],
    live: { ...state.live, bubbleId: id, streamed: true, toolsId: null, reasoning: '' }
  }
}

function appendReasoning(state, text) {
  const bubble = findItem(state.items, state.live.bubbleId)
  if (bubble) {
    return { ...state, items: replaceItem(state.items, bubble.id, item => ({ reasoning: (item.reasoning || '') + text })) }
  }
  return { ...state, live: { ...state.live, reasoning: state.live.reasoning + text } }
}

function lastAssistantText(state) {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i]
    if (item.kind === 'user') return null
    if (item.kind === 'assistant') return item
  }
  return null
}

/** The streamed bubble, when all it says is the silence sentinel, goes (its
 *  reasoning, if any, stays as a reply with no text). */
function dropSilentBubble(state) {
  const bubble = findItem(state.items, state.live.bubbleId)
  if (!bubble || !isSilenceReply(bubble.text)) return state
  const items = bubble.reasoning
    ? replaceItem(state.items, bubble.id, { text: '', streaming: false })
    : state.items.filter(item => item.id !== bubble.id)
  return { ...state, items, live: { ...state.live, bubbleId: null } }
}

export function finishTurn(state) {
  const closed = closeBubble(state)
  const items = closed.items.map(item =>
    item.kind === 'tools' && item.tools.some(tool => tool.status === 'running')
      ? { ...item, tools: item.tools.map(tool => (tool.status === 'running' ? { ...tool, status: 'done' } : tool)) }
      : item
  )
  return { ...closed, items, busy: false, status: null, live: emptyLive(), waiting: null }
}

export function applyEvent(state, event, now = Date.now()) {
  const type = event?.type
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}

  switch (type) {
    case 'message.start': {
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : ''
      // A re-sent start of the turn already on screen changes nothing.
      if (turnId && turnId === state.live.turnId) return { ...state, busy: true }
      let next = closeBubble(state)
      next = { ...next, busy: true, status: null, live: { ...emptyLive(), turnId } }
      const card = typeof payload.display_text === 'string' && payload.display_text.trim()
      if (card) {
        // A producer card (background process / agent work finished) is a
        // work row with a short label (history.js BACKGROUND_NOTICE_KINDS).
        const kind = typeof payload.display_kind === 'string' ? payload.display_kind : ''
        const notice = BACKGROUND_NOTICE_KINDS.has(kind)
          ? backgroundNotice(kind, card, { id: liveId('n'), at: now })
          : { kind: 'notice', id: liveId('n'), text: card.trim(), at: now }
        next = { ...next, items: [...next.items, notice] }
      }
      return next
    }

    case 'message.delta': {
      if (payload.text === null) return closeBubble(state)
      let text = typeof payload.text === 'string' ? payload.text : ''
      const stamp = segmentStamp(payload)
      let live = state.live
      if (stamp) {
        const admitted = admitSegmentDelta(live.cursor, stamp, text)
        live = { ...live, cursor: admitted.cursor }
        text = admitted.text
      }
      const status = state.status?.kind === 'tool' ? null : state.status
      if (!text) return { ...state, busy: true, status, live }
      return appendToBubble({ ...state, busy: true, status, live }, text, now)
    }

    case 'reasoning.delta':
    case 'thinking.delta': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      return text ? appendReasoning({ ...state, busy: true }, text) : state
    }

    case 'reasoning.available': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!text) return state
      const bubble = findItem(state.items, state.live.bubbleId)
      if (bubble) return { ...state, items: replaceItem(state.items, bubble.id, { reasoning: text }) }
      return { ...state, live: { ...state.live, reasoning: text } }
    }

    case 'message.interim': {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      const stamp = segmentStamp(payload)
      let live = state.live
      if (stamp) {
        const admitted = admitSegmentSeal(live.cursor, stamp)
        live = { ...live, cursor: admitted.cursor }
        if (!admitted.fresh) return { ...state, live }
      }
      if (!text) return closeBubble({ ...state, live })
      const bubble = findItem(state.items, live.bubbleId)
      if (bubble) {
        return {
          ...state,
          items: replaceItem(state.items, bubble.id, { text, streaming: false }),
          live: { ...sealText(live, text), bubbleId: null }
        }
      }
      const reasoning = live.reasoning
      return {
        ...state,
        items: [...state.items, { kind: 'assistant', id: liveId('a'), text, at: now, ...(reasoning ? { reasoning } : {}) }],
        live: { ...sealText(live, text), bubbleId: null, reasoning: '', toolsId: null, streamed: true }
      }
    }

    case 'tool.generating': {
      const name = String(payload.name || 'tool').replace(/_/g, ' ')
      return { ...state, busy: true, status: { kind: 'tool', text: `Preparing ${name}` } }
    }

    case 'tool.start': {
      const id = String(payload.tool_id || liveId('t'))
      const label = toolLabel({ name: payload.name, labels: payload.labels, context: payload.context, preview: payload.preview })
      const tool = { id, name: String(payload.name || 'tool'), label, status: 'running', startedAt: now, ...startDetail(payload) }
      let next = closeBubble({ ...state, busy: true, status: null })
      // A re-delivered start of a tool already listed only refreshes it.
      const owner = next.items.find(item => item.kind === 'tools' && item.tools.some(t => t.id === id))
      if (owner) {
        return { ...next, items: replaceItem(next.items, owner.id, item => ({ tools: item.tools.map(t => (t.id === id ? { ...t, label } : t)) })) }
      }
      const group = findItem(next.items, next.live.toolsId)
      if (group && next.items[next.items.length - 1]?.id === group.id) {
        return { ...next, items: replaceItem(next.items, group.id, item => ({ tools: [...item.tools, tool] })) }
      }
      const groupId = liveId('g')
      return {
        ...next,
        items: [...next.items, { kind: 'tools', id: groupId, at: now, tools: [tool] }],
        live: { ...next.live, toolsId: groupId }
      }
    }

    case 'tool.complete': {
      const id = String(payload.tool_id || '')
      const owner = state.items.find(item => item.kind === 'tools' && item.tools.some(t => t.id === id))
      if (!owner) return state
      const failed = Boolean(payload.error) || /^error\b/i.test(String(payload.summary || ''))
      return {
        ...state,
        items: replaceItem(state.items, owner.id, item => ({
          tools: item.tools.map(t =>
            t.id === id
              ? {
                  ...t,
                  status: failed ? 'error' : 'done',
                  ...(typeof payload.summary === 'string' && payload.summary ? { summary: payload.summary } : {}),
                  ...(Number.isFinite(payload.duration_s) ? { duration: payload.duration_s } : {}),
                  ...(Array.isArray(payload.labels) && payload.labels.length ? { label: toolLabel({ name: t.name, labels: payload.labels }) } : {}),
                  ...completeDetail(payload)
                }
              : t
          )
        }))
      }
    }

    case 'status.update': {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text) return state
      return { ...state, status: { kind: String(payload.kind || 'status'), text } }
    }

    case 'message.complete': {
      const raw = typeof payload.text === 'string' ? payload.text.trim() : ''
      // The silence sentinel is "no reply": no bubble, not even an empty one.
      const final = isSilenceReply(raw) ? '' : raw
      const failed = payload.status === 'error' || Boolean(payload.error)
      let next = dropSilentBubble(state)
      const bubble = findItem(next.items, next.live.bubbleId)
      if (final && !payload.response_reused) {
        if (bubble) {
          next = { ...next, items: replaceItem(next.items, bubble.id, { text: final }) }
        } else {
          const last = lastAssistantText(next)
          if (!last || last.text.trim() !== final) {
            const reasoning = next.live.reasoning || (typeof payload.reasoning === 'string' ? payload.reasoning : '')
            next = {
              ...next,
              items: [...next.items, { kind: 'assistant', id: liveId('a'), text: final, at: now, ...(reasoning ? { reasoning } : {}) }]
            }
          }
        }
      }
      if (failed) {
        const message = String(payload.error || payload.failure_reason || 'The reply failed.')
        next = { ...next, items: [...next.items, { kind: 'error', id: liveId('e'), text: message, at: now }] }
      }
      return finishTurn(next)
    }

    case 'error': {
      const message = String(payload.message || payload.error || '').trim()
      if (!message) return state
      return finishTurn({ ...state, items: [...state.items, { kind: 'error', id: liveId('e'), text: message, at: now }] })
    }

    case 'approval.request': {
      const approval = approvalFromPayload(payload)
      return approval ? { ...state, items: upsertApproval(state.items, approval, now) } : state
    }

    case 'approval.settled': {
      const id = String(payload.prompt_id || payload.request_id || '')
      return id ? { ...state, items: settleApprovals(state.items, [id]) } : state
    }

    case 'clarify.request': {
      const waiting = keepCardProgress(state.waiting, inputRequestFrom('clarify', payload))
      return waiting ? { ...state, busy: true, waiting } : state
    }

    case 'clarify.settled': {
      const id = String(payload.prompt_id || payload.request_id || '')
      return state.waiting && (!id || state.waiting.id === id) ? { ...state, waiting: null } : state
    }

    // The backend withdrew an open request (timeout, interrupt, close):
    // request-correlated, so an older cancel never clears a newer card
    // (gateway-event/input-requests.ts:126-160).
    case 'request.cancel': {
      const id = String(payload.id || '')
      return id && state.waiting && state.waiting.kind !== 'connection' && state.waiting.id === id ? { ...state, waiting: null } : state
    }

    // A connection operation opened on this session (gateway-event/
    // input-requests.ts:105-134) and its transitions / settlement.
    case 'connection.request': {
      const waiting = inputRequestFrom('connection', payload)
      return waiting ? { ...state, waiting } : state
    }

    case 'connection.update': {
      if (payload?.owner?.type && payload.owner.type !== 'session') return state
      const next = applyConnectionUpdate(state.waiting, payload)
      return next === state.waiting ? state : { ...state, waiting: next }
    }

    // The agent reacted to a message (contracts/events.py MessageReactionPayload).
    case 'message.reaction': {
      const rowId = Number(payload.row_id)
      if (!Number.isSafeInteger(rowId) || !Array.isArray(payload.reactions)) return state
      let hit = false
      const items = state.items.map(item => {
        if (item.rowId !== rowId) return item
        hit = true
        return { ...item, reactions: payload.reactions }
      })
      return hit ? { ...state, items } : state
    }

    case 'approval.cancelled': {
      const ids = Array.isArray(payload.request_ids) ? payload.request_ids.map(String) : []
      return { ...state, items: cancelApprovals(state.items, ids, String(payload.reason || 'cancelled')) }
    }

    default:
      return state
  }
}
