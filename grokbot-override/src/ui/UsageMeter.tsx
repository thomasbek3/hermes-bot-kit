// Context / cost meter for the open Bot Chat (C25): a status-bar chip (the
// spot stock's meter lives, use-statusbar-items.tsx:718). Readings come from
// rosterActions' usage watcher.

import { contextPercent, costLabel, usageContextLabel } from '../core/usage.js'
import { app } from './app'
import { roster2 } from './rosterStores'
import { useStore } from './store'

function Bar({ percent }: { percent: null | number }) {
  if (percent === null) return null
  return (
    <span className={`gbo-meter-bar${percent >= 80 ? ' is-high' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Context used">
      <span style={{ width: `${percent}%` }} />
    </span>
  )
}

/** The status-bar chip: only while an override Bot Chat is attached. */
export function UsageStatusChip() {
  const u = useStore(roster2.usage)
  const enabled = useStore(app.enabled)
  const label = usageContextLabel(u.usage)
  if (!enabled || !u.runtimeId || !label) return null
  const cost = costLabel(u.usage)
  return (
    <span data-gbo-root="" className="gbo-status-meter" style={{ height: 'auto', width: 'auto' }} title="Open Bot Chat: context used">
      <Bar percent={contextPercent(u.usage)} />
      <span>{label}</span>
      {cost ? <span>· {cost}</span> : null}
    </span>
  )
}
