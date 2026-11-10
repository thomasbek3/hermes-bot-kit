// Server-side render of the override UI with fixture data (render test and
// preview page). Not part of plugin.js.

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { app } from '../src/ui/app'
import { ChatWorkspace } from '../src/ui/Chat'
import { DirectiveContext } from '../src/ui/Directives'
import { RosterPane } from '../src/ui/Roster'
import { CSS } from '../src/ui/styles'
import { rowKey } from '../src/core/roster.js'
import { overrideChromeCss } from '../src/core/stock.js'
import { CARD_ITEMS, CARD_MULTI_WAITING, CARD_SETTLED_ITEMS, CARD_WAITING, CHAT_ITEMS, DIRECTIVE_FILES, DIRECTIVE_ITEMS, MD_ITEMS, ROSTER, SHORT_ITEMS, USER_ITEMS } from './fixtures'
import { BOT_SWATCHES } from '../src/core/colors.js'
import { ShapeFace } from '../src/ui/Avatar'
import { AVATAR_SHAPES, avatarShapeFor } from '../src/ui/avatarShapes'
import { roster2 } from '../src/ui/rosterStores'
import { primeBotModel } from '../src/ui/rosterActions'
import { primeModelOptions } from '../src/ui/ProfileConfig'
import { slack } from '../src/ui/slackActions'
import { SlackConnect } from '../src/ui/SlackConnect'
const avatarShapeForKey = (key: string) => avatarShapeFor(key).name

/** Demo scheduled jobs per fixture bot (one paused, for the off switch). */
const JOBS: Record<string, any[]> = {
  travel: [
    { job_id: 'j1', name: 'Trip price check', schedule: 'Every day around 9:30 AM', enabled: true },
    { job_id: 'j2', name: 'Weekend weather check', schedule: 'Every 2 hours', enabled: true },
    { job_id: 'j3', name: 'Packing list reminder', schedule: 'Every Friday', enabled: false, state: 'paused' }
  ],
  scholar: [
    { job_id: 'j4', name: 'Morning reading digest', schedule: 'Every day at 8:00 AM', enabled: true },
    { job_id: 'j5', name: 'New releases roundup', schedule: 'Every Monday', enabled: false, state: 'paused' }
  ],
  budget: [{ job_id: 'j6', name: 'Weekly budget summary', schedule: 'Every Sunday at 6:00 PM', enabled: true }],
  recipes: [
    { job_id: 'j7', name: 'Weekly meal plan', schedule: 'Every Sunday at 10:00 AM', enabled: true },
    { job_id: 'j8', name: 'Grocery list reminder', schedule: 'Every Saturday', enabled: true }
  ],
  sunny: [{ job_id: 'j9', name: 'Morning forecast', schedule: 'Every day at 7:00 AM', enabled: true }]
}

const PAGE_CSS = `
html, body { margin: 0; height: 100%; }
body { background: #0a0a0a; }
html:not(.dark) body { background: #fff; }
.preview { display: flex; height: 820px; width: 1360px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.preview-side { width: 290px; flex: none; display: flex; border-right: 1px solid #8882; }
.dark .preview-side { border-right-color: #202020; }
.preview-main { flex: 1; min-width: 0; display: flex; }
/* Desktop-window frame: an empty titlebar band over both zones (the tab
   strip is hidden while the override is on) and a status-bar strip. */
.preview-window { display: flex; flex-direction: column; }
.preview-window > .preview { flex: 1; min-height: 0; height: auto; width: auto; }
.preview-window .preview-side, .preview-window .preview-main { flex-direction: column; }
.preview-window .preview-side > :last-child, .preview-window .preview-main > :last-child { flex: 1; min-height: 0; }
.preview-band { flex: none; }
.preview-side .preview-band { background: #f5f5f5; }
.preview-main .preview-band { background: #fdfcfc; }
.dark .preview-side .preview-band { background: #0e0e0e; }
.dark .preview-main .preview-band { background: #121212; }
.preview-status { flex: none; border-top: 1px solid #8882; background: #fff; }
.dark .preview-status { background: #0a0a0a; border-top-color: #202020; }
/* The live window: Hermes's fixed traffic lights over the sidebar's top row,
   and Hermes's own 8px sash at the sidebar | workspace seam (its hairline is
   what the override restyles). */
.preview-window { position: relative; }
.preview-lights { position: absolute; z-index: 80; display: flex; gap: 10px; }
.preview-lights i { width: 15.5px; height: 15.5px; border-radius: 999px; background: #dcdcdc; box-shadow: inset 0 0 0 .5px #0000001f; }
.preview-main { position: relative; }
.preview-sash { position: absolute; z-index: 20; inset: 0 auto 0 0; width: 8px; cursor: col-resize; }
.preview-sash > span { position: absolute; inset: 0 auto 0 1px; width: 1px; transform: translateX(-50%); opacity: .1; background: #888; }
`

/** A desktop-window frame for the preview, in CSS px. */
export interface Frame {
  width: number
  height: number
  side: number
  titlebar: number
  status: number
  /** Traffic lights (CSS px from the window's top-left), drawn as Hermes
   *  positions them. */
  lights?: { x: number; y: number }
}

export interface RenderOptions {
  theme?: 'dark' | 'light'
  phase?: 'ready' | 'no-chat' | 'error' | 'resolving'
  busy?: boolean
  items?: any[]
  selected?: boolean
  narrow?: boolean
  drawerOpen?: boolean
  waiting?: any
  stopError?: null | string
  frame?: Frame | null
  /** Which fixture bot is open (ROSTER index). */
  botIndex?: number
  /** A stylesheet the page links before the override's own CSS: the real
   *  Hermes renderer CSS, so the preview reproduces the live cascade. */
  hostCss?: string
  /** Show Thought and tool rows (Bubble Mode's work-rows preference). */
  showWork?: boolean
  /** Bots pinned to the top, as ROSTER names. */
  pins?: string[]
  /** The open bot's Slack entry (GET /api/messaging/platforms), and whether
   *  its Suggested card was hidden. Absent: no Slack card. */
  slack?: { platform: any; hidden?: boolean; gateway?: any; served?: boolean }
  /** An open roster dialog for the open bot, e.g. {kind: 'slack', initial}. */
  dialog?: any
  /** Static fixture for the new Slack connection sheet. */
  connectPreview?: 'none' | 'connected'
  /** The profile panel (default open). */
  panelOpen?: boolean
  /** "Show earlier messages" at the top (default on for a ready chat). */
  hasMore?: boolean
  /** Live ::card / ::preview directives drawn from these workspace files. */
  directiveFiles?: Record<string, any> | null
}

export function render({
  theme = 'dark',
  phase = 'ready',
  busy = true,
  items = CHAT_ITEMS,
  selected = true,
  narrow = false,
  drawerOpen = false,
  waiting = null,
  stopError = null,
  frame = null,
  botIndex = 0,
  hostCss = '',
  showWork = false,
  pins = [],
  slack: slackOption,
  dialog = null,
  connectPreview,
  panelOpen = true,
  hasMore,
  directiveFiles = null
}: RenderOptions = {}) {
  // A host with the app-action door, so the sidebar toggle draws.
  if (!app.ctx) app.ctx = { runAction: () => ({ ok: true }) }
  app.showWork.set(showWork)
  app.pinnedBots.set(pins.map(name => ROSTER.find(bot => bot.name === name)).filter(Boolean).map(bot => rowKey(bot)))
  app.narrow.set(narrow)
  app.drawerOpen.set(drawerOpen)
  app.roster.set({ rows: ROSTER, sources: [], origin: 'stock', error: null, updatedAt: Date.now(), localMeta: {}, kitSections: null })
  const bot = ROSTER[botIndex] || ROSTER[0]
  slack.state.set(
    slackOption
      ? { key: rowKey(bot), loading: false, loaded: true, error: null, platform: slackOption.platform, gateway: slackOption.gateway ?? null, served: Boolean(slackOption.served) }
      : { key: '', loading: false, loaded: false, error: null, platform: null, gateway: null, served: false }
  )
  slack.hidden.set(slackOption?.hidden ? [rowKey(bot)] : [])
  roster2.dialog.set(dialog ? { ...dialog, bot } : null)
  // The panel's Model row and its picker: an invented demo model.
  primeBotModel(bot, { provider: 'example', model: 'atlas-large' })
  primeModelOptions(bot, { providers: [{ slug: 'example', name: 'Example', models: ['atlas-large', 'atlas-small'], authenticated: true }] })
  app.selectedKey.set(selected ? rowKey(bot) : '')
  app.panelOpen.set(panelOpen)
  app.chat.set(
    selected
      ? {
          bot,
          phase,
          error: phase === 'error' ? 'Could not check travel’s Bot Chat registry (socket closed)' : null,
          canonical: { id: 's-root' },
          storedId: 's-root',
          runtimeId: 'rt-1',
          hasMore: hasMore ?? phase === 'ready',
          loadingMore: false,
          attachError: null,
          stopError,
          chat: { items, busy, status: null, live: {}, waiting }
        }
      : null
  )
  // The open bot's scheduled jobs (demo routines), so its panel shows them.
  app.cron.set({
    key: rowKey(bot),
    loading: false,
    error: null,
    busy: {},
    jobs: JOBS[bot.name] || []
  })
  app.screen.set({ key: rowKey(bot), status: { running: false, supported: true } })
  const band = frame?.titlebar ? <div className="preview-band" style={{ height: frame.titlebar }} /> : null
  const panes = (
    <div className="preview">
      <div className="preview-side" style={frame ? { width: frame.side } : undefined}>
        {band}
        <RosterPane />
      </div>
      <div className="preview-main">
        {frame?.lights ? (
          <div className="preview-sash cursor-col-resize" role="separator" data-sash-overlap="trailing">
            <span />
          </div>
        ) : null}
        {band}
        {directiveFiles ? (
          <DirectiveContext.Provider value={{ bot, sessionId: 's-root', sendIntent: async () => ({ ok: true }), recent: new Set(), preload: directiveFiles, theme }}>
            <ChatWorkspace />
          </DirectiveContext.Provider>
        ) : (
          <ChatWorkspace />
        )}
      </div>
    </div>
  )
  const body = renderToStaticMarkup(
    frame ? (
      <div className="preview-window" style={{ width: frame.width, height: frame.height }}>
        {frame.lights ? (
          <div className="preview-lights" style={{ left: frame.lights.x, top: frame.lights.y }} aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        ) : null}
        {panes}
        {frame.status ? <div className="preview-status" style={{ height: frame.status }} /> : null}
      </div>
    ) : (
      panes
    )
  )
  const connectSheet = connectPreview ? renderToStaticMarkup(<SlackConnect bot={bot} name={bot.display_name} initial={{workspaces: [{team_id:'T1', team_name:'Example Workspace'}], status: {phase:connectPreview, mode:'http', team_name:'Example Workspace'}}} onClose={() => {}} />) : ''
  const host = hostCss ? `<link rel="stylesheet" href="${hostCss}">` : ''
  // A live frame is the override switched on: its window-chrome style too.
  const chrome = frame?.lights ? `\n${overrideChromeCss()}` : ''
  return `<!doctype html><html class="${theme === 'dark' ? 'dark' : ''}"><head><meta charset="utf-8">${host}<style>${CSS}\n${PAGE_CSS}${chrome}</style></head><body>${body}${connectSheet}</body></html>`
}
export { CARD_ITEMS, CARD_MULTI_WAITING, CARD_SETTLED_ITEMS, CARD_WAITING, CSS, DIRECTIVE_FILES, DIRECTIVE_ITEMS, MD_ITEMS, SHORT_ITEMS, USER_ITEMS }

// Test seams (review r2): the real app module and UI pieces, on the fake SDK.
export * as appApi from '../src/ui/app'
export * as fakeSdk from '@hermes/plugin-sdk'
export { ComposerNote } from '../src/ui/Composer'
export { ProfilePanel } from '../src/ui/Profile'
export { UserMeta } from '../src/ui/Chat'
export function renderElement(component: any, props: any) {
  return renderToStaticMarkup(React.createElement(component, props))
}

// Test seams (roster-side parity): actions and their stores, on the fake SDK.
export * as rosterApi from '../src/ui/rosterActions'
export * as rosterStoresApi from '../src/ui/rosterStores'

/** Every avatar shape in every swatch colour, on the light and dark sidebar
 *  greys, as one page (the contact sheet). */
export function renderAvatarSheet() {
  const cell = 64
  const grid = (bg: string, fg: string) => (
    <div className={bg === '#0e0e0e' ? 'dark' : ''} style={{ background: bg, color: fg, padding: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `90px repeat(${BOT_SWATCHES.length}, ${cell}px)`, gap: 10, alignItems: 'center' }}>
        <span />
        {BOT_SWATCHES.map(swatch => (
          <span key={swatch.name} style={{ font: '12px -apple-system, sans-serif', textAlign: 'center' }}>{swatch.name}</span>
        ))}
        {AVATAR_SHAPES.map(shape => (
          <React.Fragment key={shape.name}>
            <span style={{ font: '12px -apple-system, sans-serif' }}>{shape.name}</span>
            {BOT_SWATCHES.map(swatch => {
              const key = findKeyFor(shape.name)
              return (
                <span key={swatch.name} className="gbo-avatar" style={{ width: 48, height: 48, margin: 8 }}>
                  <ShapeFace shapeKey={key} fill={swatch.fill} swatch={swatch.name} />
                </span>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
  const body = renderToStaticMarkup(
    <div style={{ display: 'flex', flexDirection: 'column', width: 'max-content' }}>
      {grid('#f5f5f5', '#1c1c1c')}
      {grid('#0e0e0e', '#f5f5f5')}
    </div>
  )
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}\nhtml,body{margin:0}</style></head><body>${body}</body></html>`
}

/** A route key that picks the named shape (for the contact sheet only). */
function findKeyFor(name: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const key = `sheet::${i}`
    if (avatarShapeForKey(key) === name) return key
  }
  return ''
}

export * as avatarShapesApi from '../src/ui/avatarShapes'
export * as Avatar from '../src/ui/Avatar'
export { refCss, REF_STYLES } from '../src/ui/styles-ref'
