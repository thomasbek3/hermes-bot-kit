// Group chats (PARITY R14): the roster's "Group chats" section with New
// group, and a room tab (the room log as a chat, members' faces, who is
// working, a member's pending approval / retry / discard, Stop, Continue a
// paused discussion, rename, disband). Gateway-owned rooms (core/rooms.js);
// layout follows Rakazo's group chat UI (Apache-2.0, see NOTICE.md).

import * as React from 'react'

import { approvalPreview } from '../core/rooms.js'
import { displayName, rowKey } from '../core/roster.js'
import { withDividers } from '../core/time.js'
import { app, createGroupChat, disbandGroupChat, metaFor, openRoom } from './app'
import { BotAvatar } from './Avatar'
import { IconArrowUp, IconChevronDown, IconPlus } from './icons'
import { Markdown } from './sdk'
import { createStore, useStore } from './store'

/** The roster row of a room member (same profile on the room's connection). */
export function botFor(profile: string, route: any) {
  return (
    app.roster
      .get()
      .rows.find(
        (bot: any) =>
          String(bot?.route?.targetProfile || bot?.name) === profile && String(bot?.route?.connectionId || bot?.connectionId || 'local') === String(route?.connectionId || 'local')
      ) || null
  )
}

function Face({ profile, route, size = 28, working = false }: { profile: string; route: any; size?: number; working?: boolean }) {
  const bot = botFor(profile, route)
  return <BotAvatar shapeKey={bot ? rowKey(bot) : profile} name={profile} meta={bot ? metaFor(bot) : null} size={size} working={working} />
}

function NewGroup({ route, onDone }: { route: any; onDone: () => void }) {
  const roster = useStore(app.roster)
  const [name, setName] = React.useState('')
  const [picked, setPicked] = React.useState<string[]>([])
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const eligible = roster.rows.filter((bot: any) => String(bot?.route?.connectionId || bot?.connectionId || 'local') === String(route?.connectionId || 'local') && !metaFor(bot)?.hidden)
  return (
    <form
      className="gbo-new-group"
      onSubmit={async event => {
        event.preventDefault()
        setBusy(true)
        setError('')
        try {
          await createGroupChat(name, eligible.filter((bot: any) => picked.includes(rowKey(bot))))
          onDone()
        } catch (err: any) {
          setError(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <input className="gbo-input" placeholder="Group name" aria-label="Group name" value={name} onChange={event => setName(event.target.value)} />
      <div className="gbo-pick" role="group" aria-label="Members">
        {eligible.map((bot: any) => {
          const key = rowKey(bot)
          const on = picked.includes(key)
          return (
            <label key={key} className={`gbo-pick-row${on ? ' is-on' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => setPicked(list => (on ? list.filter(k => k !== key) : [...list, key]))} />
              <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={metaFor(bot)} size={22} />
              {displayName(bot, metaFor(bot))}
            </label>
          )
        })}
      </div>
      {error ? <div className="gbo-card-error">{error}</div> : null}
      <div className="gbo-card-actions">
        <button type="submit" className="gbo-pill-btn is-primary" disabled={busy || !name.trim() || picked.length < 2 || picked.length > 6}>
          {busy ? 'Creating…' : 'Create group'}
        </button>
        <button type="button" className="gbo-pill-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** The roster's group list (the active source's rooms). */
/** The Group chats section's own UI state, a store so the roster's + menu
 *  ("New group chat…", RosterMenus setNewGroupOpener) can open the form. */
export const roomsUi = createStore<{ open: boolean; creating: boolean }>({ open: true, creating: false })

export function openNewGroupForm() {
  roomsUi.set({ open: true, creating: true })
}

export function RoomsSection({ query = '' }: { query?: string }) {
  const state = useStore(app.rooms)
  const { open, creating } = useStore(roomsUi)
  const setOpen = (fn: (v: boolean) => boolean) => roomsUi.set(s => ({ ...s, open: fn(s.open) }))
  const setCreating = (fn: boolean | ((v: boolean) => boolean)) => roomsUi.set(s => ({ ...s, creating: typeof fn === 'function' ? fn(s.creating) : fn }))
  if (!state.loaded || !state.route) return null
  const q = String(query || '').trim().toLowerCase()
  const rooms = q ? state.rooms.filter((room: any) => String(room?.name || '').toLowerCase().includes(q)) : state.rooms
  return (
    <div role="group" aria-label="Group chats" className="gbo-rooms">
      <div className="gbo-section-head is-rooms">
        <button type="button" className="gbo-section-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          <IconChevronDown />
          Group chats
          <span className="gbo-count">{rooms.length}</span>
        </button>
        <button type="button" className="icon-btn icon-btn--plain" title="New group chat" aria-label="New group chat" onClick={() => setCreating(v => !v)}>
          <IconPlus />
        </button>
      </div>
      {creating ? <NewGroup route={state.route} onDone={() => setCreating(false)} /> : null}
      {open
        ? rooms.map((room: any) => (
            <button key={room.room_id} type="button" className="bot-row gbo-row gbo-room-row" title={room.name} onClick={() => openRoom(state.route, room)}>
              <span className="bot-row__avatar gbo-room-faces" aria-hidden>
                {(room.members || []).slice(0, 3).map((m: any) => (
                  <Face key={m.member_id} profile={String(m.profile || m.member_id)} route={state.route} size={20} />
                ))}
              </span>
              <span className="bot-row__text gbo-row-main">
                <span className="gbo-row-line">
                  <span className="bot-row__name gbo-row-name">{room.name}</span>
                </span>
                <span className="bot-row__preview gbo-row-preview">{(room.members || []).map((m: any) => m.display_name || m.handle || m.member_id).join(', ')}</span>
              </span>
            </button>
          ))
        : null}
      {state.error ? <div className="gbo-roster-empty">Could not load group chats: {state.error}</div> : null}
    </div>
  )
}

function PendingAction({ action, controller, members, route, acting }: { action: any; controller: any; members: any[]; route: any; acting: boolean }) {
  const [error, setError] = React.useState('')
  const member = members.find(m => m.member_id === action.member_id)
  const who = member?.display_name || member?.handle || action.member_id
  const run = (choice?: 'once' | 'deny') =>
    controller.act(action, choice).catch((err: any) => setError(String(err?.message || err)))
  if (action.kind === 'approval') {
    const preview = approvalPreview(action)
    const choices: string[] = Array.isArray(action.approval?.choices) ? action.approval.choices : []
    return (
      <div className="gbo-card" role="group" aria-label="Approval needed">
        <div className="gbo-card-title">
          <Face profile={String(member?.profile || action.member_id)} route={route} size={20} /> {who} asks: may I run this?
        </div>
        {preview.description ? <div className="gbo-card-desc">{preview.description}</div> : null}
        {preview.actualCommand ? <code>{preview.actualCommand}</code> : null}
        <div className="gbo-card-actions">
          {choices.includes('once') && preview.reviewable ? (
            <button type="button" className="gbo-pill-btn is-primary" disabled={acting} onClick={() => void run('once')}>
              Allow once
            </button>
          ) : null}
          {choices.includes('deny') ? (
            <button type="button" className="gbo-pill-btn" disabled={acting} onClick={() => void run('deny')}>
              Deny
            </button>
          ) : null}
        </div>
        {error ? <div className="gbo-card-error">{error}</div> : null}
      </div>
    )
  }
  return (
    <div className="gbo-card" role="group" aria-label={`${who} needs a decision`}>
      <div className="gbo-card-title">
        {who}’s turn {action.kind === 'retry' ? 'failed' : 'is waiting'}
      </div>
      <div className="gbo-card-actions">
        <button type="button" className="gbo-pill-btn is-primary" disabled={acting} onClick={() => void run()}>
          {action.kind === 'retry' ? 'Retry' : 'Discard'}
        </button>
      </div>
      {error ? <div className="gbo-card-error">{error}</div> : null}
    </div>
  )
}

function RoomItem({ item, route, onContinue, onStop }: { item: any; route: any; onContinue: (id: string) => void; onStop: () => void }) {
  switch (item.kind) {
    case 'divider':
      return <div className="divider gbo-divider">{item.label}</div>
    case 'room-user':
      return (
        <div className="gbo-msg is-user">
          {item.author !== 'You' ? <div className="gbo-room-author is-user">{item.author}{item.scheduled ? ' · scheduled' : ''}</div> : null}
          {item.text ? (
            <div className="bubble is-user">
              <div className="bubble__plain">{item.text}</div>
            </div>
          ) : null}
          {item.attachments?.length ? (
            <div className="gbo-attach-chips">
              {item.attachments.map((a: any, i: number) => (
                <span key={i} className="gbo-chip">
                  {a.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )
    case 'room-member':
      return (
        <div className="gbo-msg is-bot gbo-room-msg">
          <Face profile={item.profile} route={route} size={26} />
          <div className="gbo-room-body">
            <div className="gbo-room-author">{item.author}</div>
            {item.text ? (
              <div className="bubble is-agent">
                <div className="md">
                  <Markdown text={item.text} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )
    case 'room-paused':
      return (
        <div className="gbo-card" role="group" aria-label="Paused">
          <div className="gbo-card-desc">{item.text}</div>
          <div className="gbo-card-actions">
            {item.discussionEventId ? (
              <button type="button" className="gbo-pill-btn is-primary" onClick={() => onContinue(item.discussionEventId)}>
                Continue
              </button>
            ) : null}
            <button type="button" className="gbo-pill-btn" onClick={onStop}>
              Stop
            </button>
          </div>
        </div>
      )
    case 'notice':
      return <div className="system-event gbo-notice">{item.text}</div>
    default:
      return null
  }
}

export function RoomWorkspace({ slot }: { slot: any }) {
  const state = useStore(slot.chat) as any
  const controller = slot.controller()
  const route = slot.route
  const [draft, setDraft] = React.useState('')
  const [note, setNote] = React.useState('')
  const [renaming, setRenaming] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const [confirmDisband, setConfirmDisband] = React.useState(false)
  const scroller = React.useRef<HTMLDivElement | null>(null)
  const room = state.room || slot.room
  const members: any[] = room?.members || []
  const driver = state.driver
  const working = new Set((driver?.member_activity || []).filter((a: any) => a.status === 'working' || a.status === 'running').map((a: any) => a.member_id))
  const items = React.useMemo(() => withDividers(state.items || []), [state.items])
  React.useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length, state.posts?.length])

  const send = async () => {
    const text = draft
    if (!text.trim()) return
    setDraft('')
    setNote('')
    const res = await controller.post(text)
    if (!res.ok && res.posted === 'no') {
      setDraft(current => (current.trim() ? current : text))
      setNote(`Not posted: ${res.error || 'refused'}. Your message is back in the composer.`)
    }
  }

  return (
    <div data-gbo-root="" className="gbo-ws">
      <main className="chat gbo-chat">
        <header className="chat__header gbo-head">
          <div className="chat__pill gbo-head-pill gbo-room-head">
            <span className="gbo-room-faces" aria-hidden>
              {members.slice(0, 4).map(m => (
                <Face key={m.member_id} profile={String(m.profile || m.member_id)} route={route} size={22} working={working.has(m.member_id)} />
              ))}
            </span>
            <span className="chat__pill-name">{room?.name || 'Group'}</span>
          </div>
          <div className="chat__header-right gbo-head-right">
            {driver?.working || driver?.running ? (
              <button type="button" className="share-btn" onClick={() => void controller.stop()}>
                Stop
              </button>
            ) : null}
            <button type="button" className="icon-btn icon-btn--bordered" title="Rename group" aria-label="Rename group" onClick={() => {
                setNewName(room?.name || '')
                setRenaming(v => !v)
              }}>
              ✎
            </button>
            <button type="button" className="icon-btn icon-btn--bordered" title="Disband group" aria-label="Disband group" onClick={() => setConfirmDisband(true)}>
              ×
            </button>
          </div>
        </header>
        {renaming ? (
          <form
            className="gbo-confirm gbo-room-bar"
            onSubmit={async event => {
              event.preventDefault()
              await controller.rename(newName).catch((err: any) => setNote(String(err?.message || err)))
              setRenaming(false)
            }}
          >
            <input className="gbo-input" aria-label="Group name" value={newName} onChange={event => setNewName(event.target.value)} />
            <button type="submit" className="gbo-pill-btn is-primary">
              Rename
            </button>
          </form>
        ) : null}
        {confirmDisband ? (
          <div className="gbo-confirm gbo-room-bar" role="alertdialog" aria-label="Disband">
            <span>Disband {room?.name}? The members stop and the group is closed for everyone.</span>
            <button type="button" className="gbo-pill-btn is-primary" onClick={() => void disbandGroupChat(slot.id).catch((err: any) => setNote(String(err?.message || err)))}>
              Disband
            </button>
            <button type="button" className="gbo-pill-btn" onClick={() => setConfirmDisband(false)}>
              Cancel
            </button>
          </div>
        ) : null}
        <div className="transcript gbo-transcript gbo-room-transcript" ref={scroller}>
          <div className="transcript__col gbo-column">
            {state.phase === 'loading' ? <div className="gbo-center">Opening {room?.name}…</div> : null}
            {state.phase === 'error' ? <div className="gbo-error">Could not open this group: {state.error}</div> : null}
            {items.map((item: any) => (
              <RoomItem
                key={item.id}
                item={item}
                route={route}
                onContinue={id => void controller.continueDiscussion(id).catch((err: any) => setNote(String(err?.message || err)))}
                onStop={() => void controller.stop()}
              />
            ))}
            {(state.posts || []).map((p: any) => (
              <div key={p.eventId} className="gbo-msg is-user">
                <div className="bubble is-user">
                  <div className="bubble__plain">{p.text}</div>
                </div>
                <div className={`gbo-msg-meta${p.status === 'unknown' ? ' gbo-msg-failed' : ''}`}>
                  {p.status === 'sending' ? 'Posting…' : p.status === 'sent' ? 'Posted' : 'Not confirmed. Retrying is safe: the group recognises this message and never posts it twice.'}
                  {p.status === 'unknown' ? (
                    <button type="button" className="gbo-pill-btn" onClick={() => void controller.retryPost(p.eventId)}>
                      Retry
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {(driver?.pending_actions || []).map((action: any) => (
              <PendingAction
                key={`${action.member_id}:${action.task_id}:${action.request_id || ''}`}
                action={action}
                controller={controller}
                members={members}
                route={route}
                acting={Boolean(state.acting?.[`${action.member_id}:${action.task_id}`])}
              />
            ))}
            {working.size ? (
              <div className="activity-line gbo-activity">
                <span className="activity-line__text shimmer">
                  {members
                    .filter(m => working.has(m.member_id))
                    .map(m => m.display_name || m.handle || m.member_id)
                    .join(', ')}{' '}
                  {working.size === 1 ? 'is' : 'are'} working…
                </span>
              </div>
            ) : null}
            {driver?.last_error ? <div className="gbo-error">{driver.last_error}</div> : null}
          </div>
        </div>
        <div className="composer-area gbo-composer-wrap">
          <div className="composer gbo-composer">
            <div className="composer__left">
            <textarea
              className="composer__input"
              rows={1}
              value={draft}
              disabled={state.phase !== 'ready' || state.canDrive === false}
              placeholder={state.canDrive === false ? 'This connection cannot run group chats' : `Message ${room?.name || 'the group'}`}
              aria-label={`Message ${room?.name || 'the group'}`}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !(event.nativeEvent as any).isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            </div>
            <div className="composer__right gbo-composer-actions">
              <button type="button" className="composer__cta gbo-round is-send" title="Send" aria-label="Send" disabled={!draft.trim() || state.phase !== 'ready'} onClick={() => void send()}>
                <IconArrowUp />
              </button>
            </div>
          </div>
          {note ? (
            <div className="gbo-composer-note">
              <span>{note}</span>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  )
}
