// An email draft a bot wrote, as a card in the chat (core/emailDrafts.js has
// the contract; the kit's `email-drafts` agent plugin stores and sends it).
//
// Subject, From, "In reply to", To and Cc (editable), the body (editable)
// with the bot's signature under it, the attachments as the chat's file cards
// (read from the bot's own machine), and a footer: the rules menu on the left
// (Allow recipient / Needs approval / Disable drafts for <bot> / Manage
// rules), Discard and Send on the right. After a send the card says "Sent ·
// <time>" and is read-only; a failure shows the error with Retry. Nothing is
// sent unless a person clicks Send (or the bot's allow rule, which only a
// person sets, covers every recipient); a click while another action runs is
// ignored, and a send whose answer was lost is never repeated by the card.

import * as React from 'react'

import { displayName } from '../core/roster.js'
import {
  addressText,
  callDrafts,
  createSingleFlight,
  draftState,
  editsFrom,
  inReplyText,
  isDirty,
  modeLabel,
  parseAddresses,
  SEND_TIMEOUT_MS
} from '../core/emailDrafts.js'
import { clock } from '../core/time.js'
import { metaFor } from './app'
import { IconChevronDown } from './icons'
import { Dialog, MenuButton, type MenuEntry } from './kit'
import { FileCards } from './Media'

type Fields = { to: string; cc: string; subject: string; body: string }

const fieldsOf = (draft: any): Fields => ({
  to: addressText(draft?.to),
  cc: addressText(draft?.cc),
  subject: String(draft?.subject || ''),
  body: String(draft?.body || '')
})

/** A textarea that grows with its text (no inner scrollbar). */
function Body({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight) el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      className="gbo-ed-body"
      aria-label="Email body"
      value={value}
      disabled={disabled}
      rows={Math.max(4, value.split('\n').length + 1)}
      onChange={event => onChange(event.target.value)}
    />
  )
}

function RulesDialog({
  open,
  onClose,
  rules,
  botName,
  act,
  busy
}: {
  open: boolean
  onClose: () => void
  rules: any
  botName: string
  act: (op: string, params: any) => void
  busy: boolean
}) {
  const allowed: string[] = Array.isArray(rules?.allowed) ? rules.allowed : []
  const mode = String(rules?.mode || 'approval')
  const modes: Array<[string, string]> = [
    ['approval', 'Needs approval'],
    ['allow', 'Send to allowed recipients'],
    ['disabled', `Drafts off for ${botName}`]
  ]
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Email draft rules"
      title={`Email rules for ${botName}`}
      description="Drafts to allowed recipients send on their own while the mode is “Send to allowed recipients”. Every other draft waits for you to click Send."
      footer={
        <button type="button" className="btn btn--secondary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="gbo-ed-rules-modes" role="radiogroup" aria-label="Mode">
        {modes.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={`gbo-ed-mode${mode === value ? ' is-on' : ''}`}
            disabled={busy}
            onClick={() => mode !== value && act('set_mode', { mode: value })}
          >
            {label}
          </button>
        ))}
      </div>
      {allowed.length ? (
        <ul className="gbo-ed-rules-list" aria-label="Allowed recipients">
          {allowed.map(address => (
            <li key={address} className="gbo-ed-rules-item">
              <span>{address}</span>
              <button type="button" className="gbo-ed-discard" disabled={busy} aria-label={`Remove ${address}`} onClick={() => act('unallow', { addresses: [address] })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="gbo-ed-rules-empty">No allowed recipients yet. “Allow recipient” on a draft adds its To addresses.</p>
      )}
    </Dialog>
  )
}

export function EmailDraftCard({ item, bot, controller }: { item: any; bot: any; controller?: any }) {
  const draftId = String(item.draftId)
  const hint = item.hint || {}
  const [draft, setDraft] = React.useState<any>(null)
  const [fields, setFields] = React.useState<Fields>(() => fieldsOf(hint))
  const [note, setNote] = React.useState<{ text: string; error?: boolean } | null>(null)
  const [pending, setPending] = React.useState<'' | 'send' | 'discard' | 'rules'>('')
  const [rulesOpen, setRulesOpen] = React.useState(false)
  const flight = React.useRef(createSingleFlight())
  const live = React.useRef(true)
  const latest = React.useRef({ draft, fields })
  latest.current = { draft, fields }
  React.useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const request = typeof controller?.pluginRequest === 'function' ? controller.pluginRequest : null

  /** Take the plugin's copy; keep what the user typed unless it was saved. */
  const adopt = React.useCallback((next: any, { keepEdits = true } = {}) => {
    if (!live.current || !next) return
    const prev = latest.current
    setDraft(next)
    if (!keepEdits || !prev.draft || !isDirty(prev.fields, prev.draft)) setFields(fieldsOf(next))
  }, [])

  const read = React.useCallback(async () => {
    try {
      const res = await callDrafts(request, 'get', { id: draftId })
      if (!live.current) return
      if (res.ok) adopt(res.draft)
      else setNote({ text: res.error || 'This draft could not be read', error: true })
    } catch (error: any) {
      if (live.current) setNote({ text: String(error?.message || error), error: true })
    }
  }, [request, draftId, adopt])

  // Read on first draw, and again when a newer tool result names this draft.
  const hintKey = `${hint.status || ''}:${hint.rev || ''}`
  React.useEffect(() => {
    void read()
  }, [read, hintKey])

  const shown = draft || { ...hint, to: hint.to || [], cc: hint.cc || [] }
  const state = draftState(shown, (ms: number) => clock(ms))
  const rules = draft?.rules || { mode: 'approval', allowed: [] }
  const botName = displayName(bot, metaFor(bot))
  const busy = Boolean(pending)
  const editable = Boolean(draft) && state.editable && !busy
  const toParsed = parseAddresses(fields.to)
  const ccParsed = parseAddresses(fields.cc)
  const badFields = toParsed.bad.length || ccParsed.bad.length

  const run = (kind: 'send' | 'discard' | 'rules', job: () => Promise<void>) =>
    flight.current.run(async () => {
      setPending(kind)
      setNote(null)
      try {
        await job()
      } finally {
        if (live.current) setPending('')
      }
    })

  const send = () => {
    if (!draft || badFields || !toParsed.list.length) {
      setNote({ text: toParsed.list.length ? 'Fix the addresses first' : 'Add at least one To address', error: true })
      return
    }
    void run('send', async () => {
      const edits = isDirty(fields, draft) ? editsFrom(fields) : {}
      try {
        const res = await callDrafts(request, 'send', { id: draftId, rev: draft.rev, ...edits }, { timeoutMs: SEND_TIMEOUT_MS })
        if (res.draft) adopt(res.draft, { keepEdits: false })
        else if (!res.ok) {
          // Refused before anything was sent (the bot changed the draft, a bad
          // address): say why and show the plugin's current copy.
          setNote({ text: res.error || 'Not sent', error: true })
          await read()
        }
      } catch (error: any) {
        // No answer is not "not sent": never send again from here; re-read.
        setNote({ text: `Not confirmed (${String(error?.message || error)}). It may have been sent, so it was not sent again; checking…`, error: true })
        await read()
      }
    })
  }

  const discard = () =>
    void run('discard', async () => {
      const before = latest.current.draft
      if (before) setDraft({ ...before, status: 'discarded' })
      try {
        const res = await callDrafts(request, 'discard', { id: draftId })
        if (res.draft) adopt(res.draft, { keepEdits: false })
        if (!res.ok) {
          if (before && !res.draft) setDraft(before)
          setNote({ text: res.error || 'Not discarded', error: true })
        }
      } catch (error: any) {
        setNote({ text: String(error?.message || error), error: true })
        await read()
      }
    })

  const act = (op: string, params: any) =>
    void run('rules', async () => {
      try {
        const res = await callDrafts(request, op, params)
        if (!res.ok) setNote({ text: res.error || 'Rule not changed', error: true })
        else if (res.rules && live.current) setDraft((d: any) => (d ? { ...d, rules: res.rules } : d))
      } catch (error: any) {
        setNote({ text: String(error?.message || error), error: true })
      }
    })

  const entries: MenuEntry[] = [
    { label: 'Allow recipient', checked: rules.mode === 'allow', disabled: !draft || busy, onSelect: () => act('allow', { id: draftId }) },
    { label: 'Needs approval', checked: rules.mode === 'approval', disabled: !draft || busy, onSelect: () => act('set_mode', { mode: 'approval' }) },
    { label: `Disable drafts for ${botName}`, checked: rules.mode === 'disabled', disabled: !draft || busy, onSelect: () => act('set_mode', { mode: 'disabled' }) },
    'sep',
    { label: 'Manage rules', disabled: !draft, onSelect: () => setRulesOpen(true) }
  ]

  const done = state.status === 'sent' || state.status === 'discarded'
  const reply = inReplyText(shown.in_reply_to)
  const files = Array.isArray(shown.attachments) ? shown.attachments.filter((a: any) => a && typeof a.path === 'string') : []
  const set = (key: keyof Fields) => (value: string) => setFields(f => ({ ...f, [key]: value }))

  return (
    <div className={`gbo-email-draft${done ? ' is-done' : ''}`} data-draft-id={draftId} data-status={state.status} aria-label="Email draft">
      {editable ? (
        <input className="gbo-ed-subject" aria-label="Subject" value={fields.subject} placeholder="Subject" onChange={event => set('subject')(event.target.value)} />
      ) : (
        <div className="gbo-ed-subject">{shown.subject || '(no subject)'}</div>
      )}
      <div className="gbo-ed-row">
        <span className="gbo-ed-label">From</span>
        <span className={`gbo-ed-value${shown.from ? '' : ' is-empty'}`}>{shown.from_name && shown.from ? `${shown.from_name} <${shown.from}>` : shown.from || 'No From address set'}</span>
      </div>
      {reply ? (
        <div className="gbo-ed-row">
          <span className="gbo-ed-label">In reply to</span>
          <span className="gbo-ed-value">{reply}</span>
        </div>
      ) : null}
      <div className={`gbo-ed-row${toParsed.bad.length ? ' is-bad' : ''}`}>
        <span className="gbo-ed-label">To</span>
        {editable ? (
          <input className="gbo-ed-input" aria-label="To" value={fields.to} onChange={event => set('to')(event.target.value)} />
        ) : (
          <span className="gbo-ed-value">{addressText(shown.to)}</span>
        )}
      </div>
      <div className={`gbo-ed-row${ccParsed.bad.length ? ' is-bad' : ''}`}>
        <span className="gbo-ed-label">Cc</span>
        {editable ? (
          <input className="gbo-ed-input" aria-label="Cc" value={fields.cc} placeholder="name@example.com" onChange={event => set('cc')(event.target.value)} />
        ) : (
          <span className={`gbo-ed-value${shown.cc?.length ? '' : ' is-empty'}`}>{addressText(shown.cc) || '—'}</span>
        )}
      </div>
      {shown.bcc?.length ? (
        <div className="gbo-ed-row">
          <span className="gbo-ed-label">Bcc</span>
          <span className="gbo-ed-value">{addressText(shown.bcc)}</span>
        </div>
      ) : null}
      {editable ? <Body value={fields.body} onChange={set('body')} disabled={false} /> : <div className="gbo-ed-body">{shown.body || ''}</div>}
      {shown.signature ? <div className="gbo-ed-signature">{shown.signature}</div> : null}
      {files.length ? (
        <div className="gbo-ed-files">
          <FileCards bot={bot} files={files.map((a: any) => ({ path: a.path, name: a.name || a.path.split(/[\\/]/).pop() }))} />
        </div>
      ) : null}
      {note ? (
        <div className={`gbo-ed-note${note.error ? ' is-error' : ''}`} role={note.error ? 'alert' : 'status'}>
          {note.text}
        </div>
      ) : null}
      <div className="gbo-ed-foot">
        {done ? null : (
          <MenuButton entries={entries} label="Email rules" className="gbo-ed-rules" align="start">
            {modeLabel(rules.mode)}
            <IconChevronDown />
          </MenuButton>
        )}
        <span className="gbo-ed-spacer" />
        {state.line ? (
          <span className={`gbo-ed-state${state.status === 'sent' ? ' is-sent' : state.status === 'failed' ? ' is-failed' : ''}`} role="status">
            {pending === 'send' ? 'Sending…' : state.line}
          </span>
        ) : pending === 'send' ? (
          <span className="gbo-ed-state" role="status">
            Sending…
          </span>
        ) : null}
        {state.actions.includes('discard') ? (
          <button type="button" className="gbo-ed-discard" disabled={!draft || busy} onClick={discard}>
            Discard
          </button>
        ) : null}
        {state.actions.includes('send') || state.actions.includes('retry') ? (
          <button type="button" className="gbo-ed-send" disabled={!draft || busy || !request} onClick={send}>
            {state.actions.includes('retry') ? 'Retry' : 'Send'}
          </button>
        ) : null}
      </div>
      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} rules={rules} botName={botName} act={act} busy={busy} />
    </div>
  )
}
