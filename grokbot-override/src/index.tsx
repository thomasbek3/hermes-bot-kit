// Grokbot Override: a Grok-Bot-style Bot Mode screen inside Hermes Desktop,
// on the Hermes engine. Bot Mode itself is never removed or disabled; see
// PARITY.md for what this screen does and where it hands back to Bot Mode.

import { app, backToOverride, findBot, isPinnedTop, openInBotMode, PLUGIN_ID, PROBE, selectBot, selfCheck, setEnabled, setRenderers, setShowWork, start, stop, toggleTopPin } from './ui/app'
import { OverrideBoundary } from './ui/Boundary'
import { ChatWorkspace } from './ui/Chat'
import { primeModelOptions } from './ui/ProfileConfig'
import { RosterPane } from './ui/Roster'
import { RoomWorkspace } from './ui/Rooms'
import { createBot } from './ui/rosterActions'
import { openDialog, roster2 } from './ui/rosterStores'
import { openBotScreen, screenStore } from './ui/Screen'
import { contractNotice, createEventLog, probeContract } from './core/contract.js'
import { desktopBridge, host, PALETTE_AREA, queryClient, sdk } from './ui/sdk'
import { UsageStatusChip } from './ui/UsageMeter'
import { createBotChat, wireParity } from './ui/wiring'

// T10: the private-internals contract (core/contract.js). Event names seen
// this app session, the probe, and the one quiet notice per app session.
const contractEvents = createEventLog()
const NOTICE_FLAG = '__grokbotOverrideContractNoticed'
const CONTRACT_PROBE_MS = 8_000

function runContractProbe() {
  return probeContract({
    document: typeof document === 'undefined' ? null : document,
    queryClient: queryClient(),
    localStorage: (() => {
      try {
        return globalThis.localStorage ?? null
      } catch {
        return null
      }
    })(),
    bridge: desktopBridge(),
    events: contractEvents
  })
}

/** Once the override is on screen: probe, and if a required entry is gone,
 *  one quiet notice per app session (survives a plugin reload). Returns
 *  false while the override is off or not mounted yet (nothing probed). */
function contractStartupCheck(): boolean {
  try {
    if (!app.enabled.get() || typeof document === 'undefined' || !document.querySelector('[data-gbo-root]')) return false
    const notice = contractNotice(runContractProbe())
    const w = (globalThis as any).window ?? globalThis
    if (notice && !w[NOTICE_FLAG]) {
      w[NOTICE_FLAG] = true
      host?.notify?.(notice)
    }
    return true
  } catch {
    return true
  }
}

/** The startup probe's schedule (review C-R1-04): 8 s after load, retried a
 *  few times while the override is not on screen yet, and armed again each
 *  time the override is switched on, until one probe has run. */
const CONTRACT_PROBE_TRIES = 5
function createContractSchedule(ctx: any) {
  let done = false
  let tries = 0
  let cancel: null | (() => void) = null
  const arm = () => {
    if (done || cancel || typeof ctx?.setTimeout !== 'function') return
    const handle = ctx.setTimeout(() => {
      cancel = null
      if (contractStartupCheck()) {
        done = true
        return
      }
      tries += 1
      if (tries < CONTRACT_PROBE_TRIES && app.enabled.get()) arm()
    }, CONTRACT_PROBE_MS)
    cancel = typeof handle === 'function' ? handle : () => undefined
  }
  arm()
  const off = app.enabled.subscribe(() => {
    if (!app.enabled.get() || done) return
    tries = 0
    arm()
  })
  return () => {
    off()
    cancel?.()
    cancel = null
    done = true
  }
}

/** The self-check report (app.ts selfCheck writes it through ctx.files) gets
 *  the contract block: the files door is wrapped, nothing else changes. */
function withContractReport(ctx: any) {
  const files = ctx?.files
  if (!files || typeof files.writeText !== 'function') return ctx
  const wrapped = Object.create(files)
  wrapped.writeText = (scope: string, name: string, text: string, ...rest: any[]) => {
    if (scope === 'data' && name === 'self-check.json') {
      try {
        text = JSON.stringify({ ...JSON.parse(text), contract: runContractProbe() }, null, 2)
      } catch {
        /* keep the report as it was */
      }
    }
    return files.writeText(scope, name, text, ...rest)
  }
  return { ...ctx, files: wrapped }
}

export default {
  id: PLUGIN_ID,
  name: 'Grokbot Override',
  defaultEnabled: true,
  description:
    'A chat-app Bot Mode screen (roster, Bot Chat, profile panel) on the same chats and gateway as Hermes Bot Mode. ' +
    'Palette: "Grokbot Override: toggle" switches back to stock Bot Mode instantly.',
  register(ctx: any) {
    // Each pane renders inside the override's own boundary: an error stays in
    // the pane (inline, with "Turn override off"), never Hermes's root.
    setRenderers({
      roster: () => (
        <OverrideBoundary area="roster">
          <RosterPane />
        </OverrideBoundary>
      ),
      workspace: () => (
        <OverrideBoundary area="chat">
          <ChatWorkspace />
        </OverrideBoundary>
      ),
      tab: slot => (
        <OverrideBoundary area="chat">
          <ChatWorkspace slot={slot} />
        </OverrideBoundary>
      ),
      room: slot => (
        <OverrideBoundary area="room">
          <RoomWorkspace slot={slot} />
        </OverrideBoundary>
      )
    })

    ctx.registerMany([
      {
        id: 'palette-toggle',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.toggle`,
          label: 'Grokbot Override: toggle',
          keywords: ['bot', 'bots', 'override', 'chat', 'roster', 'stock', 'bot mode'],
          detail: () => (app.enabled.get() ? 'on' : 'off'),
          detailVariant: 'state',
          keepOpen: true,
          run: () => setEnabled(!app.enabled.get())
        }
      },
      // Thought and tool rows in the chat (core/workRows.js), hidden by default.
      {
        id: 'palette-show-work',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.show-work`,
          label: 'Grokbot Override: show work rows',
          keywords: ['work', 'tools', 'thinking', 'thought', 'reasoning', 'rows', 'override'],
          detail: () => (app.showWork.get() ? 'on' : 'off'),
          detailVariant: 'state',
          keepOpen: true,
          run: () => setShowWork(!app.showWork.get())
        }
      },
      {
        id: 'palette-stock',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.open-stock`,
          label: 'Grokbot Override: open Hermes Bot Mode for this bot',
          keywords: ['bot mode', 'stock', 'fallback', 'hermes'],
          run: () => void openInBotMode(undefined)
        }
      },
      {
        id: 'palette-back',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.back`,
          label: 'Grokbot Override: back to the override roster',
          keywords: ['bot', 'override', 'chats'],
          run: () => backToOverride()
        }
      },
      // Roster-side parity: keyboard doors to the new surfaces.
      ...[
        ['new-bot', 'Grokbot Override: new bot', () => openDialog({ kind: 'create' }), false],
        ['edit-bot', 'Grokbot Override: edit this bot’s profile', (bot: any) => openDialog({ kind: 'edit', bot }), true],
        ['config-bot', 'Grokbot Override: this bot’s skills, tools and model', (bot: any) => openDialog({ kind: 'config', bot }), true],
        ['new-job', 'Grokbot Override: new scheduled job for this bot', (bot: any) => openDialog({ kind: 'cron-edit', bot, job: null }), true],
        ['screen', 'Grokbot Override: open this bot’s computer', (bot: any) => openBotScreen(bot), true]
      ].map(([id, label, run, needsBot]: any) => ({
        id: `palette-${id}`,
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.${id}`,
          label,
          keywords: ['bot', 'override'],
          run: () => {
            const bot = findBot(app.selectedKey.get())
            if (needsBot && !bot) return
            run(bot)
          }
        }
      })),
      // Pins at the top of the sidebar (core/pins.js), for the current bot.
      ...[
        ['pin-top', 'Grokbot Override: pin bot to top', true],
        ['unpin-top', 'Grokbot Override: unpin bot from top', false]
      ].map(([id, label, pin]: any) => ({
        id: `palette-${id}`,
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.${id}`,
          label,
          keywords: ['bot', 'override', 'pin', 'pinned', 'top', 'favourite'],
          run: () => {
            const bot = findBot(app.selectedKey.get())
            if (bot && isPinnedTop(bot) !== pin) toggleTopPin(bot)
          }
        }
      })),
      // C25: the open Bot Chat's context / cost meter, where stock's lives.
      {
        id: 'usage-meter',
        area: (sdk as any).STATUSBAR_AREAS?.right ?? 'statusBar.right',
        order: 90,
        render: () => (
          <OverrideBoundary area="usage" compact>
            <UsageStatusChip />
          </OverrideBoundary>
        )
      },
      {
        id: 'palette-self-check',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.self-check`,
          label: 'Grokbot Override: self-check (read-only)',
          keywords: ['diagnostics', 'check', 'override'],
          run: () => void selfCheck()
        }
      }
    ])

    // Test seam for the loader-faithful smoke test: only a ctx that offers
    // this hook (never Hermes's) receives the internals.
    if (typeof ctx?.__gboSmoke === 'function') ctx.__gboSmoke({ app, roster2, openDialog, selectBot, openBotScreen, screenStore, setEnabled, primeModelOptions, createBot, createBotChat })

    // Roster-side surfaces call into the chat side (R13 kickoff, R12 new tab,
    // New group chat, room failures on the badge): src/ui/wiring.ts.
    const unwire = wireParity()
    const offContractEvents = typeof ctx?.onEvent === 'function' ? ctx.onEvent('*', (event: any) => contractEvents.note(event?.type)) : null
    start(withContractReport(ctx))
    const stopContractSchedule = createContractSchedule(ctx)
    if (PROBE) ctx.setTimeout(() => void selfCheck({ notify: false }), 6_000)
    ctx.onDispose(() => {
      stop()
      unwire()
      if (typeof offContractEvents === 'function') offContractEvents()
      stopContractSchedule()
    })
  }
}
