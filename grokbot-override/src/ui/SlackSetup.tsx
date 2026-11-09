// The profile panel's Slack cards, exactly one of two per bot
// (core/slack.js slackPanelCard), both under the scheduled jobs and above
// Computer:
//  - no Slack on the profile: a Suggested section (a one-line "Add to Slack"
//    card, Hide beside the caption) that opens "Bring <Bot> to Slack": create
//    the Slack app from a manifest, paste two tokens, connect (with a restart
//    on the user's click when the gateway needs one), approve the first DM;
//  - Slack set up: a "Slack · <status>" card that opens "<Bot> is in Slack"
//    (status rows, Test connection through the slack-check add-on, Open
//    Slack; no token editing).
// Both dialogs use kit Sheet: a centred card with the mark on top, a centred
// title and subtitle, the step body, Cancel on the left and a pill on the
// right. Calls: ./slackActions.ts.
//
// The two tokens live only in this dialog's React state, in password inputs:
// they are cleared on close, never logged, stored or shown back.

import * as React from 'react'

import { displayName, rowKey } from '../core/roster.js'
import {
  slackCheckedLabel,
  slackCheckVerdict,
  slackConnectedText,
  slackPanelCard,
  slackRowMessage,
  slackRestartWarning,
  slackStatus,
  slackStatusRows,
  slackTestVerdict,
  slackTokenError,
  slackWorkspaceName,
  SLACK_CHECK_HINT,
  SLACK_OPEN_URL,
  SLACK_PAIRING_POLL_MAX_MS,
  SLACK_PAIRING_POLL_MS,
  SLACK_RESTART_TIMEOUT_TEXT,
  withoutSecrets
} from '../core/slack.js'
import { metaFor } from './app'
import { IconChevron } from './icons'
import { IconCheck } from './iconsRoster'
import { Sheet } from './kit'
import { openDialog } from './rosterStores'
import {
  approveSlackPairing,
  checkSlack,
  checkSlackLive,
  connectSlack,
  hideSlackCard,
  loadSlackHidden,
  loadSlackState,
  openExternalLink,
  openSlackCreateApp,
  probeSlackProvisioning,
  readSlackPairings,
  restartBotGateway,
  slack,
  slackCheckCache,
  waitForSlack
} from './slackActions'
import { useStore } from './store'
import { SlackConnect } from './SlackConnect'

/** A small four-colour chat mark, drawn for the override. */
export const SlackMark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="gbo-slack-mark">
    <rect x="3" y="8.5" width="8.5" height="3" rx="1.5" fill="#36C5F0" />
    <rect x="8.5" y="3" width="3" height="4.5" rx="1.5" fill="#36C5F0" />
    <rect x="12.5" y="3" width="3" height="8.5" rx="1.5" fill="#2EB67D" />
    <rect x="16.5" y="8.5" width="4.5" height="3" rx="1.5" fill="#2EB67D" />
    <rect x="12.5" y="12.5" width="8.5" height="3" rx="1.5" fill="#ECB22E" />
    <rect x="12.5" y="16.5" width="3" height="4.5" rx="1.5" fill="#ECB22E" />
    <rect x="8.5" y="12.5" width="3" height="8.5" rx="1.5" fill="#E01E5A" />
    <rect x="3" y="12.5" width="4.5" height="3" rx="1.5" fill="#E01E5A" />
  </svg>
)

const Emblem = () => <SlackMark size={40} />
const Out = () => <span className="gbo-sheet-out" aria-hidden>↗</span>

function Intro({ name }: { name: string }) {
  return <p className="gbo-sheet-text">You can DM or @mention {name} in Slack. It’ll respond with the same skills, context and memories it uses here.</p>
}

/** Suggested → Add to Slack (one line), only for a bot whose profile has no
 *  Slack yet. Always mounted in the panel: it loads the bot's Slack state for
 *  both cards. */
export function SuggestedSlack({ bot }: { bot: any }) {
  const state = useStore(slack.state)
  const hidden = useStore(slack.hidden)
  const key = rowKey(bot)
  React.useEffect(() => {
    loadSlackHidden()
  }, [])
  React.useEffect(() => {
    void loadSlackState(bot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (state.key === key && ['created', 'installed', 'connected', 'denied', 'error'].includes(state.connectStatus?.phase)) return null
  if (slackPanelCard(state, key, hidden) !== 'suggested') return null
  const name = displayName(bot, metaFor(bot))
  return (
    <section className="gbo-panel-section" aria-label="Suggested">
      <div className="section-label section-label--row gbo-panel-label">
        <span>Suggested</span>
        <button type="button" className="link-btn link-btn--small gbo-suggest-hide" onClick={() => hideSlackCard(bot)}>
          Hide
        </button>
      </div>
      <div className="panel-card gbo-panel-box">
        <button type="button" className="panel-row panel-row--link gbo-slack-card gbo-suggest-card" title={`Bring ${name} to Slack`} onClick={() => openDialog({ kind: 'slack', bot })}>
          <span className="panel-row__glyph gbo-slack-card-mark">
            <SlackMark />
          </span>
          <span className="panel-row__title gbo-slack-card-line">Add to Slack</span>
          <IconChevron />
        </button>
      </div>
    </section>
  )
}

/** Slack · <status>, for a bot whose profile has Slack (its own card between
 *  the scheduled jobs and Computer, no caption). Reads the state
 *  SuggestedSlack loads. */
export function SlackStatusCard({ bot }: { bot: any }) {
  const state = useStore(slack.state)
  const hidden = useStore(slack.hidden)
  const phase = state.key === rowKey(bot) ? state.connectStatus?.phase : null
  if (!['created', 'installed', 'connected', 'denied', 'error'].includes(phase) && slackPanelCard(state, rowKey(bot), hidden) !== 'status') return null
  const status = ['created', 'installed', 'connected', 'denied', 'error'].includes(phase)
    ? { label: phase === 'connected' ? 'Connected' : phase === 'denied' || phase === 'error' ? 'Needs attention' : 'Connecting…', tone: phase === 'connected' ? 'ok' : 'warn' }
    : slackStatus(state.platform, { served: Boolean(state.served), gateway: state.gateway })
  return (
    <section className="gbo-panel-section gbo-slack-section">
      <div className="panel-card gbo-panel-box">
        <button type="button" className="panel-row panel-row--link gbo-slack-card is-status" title={`Slack · ${status?.label || ''}`} onClick={() => openDialog({ kind: 'slack-status', bot })}>
          <span className="panel-row__glyph gbo-slack-card-mark">
            <SlackMark />
          </span>
          <span className="panel-row__text gbo-slack-card-text">
            <span className="panel-row__title gbo-slack-card-title">Slack</span>
            <span className={`panel-row__sub gbo-slack-card-sub is-${status?.tone || 'warn'}`}>{status?.label}</span>
          </span>
          <IconChevron />
        </button>
      </div>
    </section>
  )
}

/** "<Bot> is in Slack": what the payload says, Test connection (the
 *  slack-check add-on asks Slack itself), Open Slack. Without the add-on
 *  (404) there is no Test connection, only a muted hint, for 10 minutes. */
function LegacySlackStatusDialog({ bot, onClose }: { bot: any; onClose: () => void }) {
  const state = useStore(slack.state)
  useStore(slack.checks)
  const key = rowKey(bot)
  const entry = state.key === key ? state.platform : null
  const served = state.key === key && Boolean(state.served)
  const name = displayName(bot, metaFor(bot))
  const [testing, setTesting] = React.useState(false)
  const [result, setResult] = React.useState<null | { tone: string; message: string; lines: string[]; log: string }>(null)
  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const gateway = state.key === key ? state.gateway : null
  const cache = slackCheckCache(bot)
  const rows = slackStatusRows(entry, { served, gateway }).map(row =>
    row.label === 'Status' && cache.ok ? { ...row, value: slackCheckedLabel(cache.ok.at) } : row
  )
  const testable = Boolean(entry) && !cache.missing
  const workspace = slackWorkspaceName(entry)
  const message = slackRowMessage(entry)
  const test = async () => {
    setTesting(true)
    setResult(null)
    const outcome = await checkSlackLive(bot)
    if (!alive.current) return
    setResult(outcome.kind === 'missing' ? null : slackCheckVerdict(outcome))
    setTesting(false)
    void loadSlackState(bot)
  }
  return (
    <Sheet
      onClose={onClose}
      label={`${name} is in Slack`}
      emblem={<Emblem />}
      title={`${name} is in Slack`}
      subtitle="Uses its own Slack app"
      footer={
        <>
          {testable ? (
            <button type="button" className="gbo-sheet-cancel" disabled={testing} onClick={() => void test()}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          ) : (
            <button type="button" className="gbo-sheet-cancel" onClick={onClose}>
              Close
            </button>
          )}
          <button type="button" className="gbo-sheet-primary" onClick={() => openExternalLink(SLACK_OPEN_URL)}>
            Open Slack <Out />
          </button>
        </>
      }
    >
      <Intro name={name} />
      {workspace ? (
        <div className="gbo-sheet-choice is-checked">
          <span className="gbo-sheet-check">
            <IconCheck />
          </span>
          <span>{workspace}</span>
        </div>
      ) : null}
      {entry ? (
        <div className="gbo-sheet-rows">
          {rows.map(row => (
            <div key={row.label} className="gbo-sheet-row">
              <span>{row.label}</span>
              <span title={row.value}>{row.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="gbo-sheet-note">{state.loading ? 'Loading…' : 'Slack status is not known yet.'}</div>
      )}
      {message ? <div className="gbo-form-error">{message}</div> : null}
      {result ? (
        <div className={`gbo-slack-check is-${result.tone}`} role="status">
          {/* One green line: who answered, where, and the app connection. */}
          <div className={result.tone === 'ok' ? 'gbo-slack-ok' : 'gbo-form-error'}>
            {[result.message, ...result.lines.filter(line => result.tone === 'ok' && !/failed/.test(line))].join(' · ')}
          </div>
          {result.lines
            .filter(line => result.tone !== 'ok' || /failed/.test(line))
            .map(line => (
              <div key={line} className="gbo-form-error">
                {line}
              </div>
            ))}
          {result.log ? (
            <div className="gbo-slack-log" title={result.log}>
              {result.log}
            </div>
          ) : null}
        </div>
      ) : null}
      {cache.missing ? <div className="gbo-slack-hint">{SLACK_CHECK_HINT}</div> : null}
    </Sheet>
  )
}

export type SlackStage = 'create' | 'tokens' | 'restart' | 'restarting' | 'restart-timeout' | 'connected'

/** Display-only starting point (preview pages and tests). Never tokens. */
export interface SlackDialogInitial {
  stage?: SlackStage
  error?: null | string
  note?: null | string
  pending?: any[]
}

function sleep(ms: number, cancelled: () => boolean) {
  return new Promise<void>(resolve => {
    const id = setTimeout(resolve, ms)
    if (cancelled()) {
      clearTimeout(id)
      resolve()
    }
  })
}

const STEP_NAMES = ['Create the Slack app', 'Paste two tokens', 'Connect', 'Approve your first DM']

/** "Bring <Bot> to Slack": the four setup steps. */
function LegacySlackDialog({ bot, initial, onClose }: { bot: any; initial?: SlackDialogInitial; onClose: () => void }) {
  const name = displayName(bot, metaFor(bot))
  const [stage, setStage] = React.useState<SlackStage>(initial?.stage || 'create')
  const [appToken, setAppToken] = React.useState('')
  const [botToken, setBotToken] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(initial?.error ?? null)
  const [note, setNote] = React.useState<null | string>(initial?.note ?? null)
  const [pending, setPending] = React.useState<any[]>(initial?.pending || [])
  const [approving, setApproving] = React.useState('')
  const [approved, setApproved] = React.useState<string[]>([])
  const [polling, setPolling] = React.useState(false)
  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const gone = () => !alive.current

  const close = () => {
    setAppToken('')
    setBotToken('')
    onClose()
  }

  // Step 4: after connecting, look for a pending Slack DM every 3 s for 2 min
  // while the dialog is open.
  React.useEffect(() => {
    if (stage !== 'connected' || initial?.pending) return
    let stopped = false
    const done = () => stopped || gone()
    setPolling(true)
    void (async () => {
      const started = Date.now()
      while (!done() && Date.now() - started < SLACK_PAIRING_POLL_MAX_MS) {
        try {
          const rows = await readSlackPairings(bot)
          if (done()) return
          setPending(rows)
        } catch {
          /* try again next tick */
        }
        await sleep(SLACK_PAIRING_POLL_MS, done)
      }
      if (!done()) setPolling(false)
    })()
    return () => {
      stopped = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  const appError = appToken ? slackTokenError('app', appToken) : null
  const botError = botToken ? slackTokenError('bot', botToken) : null
  const ready = !slackTokenError('app', appToken) && !slackTokenError('bot', botToken)

  const connect = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    const secrets = [appToken, botToken]
    try {
      const result = await connectSlack(bot, { appToken, botToken })
      if (gone()) return
      setAppToken('')
      setBotToken('')
      if (result.hotServed) {
        // A hot-served profile is a served secondary: see slackTestVerdict.
        const verdict = slackTestVerdict(result.test, { served: true })
        setNote(verdict && verdict.tone === 'error' ? withoutSecrets(verdict.message, secrets) : null)
        setStage('connected')
      } else {
        setStage('restart')
      }
    } catch (failure: any) {
      if (!gone()) setError(withoutSecrets(String(failure?.message || failure), secrets))
    } finally {
      if (!gone()) setBusy(false)
    }
  }

  const waitThenTest = async () => {
    setError(null)
    setStage('restarting')
    const outcome = await waitForSlack(bot, gone)
    if (gone() || outcome === 'cancelled') return
    if (outcome === 'timeout') {
      setStage('restart-timeout')
      return
    }
    const test = await checkSlack(bot)
    if (gone()) return
    setNote(test.ok ? null : test.message)
    setStage('connected')
    void loadSlackState(bot)
  }

  const restart = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await restartBotGateway(bot)
    } catch (failure: any) {
      if (!gone()) {
        setError(String(failure?.message || failure))
        setBusy(false)
      }
      return
    }
    if (gone()) return
    setBusy(false)
    await waitThenTest()
  }

  const approve = async (row: any) => {
    setApproving(row.request_id)
    setError(null)
    try {
      await approveSlackPairing(bot, row.request_id)
      if (gone()) return
      setApproved(list => [...list, row.request_id])
      setPending(list => list.filter(p => p.request_id !== row.request_id))
    } catch (failure: any) {
      if (!gone()) setError(String(failure?.message || failure))
    } finally {
      if (!gone()) setApproving('')
    }
  }

  const order: SlackStage[] = ['create', 'tokens', 'restart', 'connected']
  const at = Math.max(0, order.indexOf(stage === 'restarting' || stage === 'restart-timeout' ? 'restart' : stage))
  const cancel = (label = 'Cancel') => (
    <button type="button" className="gbo-sheet-cancel" disabled={busy} onClick={close}>
      {label}
    </button>
  )

  let body: React.ReactNode = null
  let footer: React.ReactNode = null
  if (stage === 'create') {
    body = (
      <div className="gbo-sheet-note">
        Pick your workspace, press Create, then Install to Workspace.{' '}
        <button type="button" className="gbo-link-btn" onClick={() => setStage('tokens')}>
          I already have the app
        </button>
      </div>
    )
    footer = (
      <>
        {cancel()}
        <button
          type="button"
          className="gbo-sheet-primary"
          onClick={() => {
            openSlackCreateApp(bot)
            setStage('tokens')
          }}
        >
          Create Slack app <Out />
        </button>
      </>
    )
  } else if (stage === 'tokens') {
    body = (
      <form
        className="gbo-sheet-form"
        autoComplete="off"
        onSubmit={event => {
          event.preventDefault()
          void connect()
        }}
      >
        <label className="gbo-sheet-field">
          <span>App-level token</span>
          <input
            className="gbo-input"
            type="password"
            name="slack-app-level"
            autoComplete="off"
            spellCheck={false}
            placeholder="xapp-…"
            aria-label="App-level token"
            aria-invalid={Boolean(appError)}
            value={appToken}
            disabled={busy}
            onChange={e => setAppToken(e.target.value)}
          />
          <span className={`gbo-field-hint${appError ? ' is-error' : ''}`}>{appError || 'Basic Information → App-Level Tokens → Generate, with connections:write.'}</span>
        </label>
        <label className="gbo-sheet-field">
          <span>Bot token</span>
          <input
            className="gbo-input"
            type="password"
            name="slack-bot"
            autoComplete="off"
            spellCheck={false}
            placeholder="xoxb-…"
            aria-label="Bot token"
            aria-invalid={Boolean(botError)}
            value={botToken}
            disabled={busy}
            onChange={e => setBotToken(e.target.value)}
          />
          <span className={`gbo-field-hint${botError ? ' is-error' : ''}`}>{botError || 'OAuth & Permissions → Bot User OAuth Token.'}</span>
        </label>
        <button type="button" className="gbo-link-btn gbo-sheet-back" disabled={busy} onClick={() => setStage('create')}>
          ← Back to creating the app
        </button>
        <button type="submit" hidden />
      </form>
    )
    footer = (
      <>
        {cancel()}
        <button type="button" className="gbo-sheet-primary" disabled={!ready || busy} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </>
    )
  } else if (stage === 'restart' || stage === 'restarting' || stage === 'restart-timeout') {
    body = (
      <>
        <div className="gbo-sheet-note">{slackConnectedText(name, { hotServed: false })}</div>
        {stage === 'restart' ? <div className="gbo-sheet-warn">{slackRestartWarning(name)}</div> : null}
        {stage === 'restarting' ? <div className="gbo-sheet-note">Restarting {name}’s connection…</div> : null}
        {stage === 'restart-timeout' ? <div className="gbo-sheet-note">{SLACK_RESTART_TIMEOUT_TEXT}</div> : null}
      </>
    )
    footer = (
      <>
        {cancel(stage === 'restart' ? 'Cancel' : 'Close')}
        {stage === 'restart-timeout' ? (
          <button type="button" className="gbo-sheet-primary" onClick={() => void waitThenTest()}>
            Check again
          </button>
        ) : (
          <button type="button" className="gbo-sheet-primary" disabled={busy || stage === 'restarting'} onClick={() => void restart()}>
            {busy || stage === 'restarting' ? 'Restarting…' : 'Restart now'}
          </button>
        )}
      </>
    )
  } else {
    body = (
      <>
        {note ? (
          <div className="gbo-form-error">Saved, but the check failed: {note}</div>
        ) : (
          <div className="gbo-slack-ok">{slackConnectedText(name, { hotServed: true })}</div>
        )}
        <div className="gbo-slack-pairing" aria-label="First DM">
          <div className="gbo-sheet-hint">
            {pending.length
              ? 'Someone sent a first DM. Approve it so they can chat:'
              : polling
                ? `Waiting for your first DM to ${name}…`
                : approved.length
                  ? 'Approved. They can chat now.'
                  : `When someone DMs ${name} for the first time, approve them in Hermes’s Messaging settings.`}
          </div>
          {pending.map(row => (
            <div key={row.request_id} className="gbo-sheet-choice">
              <span title={String(row.user_id || '')}>{String(row.user_name || row.user_id || 'Slack user')}</span>
              <button type="button" className="gbo-sheet-primary is-small" disabled={approving === row.request_id} onClick={() => void approve(row)}>
                {approving === row.request_id ? 'Approving…' : 'Approve'}
              </button>
            </div>
          ))}
        </div>
      </>
    )
    footer = (
      <>
        <span />
        <button type="button" className="gbo-sheet-primary" onClick={close}>
          Done
        </button>
      </>
    )
  }

  return (
    <Sheet onClose={close} busy={busy} label={`Bring ${name} to Slack`} emblem={<Emblem />} title={`Bring ${name} to Slack`} subtitle="Uses its own Slack app" footer={footer}>
      <Intro name={name} />
      <div className="gbo-sheet-step" aria-label={`Step ${at + 1} of 4`}>
        Step {at + 1} of 4 · {STEP_NAMES[at]}
      </div>
      {error ? <div className="gbo-form-error">{error}</div> : null}
      {body}
    </Sheet>
  )
}

/** Probe without replacing the existing Socket Mode or missing-plugin flows. */
function SlackConnectRouter({ bot, initial, onClose, status }: { bot: any; initial?: SlackDialogInitial; onClose: () => void; status: boolean }) {
  const [result, setResult] = React.useState<any>(initial ? { kind: 'missing' } : null)
  React.useEffect(() => {
    if (initial) return
    let cancelled = false
    setResult(null)
    void probeSlackProvisioning(bot).then(value => { if (!cancelled) setResult(value) })
    return () => { cancelled = true }
  }, [bot, initial])
  if (result?.kind === 'missing' || (result?.kind === 'available' && (result.status?.mode === 'socket' || (status && result.bootstrap)))) {
    return status ? <LegacySlackStatusDialog bot={bot} onClose={onClose} /> : <LegacySlackDialog bot={bot} initial={initial} onClose={onClose} />
  }
  if (result?.kind === 'available') return <SlackConnect bot={bot} name={displayName(bot, metaFor(bot))} initial={result} onClose={onClose} />
  return <Sheet onClose={onClose} label="Slack connection" title="Slack connection" emblem={<SlackMark size={40} />} footer={<button type="button" className="gbo-sheet-cancel" onClick={onClose}>Close</button>}><div className="gbo-sheet-note">{result?.kind === 'error' ? withoutSecrets(result.message, []) : 'Loading…'}</div></Sheet>
}

export function SlackDialog({ bot, initial, onClose }: { bot: any; initial?: SlackDialogInitial; onClose: () => void }) {
  return <SlackConnectRouter bot={bot} initial={initial} onClose={onClose} status={false} />
}

export function SlackStatusDialog({ bot, onClose }: { bot: any; onClose: () => void }) {
  const state = useStore(slack.state)
  const vars = state.key === rowKey(bot) && Array.isArray(state.platform?.env_vars) ? state.platform.env_vars : []
  if (vars.some((entry: any) => entry?.key === 'SLACK_APP_TOKEN' && entry?.is_set === true)) return <LegacySlackStatusDialog bot={bot} onClose={onClose} />
  return <SlackConnectRouter bot={bot} onClose={onClose} status />
}
