// The bot's computer (P4): Bot Screen in an override workspace tab. Live view
// through noVNC on the gateway's display bridge, with Take control / Stop in
// a white pill under the desk image (core/screenPill.js maps the state).
// Opening (or showing) the viewer wakes a screen that is asleep and dials it;
// a dropped stream recovers by itself with a bounded backoff
// (core/screenWake.js), and only then shows "Connection lost" + Retry.
// Behaviour is stock screen-pane.tsx (see core/screen.js for the citations);
// the RFB client is the kit computer-viewer's vendored noVNC 1.7.0 (MPL-2.0,
// ../../computer-viewer/vendor), loaded only when a screen attaches.

import * as React from 'react'

import { looksUnsupported } from '../core/outcomes.js'
import { displayName, rowKey } from '../core/roster.js'
import {
  CLOSE_CONTROL_TAKEN,
  createScreenStore,
  displayRequest,
  handBackParams,
  isEventForBotScreen,
  isManagedBackend,
  leaseHeldBy,
  MAX_PASTE_CUT_TEXT,
  nextEviction,
  resolveScreenWsUrl,
  retainBotScreen,
  screenPhase,
  viewerHash
} from '../core/screen.js'
import { screenLink, screenPill, screenPillTitle, screenRatio } from '../core/screenPill.js'
import { createScreenWaker } from '../core/screenWake.js'
import { app, metaFor } from './app'
import { IconEye, IconRefresh, IconWarn } from './iconsRoster'
import { onRosterParityStop } from './rosterActions'
import { setScreenOpener } from './RosterMenus'
import { host, sdk } from './sdk'
import { OverrideBoundary } from './Boundary'

const stores = new Map<string, ReturnType<typeof createScreenStore>>()
export function screenStore(bot: any) {
  const key = rowKey(bot)
  let store = stores.get(key)
  if (!store) stores.set(key, (store = createScreenStore()))
  return store
}

function useScreenState(store: ReturnType<typeof createScreenStore>) {
  return React.useSyncExternalStore(store.subscribe as any, store.get, store.get)
}

async function loadRfb(): Promise<any> {
  const mod: any = await import('../../../computer-viewer/vendor/novnc-rfb.mjs')
  return mod.default
}

function onDisplayEvent(type: string, fn: (event: any) => void) {
  if (typeof app.ctx?.onEvent === 'function') return app.ctx.onEvent(type, fn)
  return typeof host?.onEvent === 'function' ? host.onEvent(type, fn) : () => undefined
}

function errText(err: any) {
  return String(err?.message || err)
}

/** On screen: the viewer's workspace pane holds its zone's tab and the window
 *  is not hidden. Feature-detected; an older desktop counts as visible. */
function useViewerVisibility(paneId: string, onEdge: (visible: boolean) => void) {
  const visible = React.useRef(true)
  const edge = React.useRef(onEdge)
  edge.current = onEdge
  React.useEffect(() => {
    let pane = true
    const doc = typeof document === 'undefined' ? null : document
    const update = () => {
      const next = pane && doc?.visibilityState !== 'hidden'
      if (next === visible.current) return
      visible.current = next
      edge.current(next)
    }
    let offPane: undefined | (() => void)
    try {
      const atom: any = typeof host?.paneVisibility === 'function' ? host.paneVisibility(paneId) : null
      if (atom && typeof atom.subscribe === 'function') {
        const off = atom.subscribe((shown: unknown) => {
          pane = shown !== false
          update()
        })
        if (typeof off === 'function') offPane = off
      }
    } catch {
      /* older desktop: always visible */
    }
    doc?.addEventListener('visibilitychange', update)
    update()
    return () => {
      offPane?.()
      doc?.removeEventListener('visibilitychange', update)
    }
  }, [paneId])
  return visible
}

// The control pill's small icons (14px, same line style as ./iconsRoster).
const pillIcon = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const PILL_ICONS: Record<string, () => React.ReactNode> = {
  eye: () => <IconEye />,
  warn: () => <IconWarn />,
  pointer: () => (
    <svg {...pillIcon}>
      <path d="M10.5 20H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v3.5" />
      <path d="m12.5 12.5 8 2.6-3.4 1.4-1.4 3.4-3.2-7.4Z" />
    </svg>
  ),
  person: () => (
    <svg {...pillIcon}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />
    </svg>
  ),
  power: () => (
    <svg {...pillIcon}>
      <path d="M12 3.5v7.5M6.6 7a7.5 7.5 0 1 0 10.8 0" />
    </svg>
  ),
  spinner: () => (
    <svg {...pillIcon} className="gbo-screen-spin">
      <path d="M20 12a8 8 0 1 1-8-8" />
    </svg>
  )
}

/** The calm progress mark on the dark stage: a small spinner and one line. */
function StageNote({ text, spinner = true, sub }: { text?: string; spinner?: boolean; sub?: string }) {
  return (
    <div className="gbo-screen-note" role="status" aria-live="polite">
      {spinner ? <span className="gbo-screen-note-spin" aria-hidden="true" /> : null}
      {text ? <strong>{text}</strong> : null}
      {sub ? <span>{sub}</span> : null}
    </div>
  )
}

/** One white pill under the desk image: state, then its one or two actions. */
function ControlPill({ pill, title, run }: { pill: NonNullable<ReturnType<typeof screenPill>>; title: string; run: (id: string) => void }) {
  return (
    <div className={`gbo-screen-pill is-${pill.tone}`} role="group" aria-label="Screen control" title={title}>
      <span className="gbo-screen-pill-state" aria-live="polite">
        {PILL_ICONS[pill.icon]?.()}
        <span>{pill.label}</span>
      </span>
      {pill.actions.map(action => (
        <button key={action.id} type="button" className={`gbo-screen-pill-btn is-${action.kind}`} disabled={action.disabled} title={action.title} onClick={() => run(action.id)}>
          {action.label}
        </button>
      ))}
    </div>
  )
}

type WakeState = { mode: string; error: string | null; recovering: boolean }

/** `initialWake` is a preview seam (dev/preview-entry.tsx renders one state
 *  statically); the live tab never passes it. */
export function BotScreen({ bot, initialWake }: { bot: any; initialWake?: WakeState }) {
  const store = screenStore(bot)
  const state = useScreenState(store)
  const status = state.status
  const lease = state.lease ?? status?.lease ?? null
  const viewer = state.viewer
  const iHold = leaseHeldBy(lease, viewer)
  const canvasHost = React.useRef<HTMLDivElement | null>(null)
  const rfb = React.useRef<any>(null)
  const socket = React.useRef<WebSocket | null>(null)
  const retention = React.useRef<null | (() => void)>(null)
  // Review override-v2-r2 M2 (stock screen-install.tsx:55-133): the install
  // pins the bot's socket with its OWN retention, held from display.install
  // until done/failure/unmount; one resolving after unmount is released on the
  // spot and its install is never sent.
  const installRetention = React.useRef<null | (() => void)>(null)
  const unmounted = React.useRef(false)
  const releaseInstall = React.useCallback(() => {
    installRetention.current?.()
    installRetention.current = null
  }, [])
  const pasteCleanup = React.useRef<null | (() => void)>(null)
  const generation = React.useRef(0)
  const dialedAt = React.useRef(0)
  const evictions = React.useRef(0)
  const [error, setError] = React.useState<null | string>(null)
  const [busy, setBusy] = React.useState(false)
  const [evicted, setEvicted] = React.useState(false)
  const [installLog, setInstallLog] = React.useState<string[]>([])

  /** display.status into the store; 'blocked' when this Hermes has no screen. */
  const readStatus = React.useCallback(async (): Promise<any> => {
    const request = store.beginRequest()
    try {
      const next = await displayRequest(host, bot, 'display.status')
      store.setStatus(next, request)
      setError(null)
      // A reply overtaken by a pushed status: decide on the newer one.
      return store.get().status ?? next
    } catch (err) {
      if (looksUnsupported(err)) {
        store.setUnavailable() // read-only availability
        return 'blocked'
      }
      setError(errText(err))
      throw err
    }
  }, [rowKey(bot)])
  const refresh = React.useCallback(() => readStatus().catch(() => undefined), [readStatus])

  // Cold open and self-recovery (core/screenWake.js). attach is read through
  // a ref: the machine outlives renders.
  const attachRef = React.useRef<(auto?: boolean) => Promise<void>>(async () => undefined)
  const [wake, setWake] = React.useState<WakeState>(initialWake ?? { mode: 'idle', error: null, recovering: false })
  // The live machine sits in a ref (made in an effect, so a remount gets a
  // fresh one); this stable facade is what the handlers below call.
  const wakerRef = React.useRef<null | ReturnType<typeof createScreenWaker>>(null)
  const waker = React.useMemo(
    () => ({
      open: () => wakerRef.current?.open(),
      retry: () => wakerRef.current?.retry(),
      connected: () => wakerRef.current?.connected(),
      lost: (err: unknown) => wakerRef.current?.lost(err),
      fail: (err: unknown) => wakerRef.current?.fail(err),
      setVisible: (shown: boolean) => wakerRef.current?.setVisible(shown),
      mode: () => wakerRef.current?.get().mode ?? 'idle'
    }),
    []
  )
  const visible = useViewerVisibility(`plugin-workspace:${screenWorkspaceId(bot)}`, shown => waker.setVisible(shown))

  React.useEffect(() => {
    const machine = createScreenWaker({
      readStatus,
      start: async () => {
        const next = await displayRequest(host, bot, 'display.start')
        store.setStatus(next)
        return next
      },
      connect: () => attachRef.current(true),
      isVisible: () => visible.current,
      onChange: setWake
    })
    wakerRef.current = machine
    // Opened: a visible viewer wakes and dials; a hidden one only reads the
    // status, and wakes when it is shown.
    if (visible.current) machine.open()
    else void refresh()
    return () => {
      machine.dispose()
      if (wakerRef.current === machine) wakerRef.current = null
    }
  }, [readStatus])

  React.useEffect(() => {
    const key = () => store.get().status?.profile_key
    const offLease = onDisplayEvent('display.lease', event => {
      if (event?.payload?.lease && isEventForBotScreen(bot, event, key())) store.setLease(event.payload.lease)
    })
    const offStatus = onDisplayEvent('display.status', event => {
      if (event?.payload?.profile_key && isEventForBotScreen(bot, event, key())) store.setStatus(event.payload)
    })
    const offLog = onDisplayEvent('display.install.log', event => {
      if (isEventForBotScreen(bot, event, key()) && event?.payload?.line) setInstallLog(lines => [...lines.slice(-200), String(event.payload.line)])
    })
    const offDone = onDisplayEvent('display.install.done', event => {
      // screen-install.tsx:89: the done event carries a fresh status.
      if (!isEventForBotScreen(bot, event, key())) return
      releaseInstall()
      if (event?.payload?.status) store.setStatus(event.payload.status)
      else void refresh()
    })
    return () => {
      offLease?.()
      offStatus?.()
      offLog?.()
      offDone?.()
    }
  }, [refresh, releaseInstall, rowKey(bot)])

  const detach = React.useCallback((handBack = false) => {
    generation.current += 1
    if (handBack) socket.current?.close(1000)
    try {
      rfb.current?.disconnect()
    } catch {
      /* already closed */
    }
    rfb.current = null
    socket.current?.close()
    socket.current = null
    retention.current?.()
    retention.current = null
    pasteCleanup.current?.()
    pasteCleanup.current = null
  }, [])

  // Dials the stream; throws when it cannot (the wake machine backs off and
  // tries again). Its connect / disconnect events report to the machine.
  const attach = React.useCallback(
    async (auto = false) => {
      if (!auto) evictions.current = 0
      detach()
      if (!canvasHost.current) throw new Error('The screen view is not on the page yet.')
      if (!globalThis.crypto?.subtle) {
        const message = 'The screen needs a secure (HTTPS) window.'
        setError(message)
        waker.fail(message)
        return
      }
      const mine = generation.current
      setError(null)
      try {
        const Rfb = await loadRfb()
        const retain = await retainBotScreen(host, bot)
        if (mine !== generation.current) return void retain()
        retention.current = retain
        const prior = store.get().viewer?.id
        const observe: any = await displayRequest(host, bot, 'display.observe', prior ? { viewer_id: prior } : {})
        const minted = { id: observe.viewer_id, hash: await viewerHash(observe.viewer_id) }
        store.setStatus(observe)
        const url = await resolveScreenWsUrl((sdk as any).resolveSiblingWsUrl, bot, observe.ticket)
        if (mine !== generation.current) return
        if (!canvasHost.current) throw new Error('The screen view is not on the page yet.')
        store.setViewer(minted)
        dialedAt.current = Date.now()
        const ws = new WebSocket(url)
        ws.binaryType = 'arraybuffer'
        socket.current = ws
        let closeCode = 0
        ws.addEventListener('close', event => {
          closeCode = event.code
        })
        const client = new Rfb(canvasHost.current, ws, { shared: true })
        client.scaleViewport = true
        client.resizeSession = false
        client.focusOnClick = true
        client.background = 'transparent'
        client.qualityLevel = 7
        client.viewOnly = !leaseHeldBy(observe.lease, minted)
        client.addEventListener('connect', () => {
          if (mine === generation.current) {
            setEvicted(false)
            setError(null)
            waker.connected()
          }
        })
        client.addEventListener('disconnect', (event: any) => {
          if (rfb.current === client) rfb.current = null
          if (mine !== generation.current) return
          const reason = event?.detail?.reason ?? ''
          if (closeCode === CLOSE_CONTROL_TAKEN || String(reason).includes('control-taken')) {
            const next = nextEviction(evictions.current, dialedAt.current)
            evictions.current = next.count
            if (next.giveUp) {
              setEvicted(false)
              setError('Someone else took control of this screen.')
              waker.fail('Someone else took control of this screen.')
            } else {
              // Watching again at once, as before (the eviction guard counts).
              setEvicted(true)
              waker.retry()
            }
            return
          }
          // Dropped (or closed under us, e.g. the screen restarted): the
          // machine re-reads the status, wakes it if needed and redials.
          const message = reason || (event?.detail?.clean ? 'The screen stream closed.' : 'The screen stream was lost.')
          setError(message)
          waker.lost(message)
        })
        rfb.current = client
        const target = canvasHost.current
        const onPaste = (event: ClipboardEvent) => {
          if (client.viewOnly) return
          const text = event.clipboardData?.getData('text')
          if (text && text.length <= MAX_PASTE_CUT_TEXT) {
            event.preventDefault()
            client.clipboardPasteFrom(text)
          }
        }
        target.addEventListener('paste', onPaste)
        pasteCleanup.current = () => target.removeEventListener('paste', onPaste)
      } catch (err) {
        // A newer dial superseded this one: its failure is not the screen's.
        if (mine === generation.current) throw err
      }
    },
    [rowKey(bot), detach, waker]
  )
  attachRef.current = async (auto?: boolean) => {
    try {
      await attach(auto)
    } catch (err) {
      setError(errText(err))
      throw err
    }
  }

  React.useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
      releaseInstall()
      detach(true)
    }
  }, [detach, releaseInstall])
  React.useEffect(() => {
    if (rfb.current) {
      rfb.current.viewOnly = !iHold
      if (iHold) rfb.current.focus?.()
    }
  }, [iHold])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }
  // Start screen / Retry / Reconnect: one fresh wake-and-dial sequence.
  const wakeAgain = () => {
    evictions.current = 0
    setError(null)
    waker.retry()
  }
  const decideImage = (approve: boolean) => act(async () => void store.setStatus(await displayRequest(host, bot, 'display.switchSandboxImage', { approve })))
  const install = () =>
    act(async () => {
      setInstallLog([])
      const retain = await retainBotScreen(host, bot)
      if (unmounted.current) return retain()
      releaseInstall()
      installRetention.current = retain
      try {
        await displayRequest(host, bot, 'display.install')
      } catch (err) {
        releaseInstall()
        throw err
      }
    })
  const takeOver = () =>
    act(async () => {
      if (!viewer) return
      const result: any = await displayRequest(host, bot, 'display.lease.acquire', { viewer_id: viewer.id })
      store.setLease(result.lease)
      if (waker.mode() !== 'live') wakeAgain()
    })
  const handBack = (force = false) =>
    act(async () => {
      const result: any = await displayRequest(host, bot, 'display.lease.release', handBackParams(viewer, force))
      store.setLease(result.lease)
    })

  const phase = screenPhase(state)
  const link = screenLink(wake, phase)
  // The machine is on it (cold open, a wake, a redial or a give-up): the
  // stage and pill show that instead of the bare "Checking" card.
  const waking = wake.mode !== 'idle' && wake.mode !== 'paused' && wake.mode !== 'blocked'
  const who = displayName(bot, metaFor(bot))
  const center = (title: string, body: React.ReactNode, actions?: React.ReactNode) => (
    <div className="gbo-center">
      <h2>{title}</h2>
      <p>{body}</p>
      {actions}
      {error ? <div className="gbo-card-error">{error}</div> : null}
    </div>
  )

  let content: React.ReactNode
  if (phase === 'unavailable') {
    content = center('No screen on this Hermes', isManagedBackend(bot) ? 'Bot Screen has not reached this managed Hermes release yet.' : `${who}’s Hermes predates Bot Screen; update Hermes on that machine.`)
  } else if (phase === 'loading' && !waking) {
    content = center('Checking the screen…', error || ' ')
  } else if (phase === 'unsupported') {
    content = center('No screen for this bot', 'Its machine cannot run a headless desktop.')
  } else if (phase === 'not-installed') {
    content = (
      <div className="gbo-center">
        <h2>The screen is not installed</h2>
        <p>{status?.missing?.length ? `Missing: ${status.missing.join(', ')}.` : 'A few desktop packages are needed on the bot’s machine.'}</p>
        {status?.install_command ? <code className="gbo-pre">{status.install_command}</code> : null}
        <button type="button" className="gbo-btn is-primary" disabled={busy} onClick={() => void install()}>
          {busy ? 'Installing…' : 'Install'}
        </button>
        <span className="gbo-field-hint">If the install needs a password, Hermes asks for it in its own prompt.</span>
        {installLog.length ? <pre className="gbo-log">{installLog.join('\n')}</pre> : null}
        {error ? <div className="gbo-card-error">{error}</div> : null}
      </div>
    )
  } else if (phase === 'image-switch') {
    const sw = status.image_switch
    content = center(
      'A newer sandbox image is available',
      `Switch from ${sw.current_image} to ${sw.target_image}? ${sw.containers} container(s) are recreated on next use.`,
      <div className="gbo-card-actions">
        <button type="button" className="gbo-btn is-primary" disabled={busy} onClick={() => void decideImage(true)}>
          Switch
        </button>
        <button type="button" className="gbo-btn is-ghost" disabled={busy} onClick={() => void decideImage(false)}>
          Keep the current one
        </button>
      </div>
    )
  } else {
    // Running or asleep: the desk image (or its empty frame) with the control
    // pill centred under it, and Reconnect as a quiet corner icon. The canvas
    // host is always in the stage, so a screen that just woke is dialled at once.
    const running = phase === 'running'
    const humanOther = lease?.holder === 'human' && !iHold
    const pill = screenPill({ phase, conn: link, iHold, humanOther, busy, hasViewer: Boolean(viewer), blocker: status?.blocker })!
    const run = (id: string) => {
      if (id === 'start' || id === 'retry') wakeAgain()
      else if (id === 'take') void takeOver()
      else if (id === 'stop') void handBack()
      else if (id === 'take-back') void handBack(true)
    }
    const ratio = { '--gbo-screen-ratio': screenRatio(status?.geometry) } as React.CSSProperties
    const settling = link === 'attaching' || link === 'reconnecting' || link === 'waking'
    let note: React.ReactNode = null
    if (link === 'error') note = <StageNote spinner={false} text="Can’t reach the computer" sub="Tried for a minute without an answer." />
    else if (phase === 'loading') note = <StageNote />
    else if (!running && settling && !status?.blocker) note = <StageNote text="Waking the computer…" sub="This takes a few seconds." />
    else if (running && link === 'waking') note = <StageNote text="Waking the computer…" sub="This takes a few seconds." />
    // Connecting / reconnecting: the pill says which; the stage only spins.
    else if (running && link !== 'live') note = <StageNote />
    else if (!running)
      note = (
        <div className="gbo-screen-asleep">
          <strong>The computer is asleep</strong>
          <span>{status?.blocker ?? 'Start it to watch the bot work, or to take over.'}</span>
        </div>
      )
    const lostWords = link === 'error' || link === 'reconnecting' ? wake.error || error : null
    content = (
      <div className="gbo-screen-view">
        {running ? (
          <div className="gbo-screen-corner">
            <button type="button" className="gbo-screen-icon-btn" aria-label="Reconnect" title="Reconnect" disabled={settling} onClick={wakeAgain}>
              <IconRefresh />
            </button>
          </div>
        ) : null}
        <div className="gbo-screen-fit">
          <div className={`gbo-screen-stage${iHold ? ' is-held' : ''}${running && link === 'live' ? '' : ' is-asleep'}`} style={ratio}>
            <div className="gbo-screen-canvas" data-remote-screen="" data-terminal="" ref={canvasHost} />
            {evicted ? <div className="gbo-screen-banner is-top">Someone else took control; watching again.</div> : null}
            {note}
          </div>
          <ControlPill pill={pill} title={screenPillTitle(who, status, lease, lostWords)} run={run} />
        </div>
      </div>
    )
  }
  return (
    <div data-gbo-root="" data-gbo-theme="dark" className="gbo-screen">
      {content}
    </div>
  )
}

// ── the workspace tab ────────────────────────────────────────────────────

const openScreens = new Map<string, () => void>()

function screenWorkspaceId(bot: any) {
  return `grokbot-override-screen-${rowKey(bot).replace(/[^a-zA-Z0-9_-]+/g, '-')}`
}

/** screen-open.tsx: the bot's Screen as a main-window workspace tab. */
export function openBotScreen(bot: any) {
  const id = screenWorkspaceId(bot)
  if (openScreens.has(id)) {
    try {
      host?.revealPane?.(`plugin-workspace:${id}`)
    } catch {
      /* fine */
    }
    return
  }
  if (typeof host?.openWorkspace !== 'function') {
    host?.notify?.({ kind: 'info', message: 'Update Hermes Desktop to open a bot’s screen.' })
    return
  }
  const close = host.openWorkspace(id, {
    title: `${displayName(bot, metaFor(bot))} · Computer`,
    minWidth: '24rem',
    dock: { pane: 'workspace', pos: 'center' },
    render: () => (
      <OverrideBoundary area="screen">
        <BotScreen bot={bot} />
      </OverrideBoundary>
    ),
    onClose: () => openScreens.delete(id)
  })
  openScreens.set(id, typeof close === 'function' ? close : () => undefined)
}

export function closeAllScreens() {
  for (const close of openScreens.values()) {
    try {
      close()
    } catch {
      /* already closed */
    }
  }
  openScreens.clear()
}

setScreenOpener(openBotScreen)
onRosterParityStop(closeAllScreens)
