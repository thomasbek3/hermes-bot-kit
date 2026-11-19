// The override's contract with Hermes internals (T10): every PRIVATE
// dependency in one list, each with a read-only probe.
//
// The override uses the public plugin SDK wherever one exists (PARITY.md,
// architecture notes). What is left has no SDK door: Hermes's DOM anchors for
// the window chrome it hides (core/stock.js), Bot Mode's react-query roster
// cache and localStorage keys, the `window.hermesDesktop` bridge (core REST
// for history paging, file reads, workspace reads, transcription, cron; the
// machine profile; the microphone prompt) and the gateway event names the
// chat listens for. When Hermes changes, these fail silently or half-way, so:
//
//  - the self-check (palette: "Grokbot Override: self-check") writes the
//    probe results as a `contract` block in self-check.json;
//  - a probe of a REQUIRED entry that fails shows one quiet notice per app
//    session (never a modal, never repeated);
//  - core/stock.js drops any chrome rule whose anchor is missing, so a
//    renamed selector can never hide the wrong thing.
//
// Probes only read (querySelector, typeof, localStorage.getItem, the query
// cache's findAll). Nothing here changes behaviour when everything is present.
//
// Statuses: 'ok' present; 'missing' required and absent (a failure);
// 'absent' optional and absent (legitimate: a hidden status bar, a sidebar
// that is closed, a fresh install without Bot Mode data); 'seen' / 'unseen'
// for event names (an event only proves itself by arriving: informational).

import { CHROME_ANCHORS, STOCK_PANE_ID, TAB_ATTRS } from './stock.js'
import { STOCK_ROSTER_KEY } from './roster.js'

export const BOT_MODE_STORAGE_KEYS = Object.freeze({
  botMeta: 'hermes.plugin.hermes-bots.bot-meta-v2',
  activityToasts: 'hermes.plugin.hermes-bots.activity-toasts',
  groupChats: 'hermes.plugin.hermes-bots.group-chats'
})

/** The gateway event names the override's chat, roster and screen act on. */
export const CONTRACT_EVENTS = Object.freeze([
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
  'error',
  'approval.request',
  'approval.settled',
  'approval.cancelled',
  'clarify.request',
  'clarify.settled',
  'request.cancel',
  'connection.request',
  'connection.update',
  'tool.generating',
  'tool.start',
  'tool.complete',
  'status.update',
  'message.reaction',
  'session.usage',
  'session.info',
  'session.reclaimed',
  'session.replay_gap',
  'gateway.ready',
  'display.lease',
  'display.status',
  'display.install.log',
  'display.install.done'
])

/** Event-name prefixes the override acts on as a family (rooms.js re-reads a
 *  group chat on any `room.*` / `group*` frame). */
export const CONTRACT_EVENT_PREFIXES = Object.freeze(['room.', 'group'])

const selector = (id, sel, used, required) => ({ id, kind: 'selector', target: sel, used, required })

/** Every private touch point. `used` names where the override relies on it. */
export const CONTRACT = Object.freeze([
  // DOM anchors (stock.js hides; app.ts finds the stock session tiles).
  selector('dom.tree-tab', `[${TAB_ATTRS[0]}]`, 'stock.js: hide the stock Bots tab; app.ts: stock session tiles and whether a hidden computer-viewer pane exists (T3)', true),
  selector('dom.narrow-overlay-tab', `[${TAB_ATTRS[1]}]`, 'stock.js: hide the stock Bots tab on the narrow overlay (only in narrow windows)', false),
  selector('dom.stock-bots-tab', `[${TAB_ATTRS[0]}="${STOCK_PANE_ID}"]`, 'stock.js: the tab that is hidden (Bot Mode registered)', false),
  selector('dom.top-header', CHROME_ANCHORS.topHeader, 'stock.js: top tab strips hidden, header band kept as drag region', true),
  selector('dom.zone-tabstrip', '[data-zone-tabstrip]', 'stock.js: top tab strip rule', false),
  selector('dom.panel-page-header', '[data-panel-page-header]', 'stock.js: top page header hidden with the strip (only on some panes)', false),
  selector('dom.tab-vertical', '[data-vertical]', 'stock.js: a vertical (rail) stock tab is not the shown one (only with a rail)', false),
  selector('dom.tab-active', '[data-active]', 'stock.js / app.ts: which stock tab is active', false),
  selector('dom.window-drag-handle', '[data-window-drag-handle]', 'stock.js: drag handle widened', false),
  selector('dom.titlebar-cluster', CHROME_ANCHORS.titlebarCluster, 'stock.js: titlebar icon clusters made invisible and click-through', true),
  selector('dom.statusbar', CHROME_ANCHORS.statusbar, 'stock.js: status bar hidden (absent when the user turned it off)', false),
  selector('dom.tree-group', CHROME_ANCHORS.rosterZone, 'stock.js: native scrollbars hidden in the roster zone', true),
  selector('dom.sash-overlap', CHROME_ANCHORS.seam, 'stock.js: the sidebar | workspace seam (absent while the sidebar is closed)', false),
  selector('css.aui-md', '.aui-md', 'styles-adapt.ts: Hermes markdown inside bubbles (only once a chat is on screen)', false),
  // Bot Mode's data.
  { id: 'query.bot-mode-roster', kind: 'query', target: JSON.stringify(STOCK_ROSTER_KEY), used: 'app.ts/roster.js: read Bot Mode\'s roster cache (falls back to host.agents + profiles.list)', required: false },
  { id: 'storage.bot-meta', kind: 'storage', target: BOT_MODE_STORAGE_KEYS.botMeta, used: 'app.ts readSideData: Bot Mode\'s local bot meta (read directly with localStorage.getItem on every roster tick, re-parsed only when the text changes, T2)', required: false },
  { id: 'storage.activity-toasts', kind: 'storage', target: BOT_MODE_STORAGE_KEYS.activityToasts, used: 'app.ts: Bot Mode\'s activity-toast setting', required: false },
  { id: 'storage.group-chats', kind: 'storage', target: BOT_MODE_STORAGE_KEYS.groupChats, used: 'rosterActions.ts: Bot Mode\'s group chats', required: false },
  // The desktop bridge.
  { id: 'bridge.api', kind: 'bridge', target: 'api', used: 'app.ts/rosterActions.ts/cronOps.js: core REST (history paging, media and workspace reads, transcription, cron)', required: true },
  { id: 'bridge.readFileDataUrl', kind: 'bridge', target: 'readFileDataUrl', used: 'app.ts: local media reads (falls back to api)', required: false },
  { id: 'bridge.getMachineProfile', kind: 'bridge', target: 'getMachineProfile', used: 'app.ts: the user\'s name for the roster', required: false },
  { id: 'bridge.openExternal', kind: 'bridge', target: 'openExternal', used: 'slackActions.ts openExternalLink: Add to Slack, and a source link the SDK\'s ctx.os.openExternal refused (SourceLink.tsx; falls back to window.open)', required: false },
  { id: 'bridge.requestMicrophoneAccess', kind: 'bridge', target: 'requestMicrophoneAccess', used: 'Voice.tsx: the microphone prompt', required: false },
  // Gateway events.
  ...CONTRACT_EVENTS.map(name => ({ id: `event.${name}`, kind: 'event', target: name, used: 'session.js / reducer.js / rosterActions.ts / Screen.tsx event tap', required: false })),
  ...CONTRACT_EVENT_PREFIXES.map(prefix => ({ id: `event.${prefix}*`, kind: 'event-prefix', target: prefix, used: 'rooms.js: group chat re-read', required: false }))
])

/** Counts of contract event names seen this app session (fed by the tap). */
export function createEventLog(names = CONTRACT_EVENTS, prefixes = CONTRACT_EVENT_PREFIXES) {
  const wanted = new Set(names)
  const counts = new Map()
  const prefixCounts = new Map()
  return {
    note(type) {
      const name = String(type || '')
      if (wanted.has(name)) counts.set(name, (counts.get(name) || 0) + 1)
      for (const prefix of prefixes) if (name.startsWith(prefix)) prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1)
    },
    count: name => counts.get(name) || 0,
    prefixCount: prefix => prefixCounts.get(prefix) || 0
  }
}

function probeEntry(entry, env) {
  try {
    switch (entry.kind) {
      case 'selector': {
        const doc = env.document
        if (!doc || typeof doc.querySelector !== 'function') return 'unprobed'
        return doc.querySelector(entry.target) ? 'ok' : null
      }
      case 'query': {
        const client = env.queryClient
        const cache = client?.getQueryCache?.()
        if (!cache || typeof cache.findAll !== 'function') return null
        const hits = cache.findAll({ queryKey: JSON.parse(entry.target) })
        return Array.isArray(hits) && hits.length ? 'ok' : null
      }
      case 'storage': {
        const store = env.localStorage
        if (!store || typeof store.getItem !== 'function') return 'unprobed'
        return store.getItem(entry.target) !== null ? 'ok' : null
      }
      case 'bridge':
        return typeof env.bridge?.[entry.target] === 'function' ? 'ok' : null
      case 'event':
        return env.events ? (env.events.count(entry.target) > 0 ? 'seen' : 'unseen') : 'unprobed'
      case 'event-prefix':
        return env.events?.prefixCount ? (env.events.prefixCount(entry.target) > 0 ? 'seen' : 'unseen') : 'unprobed'
      default:
        return 'unprobed'
    }
  } catch {
    return null
  }
}

/** Run every probe. `env`: { document, queryClient, localStorage, bridge,
 *  events }. Returns { ok, missing: [ids], counts, entries }. */
export function probeContract(env = {}, contract = CONTRACT) {
  const entries = contract.map(entry => {
    const found = probeEntry(entry, env)
    const status = found ?? (entry.required ? 'missing' : 'absent')
    return { id: entry.id, kind: entry.kind, target: entry.target, required: entry.required, status }
  })
  const missing = entries.filter(e => e.status === 'missing').map(e => e.id)
  const counts = {}
  for (const e of entries) counts[e.status] = (counts[e.status] || 0) + 1
  return { ok: missing.length === 0, missing, counts, entries }
}

/** The one quiet notice for failed required probes, or null. */
export function contractNotice(result) {
  if (!result || result.ok || !result.missing?.length) return null
  const list = result.missing.slice(0, 3).join(', ') + (result.missing.length > 3 ? '…' : '')
  return {
    kind: 'info',
    title: 'Grokbot Override: Hermes changed',
    message: `Some Hermes internals the override relies on were not found (${list}). It keeps working where it can; run "Grokbot Override: self-check" from the command palette (⌘K / Ctrl+K) for details.`
  }
}
