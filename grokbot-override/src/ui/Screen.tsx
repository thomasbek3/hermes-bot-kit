// The bot's computer (P4): Bot Screen in an override workspace tab. Live view
// through noVNC on the gateway's display bridge, with Take over / Hand back.
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
import { app, metaFor } from './app'
import { IconPlay, IconRefresh } from './iconsRoster'
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

export function BotScreen({ bot }: { bot: any }) {
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
  const [conn, setConn] = React.useState<'idle' | 'attaching' | 'live' | 'error'>('idle')
  const [error, setError] = React.useState<null | string>(null)
  const [busy, setBusy] = React.useState(false)
  const [evicted, setEvicted] = React.useState(false)
  const [installLog, setInstallLog] = React.useState<string[]>([])

  const refresh = React.useCallback(async () => {
    const request = store.beginRequest()
    try {
      store.setStatus(await displayRequest(host, bot, 'display.status'), request)
      setError(null)
    } catch (err) {
      if (looksUnsupported(err)) store.setUnavailable() // read-only availability
      setError(errText(err))
    }
  }, [rowKey(bot)])

  React.useEffect(() => {
    void refresh()
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
  }, [refresh, releaseInstall])

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

  const attach = React.useCallback(
    async (auto = false) => {
      if (!canvasHost.current) return
      if (!auto) evictions.current = 0
      detach()
      if (!globalThis.crypto?.subtle) {
        setConn('error')
        setError('The screen needs a secure (HTTPS) window.')
        return
      }
      const mine = generation.current
      setConn('attaching')
      setError(null)
      try {
        const Rfb = await loadRfb()
        const retain = await retainBotScreen(host, bot)
        if (mine !== generation.current) return retain()
        retention.current = retain
        const prior = store.get().viewer?.id
        const observe: any = await displayRequest(host, bot, 'display.observe', prior ? { viewer_id: prior } : {})
        const minted = { id: observe.viewer_id, hash: await viewerHash(observe.viewer_id) }
        store.setStatus(observe)
        const url = await resolveScreenWsUrl((sdk as any).resolveSiblingWsUrl, bot, observe.ticket)
        if (mine !== generation.current || !canvasHost.current) return
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
            setConn('live')
            setEvicted(false)
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
              setConn('error')
              setError('Someone else took control of this screen.')
            } else {
              setEvicted(true)
              setConn('idle')
            }
          } else if (event?.detail?.clean) setConn('idle')
          else {
            setConn('error')
            setError(reason || 'The screen stream was lost.')
          }
          void refresh()
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
        if (mine === generation.current) {
          setConn('error')
          setError(errText(err))
        }
      }
    },
    [rowKey(bot), detach, refresh]
  )

  React.useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
      releaseInstall()
      detach(true)
    }
  }, [detach, releaseInstall])
  React.useEffect(() => {
    if (status?.running && conn === 'idle') void attach(true)
  }, [status?.running, conn, attach])
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
  const start = () =>
    act(async () => {
      store.setStatus(await displayRequest(host, bot, 'display.start'))
      setConn('idle')
    })
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
      if (conn !== 'live') void attach()
    })
  const handBack = (force = false) =>
    act(async () => {
      const result: any = await displayRequest(host, bot, 'display.lease.release', handBackParams(viewer, force))
      store.setLease(result.lease)
    })

  const phase = screenPhase(state)
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
  } else if (phase === 'loading') {
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
  } else if (phase === 'stopped') {
    content = center(
      `${who}’s computer is asleep`,
      status?.blocker ?? 'Start it to watch the bot work, or to take over.',
      <button type="button" className="gbo-btn is-primary" disabled={busy || Boolean(status?.blocker)} onClick={() => void start()}>
        <IconPlay />
        {busy ? 'Starting…' : 'Start'}
      </button>
    )
  } else {
    const humanOther = lease?.holder === 'human' && !iHold
    content = (
      <>
        <div className="gbo-screen-bar">
          <strong>{who}’s computer</strong>
          {status?.display ? (
            <span className="gbo-field-hint">
              {status.display} · {status.geometry}
            </span>
          ) : null}
          {String(status?.placement || '').startsWith('terminal:') ? <span className="gbo-screen-tag">in sandbox {String(status.placement).slice(9)}</span> : null}
          <span className="gbo-spacer" />
          {lease?.holder === 'human' && lease.reason ? (
            <span className="gbo-screen-tag is-reason" title={lease.reason}>
              {lease.reason}
            </span>
          ) : null}
          <span className={`gbo-screen-tag${iHold ? ' is-you' : ''}`}>{iHold ? 'You have control' : humanOther ? 'Someone else has control' : 'The bot has control'}</span>
          {iHold ? (
            <button type="button" className="gbo-btn is-small" disabled={busy} onClick={() => void handBack()}>
              Hand back
            </button>
          ) : (
            <>
              {humanOther ? (
                <button type="button" className="gbo-btn is-small" disabled={busy} title="Take control back from a viewer that is gone" onClick={() => void handBack(true)}>
                  Force hand back
                </button>
              ) : null}
              <button type="button" className="gbo-btn is-small is-primary" disabled={busy || conn === 'attaching' || !viewer} onClick={() => void takeOver()}>
                Take over
              </button>
            </>
          )}
          <button type="button" className="gbo-icon-btn" aria-label="Reconnect" title="Reconnect" disabled={conn === 'attaching'} onClick={() => void attach()}>
            <IconRefresh />
          </button>
        </div>
        <div className={`gbo-screen-stage${iHold ? ' is-held' : ''}`}>
          <div className="gbo-screen-canvas" data-remote-screen="" data-terminal="" ref={canvasHost} />
          {conn === 'attaching' ? <div className="gbo-screen-overlay">Connecting…</div> : null}
          {evicted ? <div className="gbo-screen-banner is-top">Someone else took control; watching again.</div> : null}
          {conn === 'error' && error ? <div className="gbo-screen-banner is-bottom">{error}</div> : null}
        </div>
      </>
    )
  }
  return (
    <div data-gbo-root="" className="gbo-screen">
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
