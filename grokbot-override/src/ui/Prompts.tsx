// The cards for a turn blocked on the user (PARITY C11): clarify questions,
// sudo / secret / vault prompts and connection operations, answered here
// (core/prompts.js names the gateway calls). Card layout follows Rakazo's
// dialog/settings panels (Apache-2.0, see NOTICE.md); behaviour follows the
// app's own cards: components/prompt-overlays.tsx (closing a password card is
// a refusal, '' ), components/assistant-ui/clarify/pending.tsx (choices, free
// text, multi-select, Skip) and the connection card's Approve / Not now /
// Continue (store/connection-request.ts).
//
// Secrets: inputs are uncontrolled password fields read once on submit and
// cleared; the value is never put in React state, chat state or a log.

import * as React from 'react'

import { openInBotMode } from './app'

const TITLES: Record<string, string> = {
  clarify: 'has a question for you',
  sudo: 'needs your administrator password',
  secret: 'needs a secret value',
  'vault-unlock': 'needs your password manager unlocked',
  'vault-login': 'wants to save a login',
  'vault-code': 'needs a one-time code',
  connection: 'wants to connect'
}

const RECOMMENDED = '(Recommended)'
const bare = (choice: string) => (choice.endsWith(RECOMMENDED) ? choice.slice(0, -RECOMMENDED.length).trim() : choice)

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

function ClarifyCard({ waiting, onAnswer }: { waiting: any; onAnswer: (answer: any) => void }) {
  const questions: any[] = waiting.questions || []
  const [answers, setAnswers] = React.useState<Record<string, any>>(() => ({ ...(waiting.locked || {}) }))
  const [typed, setTyped] = React.useState<Record<string, string>>({})
  const busy = Boolean(waiting.answering)
  const value = (q: any) => (typed[q.qid]?.trim() ? typed[q.qid].trim() : answers[q.qid])
  const complete = questions.every(q => {
    const v = value(q)
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.length > 0
  })
  const submit = (overrides?: Record<string, any>) => {
    const out: Record<string, any> = {}
    for (const q of questions) out[q.qid] = overrides && q.qid in overrides ? overrides[q.qid] : value(q) ?? null
    onAnswer(out)
  }
  const single = questions.length === 1 && !questions[0].multiSelect && questions[0].choices
  return (
    <>
      {questions.map(q => (
        <fieldset key={q.qid} className="gbo-q" disabled={busy}>
          <legend>{q.question}</legend>
          {q.choices ? (
            <div className="gbo-choices" role={q.multiSelect ? 'group' : 'radiogroup'}>
              {q.choices.map((choice: string) => {
                const label = bare(choice)
                const picked = q.multiSelect ? (answers[q.qid] || []).includes(label) : answers[q.qid] === label
                return (
                  <button
                    key={choice}
                    type="button"
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={picked}
                    className={`gbo-choice${picked ? ' is-on' : ''}${choice !== label ? ' is-recommended' : ''}`}
                    onClick={() => {
                      if (single) return submit({ [q.qid]: label })
                      setAnswers(current => {
                        if (!q.multiSelect) return { ...current, [q.qid]: label }
                        const list: string[] = current[q.qid] || []
                        return { ...current, [q.qid]: list.includes(label) ? list.filter(x => x !== label) : [...list, label] }
                      })
                    }}
                  >
                    {label}
                    {choice !== label ? <span className="gbo-choice-tag">Recommended</span> : null}
                  </button>
                )
              })}
            </div>
          ) : null}
          {!q.multiSelect ? (
            <input
              className="gbo-input"
              placeholder={q.choices ? 'Or type your own answer' : 'Your answer'}
              aria-label={q.question}
              value={typed[q.qid] || ''}
              onChange={event => setTyped(current => ({ ...current, [q.qid]: event.target.value }))}
              onKeyDown={event => {
                if (event.key === 'Enter' && questions.length === 1 && event.currentTarget.value.trim()) submit()
              }}
            />
          ) : null}
        </fieldset>
      ))}
      <div className="gbo-card-actions">
        {!single ? (
          <button type="button" className="gbo-pill-btn is-primary" disabled={busy || !complete} onClick={() => submit()}>
            {busy ? 'Sending…' : 'Answer'}
          </button>
        ) : null}
        <button
          type="button"
          className="gbo-pill-btn"
          disabled={busy}
          onClick={() => onAnswer(Object.fromEntries(questions.map(q => [q.qid, null])))}
        >
          Skip
        </button>
      </div>
    </>
  )
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

function openExternal(url: string) {
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
                {target?.connect_url ? (
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
  return (
    <div className="gbo-card is-question" role="group" aria-label="Waiting for your answer">
      <div className="gbo-card-title">Waiting for your answer</div>
      <div className="gbo-card-desc">
        {name} {TITLES[waiting.kind] || 'is waiting for you'}
        {waiting.kind !== 'clarify' && waiting.kind !== 'sudo' && waiting.kind !== 'secret' && waiting.text ? `: ${waiting.text}` : '.'}
      </div>
      {waiting.kind === 'clarify' ? (
        <ClarifyCard key={waiting.id} waiting={waiting} onAnswer={answer} />
      ) : waiting.kind === 'connection' ? (
        <ConnectionCard waiting={waiting} onRespond={respond} />
      ) : (
        <ValueCard key={waiting.id} waiting={waiting} onAnswer={answer} />
      )}
      <Footer waiting={waiting} bot={bot} />
    </div>
  )
}
