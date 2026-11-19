import * as React from 'react'
import { ACCESS_CHOICES, accessBody, accessChoices, audienceView, isSlackAuthorizationUrl, needsWorkspace, refreshTokenError, workspaceLabel } from '../core/slackConnect.js'
import { slackError } from '../core/slack.js'
import { Sheet } from './kit'
import { openExternalLink, slack, slackProvisioning, slackWorkspaceProvisioning, enableSlackProvisioning, loadSlackState } from './slackActions'
import { SlackMark } from './SlackSetup'

type Props = { bot: any; name: string; initial: any; onClose: () => void }

/** Slack app provisioning for a single profile. */
export function SlackConnect({ bot, name, initial, onClose }: Props) {
  const [workspaces, setWorkspaces] = React.useState<any[]>(initial.workspaces)
  const [selected, setSelected] = React.useState((initial.workspaces.find((w: any) => w?.ok !== false) || initial.workspaces[0])?.team_id || '')
  const [phase, setPhase] = React.useState(initial.status?.phase || 'none')
  const [teamName, setTeamName] = React.useState(initial.status?.team_name || '')
  // No usable workspace token yet: open on adding one.
  const [adding, setAdding] = React.useState(needsWorkspace(initial.workspaces))
  const [refresh, setRefresh] = React.useState('')
  const [authorize, setAuthorize] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [confirm, setConfirm] = React.useState(false)
  const [error, setError] = React.useState('')
  const [timedOut, setTimedOut] = React.useState(false)
  const [testResult, setTestResult] = React.useState('')
  const [needsBootstrap, setNeedsBootstrap] = React.useState(Boolean(initial.bootstrap))
  // Who can talk to the bot: the whole team by default.
  const [access, setAccess] = React.useState<string>(ACCESS_CHOICES.some(c => c.id === initial.status?.access) ? initial.status.access : 'members')
  const [allowed, setAllowed] = React.useState('')
  const [audience, setAudience] = React.useState<any>(audienceView(initial.status))
  const [changing, setChanging] = React.useState(false)
  // The profile has a bot token: Cancel or close never deletes the app then;
  // only Remove from Slack (with its confirmation) does.
  const [tokenInstalled, setTokenInstalled] = React.useState(initial.status?.token_installed === true)
  const phaseRef = React.useRef(phase)
  const tokenRef = React.useRef(tokenInstalled)
  const alive = React.useRef(true)
  phaseRef.current = phase
  tokenRef.current = tokenInstalled
  const noteToken = (status: any) => { if (typeof status?.token_installed === 'boolean') setTokenInstalled(status.token_installed) }
  React.useEffect(() => () => { alive.current = false }, [])
  React.useEffect(() => {
    if (phase !== 'created' && phase !== 'installed') return
    let stopped = false
    const started = Date.now()
    const tick = async () => {
      if (stopped) return
      if (Date.now() - started >= 600_000) { setTimedOut(true); return }
      try {
        const status: any = await slackProvisioning(bot, 'status')
        if (stopped) return
        if (status?.team_name) setTeamName(status.team_name)
        noteToken(status)
        const view = audienceView(status)
        if (view) setAudience(view)
        if (['created', 'installed', 'connected', 'denied', 'error'].includes(status?.phase)) setPhase(status.phase)
        if (status?.phase === 'connected') void loadSlackState(bot)
      } catch { /* Keep polling until the deadline. */ }
      if (!stopped) timer = setTimeout(tick, 2000)
    }
    let timer = setTimeout(tick, 2000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [bot, phase])
  // While the window is open on a connected bot, keep who-can-talk current
  // (a member sync or a settings change shows without reopening). The
  // audience route reads local state only; live checks run on open and on
  // Test connection.
  React.useEffect(() => {
    if (phase !== 'connected') return
    const timer = setInterval(async () => {
      try {
        const view = audienceView(await slackProvisioning(bot, 'audience'))
        if (view && alive.current) setAudience(view)
      } catch { /* The next poll retries. */ }
    }, 20_000)
    return () => clearInterval(timer)
  }, [bot, phase])

  const failure = (err: any, secrets: string[] = []) => slackError(err, 'Slack connection failed', secrets).message
  const add = async () => {
    if (refreshTokenError(refresh) || busy) return
    setBusy(true); setError('')
    const token = refresh.trim()
    try {
      const result: any = await slackWorkspaceProvisioning(bot, needsBootstrap, 'POST', { refresh_token: token })
      const rows: any = await slackWorkspaceProvisioning(bot, needsBootstrap)
      if (!alive.current) return
      setRefresh(''); setWorkspaces(rows); setSelected(result.team_id); setAdding(false)
    } catch (err) { if (alive.current) setError(failure(err, [token])) }
    finally { if (alive.current) setBusy(false) }
  }
  const connect = async () => {
    if (!selected || busy) return
    setBusy(true); setError('')
    try {
      const who = accessBody(access, allowed)
      if (who.error) { setError(who.error); return }
      if (needsBootstrap) { await enableSlackProvisioning(bot); setNeedsBootstrap(false) }
      const result: any = await slackProvisioning(bot, 'connect', 'POST', { team_id: selected, bot_name: name, ...who.body })
      if (!alive.current) return
      setPhase('created')
      if (!isSlackAuthorizationUrl(result.authorize_url)) { setError('Slack returned an invalid authorization link. Cancel to remove the incomplete app.'); return }
      setAuthorize(result.authorize_url); openExternalLink(result.authorize_url)
    } catch (err) { if (alive.current) setError(failure(err)) }
    finally { if (alive.current) setBusy(false) }
  }
  // confirmed: the explicit Remove from Slack. Otherwise a cancel, which the
  // server refuses for an app whose bot token is installed.
  const remove = async (close = false, confirmed = false) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (confirmed) await slackProvisioning(bot, 'remove', 'POST', { confirm: true })
      else await slackProvisioning(bot, 'connect', 'DELETE')
      if (!alive.current) return
      setAuthorize(''); setPhase('none'); setConfirm(false); setTokenInstalled(false); void loadSlackState(bot)
      if (close) onClose()
    } catch (err) { if (alive.current) setError(failure(err)) }
    finally { if (alive.current) setBusy(false) }
  }
  const close = () => {
    setRefresh('')
    if (['created', 'denied', 'error'].includes(phaseRef.current) && !tokenRef.current) void remove(true)
    else onClose()
  }
  const applyAccess = async (mode = access, list = allowed) => {
    if (busy) return
    const who = accessBody(mode, list)
    if (who.error) { setError(who.error); return }
    setBusy(true); setError('')
    try {
      const status: any = await slackProvisioning(bot, 'access', 'POST', who.body)
      if (!alive.current) return
      setAudience(audienceView(status)); setChanging(false)
    } catch (err) { if (alive.current) setError(failure(err)) }
    finally { if (alive.current) setBusy(false) }
  }
  const accessPicker = (
    <fieldset className="gbo-slack-access">
      <legend className="gbo-sheet-text">Who can talk to {name} in Slack</legend>
      {accessChoices(audience?.ownerKnown ?? true).map(c => (
        <label key={c.id} className="gbo-sheet-choice" title={c.hint}>
          <input className="gbo-slack-access-choice" type="radio" name="slack-access" checked={access === c.id} onChange={() => setAccess(c.id)} />
          <span>{c.label}<span className="gbo-field-hint"> · {c.hint}</span></span>
        </label>
      ))}
      {access === 'list' ? <label className="gbo-sheet-field"><span>Member IDs</span><input className="gbo-input gbo-slack-access-list" spellCheck={false} value={allowed} onChange={e => setAllowed(e.target.value)} placeholder="U0123ABCD, U0456EFGH" /></label> : null}
      {audience && !audience.ownerKnown ? <p className="gbo-field-hint gbo-slack-reconnect-hint">To choose Only me, reconnect the bot.</p> : null}
      <p className="gbo-field-hint">Anyone who can talk to {name} can ask it to use its tools, and it acts with its own access. Give it only the tools you are happy for all of them to use.</p>
    </fieldset>
  )
  const audienceBlock = audience ? (
    <div className={`gbo-sheet-note gbo-slack-audience${audience.open || audience.grants.length || audience.stale ? ' is-warning' : ''}`} role="status">
      {audience.legacy ? <div className="gbo-slack-legacy">{audience.legacy.text}</div> : null}
      <div>{audience.text}</div>
      {audience.sync ? <div className="gbo-field-hint gbo-slack-sync">{audience.sync}</div> : null}
      {audience.welcomeError ? <div className="gbo-field-hint gbo-slack-welcome">Welcome message couldn’t be sent: {audience.welcomeError}</div> : null}
      {audience.grants.length ? <ul className="gbo-slack-extra-grants">{audience.grants.map((g: any) => <li key={g.what + g.source}>{g.what} ({g.source}). To change: {g.how}</li>)}</ul> : null}
    </div>
  ) : null
  // A bot connected before team access keeps its list until the owner picks.
  const legacyChoices = audience?.legacy ? (
    <div className="gbo-slack-legacy-choices">
      {audience.legacy.ids.length ? <button type="button" className="gbo-link-btn gbo-slack-legacy-keep" disabled={busy} onClick={() => void applyAccess('list', audience.legacy.ids.join(','))}>Keep these people</button> : null}
      <button type="button" className="gbo-link-btn gbo-slack-legacy-members" disabled={busy} onClick={() => void applyAccess('members', '')}>Everyone in the workspace</button>
      {audience.ownerKnown ? <button type="button" className="gbo-link-btn gbo-slack-legacy-owner" disabled={busy} onClick={() => void applyAccess('owner', '')}>Only me</button> : <p className="gbo-field-hint gbo-slack-reconnect-hint">To choose Only me, reconnect the bot.</p>}
    </div>
  ) : null
  const testConnection = async () => {
    if (busy) return
    setBusy(true); setTestResult(''); setError('')
    try {
      const status: any = await slackProvisioning(bot, 'status')
      if (!alive.current) return
      noteToken(status)
      setTestResult(status?.phase === 'connected'
        ? 'Slack authentication and the bot’s events endpoint are working.'
        : 'Slack could not confirm the bot’s connection. Try again shortly.')
      void loadSlackState(bot)
    } catch (err) { if (alive.current) setError(failure(err)) }
    finally { if (alive.current) setBusy(false) }
  }
  const connected = phase === 'connected'
  const waiting = phase === 'created' || phase === 'installed'
  const workspace = teamName || workspaceLabel(workspaces.find(w => w.team_id === selected) || { team_id: selected }, Object.values(slack.checks.get()))
  const title = confirm ? `Remove the Slack app for ${name}?` : connected ? `Connected to ${workspace} Slack` : adding ? 'Connect another workspace' : `Bring ${name} to Slack`
  const cancel = <button type="button" className="gbo-sheet-cancel" disabled={busy} onClick={confirm ? () => setConfirm(false) : close}>Cancel</button>
  let body: React.ReactNode
  let footer: React.ReactNode
  if (confirm) {
    body = <p className="gbo-sheet-text">This deletes the app from the Slack workspace. Teammates can no longer reach {name} from Slack until it is added again.</p>
    footer = <>{cancel}<button type="button" className="gbo-sheet-primary gbo-slack-remove-primary" disabled={busy} onClick={() => void remove(false, true)}>Remove</button></>
  } else if (connected) {
    body = <><p className="gbo-sheet-text">You can DM or @mention {name} in {workspace} Slack. It’ll respond with the same plugins, context, and memories it uses here.</p>{audienceBlock}{legacyChoices}{changing ? <>{accessPicker}<button type="button" className="gbo-sheet-primary is-small gbo-slack-access-apply" disabled={busy} onClick={() => void applyAccess()}>Apply</button></> : <button type="button" className="gbo-link-btn gbo-slack-access-change" disabled={busy} onClick={() => setChanging(true)}>Change who can talk to it</button>}{testResult ? <div className="gbo-sheet-note" role="status">{testResult}</div> : null}</>
    footer = <><button type="button" className="gbo-sheet-cancel" disabled={busy} onClick={() => void testConnection()}>{busy ? 'Testing…' : 'Test connection'}</button><button type="button" className="gbo-sheet-cancel gbo-slack-remove" disabled={busy} onClick={() => setConfirm(true)}>Remove from Slack</button><button type="button" className="gbo-sheet-primary" disabled={busy} onClick={onClose}>Done</button></>
  } else if (waiting) {
    body = <><div className="gbo-sheet-note">{phase === 'installed' ? 'Slack is installed. Waiting for the bot connection…' : 'Finish in Slack… Allow the bot in the browser tab that just opened.'}{timedOut ? ' The connection timed out. Select Cancel to remove the incomplete app.' : ''}</div>{phase === 'installed' ? audienceBlock : null}</>
    footer = <>{cancel}{phase === 'installed' ? <button type="button" className="gbo-sheet-cancel gbo-slack-remove" onClick={() => setConfirm(true)}>Remove from Slack</button> : authorize ? <button type="button" className="gbo-sheet-primary" onClick={() => openExternalLink(authorize)}>Open again ↗</button> : null}</>
  } else if (phase === 'denied' || phase === 'error') {
    body = <div className="gbo-sheet-note">{phase === 'denied' ? 'Slack install was cancelled.' : 'Slack setup needs attention.'} {tokenInstalled ? 'The bot’s Slack token is installed, so Cancel keeps the app. Remove from Slack deletes it.' : 'Remove the incomplete app before trying again.'}</div>
    footer = <>{cancel}{tokenInstalled
      ? <button type="button" className="gbo-sheet-primary gbo-slack-remove" disabled={busy} onClick={() => setConfirm(true)}>Remove from Slack</button>
      : <button type="button" className="gbo-sheet-primary" disabled={busy} onClick={() => void remove()}>Remove and try again</button>}</>
  } else if (adding) {
    body = <div className="gbo-sheet-form"><p className="gbo-sheet-text gbo-slack-howto">On api.slack.com/apps, scroll to Your App Configuration Tokens and click Generate Token for your workspace.<br />Paste the Refresh token (it starts with xoxe-) below. Hermes keeps it on the bot’s server.</p><button type="button" className="gbo-link-btn" onClick={() => openExternalLink('https://api.slack.com/apps')}>Open Slack app settings ↗</button><label className="gbo-sheet-field"><span>Refresh token</span><input className="gbo-input" type="password" autoComplete="off" spellCheck={false} value={refresh} onChange={e => setRefresh(e.target.value)} /></label></div>
    footer = <>{cancel}<button type="button" className="gbo-sheet-primary" disabled={busy || Boolean(refreshTokenError(refresh))} onClick={() => void add()}>Add</button></>
  } else {
    body = <><p className="gbo-sheet-text">You can DM or @mention {name} in Slack. It’ll respond with the same plugins, context, and memories it uses here.</p>{phase === 'denied' ? <div className="gbo-sheet-note">Slack install was cancelled. Try again.</div> : null}{workspaces.map(w => <label key={w.team_id} className="gbo-sheet-choice"><input className="gbo-slack-workspace-choice" type="radio" name="slack-workspace" checked={selected === w.team_id} onChange={() => setSelected(w.team_id)} />{workspaceLabel(w, Object.values(slack.checks.get()))}</label>)}<button type="button" className="gbo-link-btn gbo-slack-add-workspace" onClick={() => setAdding(true)}>+ Connect another workspace</button>{accessPicker}</>
    footer = <>{cancel}<button type="button" className="gbo-sheet-primary" disabled={busy || !selected} onClick={() => void connect()}>Connect ↗</button></>
  }
  return <Sheet onClose={close} busy={busy} label={title} title={title} subtitle="Uses your Slack connection" emblem={<SlackMark size={40} />} footer={footer}>{body}{error ? <div className="gbo-form-error" role="alert">{error}</div> : null}</Sheet>
}
