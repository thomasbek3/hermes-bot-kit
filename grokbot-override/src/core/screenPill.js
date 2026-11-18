// The bot's computer: what the control pill under the desk image shows.
// The override's own presentation (Grok Bot's viewer look: "Watching" +
// "Take control", "You're in control" + "Stop"). It maps the screen state
// that Screen.tsx already has to a label and buttons; every button runs an
// action Screen.tsx already had (start, attach, takeOver, handBack, handBack
// with force), under the same disabled rules as the old header bar.
// Take control (and Take back) appear only while a stream is live; while the
// viewer wakes, connects or reconnects by itself (core/screenWake.js) the pill
// shows that progress with no button but Stop for a held control.

/**
 * The viewer's stream state for the pill, from the wake machine's state
 * (core/screenWake.js) and the screen phase:
 * 'live' | 'attaching' | 'reconnecting' | 'waking' | 'error' | 'idle'.
 */
export function screenLink(wake, phase) {
  const mode = wake?.mode ?? 'idle'
  if (mode === 'live') return 'live'
  if (mode === 'gave-up') return 'error'
  if (mode === 'waking') return 'waking'
  if (mode === 'retrying') return 'reconnecting'
  if (mode === 'checking' || mode === 'connecting') return wake?.recovering ? 'reconnecting' : 'attaching'
  // idle / paused / blocked: a running screen is dialled as soon as the viewer shows.
  return phase === 'running' ? 'attaching' : 'idle'
}

/**
 * @param {{
 *   phase: string,            // screenPhase(state); 'loading' while the first status is read
 *   conn: string,             // screenLink(): 'idle' | 'attaching' | 'reconnecting' | 'waking' | 'live' | 'error'
 *   iHold: boolean,           // this window holds the human lease
 *   humanOther: boolean,      // a human lease this window does not hold
 *   busy: boolean,            // a lease call is in flight
 *   hasViewer: boolean,       // a viewer id was minted (Take control needs it)
 *   blocker?: string | null   // status.blocker (Start is refused)
 * }} input
 * @returns {null | { tone: 'watch' | 'you' | 'idle', icon: string, label: string,
 *   actions: { id: string, label: string, kind: 'dark' | 'light', disabled: boolean, title?: string }[] }}
 */
export function screenPill({ phase, conn, iHold, humanOther, busy, hasViewer, blocker }) {
  const retry = { id: 'retry', label: 'Retry', kind: 'dark', disabled: false, title: 'Try to reach the screen again' }
  if (phase === 'stopped' || phase === 'loading') {
    if (conn === 'error') return { tone: 'idle', icon: 'warn', label: 'Connection lost', actions: [retry] }
    if (phase === 'loading') return { tone: 'idle', icon: 'spinner', label: 'Connecting…', actions: [] }
    if (conn !== 'idle' && conn !== 'live' && !blocker) return { tone: 'idle', icon: 'spinner', label: 'Starting…', actions: [] }
    return {
      tone: 'idle',
      icon: 'power',
      label: 'Not running',
      actions: [{ id: 'start', label: 'Start screen', kind: 'dark', disabled: Boolean(busy || blocker) }]
    }
  }
  if (phase !== 'running') return null

  const live = conn === 'live'
  const actions = []
  if (conn === 'error') actions.push(retry)
  if (iHold) {
    actions.push({ id: 'stop', label: 'Stop', kind: 'light', disabled: Boolean(busy), title: 'Hand control back to the bot' })
  } else if (live) {
    if (humanOther) {
      actions.push({ id: 'take-back', label: 'Take back', kind: 'light', disabled: Boolean(busy), title: 'Take control back from a viewer that is gone (hands it to the bot)' })
    }
    actions.push({ id: 'take', label: 'Take control', kind: 'dark', disabled: Boolean(busy || !hasViewer) })
  }

  let icon = iHold ? 'pointer' : humanOther ? 'person' : 'eye'
  let label = iHold ? 'You’re in control' : humanOther ? 'Someone else is in control' : 'Watching'
  if (conn === 'attaching' || conn === 'idle') {
    icon = 'spinner'
    label = 'Connecting…'
  } else if (conn === 'reconnecting') {
    icon = 'spinner'
    label = 'Reconnecting…'
  } else if (conn === 'waking') {
    icon = 'spinner'
    label = 'Starting…'
  } else if (conn === 'error') {
    icon = 'warn'
    label = 'Connection lost'
  }
  return { tone: iHold ? 'you' : 'watch', icon, label, actions }
}

/** "1920x1200" -> 1.6, the desk image's aspect ratio (16:10 when unknown). */
export function screenRatio(geometry) {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/.exec(String(geometry ?? ''))
  const width = match ? Number(match[1]) : 0
  const height = match ? Number(match[2]) : 0
  return width > 0 && height > 0 ? width / height : 1.6
}

/** The pill's tooltip: who, display, size, sandbox, a holder's reason, and
 *  the backend's own words for a lost connection (never the main message). */
export function screenPillTitle(who, status, lease, error = null) {
  const parts = [`${who}’s computer`]
  if (status?.display) parts.push(status.geometry ? `${status.display} · ${status.geometry}` : String(status.display))
  const placement = String(status?.placement || '')
  if (placement.startsWith('terminal:')) parts.push(`in sandbox ${placement.slice(9)}`)
  if (lease?.holder === 'human' && lease.reason) parts.push(String(lease.reason))
  if (error) parts.push(String(error))
  return parts.join(' — ')
}
