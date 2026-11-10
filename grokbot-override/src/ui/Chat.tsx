// The chat tab: floating header (bot pill, Share), transcript (time dividers,
// grouped bubbles with hover times, tool activity, thinking, approval cards),
// composer, and the profile panel. Markup uses the reference layout's class
// names (chat__header, transcript, group, bubble, card, activity-line,
// details; see styles-ref.ts); the gbo-* classes are hooks.

import * as React from 'react'

import { CHOICE_LABELS } from '../core/approvals.js'
import { botTintVars } from '../core/colors.js'
import { draftOwnerKey } from '../core/drafts.js'
import { drawerKeyDown, trapFocus } from '../core/focus.js'
import { displayName, rowKey } from '../core/roster.js'
import { cornerClass, groupMessages } from '../core/groups.js'
import { clock, withDividers } from '../core/time.js'
import { withNewMarker } from '../core/newMarker.js'
import { activityLabel, visibleItems } from '../core/workRows.js'
import { app, canToggleSidebar, type ChatSlot, findBot, freshBot, mainSlot, metaFor, noteTranscript, openBotInNewTab, openInBotMode, resetPanelWidth, selectBot, setPanelOpen, startPanelResize, stockHandoffProblem, toggleSidebar } from './app'
import { roster2 } from './rosterStores'
import { BotAvatar, botColor } from './Avatar'
import { Composer } from './Composer'
import { IconChevron, IconOpen, IconPanel, IconSidebar, IconX } from './icons'
import { MenuButton } from './kit'
import { DirectiveBlock, DirectiveContext, type DirectiveScope, useDirectiveSegments } from './Directives'
import { BotText } from './Media'
import { AssistantActions, Reactions, UserActions } from './MessageActions'
import { ProfilePanel } from './Profile'
import { OverlayScroll } from './OverlayScroll'
import { SettledChoiceCard, WaitingCard } from './Prompts'
import { ToolGroup } from './Tools'
import { useStore } from './store'

function Thinking({ text }: { text: string }) {
  return (
    <details className="gbo-think">
      <summary>
        <IconChevron />
        Thought
      </summary>
      <div className="gbo-think-body">{text}</div>
    </details>
  )
}

function ApprovalCard({ item, onAnswer }: { item: any; onAnswer: (requestId: string, choice: string) => void }) {
  const pending = item.status === 'pending'
  const answering = item.status === 'answering'
  const stateText =
    item.status === 'answered'
      ? `${CHOICE_LABELS[item.answer as keyof typeof CHOICE_LABELS] || item.answer}`
      : item.status === 'resolved'
        ? 'Answered in another window'
        : item.status === 'expired'
          ? 'No longer waiting, nothing was approved'
          : item.status === 'cancelled'
          ? 'No longer waiting'
          : answering
            ? 'Sending…'
            : ''
  const ok = item.status === 'answered' && item.answer !== 'deny'
  return (
    <div className={`card${pending ? '' : ' is-resolved'}`} role="group" aria-label="Approval needed">
      <div className="card__head">
        <div className="card__titles">
          <div className="card__title">May I run this?</div>
          {item.description ? <div className="card__sub">{item.description}</div> : null}
        </div>
      </div>
      {item.command ? (
        <div className="card__body">
          <code>{item.command}</code>
        </div>
      ) : null}
      {pending ? (
        <div className="card__actions">
          {item.choices.map((choice: string) => (
            <button
              key={choice}
              type="button"
              className={`btn btn--sm ${choice === 'once' ? 'btn--primary' : 'btn--secondary'}`}
              disabled={!item.requestId}
              onClick={() => onAnswer(item.requestId, choice)}
            >
              {CHOICE_LABELS[choice as keyof typeof CHOICE_LABELS] || choice}
            </button>
          ))}
        </div>
      ) : (
        <div className={`card__outcome${ok ? ' is-ok' : ''}`}>
          {ok ? '✓ ' : ''}
          {stateText}
        </div>
      )}
      {item.error ? <div className="card__error gbo-card-error">{item.error}</div> : null}
    </div>
  )
}

/** Status line under a user bubble: sending, receipt, or a failed send with
 *  its way forward. A definite refusal offers Retry; a "delivery unknown"
 *  send never does (it may already be stored or queued): only a read-only
 *  check and Hermes Bot Mode (review r2 #7, r3 #1-#2). */
export function UserMeta({
  item,
  onRetry,
  onRecheck,
  onOpen
}: {
  item: any
  onRetry: (clientId: string) => void
  onRecheck: (clientId: string) => void
  onOpen: () => void
}) {
  if (item.failed) {
    if (item.delivery !== 'not-sent') {
      const status = !item.checked
        ? 'Delivery unknown: checking the chat history…'
        : item.checkFailed
          ? 'Delivery unknown: the chat history could not be read.'
          : 'Delivery unknown: not in the chat history yet. It may still be queued.'
      if (item.idempotent) {
        // It carried its submission id: a retry re-sends the same message
        // under the same id, and Hermes answers with the original instead of
        // running it twice (stock's explicit retry, PARITY C6).
        return (
          <div className="gbo-msg-meta gbo-msg-failed">
            <span>{status} Retrying is safe: Hermes recognises this message and never runs it twice.</span>
            <button type="button" className="gbo-pill-btn" onClick={() => onRetry(item.id)}>
              Retry
            </button>
            {item.checked ? (
              <button type="button" className="gbo-pill-btn" onClick={() => onRecheck(item.id)}>
                Check again
              </button>
            ) : null}
          </div>
        )
      }
      return (
        <div className="gbo-msg-meta gbo-msg-failed">
          <span>
            {status} It is not sent again from here, so it cannot run twice.
          </span>
          {item.checked ? (
            <button type="button" className="gbo-pill-btn" onClick={() => onRecheck(item.id)}>
              Check again
            </button>
          ) : null}
          <button type="button" className="gbo-pill-btn" onClick={onOpen}>
            Open in Hermes Bot Mode
          </button>
        </div>
      )
    }
    return (
      <div className="gbo-msg-meta gbo-msg-failed">
        Not sent: {item.failed}
        <button type="button" className="gbo-pill-btn" onClick={() => onRetry(item.id)}>
          Retry
        </button>
      </div>
    )
  }
  if (item.receipt === 'unknown') {
    return <div className="gbo-msg-meta gbo-msg-failed">Hermes accepted this message but lost track of it, so it will not run.</div>
  }
  if (item.receipt === 'terminal') return <div className="gbo-msg-meta">Already delivered</div>
  if (item.pending || item.receipt === 'queued' || item.receipt === 'steered' || item.receipt === 'redirected') {
    return (
      <div className="gbo-msg-meta">
        {item.pending ? 'Sending…' : item.receipt === 'queued' ? 'Queued after the current reply' : 'Sent to the running reply'}
      </div>
    )
  }
  return null
}

/** An assistant message: one bubble, or, in the open chat, bubbles with its
 *  live `::card` / `::preview` directives between them (Directives.tsx). */
function AssistantBody({ item, bot, pos }: { item: any; bot: any; pos: string }) {
  const { segments, scope } = useDirectiveSegments(item.streaming ? '' : item.text)
  const time = item.at ? <span className="bubble__time">{clock(item.at)}</span> : null
  if (item.streaming || !segments || !scope) {
    return (
      <div className="bubble-wrap is-left">
        <div className={`bubble is-agent${pos}${item.streaming ? ' is-streaming' : ''}`}>
          {item.streaming ? <div className="bubble__plain">{item.text}</div> : <div className="md"><BotText bot={bot} text={item.text} /></div>}
        </div>
        {time}
      </div>
    )
  }
  const lastProse = segments.map((segment: any) => segment.kind).lastIndexOf('prose')
  return (
    <>
      {segments.map((segment: any, index: number) =>
        segment.kind === 'prose' ? (
          <div key={index} className="bubble-wrap is-left">
            <div className={`bubble is-agent${pos}`}>
              <div className="md">
                <BotText bot={bot} text={segment.text} />
              </div>
            </div>
            {index === lastProse ? time : null}
          </div>
        ) : (
          <DirectiveBlock key={index} segment={segment} poll={scope.recent.has(item.id)} scope={scope} />
        )
      )}
    </>
  )
}

function Item({
  item,
  bot,
  onAnswer,
  onRetry,
  onRecheck,
  onOpen,
  controller,
  busy = false,
  onPrefill = () => undefined,
  pos = ''
}: {
  item: any
  bot: any
  onAnswer: (requestId: string, choice: string) => void
  onRetry: (clientId: string) => void
  onRecheck: (clientId: string) => void
  onOpen: () => void
  controller?: any
  busy?: boolean
  onPrefill?: (text: string) => void
  /** The bubble's tail-corner class in its group (core/groups.js). */
  pos?: string
}) {
  const react = (emoji: string) => void controller?.react(item.id, emoji)
  switch (item.kind) {
    case 'divider':
      return <div className="divider gbo-divider">{item.label}</div>
    case 'new':
      return <NewLine />
    case 'user':
      return (
        <div className="gbo-msg is-user">
          {item.attachments?.length ? (
            <div className="gbo-attach-chips">
              {item.attachments.map((a: any, i: number) => (
                <span key={i} className="gbo-chip">
                  {a.name || a.kind}
                </span>
              ))}
            </div>
          ) : null}
          {item.text ? (
            <div className="bubble-wrap is-right">
              <div className={`bubble is-user${pos}`}>
                <div className="bubble__plain">{item.text}</div>
              </div>
              {item.at ? <span className="bubble__time">{clock(item.at)}</span> : null}
            </div>
          ) : null}
          <Reactions item={item} onReact={react} />
          <UserMeta item={item} onRetry={onRetry} onRecheck={onRecheck} onOpen={onOpen} />
          <UserActions item={item} controller={controller} busy={busy} onPrefill={onPrefill} />
        </div>
      )
    case 'assistant':
      return (
        <div className="gbo-msg is-bot">
          {item.reasoning ? <Thinking text={item.reasoning} /> : null}
          {item.text ? <AssistantBody item={item} bot={bot} pos={pos} /> : null}
          <Reactions item={item} onReact={react} />
          {item.text && !item.streaming ? <AssistantActions item={item} controller={controller} busy={busy} /> : null}
        </div>
      )
    case 'tools':
      return <ToolGroup item={item} bot={bot} />
    case 'approval':
      return <ApprovalCard item={item} onAnswer={onAnswer} />
    case 'clarify':
      return <SettledChoiceCard item={item} />
    case 'notice':
      return <div className="system-event gbo-notice">{item.text}</div>
    case 'command':
      return (
        <div className={`gbo-command${item.error ? ' is-error' : ''}`} role="status">
          <div className="gbo-command-head">{item.command}</div>
          {item.running ? <div className="gbo-shimmer">Running…</div> : item.output ? <pre>{item.output}</pre> : null}
        </div>
      )
    case 'error':
      return <div className="notice is-error gbo-error">{item.text}</div>
    default:
      return null
  }
}

/** How close to the bottom still counts as "at the bottom" (CSS px). Small on
 *  purpose: a reader a few lines up is reading, and a transcript update must
 *  not pull them down (it was 80px, three lines). */
export const STICK_PX = 16

/** Follow new messages while the transcript is at its bottom. Once the user
 *  scrolls up, nothing moves their position until they come back to the
 *  bottom themselves or send a message (`mine`: the id of their newest
 *  message; a new one pins). */
function useStickToBottom(dep: unknown, mine: string) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const stick = React.useRef(true)
  const lastMine = React.useRef(mine)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (mine !== lastMine.current) {
      lastMine.current = mine
      if (mine) stick.current = true
    }
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [dep, mine])
  const onScroll = () => {
    const el = ref.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
  }
  const pin = () => {
    stick.current = true
  }
  return { ref, onScroll, pin, stick }
}

/** Whether the user is looking at this transcript's newest messages: the
 *  window focused and visible, the transcript on screen, scrolled to its
 *  bottom (core/newMarker.js). */
function lookingAt(el: HTMLElement | null): boolean {
  const doc = el?.ownerDocument as any
  if (!el || !doc || !el.isConnected) return false
  if (doc.visibilityState === 'hidden') return false
  if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return false
  if (!el.clientHeight) return false
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
}

/** The NEW line: decided when the chat opens, kept while it is open, and fed
 *  focus, visibility and scroll changes so messages read on arrival never
 *  start one. Returns the id of the message it sits above, or null. */
function useNewLine(key: string, items: any[], ready: boolean, ref: React.RefObject<HTMLDivElement | null>) {
  const line = useStore(roster2.newLine)
  const latest = React.useRef({ key, items, ready })
  latest.current = { key, items, ready }
  const note = React.useCallback(() => {
    const { key: k, items: list, ready: ok } = latest.current
    noteTranscript(k, list, ok, lookingAt(ref.current))
  }, [ref])
  React.useEffect(() => {
    note()
  }, [key, items, ready, note])
  React.useEffect(() => {
    const win = (globalThis as any).window
    const doc = (globalThis as any).document
    win?.addEventListener?.('focus', note)
    doc?.addEventListener?.('visibilitychange', note)
    return () => {
      win?.removeEventListener?.('focus', note)
      doc?.removeEventListener?.('visibilitychange', note)
    }
  }, [note])
  return { id: line.markers[key] ?? null, note }
}

/** The red NEW rule above the first unread bot message. */
export function NewLine() {
  return (
    <div className="gbo-new-line" role="separator" aria-label="New messages">
      <span>NEW</span>
    </div>
  )
}

/** Which chat a ChatWorkspace shows: the main tab, or an extra tab opened
 *  beside it (PARITY C26). */
const SlotContext = React.createContext<ChatSlot>(mainSlot)
const useController = () => React.useContext(SlotContext).controller()

function Transcript({ state, bot, meta, onPrefill }: { state: any; bot: any; meta: any; onPrefill?: (text: string) => void }) {
  const items = state.chat.items
  // Thought and tool rows are hidden unless the work-rows preference shows
  // them (core/workRows.js); display only, the chat keeps every item.
  const showWork = useStore(app.showWork)
  const mine = React.useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) if (items[i]?.kind === 'user') return String(items[i].id)
    return ''
  }, [items])
  const { ref, onScroll: onStickScroll, pin } = useStickToBottom(items, mine)
  const newLine = useNewLine(rowKey(bot), items, state.phase === 'ready', ref)
  const onScroll = () => {
    onStickScroll()
    newLine.note()
  }
  const decorated = React.useMemo(
    () => groupMessages(withNewMarker(withDividers(visibleItems(items, showWork)), newLine.id)),
    [items, showWork, newLine.id]
  )
  const controller = useController()
  const answer = (requestId: string, choice: string) => void controller?.respondApproval(requestId, choice)
  const retry = (clientId: string) => void controller?.retry(clientId)
  const recheck = (clientId: string) => void controller?.recheck(clientId)
  const openStock = () => void openInBotMode(bot, 'Check whether your message arrived before sending anything again.')
  const activity = state.chat.busy ? activityLabel(state.chat, showWork) : ''
  // Live directives (Cards 7) belong to this open chat only: its bot, its
  // stored session, its controller. Cards in the last few messages poll.
  const recentKey = items.slice(-8).map((item: any) => item.id).join('|')
  const outer = React.useContext(DirectiveContext)
  const directives = React.useMemo<DirectiveScope | null>(
    () =>
      !controller
        ? outer
        : state.storedId
        ? {
            bot,
            sessionId: String(state.storedId),
            sendIntent: (text: string) => controller.sendIntent(text),
            recent: new Set(recentKey.split('|'))
          }
        : null,
    [bot, state.storedId, controller, recentKey, outer]
  )

  // A block body on purpose: an effect's return value is its cleanup, and
  // `pin()` returns `true`, which React then called as a function when the
  // Transcript unmounted (switching bots): "destroy is not a function", the
  // live crash. test/loader-render.test.mjs covers it.
  React.useEffect(() => {
    pin()
  }, [state.storedId])

  return (
    <DirectiveContext.Provider value={directives}>
    <OverlayScroll wrapClassName="transcript-wrap gbo-transcript-scroll" className="transcript gbo-transcript" scrollRef={ref} onScroll={onScroll}>
      <div className="transcript__col gbo-column">
        {state.hasMore ? (
          <button type="button" className="btn btn--sm btn--secondary gbo-more" disabled={state.loadingMore} onClick={() => void controller?.loadEarlier()}>
            {state.loadingMore ? 'Loading…' : 'Show earlier messages'}
          </button>
        ) : null}
        {!items.length && state.phase === 'ready' ? (
          <div className="empty-chat">
            <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={meta} size={80} />
            <div className="empty-chat__title">{displayName(bot, meta)}</div>
            <div className="empty-chat__sub">Send a message to start the conversation</div>
          </div>
        ) : null}
        {decorated.map((entry: any) => {
          const props = { bot, controller, busy: Boolean(state.chat.busy), onPrefill, onAnswer: answer, onRetry: retry, onRecheck: recheck, onOpen: openStock }
          if (entry.kind !== 'group') return <Item key={entry.id} item={entry} {...props} />
          // Tail corners count the group's bubbles only (a reasoning-only
          // reply draws none).
          const bubbles = entry.items.filter((item: any) => item.text)
          return (
            <div key={entry.id} className={`group is-${entry.side}`}>
              {entry.items.map((item: any) => (
                <Item key={item.id} item={item} {...props} pos={item.text ? cornerClass(bubbles.indexOf(item), bubbles.length) : ''} />
              ))}
            </div>
          )
        })}
        {state.chat.waiting ? <WaitingCard waiting={state.chat.waiting} bot={bot} name={displayName(bot, meta)} controller={controller} /> : null}
        {activity ? (
          <div className="activity-line gbo-activity" role="status">
            <span className="activity-line__mark">
              <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={meta} size={22} />
            </span>
            <span className="activity-line__text shimmer">{activity}…</span>
          </div>
        ) : null}
        {/* A failed attach is retried quietly while the idle refresh keeps
            the history current; only a chat still not attached after 10 s
            says so, and never with the gateway's raw error. */}
        {state.reconnecting && !state.runtimeId && state.phase === 'ready' ? (
          <div className="notice gbo-notice gbo-reconnecting" role="status">
            Reconnecting…
          </div>
        ) : null}
      </div>
    </OverlayScroll>
    </DirectiveContext.Provider>
  )
}

function Center({ state, bot }: { state: any; bot: any }) {
  const controller = useController()
  const slot = React.useContext(SlotContext)
  const name = displayName(bot, metaFor(bot))
  if (state.phase === 'no-chat') {
    return (
      <div className="gbo-center">
        <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={metaFor(bot)} size={80} />
        <h2>No Bot Chat yet</h2>
        <p>{name} has no Bot Chat yet. Start it here; it is the same one forever-chat Hermes Bot Mode opens.</p>
        <button type="button" className="btn btn--primary" onClick={() => void controller?.create()}>
          Start Bot Chat
        </button>
      </div>
    )
  }
  if (state.phase === 'creating') {
    return (
      <div className="gbo-center">
        <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={metaFor(bot)} size={72} working />
        <p>Starting {name}’s Bot Chat…</p>
      </div>
    )
  }
  if (state.phase === 'error') {
    // Retry on the roster's current row: a chat opened before its route
    // arrived holds a row without one, and retrying that row fails forever.
    const fresh = freshBot(bot)
    const retry = () => (fresh && fresh !== bot && !slot.extra ? selectBot(fresh) : void controller?.open())
    // Hermes Bot Mode is only offered with the bot's exact route: a bare
    // profile would open a same-named profile on this machine instead.
    const stockProblem = stockHandoffProblem(fresh || bot)
    return (
      <div className="gbo-center">
        <h2>Could not open {name}</h2>
        <p>{state.error}</p>
        {stockProblem ? <p>{stockProblem}. Hermes Bot Mode is not offered until it is.</p> : null}
        <div className="gbo-card-actions">
          <button type="button" className="btn btn--primary" onClick={retry}>
            Try again
          </button>
          {stockProblem ? null : (
            <button type="button" className="btn btn--secondary" onClick={() => void openInBotMode(fresh || bot)}>
              Open in Hermes Bot Mode
            </button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="gbo-center">
      <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={metaFor(bot)} size={72} working />
      <p>Opening {name}’s chat…</p>
    </div>
  )
}

const NARROW_PANE_PX = 900

/** Track the workspace pane's own width (Hermes can dock a narrow pane in a
 *  wide window), so the profile panel turns into a drawer when it would not
 *  fit beside the chat (review r1 #9). */
function usePaneWidth(ref: React.RefObject<HTMLDivElement | null>, enabled = true) {
  React.useEffect(() => {
    const el = ref.current
    if (!enabled) return undefined
    const RO = (globalThis as any).ResizeObserver
    if (!el || typeof RO !== 'function') return
    const measure = (width: number) => {
      const narrow = width > 0 && width < NARROW_PANE_PX
      if (narrow !== app.narrow.get()) app.narrow.set(narrow)
    }
    const observer = new RO((entries: any[]) => measure(entries[0]?.contentRect?.width ?? el.clientWidth))
    observer.observe(el)
    measure(el.clientWidth)
    return () => observer.disconnect()
  }, [ref, enabled])
}

/** The hairline between the chat and the profile panel: drag to resize the
 *  panel (clamped, stored once on release), double-click for the default. */
function PanelSash({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
  const width = useStore(app.panelWidth)
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const target = event.currentTarget
    const resize = startPanelResize(event.clientX, rootRef.current?.clientWidth ?? Infinity)
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      /* capture is a nicety */
    }
    target.dataset.dragging = 'true'
    const move = (e: PointerEvent) => void resize.move(e.clientX)
    const end = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      delete target.dataset.dragging
      resize.end()
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }
  return (
    <div
      className="gbo-panel-sash"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the profile panel"
      aria-valuenow={width}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onDoubleClick={() => resetPanelWidth()}
    />
  )
}

/** The narrow-pane profile drawer is modal over the chat (review r2 #8): it
 *  takes focus, keeps Tab inside, makes the chat column inert, closes on an
 *  Escape pressed inside it (not on every Escape in the app), and gives
 *  focus back to the control that opened it. */
function ProfileDrawer({ bot, onClose, backgroundRef }: { bot: any; onClose: () => void; backgroundRef: React.RefObject<HTMLDivElement | null> }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!ref.current) return
    return trapFocus(ref.current, { background: backgroundRef.current })
  }, [backgroundRef])
  return (
    <>
      <div className="gbo-scrim" aria-hidden="true" onClick={onClose} />
      <div
        className="gbo-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Profile"
        tabIndex={-1}
        ref={ref}
        onKeyDown={event => drawerKeyDown(event, ref.current, onClose)}
      >
        <button type="button" className="icon-btn icon-btn--bordered gbo-drawer-close" title="Close profile" aria-label="Close profile" onClick={onClose}>
          <IconX />
        </button>
        <ProfilePanel bot={bot} />
      </div>
    </>
  )
}

export function ChatWorkspace({ slot = mainSlot }: { slot?: ChatSlot } = {}) {
  const state = useStore(slot.chat)
  const selectedKey = useStore(app.selectedKey)
  const panelOpen = useStore(app.panelOpen)
  const narrow = useStore(app.narrow)
  const drawerOpen = useStore(app.drawerOpen)
  const panelWidth = useStore(app.panelWidth)
  const roster = useStore(app.roster)
  const rosterShown = useStore(app.rosterShown)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const draftRef = React.useRef<null | ((text: string, owner?: string) => void)>(null)
  const chatRef = React.useRef<HTMLDivElement | null>(null)
  usePaneWidth(rootRef, !slot.extra)
  const closeDrawer = React.useCallback(() => app.drawerOpen.set(false), [])
  const bot = state?.bot ? findBot(rowKey(state.bot)) || state.bot : findBot(selectedKey)
  // A chat tab showing the remembered bot opens its chat; the chat lives
  // while this tab does (closing the tab retires it, review r2 #5).
  const pending = !state && bot && !slot.extra ? rowKey(bot) : ''
  React.useEffect(() => {
    if (!pending || app.chat.get()) return
    const target = findBot(pending)
    if (target) selectBot(target, { openWorkspace: false })
  }, [pending])

  if (!bot || !state) {
    return (
      <div data-gbo-root="" className="gbo-ws" ref={rootRef}>
        <div className="gbo-center">
          <h2>Pick a bot</h2>
          <p>Choose a bot in the Bots sidebar to open its Bot Chat.</p>
        </div>
      </div>
    )
  }

  const meta = metaFor(bot)
  const name = displayName(bot, meta)
  // Your bubbles, the send button and the panel's switches wear the bot's
  // swatch (core/colors.js); a black bot keeps the theme's ink and primary.
  const style = botTintVars(botColor(bot.name, meta)) as React.CSSProperties | undefined
  const controller = slot.controller()
  const ready = state.phase === 'ready'
  // An extra tab (C26) is the chat only: its profile button fronts the main
  // tab's panel for that bot.
  const extra = slot.extra
  const shown = extra ? false : narrow ? drawerOpen : panelOpen
  const togglePanel = () =>
    extra ? selectBot(bot) : narrow ? app.drawerOpen.set(!drawerOpen) : setPanelOpen(!panelOpen)
  const completeSlash = (text: string) => controller?.completeSlash(text) ?? Promise.resolve({ items: [], replaceFrom: 0 })

  const view = (
    <div data-gbo-root="" className={`gbo-ws${narrow && !extra ? ' is-narrow' : ''}`} style={style} ref={rootRef}>
      <main className="chat gbo-chat" ref={chatRef}>
        <header className="chat__header gbo-head">
          {/* Hermes's sidebar is collapsed: its toggle comes here, past the
              window's traffic lights. */}
          {!extra && !rosterShown && canToggleSidebar() ? (
            <div className="gbo-head-left">
              <button type="button" className="icon-btn icon-btn--plain" title="Show sidebar (⌘B)" aria-label="Show sidebar" onClick={() => void toggleSidebar()}>
                <IconSidebar />
              </button>
            </div>
          ) : null}
          <span className="chat__pill-anchor">
            <button type="button" className="chat__pill gbo-head-pill" title={`${name}: profile`} aria-expanded={shown} onClick={togglePanel}>
              <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={meta} size={27} working={Boolean(state.chat.busy)} />
              <span className="chat__pill-name">{name}</span>
            </button>
          </span>
          <div className="chat__header-right gbo-head-right">
            {/* The reference header: a details toggle only while the panel
                is closed (the panel closes from its own X or the pill),
                then Share. */}
            {!extra && !shown ? (
              <button type="button" className="icon-btn icon-btn--bordered gbo-panel-toggle" title="Show profile" aria-label="Show profile" aria-expanded={false} onClick={togglePanel}>
                <IconPanel />
              </button>
            ) : null}
            <MenuButton
              label="Share"
              className="share-btn"
              entries={[{ label: 'Open another chat beside this one', icon: <IconOpen />, onSelect: () => openBotInNewTab(bot) }]}
            >
              Share
            </MenuButton>
          </div>
        </header>
        {ready ? <Transcript state={state} bot={bot} meta={meta} onPrefill={text => draftRef.current?.(text, draftOwnerKey(bot))} /> : <Center state={state} bot={bot} />}
        <Composer
          key={rowKey(bot)}
          bot={bot}
          name={name}
          busy={Boolean(state.chat.busy)}
          disabled={!ready}
          roster={roster.rows}
          stopError={state.stopError}
          blocked={state.sendBlocked}
          draftRef={draftRef}
          onSend={(text, attachments, options) =>
            controller?.sendDraft(text, attachments, options) ?? Promise.resolve({ ok: false, delivery: 'not-sent', error: 'This chat is closed' })
          }
          onSlash={text => controller?.runSlash(text) ?? Promise.resolve({ ok: false })}
          onCompleteSlash={completeSlash}
          onRestored={clientId => controller?.dropFailed(clientId)}
          onDiscard={id => void controller?.discardStaged([id])}
          onStop={() => void controller?.interrupt()}
          answering={state.chat.waiting?.kind === 'clarify'}
          onAnswer={text => controller?.answerClarifyText(text) ?? Promise.resolve({ ok: false, error: 'This chat is closed' })}
        />
      </main>
      {extra ? null : narrow ? drawerOpen ? <ProfileDrawer bot={bot} onClose={closeDrawer} backgroundRef={chatRef} /> : null : panelOpen ? (
        <div className="details gbo-panel-dock" style={{ width: panelWidth }}>
          <PanelSash rootRef={rootRef} />
          <div className="gbo-drag-band" aria-hidden="true" />
          <ProfilePanel bot={bot} onClose={() => setPanelOpen(false)} />
        </div>
      ) : null}
    </div>
  )
  return <SlotContext.Provider value={slot}>{view}</SlotContext.Provider>
}
