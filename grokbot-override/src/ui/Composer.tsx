// "Message <bot>": attach (button, paste or drop), text, mic, send / stop.
// Enter sends, Shift+Enter is a newline.
//
// Native, as in the Hermes composer:
//  - slash commands run in this chat (controller.runSlash, PARITY C19), with
//    `complete.slash` completions while the command word is typed;
//  - @mentions of other bots get stock's identification note on the submitted
//    text (core/mentions.js mentionNote, C20), with the roster's completions;
//  - voice input records in this window and transcribes on the bot's own
//    backend (C29, VoiceButton).
//
// The composer is keyed by the bot's route identity (ChatWorkspace), and every
// attachment is stamped with its owner: a file read that finishes after the
// bot changed is dropped, never added to another bot's draft (review r1 #4).
// Failed sends (review r2 #7): a message the gateway definitely did not take
// comes back into this composer when nothing newer was typed; otherwise its
// bubble offers Retry. A "delivery unknown" message is never put back.

import * as React from 'react'

import { draftOwnerKey, failureNote, readDraftFiles, restoreAfterFailure } from '../core/drafts.js'
import { mentionCompletions, mentionedBots, mentionNote } from '../core/mentions.js'
import { displayName } from '../core/roster.js'
import { metaFor, openInBotMode, stockHandoffProblem } from './app'
import { IconArrowUp, IconPlus, IconStop, IconX } from './icons'
import { VoiceButton } from './Voice'

export interface SendResult {
  ok: boolean
  delivery?: 'sent' | 'not-sent' | 'unknown'
  error?: string
  clientId?: string
}

export interface DraftAttachment {
  id: string
  kind: 'file' | 'image' | 'pdf'
  name: string
  data: string
  owner: string
}

export interface Completion {
  insert: string
  display: string
  meta?: string
  from: number
}

function readDataUrl(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => {
      try {
        reader.abort()
      } catch {
        /* already done */
      }
      reject(new Error('cancelled'))
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

/** The `@word` or `/command` token the caret is in, or null. */
export function completionToken(text: string, caret: number): null | { kind: '@' | '/'; query: string; from: number } {
  const before = text.slice(0, caret)
  const slash = /^\/([^\s/]*)$/.exec(before)
  if (slash) return { kind: '/', query: slash[1], from: 0 }
  const at = /(^|\s)@([a-z0-9_-]*)$/i.exec(before)
  if (at) return { kind: '@', query: at[2], from: before.length - at[2].length - 1 }
  return null
}

/** The line under the composer: what an @mention will do, a failed stop, a
 *  blocked route, or a note. Pure (props only). */
export function ComposerNote({
  mentionNames,
  blocked,
  stopError,
  note,
  onOpen
}: {
  mentionNames?: string
  blocked?: null | string
  stopError?: null | string
  note?: string
  onOpen?: () => void
}) {
  if (blocked) {
    return (
      <div className="gbo-composer-note gbo-msg-failed" role="alert">
        <span>Can’t send from this screen: {blocked}.</span>
        {onOpen ? (
          <button type="button" onClick={onOpen}>
            Open in Hermes Bot Mode
          </button>
        ) : null}
      </div>
    )
  }
  if (stopError) {
    return (
      <div className="gbo-composer-note gbo-msg-failed" role="alert">
        <span>Could not stop: {stopError}</span>
      </div>
    )
  }
  if (note) {
    return (
      <div className="gbo-composer-note">
        <span>{note}</span>
      </div>
    )
  }
  if (mentionNames) {
    return (
      <div className="gbo-composer-note" role="status">
        <span>The bot will be told who {mentionNames} is and can message them.</span>
      </div>
    )
  }
  return null
}

const COMPOSER_MAX_H = 223

export function Composer({
  bot,
  name,
  busy,
  disabled,
  roster,
  stopError,
  blocked,
  onSend,
  onSlash,
  onCompleteSlash,
  onRestored,
  onDiscard,
  onStop,
  draftRef
}: {
  bot: any
  name: string
  busy: boolean
  disabled: boolean
  roster?: any[]
  stopError?: null | string
  blocked?: null | string
  onSend: (text: string, attachments: DraftAttachment[], options?: { apiText?: string }) => Promise<SendResult>
  onSlash?: (text: string) => Promise<{ ok: boolean; prefill?: string }>
  onCompleteSlash?: (text: string) => Promise<{ items: any[]; replaceFrom: number }>
  onRestored?: (clientId: string) => void
  onDiscard?: (attachmentId: string) => void
  onStop: () => void
  /** Lets the transcript put text into this composer (edit, /undo). */
  draftRef?: React.MutableRefObject<null | ((text: string, owner?: string) => void)>
}) {
  const [text, setText] = React.useState('')
  const [files, setFiles] = React.useState<DraftAttachment[]>([])
  const [note, setNote] = React.useState('')
  const [options, setOptions] = React.useState<Completion[]>([])
  const [active, setActive] = React.useState(0)
  const [caret, setCaret] = React.useState(0)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const fileRef = React.useRef<HTMLInputElement | null>(null)
  const owner = draftOwnerKey(bot)
  const ownerRef = React.useRef(owner)
  ownerRef.current = owner
  // The latest draft, for decisions taken after an await.
  const textRef = React.useRef(text)
  textRef.current = text
  const filesRef = React.useRef(files)
  filesRef.current = files
  const reads = React.useRef(new Set<AbortController>())
  const completionSeq = React.useRef(0)
  const completeRef = React.useRef(onCompleteSlash)
  completeRef.current = onCompleteSlash

  const abortReads = () => {
    for (const controller of reads.current) controller.abort()
    reads.current.clear()
  }

  React.useEffect(() => {
    setText('')
    setFiles([])
    setNote('')
    setOptions([])
    return abortReads
  }, [owner])

  React.useEffect(() => {
    if (!draftRef) return undefined
    // A rewound message comes back here (review override-v2-r1 #3): only into
    // the composer of the bot it was rewound in, and never over a draft:
    // what the user had typed stays, the message goes below it.
    draftRef.current = (value: string, forOwner?: string) => {
      if (forOwner && forOwner !== ownerRef.current) return
      const current = textRef.current
      if (current.trim()) {
        setText(`${current.replace(/\s+$/, '')}\n\n${value}`)
        setNote('Your draft was kept; the rewound message is below it.')
      } else setText(value)
      inputRef.current?.focus()
    }
    return () => {
      draftRef.current = null
    }
  }, [draftRef])

  React.useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    // The reference composer: grow with the text up to 200px (at Hermes's
    // zoom), then scroll.
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_H ? 'auto' : 'hidden'
  }, [text])

  // Completions: `/command` from the gateway (complete.slash), `@bot` from
  // the roster (stock's mention-completions provider).
  React.useEffect(() => {
    const token = completionToken(text, caret)
    const seq = ++completionSeq.current
    if (!token) {
      setOptions(current => (current.length ? [] : current))
      return undefined
    }
    if (token.kind === '@') {
      const items = mentionCompletions(roster, bot, token.query, (row: any) => displayName(row, metaFor(row)))
      setOptions(items.map(item => ({ insert: item.insert, display: item.display, meta: item.meta, from: token.from })))
      setActive(0)
      return undefined
    }
    const complete = completeRef.current
    if (!complete) return undefined
    const timer = setTimeout(() => {
      void complete(text.slice(0, caret)).then(res => {
        if (seq !== completionSeq.current) return
        setOptions(
          (res.items || []).slice(0, 12).map((item: any) => ({
            insert: String(item.text || ''),
            display: String(item.display || item.text || ''),
            meta: String(item.meta || ''),
            from: res.replaceFrom || 0
          }))
        )
        setActive(0)
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [text, caret, roster, bot])

  const pick = (option: Completion) => {
    const before = text.slice(0, option.from)
    const after = text.slice(caret)
    const insert = option.insert.endsWith(' ') ? option.insert : `${option.insert} `
    const next = `${before}${insert}${after.replace(/^\S*/, '')}`
    setText(next)
    setOptions([])
    const at = before.length + insert.length
    setCaret(at)
    ;(globalThis as any).requestAnimationFrame?.(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(at, at)
      }
    })
  }

  const slash = text.trimStart().startsWith('/')
  const mentions = React.useMemo(() => (slash ? [] : mentionedBots(text, roster, bot)), [text, roster, bot, slash])
  const canSend = !disabled && !blocked && (text.trim().length > 0 || files.length > 0)

  const submit = async () => {
    if (!canSend) return
    const sending = text
    const sentOwner = owner
    if (slash && !files.length) {
      setText('')
      setNote('')
      setOptions([])
      const result = await onSlash?.(sending)
      if (ownerRef.current !== sentOwner) return
      if (result?.prefill && !textRef.current.trim()) setText(result.prefill)
      inputRef.current?.focus()
      return
    }
    if (slash && files.length) {
      setNote('A command can’t carry attachments: remove them, or send the text without the leading /.')
      return
    }
    const attachments = files.filter(file => file.owner === ownerRef.current)
    const apiText = mentionNote(mentions)
    setText('')
    setFiles([])
    setNote('')
    setOptions([])
    const result = await onSend(sending, attachments, apiText ? { apiText } : undefined)
    if (ownerRef.current !== sentOwner) return
    if (!result.ok) {
      const restore = restoreAfterFailure({ result, sentOwner, currentOwner: ownerRef.current, currentText: textRef.current, currentFiles: filesRef.current })
      if (restore) {
        // Hermes refused it before admitting anything: the whole draft comes
        // back, files included (their staging receipts move with them).
        setText(sending)
        setFiles(attachments)
        if (result.clientId) onRestored?.(result.clientId)
      }
      setNote(failureNote(result, restore))
    }
    inputRef.current?.focus()
  }

  const addFiles = async (list: FileList | null) => {
    const picked = Array.from(list || [])
    if (!picked.length) return
    const mine = ownerRef.current
    const controller = new AbortController()
    reads.current.add(controller)
    try {
      const result = await readDraftFiles(picked, {
        owner: mine,
        isCurrent: key => !controller.signal.aborted && ownerRef.current === key,
        read: file => readDataUrl(file as File, controller.signal),
        signal: controller.signal
      })
      if (result.stale) return
      if (result.notes.length) setNote(result.notes.join(' '))
      if (result.files.length) setFiles(current => [...current, ...(result.files as DraftAttachment[]).filter(file => file.owner === ownerRef.current)])
    } finally {
      reads.current.delete(controller)
    }
  }

  const insertTranscript = (spoken: string) => {
    setText(current => (current.trim() ? `${current.replace(/\s+$/, '')} ${spoken}` : spoken))
    inputRef.current?.focus()
  }

  const mentionNames = mentions.map(m => displayName(m, metaFor(m))).join(', ')
  const open = options.length > 0

  return (
    <div
      className="composer-area gbo-composer-wrap"
      onDragOver={event => {
        if (!disabled && event.dataTransfer?.types?.includes('Files')) event.preventDefault()
      }}
      onDrop={event => {
        if (disabled || !event.dataTransfer?.files?.length) return
        event.preventDefault()
        void addFiles(event.dataTransfer.files)
      }}
    >
      {open ? (
        <div className="gbo-popover" role="listbox" aria-label={text.startsWith('/') ? 'Commands' : 'Bots'}>
          {options.map((option, i) => (
            <button
              key={`${option.insert}:${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`gbo-popover-row${i === active ? ' is-active' : ''}`}
              onMouseDown={event => {
                event.preventDefault()
                pick(option)
              }}
            >
              <span className="gbo-popover-main">{option.display}</span>
              {option.meta ? <span className="gbo-popover-meta">{option.meta}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className={`composer gbo-composer${files.length ? ' has-chips' : ''}`}>
        {files.length ? (
          <div className="gbo-composer-chips">
            {files.map(file => (
              <span key={file.id} className="gbo-chip">
                {file.name}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => {
                    setFiles(current => current.filter(f => f.id !== file.id))
                    onDiscard?.(file.id)
                  }}
                >
                  <IconX />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="composer__left">
        <span className="composer__plus-anchor">
          <button
            type="button"
            className="composer__btn gbo-round is-attach"
            title="Attach files"
            aria-label="Attach files"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            <IconPlus />
          </button>
        </span>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={event => {
            void addFiles(event.target.files)
            event.target.value = ''
          }}
        />
        <textarea
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={`Message ${name}`}
          aria-label={`Message ${name}`}
          aria-autocomplete="list"
          onChange={event => {
            setText(event.target.value)
            setCaret(event.target.selectionStart ?? event.target.value.length)
          }}
          onSelect={event => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onPaste={event => {
            const items = event.clipboardData?.files
            if (items && items.length) {
              event.preventDefault()
              void addFiles(items)
            }
          }}
          onKeyDown={event => {
            if (open) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setActive(i => (i + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
                return
              }
              if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                event.preventDefault()
                pick(options[active] || options[0])
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setOptions([])
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !(event.nativeEvent as any).isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        </div>
        <div className="composer__right gbo-composer-actions">
          <VoiceButton bot={bot} disabled={disabled} onTranscript={insertTranscript} onError={setNote} />
          {busy && !canSend ? (
            <button type="button" className="composer__cta gbo-round is-stop" title="Stop" aria-label="Stop" onClick={onStop}>
              <IconStop />
            </button>
          ) : (
            <button type="button" className="composer__cta gbo-round is-send" title="Send (Enter)" aria-label="Send" disabled={!canSend} onClick={() => void submit()}>
              <IconArrowUp />
            </button>
          )}
        </div>
      </div>
      <ComposerNote mentionNames={mentionNames} blocked={blocked} stopError={stopError} note={note} onOpen={stockHandoffProblem(bot) ? undefined : () => void openInBotMode(bot)} />
    </div>
  )
}
