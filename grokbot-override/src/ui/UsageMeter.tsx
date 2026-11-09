// Context / cost meter for the open Bot Chat (C25): a status-bar chip (the
// spot stock's meter lives, use-statusbar-items.tsx:718) and a block in the
// profile panel. Readings come from rosterActions' usage watcher.

import { rowKey } from '../core/roster.js'
import { contextPercent, costLabel, usageContextLabel, usageDetailRows } from '../core/usage.js'
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

/** Usage for `bot` when it is the open chat, else null. */
function useBotUsage(bot: any) {
  const u = useStore(roster2.usage)
  useStore(app.chat)
  return bot && u.key === rowKey(bot) ? u : null
}

export function UsageBlock({ bot }: { bot: any }) {
  const u = useBotUsage(bot)
  const usage = u?.usage
  const label = usageContextLabel(usage)
  if (!u || (!label && !u.error)) {
    return <div className="panel-empty gbo-panel-empty">{u?.runtimeId ? 'No usage reported yet.' : 'Shown once the chat is attached.'}</div>
  }
  if (!label) return <div className="panel-empty gbo-panel-empty">Usage unavailable: {u.error}</div>
  const percent = contextPercent(usage)
  return (
    <div className="gbo-meter">
      <div className="gbo-meter-line">
        <span>Context {label}</span>
        <span>{percent === null ? '' : `${percent}%`}</span>
      </div>
      <Bar percent={percent} />
      {usageDetailRows(usage)
        .filter(r => r.label !== 'Context' && r.label !== 'Used')
        .map(r => (
          <div key={r.label} className="gbo-meter-line">
            <span>{r.label}</span>
            <span>{r.value}</span>
          </div>
        ))}
    </div>
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
