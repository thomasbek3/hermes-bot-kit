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
// preview frame is sandboxed with scripts only (no same-origin): it cannot
// reach the app, its storage or the bridge.

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
  previewPrelude,
  previewStartHeight,
  splitDirectives,
  workspaceRelPath
} from '../core/directives.js'
import { choiceLetter } from '../core/prompts.js'
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

function useCardFile(scope: DirectiveScope, rel: string | null, poll: boolean) {
  const known = rel && scope.preload ? scope.preload[rel] : undefined
  const [payload, setPayload] = React.useState<any>(() => (known ? cardFromRead(known) : null))
  const { bot, sessionId } = scope
  React.useEffect(() => {
    if (!rel || known) return undefined
    setPayload(null)
    let alive = true
    let timer: any = 0
    const started = Date.now()
    const tick = async () => {
      let next: any
      try {
        next = cardFromRead(await readBotWorkspaceText(bot, rel, sessionId))
      } catch {
        next = { ok: false, reason: 'read' }
      }
      if (!alive) return
      setPayload(next)
      if (!poll || (next.ok && isFinalCard(next.card)) || Date.now() - started > POLL_MAX_MS) return
      timer = timers().setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      timers().clearTimeout(timer)
    }
  }, [bot, sessionId, rel, poll, known])
  return payload
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
                <span className="gbo-ask-label">{action.label}</span>
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
      lastIntent.current = Date.now()
      void scope.sendIntent(decision.prompt).then(
        result => reply(result.ok ? { ok: true } : { ok: false, error: 'undelivered' }),
        () => reply({ ok: false, error: 'undelivered' })
      )
    }
    win.addEventListener('message', onMessage)
    return () => win.removeEventListener('message', onMessage)
  }, [token, scope])
  return (
    <div className="gbo-preview" ref={wrap}>
      {doc ? <iframe ref={frame} className="gbo-preview-frame" title={name} sandbox="allow-scripts" srcDoc={doc} style={{ height }} /> : null}
    </div>
  )
}

function PreviewDirective({ attrs, source, scope }: { attrs: Record<string, string>; source: string; scope: DirectiveScope }) {
  const rel = workspaceRelPath(attrs.file)
  const html = rel ? isHtmlFile(rel) : false
  const known = rel && scope.preload ? scope.preload[rel] : undefined
  const [state, setState] = React.useState<{ text: string; error: string } | null>(() => (known ? { text: String(known.text || ''), error: known.text ? '' : 'not available' } : null))
  const { bot, sessionId } = scope
  React.useEffect(() => {
    if (!rel || !html || known) return undefined
    setState(null)
    let alive = true
    readBotWorkspaceText(bot, rel, sessionId).then(
      result => {
        if (!alive) return
        if (!result || result.binary || typeof result.text !== 'string' || result.truncated) setState({ text: '', error: 'not available' })
        else setState({ text: result.text, error: '' })
      },
      () => alive && setState({ text: '', error: 'not available' })
    )
    return () => {
      alive = false
    }
  }, [bot, sessionId, rel, html, known])
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
