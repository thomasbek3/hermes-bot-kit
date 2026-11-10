// `::card{…}` and `::preview{…}` drawn live in the open Bot Chat (Cards 7,
// part 3; contracts in core/directives.js). Only the transcript of an open
// chat provides DirectiveContext; everywhere else (group rooms, any other
// surface) the directive stays the inert text it was, and markdown keeps
// the SDK renderer's owner-safe mode (sdk.ts MARKDOWN_SAFE_PROPS).
//
// Files come from the bot's own machine, relative to the bot's own session
// (app.ts readBotWorkspaceText). A card polls its JSON every 3 s until it is
// final (30 minutes at most; older messages read once). Buttons and widget
// intents go back to this chat as hidden turns (controller.sendIntent). The
// preview frame is sandboxed with scripts only (no same-origin) and has no
// network (core/directives.js PREVIEW_CSP): it cannot reach the app, its
// storage or the bridge. A page's intent is sent at once only right after
// the user stepped into that frame (seen by this window, never reported by
// the page); otherwise a row under the frame shows the exact text with Send
// and Dismiss. A card row shows what it sends when that differs from its
// label.

import * as React from 'react'

import {
  cardChip,
  cardFromRead,
  cardLead,
  isFinalCard,
  isHtmlFile,
  previewAck,
  previewDocument,
  previewHeightFrom,
  previewIntentFrom,
  previewIntentRoute,
  previewPrelude,
  previewStartHeight,
  splitDirectives,
  workspaceRelPath
} from '../core/directives.js'
import { choiceLetter } from '../core/prompts.js'
import { rowKey } from '../core/roster.js'
import { readBotWorkspaceText } from './app'
import { IconCheck } from './iconsRoster'

const POLL_MS = 3000
const POLL_MAX_MS = 30 * 60_000
const CLICK_THROTTLE_MS = 1000

export interface DirectiveScope {
  bot: any
  /** The open chat's stored session id (file reads resolve against it). */
  sessionId: string
  sendIntent: (text: string) => Promise<{ ok: boolean; error?: string }>
  /** Item ids recent enough for their cards to keep polling. */
  recent: Set<string>
  /** Read results already known, by workspace path (the preview pages). */
  preload?: Record<string, any>
  /** The theme when it cannot be read from the page (the preview pages). */
  theme?: 'dark' | 'light'
}

export const DirectiveContext = React.createContext<DirectiveScope | null>(null)

const timers = () => globalThis as any

// ── card ──────────────────────────────────────────────────────────────────

/** The file a directive reads, as one string: the bot's route key, the chat
 *  and the path. The roster hands the transcript a fresh bot object on every
 *  refresh (every 3 s); keying reads by that object restarted them, blanked
 *  the card to its loading box and drew it again, so the transcript under it
 *  jumped up and down while scrolling. Reads key by this string instead. */
function readKeyFor(scope: DirectiveScope, rel: string | null) {
  return rel ? `${rowKey(scope.bot)}\n${scope.sessionId}\n${rel}` : ''
}

/** The scope's newest bot, for a read that must not restart when only the
 *  object (not the route) changed. */
function useLatest<T>(value: T) {
  const ref = React.useRef(value)
  ref.current = value
  return ref
}

/** A card's file, polled every 3 s while it can still change. A re-read that
 *  returns the same text changes nothing (same state object, no render); a
 *  card keeps what it shows while a re-read is in flight; a final card
 *  (resolved, done, error) is never read again. */
function useCardFile(scope: DirectiveScope, rel: string | null, poll: boolean) {
  const known = rel && scope.preload ? scope.preload[rel] : undefined
  const key = readKeyFor(scope, rel)
  const [state, setState] = React.useState<{ key: string; raw: string; payload: any }>(() => ({ key, raw: '', payload: known ? cardFromRead(known) : null }))
  const latest = useLatest(scope)
  const have = state.key === key ? state : null
  const settled = Boolean(have?.payload?.ok && isFinalCard(have.payload.card))
  const loaded = Boolean(have?.payload)
  React.useEffect(() => {
    if (!rel || known || settled) return undefined
    // Already drawn and no longer polling (an older message): nothing to read.
    if (loaded && !poll) return undefined
    let alive = true
    let timer: any = 0
    const started = Date.now()
    const tick = async () => {
      let raw = ''
      let next: any
      try {
        const result = await readBotWorkspaceText(latest.current.bot, rel, latest.current.sessionId)
        raw = JSON.stringify(result ?? null)
        next = cardFromRead(result)
      } catch {
        raw = '\u0000read'
        next = { ok: false, reason: 'read' }
      }
      if (!alive) return
      setState(prev => (prev.key === key && prev.raw === raw ? prev : { key, raw, payload: next }))
      if (!poll || (next.ok && isFinalCard(next.card)) || Date.now() - started > POLL_MAX_MS) return
      timer = timers().setTimeout(tick, POLL_MS)
    }
    if (loaded) timer = timers().setTimeout(tick, POLL_MS)
    else void tick()
    return () => {
      alive = false
      timers().clearTimeout(timer)
    }
    // `loaded` only gates the first read: flipping it must not restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rel, poll, known, settled])
  return have ? have.payload : null
}

function Rows({ rows }: { rows: [string, string][] }) {
  if (!rows.length) return null
  return (
    <dl className="gbo-dcard-kv">
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

function Body({ body }: { body: any[] }) {
  return (
    <>
      {body.map((block, i) =>
        block.type === 'text' ? (
          <p key={i} className="gbo-dcard-text">
            {block.text}
          </p>
        ) : block.type === 'kv' ? (
          <Rows key={i} rows={block.rows} />
        ) : (
          <Rows key={i} rows={block.items.map((f: any) => [f.label, f.value])} />
        )
      )}
    </>
  )
}

/** The actions as the clarify card's lettered rows (A, B, C…), stacked. A
 *  click sends at once; after it, or once the file says resolved, the rows
 *  stop being clickable and the chosen one is marked as a settled clarify
 *  card marks it. */
function Actions({ card, scope, labelledBy }: { card: any; scope: DirectiveScope; labelledBy: string }) {
  const [sent, setSent] = React.useState('')
  const [error, setError] = React.useState('')
  const last = React.useRef(0)
  const frozen = Boolean(card.resolved || sent)
  const click = async (action: any) => {
    const at = Date.now()
    if (frozen || at - last.current < CLICK_THROTTLE_MS) return
    last.current = at
    setError('')
    setSent(action.label)
    const result = await scope.sendIntent(action.send)
    if (!result.ok) {
      setSent('')
      setError(result.error || 'Not sent')
    }
  }
  const picked = card.resolved ? card.resolved.action : sent
  const matched = card.actions.some((action: any) => action.label === picked)
  if (!card.actions.length && !card.resolved && !error) return null
  return (
    <>
      {card.actions.length ? (
        <div className={`gbo-ask-rows gbo-dcard-rows${frozen ? ' is-settled' : ''}`} role="radiogroup" aria-labelledby={labelledBy}>
          {card.actions.map((action: any, i: number) => {
            const on = action.label === picked
            return (
              <button
                key={action.label}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={frozen}
                className={`gbo-ask-row${on ? ' is-on' : ''}${action.style === 'danger' ? ' is-danger' : ''}`}
                onClick={() => void click(action)}
              >
                <span className="gbo-ask-key" aria-hidden="true">
                  {choiceLetter(i)}
                </span>
                {action.send !== action.label ? (
                  <span className="gbo-ask-label is-stacked">
                    <span className="gbo-ask-label-main">{action.label}</span>
                    <span className="gbo-ask-send" title={action.send}>
                      {action.send}
                    </span>
                  </span>
                ) : (
                  <span className="gbo-ask-label">{action.label}</span>
                )}
                {on ? (
                  <span className="gbo-ask-check" aria-hidden="true">
                    <IconCheck />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
      {card.resolved && !matched ? <div className="gbo-dcard-note">{card.resolved.action}</div> : null}
      {error ? (
        <div className="gbo-card-error" role="alert">
          {error}
        </div>
      ) : null}
    </>
  )
}

/** A live card in the clarify card's shell: the title as the bold heading,
 *  a one-line body as the question under it, a quiet chip only for running,
 *  done and error, then the body blocks and the lettered action rows. */
export function CardView({ card, scope }: { card: any; scope: DirectiveScope }) {
  const email = card.kind === 'draft-email' ? card.email || { to: '', cc: '', subject: '', bodyText: '' } : null
  const chip = cardChip(card)
  const lead = email ? null : cardLead(card)
  const titleId = React.useId()
  const settled = Boolean(card.resolved)
  return (
    <div
      className={`gbo-dcard is-${card.kind} is-${card.status.state}${settled ? ' is-settled' : ''}`}
      data-gbo-card={card.kind}
      role="group"
      aria-labelledby={titleId}
    >
      <div className="gbo-dcard-head">
        <div className="gbo-dcard-title" id={titleId}>
          {email?.subject || card.title}
        </div>
        {chip ? (
          <span className={`gbo-dcard-status is-${chip.state}`} role="status">
            {chip.state === 'running' ? <span className="gbo-dcard-spin" aria-hidden="true" /> : null}
            {chip.label}
          </span>
        ) : null}
      </div>
      {lead ? <p className="gbo-dcard-text is-lead">{lead}</p> : null}
      {email ? <Rows rows={[['To', email.to || '—'], ...(email.cc.trim() ? ([['Cc', email.cc]] as [string, string][]) : [])]} /> : null}
      {email?.bodyText ? <p className="gbo-dcard-text is-email">{email.bodyText}</p> : null}
      {lead ? null : <Body body={card.body} />}
      <Actions card={card} scope={scope} labelledBy={titleId} />
    </div>
  )
}

function CardDirective({ attrs, source, poll, scope }: { attrs: Record<string, string>; source: string; poll: boolean; scope: DirectiveScope }) {
  const rel = workspaceRelPath(attrs.file)
  const payload = useCardFile(scope, rel, poll)
  if (rel && payload === null) return <div className="gbo-dcard is-loading" aria-label="Loading card" />
  if (!rel || !payload?.ok) {
    return (
      <div className="gbo-dcard is-unavailable" title={source}>
        <div className="gbo-dcard-title">{attrs.kind && /^[a-z-]{1,24}$/.test(attrs.kind) ? attrs.kind.replace('-', ' ') : 'Card'}</div>
        <div className="gbo-dcard-note">Card not available</div>
      </div>
    )
  }
  return <CardView card={payload.card} scope={scope} />
}

// ── preview ───────────────────────────────────────────────────────────────

// The frame's tokens before the page can be measured (and where it cannot).
const FALLBACK_THEME = {
  light: { '--foreground': '#1C1C1C', '--muted-foreground': '#1C1C1C8F', '--accent': '#1C1C1C', '--border': '#1C1C1C1F', '--card': '#F0F0F0' },
  dark: { '--foreground': '#F5F5F5', '--muted-foreground': '#F5F5F58A', '--accent': '#F5F5F5', '--border': '#F5F5F51A', '--card': '#242424' }
}
const FALLBACK_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

function themeFor(el: HTMLElement | null, given?: 'dark' | 'light') {
  const doc = (globalThis as any).document
  const style = el && typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const read = (name: string) => style?.getPropertyValue(name).trim() || ''
  const root = doc?.documentElement
  const dark = given ? given === 'dark' : Boolean(root && (root.classList?.contains('dark') || root.dataset?.theme === 'dark' || root.dataset?.hermesMode === 'dark'))
  const scheme = (dark ? 'dark' : 'light') as 'dark' | 'light'
  const fallback = FALLBACK_THEME[scheme]
  return {
    vars: {
      '--foreground': read('--color-text-primary') || fallback['--foreground'],
      '--muted-foreground': read('--color-text-tertiary') || fallback['--muted-foreground'],
      '--accent': read('--color-primary') || fallback['--accent'],
      '--border': read('--color-border-tertiary') || fallback['--border'],
      '--card': read('--color-bubble-agent-flat') || fallback['--card']
    },
    font: style?.fontFamily || FALLBACK_FONT,
    scheme
  }
}

let frameSeq = 0

function PreviewFrame({ html, name, startHeight, scope }: { html: string; name: string; startHeight: number; scope: DirectiveScope }) {
  const wrap = React.useRef<HTMLDivElement | null>(null)
  const frame = React.useRef<HTMLIFrameElement | null>(null)
  const token = React.useMemo(() => `gbo-${Date.now().toString(36)}-${(frameSeq += 1)}-${Math.random().toString(36).slice(2, 10)}`, [])
  const [doc, setDoc] = React.useState(() => {
    const theme = themeFor(null, scope.theme)
    return previewDocument(html, token, previewPrelude(theme.vars, theme.font, theme.scheme))
  })
  const [height, setHeight] = React.useState(startHeight)
  const lastIntent = React.useRef(0)
  // When this window last saw the user step into THIS frame (its blur while
  // the frame is the focused element). The page cannot set it.
  const lastUser = React.useRef(0)
  // The one intent waiting for the user (a newer one replaces it).
  const [pending, setPending] = React.useState<{ id: number | null; prompt: string } | null>(null)
  const pendingRef = React.useRef<typeof pending>(null)
  const sendFromFrame = React.useCallback(
    (prompt: string, reply: (ack: any) => void) => {
      void scope.sendIntent(prompt).then(
        result => reply(result.ok ? { ok: true } : { ok: false, error: 'undelivered' }),
        () => reply({ ok: false, error: 'undelivered' })
      )
    },
    [scope]
  )
  const replyTo = React.useCallback(
    (id: number | null, ack: any) => {
      const source = frame.current?.contentWindow
      if (source && id !== null) source.postMessage(previewAck(token, id, ack), '*')
    },
    [token]
  )
  const hold = (next: { id: number | null; prompt: string } | null) => {
    pendingRef.current = next
    setPending(next)
  }
  React.useEffect(() => {
    const win = (globalThis as any).window
    if (!win?.addEventListener) return undefined
    const seen = () => {
      const el = frame.current
      if (el && win.document?.activeElement === el) lastUser.current = Date.now()
    }
    const onBlur = () => {
      seen()
      // Some engines move focus onto the frame just after the blur.
      timers().setTimeout(seen, 0)
    }
    win.addEventListener('blur', onBlur)
    return () => win.removeEventListener('blur', onBlur)
  }, [])
  React.useLayoutEffect(() => {
    const theme = themeFor(wrap.current, scope.theme)
    setDoc(previewDocument(html, token, previewPrelude(theme.vars, theme.font, theme.scheme)))
  }, [html, token, scope.theme])
  React.useEffect(() => {
    const win = (globalThis as any).window
    if (!win?.addEventListener) return undefined
    const onMessage = (event: MessageEvent) => {
      const source = frame.current?.contentWindow
      if (!source || event.source !== source) return
      const h = previewHeightFrom(event.data, token)
      if (h !== null) {
        setHeight(h)
        return
      }
      const decision = previewIntentFrom(event.data, token, Date.now(), lastIntent.current)
      if (!decision) return
      const reply = (ack: any) => {
        if (decision.id !== null) source.postMessage(previewAck(token, decision.id, ack), '*')
      }
      if (decision.kind === 'reject') return reply(decision.ack)
      const now = Date.now()
      lastIntent.current = now
      if (previewIntentRoute(now, lastUser.current) === 'send') return sendFromFrame(decision.prompt, reply)
      const older = pendingRef.current
      if (older) replyTo(older.id, { ok: false, error: 'replaced' })
      hold({ id: decision.id, prompt: decision.prompt })
    }
    win.addEventListener('message', onMessage)
    return () => win.removeEventListener('message', onMessage)
  }, [token, sendFromFrame, replyTo])
  const send = () => {
    const ask = pendingRef.current
    if (!ask) return
    hold(null)
    sendFromFrame(ask.prompt, ack => replyTo(ask.id, ack))
  }
  const dismiss = () => {
    const ask = pendingRef.current
    if (!ask) return
    hold(null)
    replyTo(ask.id, { ok: false, error: 'dismissed' })
  }
  return (
    <div className="gbo-preview-wrap">
      <div className="gbo-preview" ref={wrap}>
        {doc ? <iframe ref={frame} className="gbo-preview-frame" title={name} sandbox="allow-scripts" srcDoc={doc} style={{ height }} /> : null}
      </div>
      {pending ? (
        <div className="gbo-preview-ask" role="group" aria-label={`${name} wants to send a message`}>
          <div className="gbo-preview-ask-text">
            <span className="gbo-preview-ask-lead">This page wants to send:</span>
            <span className="gbo-preview-ask-prompt">{pending.prompt}</span>
          </div>
          <div className="gbo-preview-ask-actions">
            <button type="button" className="gbo-pill-btn is-primary" onClick={send}>
              Send
            </button>
            <button type="button" className="gbo-pill-btn" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PreviewDirective({ attrs, source, scope }: { attrs: Record<string, string>; source: string; scope: DirectiveScope }) {
  const rel = workspaceRelPath(attrs.file)
  const html = rel ? isHtmlFile(rel) : false
  const known = rel && scope.preload ? scope.preload[rel] : undefined
  const key = readKeyFor(scope, rel)
  const [read, setRead] = React.useState<{ key: string; value: { text: string; error: string } | null }>(() => ({
    key,
    value: known ? { text: String(known.text || ''), error: known.text ? '' : 'not available' } : null
  }))
  const state = read.key === key ? read.value : null
  const latest = useLatest(scope)
  // Read once per file (keyed like the card: a fresh bot object from a roster
  // refresh neither re-reads nor remounts the frame).
  React.useEffect(() => {
    if (!rel || !html || known) return undefined
    let alive = true
    readBotWorkspaceText(latest.current.bot, rel, latest.current.sessionId).then(
      result => {
        if (!alive) return
        if (!result || result.binary || typeof result.text !== 'string' || result.truncated) setRead({ key, value: { text: '', error: 'not available' } })
        else setRead({ key, value: { text: result.text, error: '' } })
      },
      () => alive && setRead({ key, value: { text: '', error: 'not available' } })
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rel, html, known])
  const name = rel ? rel.split('/').pop() || rel : 'Preview'
  if (rel && html && state === null) return <div className="gbo-preview is-loading" aria-label={`Loading ${name}`} />
  if (!rel || !html || state?.error) {
    return (
      <div className="gbo-preview-row" title={source}>
        <span className="gbo-preview-name">{name}</span>
        <span className="gbo-preview-why">{!rel ? 'Preview not available' : !html ? 'Only HTML previews show here' : 'Preview not available'}</span>
      </div>
    )
  }
  return <PreviewFrame html={state!.text} name={name} startHeight={previewStartHeight(attrs.height)} scope={scope} />
}

/** One claimed directive. */
export function DirectiveBlock({ segment, poll, scope }: { segment: any; poll: boolean; scope: DirectiveScope }) {
  return (
    <div className="gbo-directive">
      {segment.name === 'card' ? (
        <CardDirective attrs={segment.attrs} source={segment.source} poll={poll} scope={scope} />
      ) : (
        <PreviewDirective attrs={segment.attrs} source={segment.source} scope={scope} />
      )}
    </div>
  )
}

/** The message split into prose and live directives, or null to render it
 *  as before (no scope: not the open transcript; or no directive in it). */
export function useDirectiveSegments(text: string): { segments: any[] | null; scope: DirectiveScope | null } {
  const scope = React.useContext(DirectiveContext)
  const segments = React.useMemo(() => (scope ? splitDirectives(text) : null), [scope, text])
  return { segments, scope }
}
