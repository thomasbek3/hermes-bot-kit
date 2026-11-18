// The bot's computer: cold open and self-recovery for an OPEN, VISIBLE viewer.
//
// Opening the viewer (or showing it again) reads display.status; a screen
// that is not running is started with the same display.start the "Start
// screen" button sends, then the stream is dialled, with no click. A dropped
// stream, or display.observe's "not running; call display.start first",
// re-runs that sequence after a bounded backoff (1 s, 2 s, 4 s, then every
// 8 s) and gives up about 60 s after the first failure; only then does the
// viewer show "Connection lost" + Retry. Retry starts a fresh sequence.
//
// Never started here: a viewer that is not visible (a background tab or a
// hidden pane waits until it is shown again), and any state the gateway
// blocks or redirects (unsupported, not installed, a pending sandbox image
// switch, a start blocker such as low memory): those keep their own cards.
// Nothing runs on a timer while the viewer is live, so the gateway's idle
// stop is untouched; only the viewer's own open/loss edges start anything.
//
// The machine is UI-free: Screen.tsx hands it readStatus / start / connect,
// reports the stream's connect and loss, and renders `state.mode`.

import { screenPhase } from './screen.js'

export const RECOVERY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000])
export const RECOVERY_GIVE_UP_MS = 60_000

/** What an open viewer does with a status: dial it, start it, or leave the card. */
export function wakeDecision(status) {
  const phase = screenPhase({ status })
  if (phase === 'running') return 'connect'
  if (phase === 'stopped' && !status.blocker) return 'start'
  return 'blocked'
}

/** The wait before recovery attempt `n` (0-based): 1 s, 2 s, 4 s, then 8 s. */
export function recoveryDelay(attempt) {
  return RECOVERY_DELAYS_MS[Math.min(Math.max(0, attempt), RECOVERY_DELAYS_MS.length - 1)]
}

/**
 * @param {{
 *   readStatus: () => Promise<any>,   // display.status; resolves 'blocked' when the screen is unavailable
 *   start: () => Promise<any>,        // display.start; resolves with the new status
 *   connect: () => Promise<void>,     // dial the stream; rejects when it cannot; live is reported by connected()
 *   isVisible: () => boolean,
 *   onChange?: (state: { mode: string, error: string | null, recovering: boolean }) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (id: any) => void
 * }} deps
 *
 * Modes: idle (nothing yet), checking, waking (display.start in flight),
 * connecting, live, retrying (waiting out a backoff), paused (lost while
 * hidden), blocked (a card the gateway asks for), gave-up.
 */
export function createScreenWaker({ readStatus, start, connect, isVisible, onChange = () => undefined, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = { mode: 'idle', error: null, recovering: false }
  let token = 0
  let timer = null
  let attempt = 0
  let lostSince = null
  let disposed = false

  const set = (mode, error = state.error) => {
    if (disposed) return
    state = { mode, error, recovering: lostSince !== null }
    onChange(state)
  }
  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const reason = err => (err == null ? null : String(err?.message || err))

  /** One failed attempt of sequence `mine`: back off, pause while hidden, or give up. */
  const failed = (mine, err) => {
    if (disposed || mine !== token) return
    const error = reason(err) || state.error
    const at = now()
    if (lostSince === null) lostSince = at
    const wait = recoveryDelay(attempt)
    // No attempt is scheduled past the budget: the last one lands inside it.
    if (at - lostSince + wait > RECOVERY_GIVE_UP_MS) return set('gave-up', error)
    if (!isVisible()) return set('paused', error)
    attempt += 1
    set('retrying', error)
    cancelTimer()
    timer = setTimer(() => {
      timer = null
      if (mine !== token || disposed) return
      if (!isVisible()) return set('paused', state.error)
      void run(mine)
    }, wait)
  }

  const run = async mine => {
    set('checking')
    let status
    try {
      status = await readStatus()
    } catch (err) {
      return failed(mine, err)
    }
    if (disposed || mine !== token) return
    let decision = status === 'blocked' ? 'blocked' : wakeDecision(status)
    if (decision === 'blocked') return set('blocked', null)
    if (decision === 'start') {
      if (!isVisible()) return set('paused')
      set('waking')
      try {
        status = await start()
      } catch (err) {
        return failed(mine, err)
      }
      if (disposed || mine !== token) return
      decision = wakeDecision(status)
      if (decision === 'blocked') return set('blocked', null)
      if (decision !== 'connect') return failed(mine, new Error('The screen did not come up.'))
    }
    set('connecting')
    try {
      await connect()
    } catch (err) {
      failed(mine, err)
    }
  }

  /** A fresh sequence: a new budget, and any older one's replies are dropped. */
  const begin = () => {
    if (disposed) return
    cancelTimer()
    token += 1
    attempt = 0
    lostSince = null
    void run(token)
  }

  const ACTIVE = new Set(['checking', 'waking', 'connecting', 'live', 'retrying'])

  const api = {
    get: () => state,
    /** The viewer was opened or shown: wake and dial unless already on it. */
    open() {
      if (disposed || ACTIVE.has(state.mode) || !isVisible()) return
      begin()
    },
    /** Retry / Reconnect / Start screen: a fresh sequence whatever the mode. */
    retry: begin,
    /** The stream drew its first frame. */
    connected() {
      if (disposed) return
      cancelTimer()
      attempt = 0
      lostSince = null
      set('live', null)
    },
    /** The stream dropped or the dial failed: recover (only from connecting/live). */
    lost(err) {
      if (disposed || (state.mode !== 'connecting' && state.mode !== 'live')) return
      failed(token, err)
    },
    /** Lost for good without retrying (e.g. someone keeps taking control). */
    fail(err) {
      if (disposed) return
      cancelTimer()
      token += 1
      set('gave-up', reason(err))
    },
    /** Visibility edges: shown again → open(); hidden → stop waiting out a backoff. */
    setVisible(visible) {
      if (disposed) return
      if (visible) {
        if (state.mode === 'paused') set('idle')
        api.open()
      } else if (state.mode === 'retrying') {
        cancelTimer()
        set('paused')
      }
    },
    dispose() {
      cancelTimer()
      token += 1
      disposed = true
    }
  }
  return api
}
