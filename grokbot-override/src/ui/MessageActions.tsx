// Per-message actions (PARITY C22, C23): reactions (the iOS Tapback set
// stock offers, store/reactions.ts QUICK_REACTIONS), edit and rewind on a
// stored user message, regenerate on a reply. Editing or regenerating an older
// turn removes the later ones, so that asks first (stock's confirm for a deep
// truncation, use-prompt-actions/rewind.ts `confirm_deep_truncate`).

import * as React from 'react'

import { IconCopy } from './icons'

export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '‼️', '❓']

export function Reactions({ item, onReact }: { item: any; onReact: (emoji: string) => void }) {
  const list: any[] = Array.isArray(item.reactions) ? item.reactions : []
  if (!list.length) return null
  return (
    <div className="gbo-reactions">
      {list.map(reaction => (
        <button
          key={`${reaction.author}:${reaction.emoji}`}
          type="button"
          className={`gbo-reaction${reaction.author === 'user' ? ' is-mine' : ''}`}
          title={reaction.author === 'user' ? 'Your reaction (click to remove)' : 'The bot reacted'}
          disabled={reaction.author !== 'user'}
          onClick={() => onReact(reaction.emoji)}
        >
          {reaction.emoji}
        </button>
      ))}
    </div>
  )
}

function ReactButton({ onReact }: { onReact: (emoji: string) => void }) {
  const [open, setOpen] = React.useState(false)
  return (
    <span className="gbo-react-wrap">
      <button type="button" className="gbo-icon-btn gbo-act" title="React" aria-label="React" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        ☺
      </button>
      {open ? (
        <span className="gbo-react-picker" role="menu">
          {QUICK_REACTIONS.map(emoji => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onReact(emoji)
              }}
            >
              {emoji}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  )
}

function copyText(text: string) {
  try {
    void (globalThis as any).navigator?.clipboard?.writeText?.(text)
  } catch {
    /* clipboard unavailable */
  }
}

/** A confirm step for cuts that remove later turns. */
function useConfirm() {
  const [pending, setPending] = React.useState<null | { label: string; run: () => void }>(null)
  const ask = (later: number, label: string, run: () => void) => (later > 0 ? setPending({ label: `${label}: this removes ${later} later message${later === 1 ? '' : 's'} from the chat.`, run }) : run())
  const view = pending ? (
    <div className="gbo-confirm" role="alertdialog" aria-label="Confirm">
      <span>{pending.label}</span>
      <button
        type="button"
        className="gbo-pill-btn is-primary"
        onClick={() => {
          const run = pending.run
          setPending(null)
          run()
        }}
      >
        Continue
      </button>
      <button type="button" className="gbo-pill-btn" onClick={() => setPending(null)}>
        Cancel
      </button>
    </div>
  ) : null
  return { ask, view }
}

export function UserActions({ item, controller, busy, onPrefill }: { item: any; controller: any; busy: boolean; onPrefill: (text: string) => void }) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(item.text)
  const { ask, view } = useConfirm()
  const stored = Boolean(item.rowId) && !item.pending && !item.failed
  if (!stored) return null
  const later = () => controller?.laterTurns?.(item.id) ?? 0
  if (editing) {
    return (
      <div className="gbo-edit">
        <textarea className="gbo-input gbo-edit-box" value={draft} aria-label="Edit message" onChange={event => setDraft(event.target.value)} />
        <div className="gbo-card-actions">
          <button
            type="button"
            className="gbo-pill-btn is-primary"
            disabled={busy || !draft.trim()}
            onClick={() =>
              ask(later(), 'Send the edit', () => {
                setEditing(false)
                void controller?.editMessage(item.id, draft)
              })
            }
          >
            Send edit
          </button>
          <button type="button" className="gbo-pill-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
        {view}
      </div>
    )
  }
  return (
    <>
      <div className="gbo-msg-actions">
        <ReactButton onReact={emoji => void controller?.react(item.id, emoji)} />
        <button type="button" className="gbo-icon-btn gbo-act" title="Copy" aria-label="Copy message" onClick={() => copyText(item.text)}>
          <IconCopy />
        </button>
        <button
          type="button"
          className="gbo-icon-btn gbo-act"
          title="Edit"
          aria-label="Edit message"
          disabled={busy}
          onClick={() => {
            setDraft(item.text)
            setEditing(true)
          }}
        >
          ✎
        </button>
        <button
          type="button"
          className="gbo-icon-btn gbo-act"
          title="Rewind to here (the message goes back into the composer)"
          aria-label="Rewind to here"
          disabled={busy}
          onClick={() =>
            ask(later(), 'Rewind', () => {
              void controller?.rewindTo(item.id).then((res: any) => {
                if (res?.prefill) onPrefill(res.prefill)
              })
            })
          }
        >
          ↶
        </button>
      </div>
      {view}
    </>
  )
}

export function AssistantActions({ item, controller, busy }: { item: any; controller: any; busy: boolean }) {
  const { ask, view } = useConfirm()
  const later = () => {
    // Regenerating cuts from the user turn this reply answered.
    const items = controller?.get?.().chat.items || []
    const at = items.findIndex((entry: any) => entry.id === item.id)
    for (let i = at; i >= 0; i -= 1) if (items[i]?.kind === 'user') return controller?.laterTurns?.(items[i].id) ?? 0
    return 0
  }
  return (
    <>
      <div className="gbo-msg-meta gbo-msg-actions">
        <button type="button" className="gbo-icon-btn" title="Copy" aria-label="Copy message" onClick={() => copyText(item.text)}>
          <IconCopy />
        </button>
        <ReactButton onReact={emoji => void controller?.react(item.id, emoji)} />
        <button
          type="button"
          className="gbo-icon-btn gbo-act"
          title="Regenerate"
          aria-label="Regenerate reply"
          disabled={busy}
          onClick={() => ask(later(), 'Regenerate', () => void controller?.regenerate(item.id))}
        >
          ↻
        </button>
      </div>
      {view}
    </>
  )
}
