// The cards for a turn blocked on the user (PARITY C11): clarify questions,
// sudo / secret / vault prompts and connection operations, answered here
// (core/prompts.js names the gateway calls). Card layout follows Rakazo's
// dialog/settings panels (Apache-2.0, see NOTICE.md); behaviour follows the
// app's own cards: components/prompt-overlays.tsx (closing a password card is
// a refusal, '' ), components/assistant-ui/clarify/pending.tsx (choices, free
// text, multi-select, Skip) and the connection card's Approve / Not now /
// Continue (store/connection-request.ts). A clarify question is not a box of
// its own: it is a choice card at the end of the transcript (lettered rows),
// and the composer types its free-text answer.
//
// Secrets: inputs are uncontrolled password fields read once on submit and
// cleared; the value is never put in React state, chat state or a log.

import * as React from 'react'

import { bareChoice, choiceLetter, clarifyFilled, clarifyOpenPages, clarifyPage, clarifyPicks } from '../core/prompts.js'
import { isOpenableConnectUrl } from '../core/urls.js'
import { openInBotMode } from './app'
import { IconCheck } from './iconsRoster'

const TITLES: Record<string, string> = {
  sudo: 'needs your administrator password',
  secret: 'needs a secret value',
  'vault-unlock': 'needs your password manager unlocked',
  'vault-login': 'wants to save a login',
  'vault-code': 'needs a one-time code',
  connection: 'wants to connect'
}

function Footer({ waiting, bot }: { waiting: any; bot: any }) {
  if (!waiting.error) return null
  return (
    <div className="gbo-card-error" role="alert">
      {waiting.error}
      {waiting.unsupported ? (
        <button type="button" className="gbo-link-btn" onClick={() => void openInBotMode(bot, 'Answer the question in the Hermes Bot Chat.')}>
          Answer in Hermes Bot Mode
        </button>
      ) : null}
    </div>
  )
}

const SETTLED_NOTE: Record<string, string> = {
  skipped: 'Skipped',
  expired: 'No longer waiting for an answer'
}

/** A clarify request as a card in the transcript: the question in bold, one
 *  row per choice with a letter badge (A, B, C…). One question with single
 *  choices answers on click; one multi-select question collects picks (kept
 *  on the controller) and sends with Answer. Several questions page, one
 *  question at a time like Grok Bot: a click picks the row (the letter badge
 *  turns blue), Next moves on, Back goes back with the picks kept, Skip
 *  skips the question on screen, Done on the last page sends every answer
 *  (a skipped or unpicked question as null). Page dots sit on the left; the
 *  page lives on the controller (`page`, `pages`: the open question indexes,
 *  locked ones left out). A typed answer comes from the composer (Chat.tsx).
 *  Settled (`settled`): every question, the chosen rows marked, nothing
 *  clickable. */
export function ChoiceCard({
  questions,
  picks,
  settled = null,
  busy = false,
  name = '',
  page,
  pages,
  onPick,
  onPage,
  onAnswer,
  footer = null
}: {
  questions: any[]
  picks: Record<string, any>
  settled?: null | { status: string }
  busy?: boolean
  name?: string
  page?: number
  pages?: number[]
  onPick?: (qid: string, value: any, page?: number) => void
  onPage?: (page: number) => void
  onAnswer?: (answer: Record<string, any>) => void
  footer?: React.ReactNode
}) {
  const live = !settled
  const single = questions.length === 1 && !questions[0].multiSelect && Boolean(questions[0].choices)
  const paged = live && questions.length > 1
  const open = pages && pages.length ? pages : questions.map((_, i) => i)
  const current = paged ? (page !== undefined && open.includes(page) ? page : open[0]) : -1
  const step = open.indexOf(current)
  const nextPage = step >= 0 && step < open.length - 1 ? open[step + 1] : undefined
  const prevPage = step > 0 ? open[step - 1] : undefined
  const complete = questions.every(q => clarifyFilled(picks[q.qid]))
  const answerWith = (overrides: Record<string, any> = {}) =>
    onAnswer?.(Object.fromEntries(questions.map(q => [q.qid, q.qid in overrides ? overrides[q.qid] : picks[q.qid] ?? null])))
  // Next / Done (and Skip, which first clears the question on screen).
  const forward = (overrides: Record<string, any> = {}) => {
    if (nextPage === undefined) return answerWith(overrides)
    const qid = questions[current]?.qid
    if (qid && qid in overrides) return onPick?.(qid, overrides[qid], nextPage)
    onPage?.(nextPage)
  }
  const baseId = React.useId()
  const shown = paged ? [current, ...questions.map((_, i) => i).filter(i => i !== current)] : questions.map((_, i) => i)
  const block = (qi: number) => {
    const q = questions[qi]
    const ghost = paged && qi !== current
    const value = picks[q.qid]
    const chosen: string[] = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
    const labels = (q.choices || []).map((choice: string) => bareChoice(choice))
    const typed = chosen.filter(v => !labels.includes(v))
    const titleId = `${baseId}-q${qi}`
    return (
      <div
        key={q.qid}
        className={`gbo-ask-q${ghost ? ' is-ghost' : ''}`}
        aria-hidden={ghost || undefined}
        inert={ghost || undefined}
      >
        <div className="gbo-ask-title" id={ghost ? undefined : titleId}>
          {q.question}
        </div>
        {q.choices ? (
          <div className="gbo-ask-rows" role={q.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={ghost ? undefined : titleId}>
            {q.choices.map((choice: string, i: number) => {
              const label = labels[i]
              const on = chosen.includes(label)
              return (
                <button
                  key={choice}
                  type="button"
                  role={q.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  disabled={!live || busy || ghost}
                  tabIndex={ghost ? -1 : undefined}
                  className={`gbo-ask-row${on ? ' is-on' : ''}`}
                  onClick={() => {
                    if (single) return answerWith({ [q.qid]: label })
                    if (!q.multiSelect) return onPick?.(q.qid, label)
                    onPick?.(q.qid, on ? chosen.filter(v => v !== label) : [...chosen, label])
                  }}
                >
                  <span className="gbo-ask-key" aria-hidden="true">
                    {choiceLetter(i)}
                  </span>
                  <span className="gbo-ask-label">{label}</span>
                  {choice !== label ? <span className="gbo-ask-tag">Recommended</span> : null}
                  {on && !paged ? (
                    <span className="gbo-ask-check" aria-hidden="true">
                      <IconCheck />
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}
        {typed.map((text, j) => (
          <div key={text} className="gbo-ask-row is-on is-typed" role="note" aria-label={`Your answer: ${text}`}>
            <span className="gbo-ask-key" aria-hidden="true">
              {choiceLetter(labels.length + j)}
            </span>
            <span className="gbo-ask-label">{text}</span>
            {!paged ? (
              <span className="gbo-ask-check" aria-hidden="true">
                <IconCheck />
              </span>
            ) : null}
          </div>
        ))}
        {live && !q.choices && !typed.length ? <div className="gbo-ask-hint">Type your answer below.</div> : null}
      </div>
    )
  }
  return (
    <div
      className={`gbo-ask${live ? '' : ' is-settled'}${busy ? ' is-busy' : ''}${paged ? ' is-paged' : ''}`}
      role="group"
      aria-label={name ? `Question from ${name}` : 'Question'}
      aria-busy={busy || undefined}
    >
      {paged ? <div className="gbo-ask-pages">{shown.map(block)}</div> : shown.map(block)}
      {paged ? (
        <div className="gbo-ask-actions is-paged">
          <div className="gbo-ask-dots" role="img" aria-label={`Question ${step + 1} of ${open.length}`}>
            {open.map(i => (
              <span key={i} className={`gbo-ask-dot${i === current ? ' is-current' : ''}`} />
            ))}
          </div>
          {prevPage !== undefined ? (
            <button type="button" className="gbo-pill-btn" disabled={busy} title={busy ? 'Sending your answers…' : undefined} onClick={() => onPage?.(prevPage)}>
              Back
            </button>
          ) : null}
          <button
            type="button"
            className="gbo-pill-btn"
            disabled={busy}
            title={busy ? 'Sending your answers…' : 'Skip this question'}
            onClick={() => forward({ [questions[current].qid]: null })}
          >
            Skip
          </button>
          <button
            type="button"
            className="gbo-pill-btn is-primary is-next"
            disabled={busy}
            title={busy ? 'Sending your answers…' : undefined}
            onClick={() => forward()}
          >
            {busy ? 'Sending…' : nextPage === undefined ? 'Done' : 'Next'}
          </button>
        </div>
      ) : live ? (
        <div className="gbo-ask-actions">
          {!single ? (
            <button
              type="button"
              className="gbo-pill-btn is-primary"
              disabled={busy || !complete}
              title={busy ? 'Sending your answer…' : !complete ? 'Pick at least one choice first' : undefined}
              onClick={() => answerWith()}
            >
              {busy ? 'Sending…' : 'Answer'}
            </button>
          ) : null}
          <button
            type="button"
            className="gbo-ask-skip"
            disabled={busy}
            onClick={() => onAnswer?.(Object.fromEntries(questions.map(q => [q.qid, null])))}
          >
            {busy && single ? 'Sending…' : 'Skip'}
          </button>
        </div>
      ) : SETTLED_NOTE[settled.status] ? (
        <div className="gbo-ask-note">{SETTLED_NOTE[settled.status]}</div>
      ) : null}
      {footer}
    </div>
  )
}

/** A settled choice card (transcript item `kind: 'clarify'`). */
export function SettledChoiceCard({ item }: { item: any }) {
  return <ChoiceCard questions={item.questions || []} picks={item.answers || {}} settled={{ status: item.status }} />
}

/** One-value prompts (sudo, secret, vault unlock / code / save login). */
function ValueCard({ waiting, onAnswer }: { waiting: any; onAnswer: (answer: any) => void }) {
  const first = React.useRef<HTMLInputElement | null>(null)
  const second = React.useRef<HTMLInputElement | null>(null)
  const busy = Boolean(waiting.answering)
  const login = waiting.kind === 'vault-login'
  const secret = waiting.kind !== 'vault-code'
  const send = (decline = false) => {
    const a = first.current
    const b = second.current
    const answer = decline ? (login ? { identifier: '', password: '' } : '') : login ? { identifier: a?.value || '', password: b?.value || '' } : a?.value || ''
    if (a) a.value = ''
    if (b) b.value = ''
    onAnswer(answer)
  }
  const label =
    waiting.kind === 'sudo'
      ? 'Password'
      : waiting.kind === 'secret'
        ? waiting.envVar || 'Value'
        : waiting.kind === 'vault-unlock'
          ? 'Master password'
          : waiting.kind === 'vault-code'
            ? 'Code'
            : 'Username or email'
  return (
    <form
      className="gbo-q"
      autoComplete="off"
      onSubmit={event => {
        event.preventDefault()
        send()
      }}
    >
      {waiting.kind === 'sudo' && waiting.text ? <code>{waiting.text}</code> : null}
      {waiting.kind === 'secret' && waiting.text ? <div className="gbo-card-desc">{waiting.text}</div> : null}
      {waiting.kind === 'vault-code' && waiting.hint ? <div className="gbo-card-desc">{waiting.hint}</div> : null}
      <input
        ref={first}
        className="gbo-input"
        type={secret && !login ? 'password' : 'text'}
        aria-label={label}
        placeholder={label}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
      {login ? (
        <input ref={second} className="gbo-input" type="password" aria-label="Password" placeholder="Password" autoComplete="off" disabled={busy} />
      ) : null}
      <div className="gbo-card-actions">
        <button type="submit" className="gbo-pill-btn is-primary" disabled={busy}>
          {busy ? 'Sending…' : login ? 'Save login' : 'Send'}
        </button>
        <button type="button" className="gbo-pill-btn" disabled={busy} onClick={() => send(true)}>
          {waiting.kind === 'secret' || login ? 'Skip' : 'Cancel'}
        </button>
      </div>
    </form>
  )
}

const TARGET_STATE: Record<string, string> = {
  pending: 'Waiting',
  initiated: 'Connecting…',
  connected: 'Connected',
  skipped: 'Skipped',
  failed: 'Failed',
  expired: 'Expired',
  not_connected: 'Not connected'
}

/** Opens only an allowed sign-in link (core/urls.js isOpenableConnectUrl). */
function openExternal(url: string) {
  if (!isOpenableConnectUrl(url)) return
  try {
    ;(globalThis as any).window?.open?.(url, '_blank', 'noopener,noreferrer')
  } catch {
    /* no window */
  }
}

/** A connection operation: per target Approve (with any credentials an
 *  install asks for) / Not now, a sign-in link when the backend minted one,
 *  and Continue to end the operation with what is resolved. */
function ConnectionCard({ waiting, onRespond }: { waiting: any; onRespond: (result: any) => void }) {
  const busy = Boolean(waiting.answering)
  const forms = React.useRef<Record<string, HTMLFormElement | null>>({})
  const targets: any[] = waiting.targets || []
  return (
    <>
      {targets.length === 0 ? <div className="gbo-card-desc">Open the connections directory or keep going.</div> : null}
      {targets.map(target => {
        const name = String(target?.name || '')
        const env: any[] = Array.isArray(target?.required_env) ? target.required_env : []
        const open = !target?.resolved && (target?.state === 'pending' || target?.state === 'initiated' || target?.state === 'not_connected')
        return (
          <form
            key={name}
            className="gbo-target"
            ref={el => {
              forms.current[name] = el
            }}
            onSubmit={event => {
              event.preventDefault()
              const values: Record<string, string> = {}
              for (const field of env) {
                const input = forms.current[name]?.elements.namedItem(field.name) as HTMLInputElement | null
                if (input?.value) values[field.name] = input.value
                if (input) input.value = ''
              }
              onRespond({ targets: [{ name, status: 'approved', ...(Object.keys(values).length ? { env: values } : {}) }] })
            }}
          >
            <div className="gbo-target-head">
              <span className="gbo-target-name">{target?.display || name}</span>
              <span className={`gbo-target-state is-${target?.state || 'pending'}`}>{TARGET_STATE[target?.state] || target?.state}</span>
            </div>
            {target?.description || target?.detail ? <div className="gbo-card-desc">{target.description || target.detail}</div> : null}
            {target?.instructions ? <div className="gbo-card-desc">{target.instructions}</div> : null}
            {target?.launch?.target ? <code>{target.launch.target}</code> : null}
            {open
              ? env.map(field => (
                  <input
                    key={field.name}
                    name={field.name}
                    className="gbo-input"
                    type={field.secret ? 'password' : 'text'}
                    placeholder={field.prompt || field.name}
                    aria-label={field.prompt || field.name}
                    defaultValue={field.secret ? undefined : field.default || undefined}
                    autoComplete="off"
                    required={Boolean(field.required)}
                    disabled={busy}
                  />
                ))
              : null}
            {open ? (
              <div className="gbo-card-actions">
                {target?.connect_url && !isOpenableConnectUrl(String(target.connect_url)) ? (
                  <div className="gbo-card-desc gbo-connect-url-blocked">
                    This sign-in link was not opened because it is not an https address: <code>{String(target.connect_url)}</code>
                  </div>
                ) : target?.connect_url ? (
                  <button type="button" className="gbo-pill-btn is-primary" onClick={() => openExternal(String(target.connect_url))}>
                    Sign in
                  </button>
                ) : (
                  <button type="submit" className="gbo-pill-btn is-primary" disabled={busy}>
                    Approve
                  </button>
                )}
                <button type="button" className="gbo-pill-btn" disabled={busy} onClick={() => onRespond({ targets: [{ name, status: 'skipped' }] })}>
                  Not now
                </button>
              </div>
            ) : null}
          </form>
        )
      })}
      <div className="gbo-card-actions">
        <button type="button" className="gbo-pill-btn" disabled={busy} onClick={() => onRespond({ settled_by: 'continue' })}>
          Continue
        </button>
      </div>
    </>
  )
}

export function WaitingCard({ waiting, bot, name, controller }: { waiting: any; bot: any; name: string; controller: any }) {
  const answer = (value: any) => void controller?.answerPrompt(value)
  const respond = (result: any) => void controller?.respondConnection(result)
  if (waiting.kind === 'clarify') {
    return (
      <ChoiceCard
        key={waiting.id}
        questions={waiting.questions || []}
        picks={clarifyPicks(waiting)}
        busy={Boolean(waiting.answering)}
        name={name}
        page={clarifyPage(waiting)}
        pages={clarifyOpenPages(waiting)}
        onPick={(qid, value, page) => void controller?.pickClarify(qid, value, page)}
        onPage={page => void controller?.pageClarify(page)}
        onAnswer={answer}
        footer={<Footer waiting={waiting} bot={bot} />}
      />
    )
  }
  return (
    <div className="gbo-card is-question" role="group" aria-label="Waiting for your answer">
      <div className="gbo-card-title">Waiting for your answer</div>
      <div className="gbo-card-desc">
        {name} {TITLES[waiting.kind] || 'is waiting for you'}
        {waiting.kind !== 'sudo' && waiting.kind !== 'secret' && waiting.text ? `: ${waiting.text}` : '.'}
      </div>
      {waiting.kind === 'connection' ? (
        <ConnectionCard waiting={waiting} onRespond={respond} />
      ) : (
        <ValueCard key={waiting.id} waiting={waiting} onAnswer={answer} />
      )}
      <Footer waiting={waiting} bot={bot} />
    </div>
  )
}
