// The bot's computer: what the control pill under the desk image shows.
// The override's own presentation (Grok Bot's viewer look: "Watching" +
// "Take control", "You're in control" + "Stop"). It maps the screen state
// that Screen.tsx already has to a label and buttons; every button runs an
// action Screen.tsx already had (start, attach, takeOver, handBack, handBack
// with force), under the same disabled rules as the old header bar.

/**
 * @param {{
 *   phase: string,            // screenPhase(state)
 *   conn: string,             // 'idle' | 'attaching' | 'live' | 'error'
 *   iHold: boolean,           // this window holds the human lease
 *   humanOther: boolean,      // a human lease this window does not hold
 *   busy: boolean,            // a lease / start call is in flight
 *   hasViewer: boolean,       // a viewer id was minted (Take control needs it)
 *   blocker?: string | null   // status.blocker (Start is refused)
 * }} input
 * @returns {null | { tone: 'watch' | 'you' | 'idle', icon: string, label: string,
 *   actions: { id: string, label: string, kind: 'dark' | 'light', disabled: boolean, title?: string }[] }}
 */
export function screenPill({ phase, conn, iHold, humanOther, busy, hasViewer, blocker }) {
  if (phase === 'stopped') {
    return {
      tone: 'idle',
      icon: 'power',
      label: 'Not running',
      actions: [{ id: 'start', label: busy ? 'Starting…' : 'Start screen', kind: 'dark', disabled: Boolean(busy || blocker) }]
    }
  }
  if (phase !== 'running') return null

  const actions = []
  if (conn === 'error') actions.push({ id: 'retry', label: 'Retry', kind: 'light', disabled: false, title: 'Reconnect to the screen' })
  if (iHold) {
    actions.push({ id: 'stop', label: 'Stop', kind: 'light', disabled: Boolean(busy), title: 'Hand control back to the bot' })
  } else {
    if (humanOther) {
      actions.push({ id: 'take-back', label: 'Take back', kind: 'light', disabled: Boolean(busy), title: 'Take control back from a viewer that is gone (hands it to the bot)' })
    }
    actions.push({ id: 'take', label: 'Take control', kind: 'dark', disabled: Boolean(busy || conn === 'attaching' || !hasViewer) })
  }

  let icon = iHold ? 'pointer' : humanOther ? 'person' : 'eye'
  let label = iHold ? 'You’re in control' : humanOther ? 'Someone else is in control' : 'Watching'
  if (conn === 'attaching') {
    icon = 'spinner'
    label = 'Connecting…'
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

/** The pill's tooltip: who, display, size, sandbox and a holder's reason. */
export function screenPillTitle(who, status, lease) {
  const parts = [`${who}’s computer`]
  if (status?.display) parts.push(status.geometry ? `${status.display} · ${status.geometry}` : String(status.display))
  const placement = String(status?.placement || '')
  if (placement.startsWith('terminal:')) parts.push(`in sandbox ${placement.slice(9)}`)
  if (lease?.holder === 'human' && lease.reason) parts.push(String(lease.reason))
  return parts.join(' — ')
}
