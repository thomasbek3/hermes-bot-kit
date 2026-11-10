// Write preview HTML pages of the override UI (fixture data) into a folder:
//   node dev/preview.mjs <out-dir> [--window]
// --window frames each page as a desktop window (CSS px): 1576 x 1000, a
// 264px sidebar, the 34px titlebar band and a 21px status strip. That is the
// 2026-11-09 reference window (1135 x 720 screenshot px at 0.72 px per
// CSS px), so a 0.72 downscale of a capture lines up with that screenshot.
// --live frames each page as the live Hermes window compared on
// 2026-11-09: 1047 x 986 pt at Hermes's 90% zoom (0.896 pt per CSS px), so
// 1168 x 1100 CSS px with a 342px sidebar (re-measured on the pass-5
// screenshot; it was 261px before), Hermes's traffic lights, and no
// titlebar band or status strip (the override hides both). It also links the
// real Hermes renderer stylesheet (--host-css=<file>, default: the built
// desktop app under ~/.hermes) so the cascade matches the live app.

import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { bundlePreview } from './bundle.mjs'

/** The same page as an SVG image (foreignObject), for image viewers. */
function toSvg(html, light) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1]
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<svg /g, '<svg xmlns="http://www.w3.org/2000/svg" ')
  const cls = light ? '' : 'dark'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1360" height="820"><foreignObject width="1360" height="820"><div xmlns="http://www.w3.org/1999/xhtml" class="${cls}" style="height:820px;background:${light ? '#fff' : '#0a0a0a'}"><style>${style.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</style>${body}</div></foreignObject></svg>`
}

const WINDOW = { width: 1576, height: 1000, side: 264, titlebar: 34, status: 21 }
const LIVE = { width: 1168, height: 1100, side: 342, titlebar: 0, status: 0, lights: { x: 13, y: 11 } }
const live = process.argv.includes('--live')
const framed = live || process.argv.includes('--window')
const outDir = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'preview-out')

/** The built Hermes desktop stylesheet, if this machine has one. */
function hostCss() {
  const given = process.argv.find(arg => arg.startsWith('--host-css='))
  if (given) return pathToFileURL(resolve(given.slice('--host-css='.length))).href
  const dir = join(homedir(), '.hermes/hermes-agent/apps/desktop/dist/assets')
  if (!existsSync(dir)) return ''
  const main = readdirSync(dir).find(name => /^main-.*\.css$/.test(name))
  return main ? pathToFileURL(join(dir, main)).href : ''
}

/** Add to Slack: the panel's two Slack cards and each dialog step (fixture
 *  payloads shaped like GET /api/messaging/platforms and /api/status; the
 *  served case is a bot on a remote host: a working multiplexed Slack with
 *  no per-profile row, state pending_restart). */
function slackPages() {
  const vars = set => [
    { key: 'SLACK_BOT_TOKEN', required: true, is_set: set },
    { key: 'SLACK_APP_TOKEN', required: true, is_set: set }
  ]
  const none = { id: 'slack', name: 'Slack', enabled: false, configured: false, gateway_running: true, state: 'not_configured', env_vars: vars(false) }
  const live = { ...none, enabled: true, configured: true, state: 'connected', env_vars: vars(true), updated_at: '2026-11-09T17:40:00Z', home_channel: { platform: 'slack', chat_id: 'C0123456789', name: 'bots' } }
  const servedRow = { ...live, state: 'pending_restart', updated_at: null }
  const servedGateway = { gateway_running: true, gateway_state: 'running', gateway_shared_with: ['default', 'helper', 'travel'] }
  const page = (theme, extra) => ({ theme, botIndex: 0, items: SHORT_ITEMS, busy: false, slack: { platform: none }, ...extra })
  const step = (stage, extra = {}) => ({ dialog: { kind: 'slack', initial: { stage, ...extra } } })
  const pending = [{ platform: 'slack', request_id: 'r1', user_id: 'U07ABCDEF', user_name: 'Alex Example' }]
  return {
    'light-slack-connect-new.html': page('light', {connectPreview:'none'}),
    'dark-slack-connect-new.html': page('dark', {connectPreview:'none'}),
    'light-slack-connect-connected.html': page('light', {connectPreview:'connected'}),
    'light-slack-suggested.html': page('light'),
    'dark-slack-suggested.html': page('dark'),
    'light-slack-connected.html': page('light', { slack: { platform: live } }),
    'light-slack-served-connected.html': page('light', { slack: { platform: servedRow, gateway: servedGateway, served: true } }),
    'light-slack-status-sheet.html': page('light', { slack: { platform: live }, dialog: { kind: 'slack-status' } }),
    'light-slack-status-sheet-served.html': page('light', { slack: { platform: servedRow, gateway: servedGateway, served: true }, dialog: { kind: 'slack-status' } }),
    'dark-slack-status-sheet.html': page('dark', { slack: { platform: live }, dialog: { kind: 'slack-status' } }),
    'light-slack-1-create.html': page('light', step('create')),
    'light-slack-2-tokens.html': page('light', step('tokens')),
    'light-slack-2-conflict.html': page('light', step('tokens', { error: "Cannot enable 'slack' on profile 'travel': gateway.multiplex_profiles is on and the default profile's listener already serves it for every profile at /p/travel/." })),
    'light-slack-3-restart.html': page('light', step('restart')),
    'light-slack-3-restarting.html': page('light', step('restarting')),
    'light-slack-3-timeout.html': page('light', step('restart-timeout')),
    'light-slack-4-approve.html': page('light', step('connected', { pending })),
    'dark-slack-1-create.html': page('dark', step('create')),
    'dark-slack-4-approve.html': page('dark', step('connected', { pending }))
  }
}

mkdirSync(outDir, { recursive: true })
const file = await bundlePreview()
const { render, renderAvatarSheet, DIRECTIVE_FILES, DIRECTIVE_ITEMS, CARD_ITEMS, CARD_MULTI_WAITING, CARD_SETTLED_ITEMS, CARD_WAITING, MD_ITEMS, SHORT_ITEMS, USER_ITEMS } = await import(pathToFileURL(file).href)
const host = live ? hostCss() : ''
if (live && !host) console.warn('no Hermes stylesheet found: rendering without the host cascade')
// ROSTER indexes: 0 travel, 1 scholar, 4 recipes (pink), 5 sunny (yellow).
const pages = live ? {
  'light-short.html': { theme: 'light', botIndex: 1, items: SHORT_ITEMS, busy: false },
  // The reference screenshot's chat: panel closed (Share and the details
  // toggle in the header), a pinned bot, markdown with a heading, bullets
  // and links; the same chat with the panel open, and in dark.
  'light-markdown.html': { theme: 'light', botIndex: 1, items: MD_ITEMS, busy: false, panelOpen: false, hasMore: false, pins: ['scholar'] },
  'light-markdown-panel.html': { theme: 'light', botIndex: 1, items: MD_ITEMS, busy: false, hasMore: false, pins: ['scholar'] },
  'dark-markdown.html': { theme: 'dark', botIndex: 1, items: MD_ITEMS, busy: false, panelOpen: false, hasMore: false, pins: ['scholar'] },
  'dark-short.html': { theme: 'dark', botIndex: 1, items: SHORT_ITEMS, busy: false, pins: ['scholar', 'travel'] },
  'light-chat.html': { theme: 'light' },
  'light-chat-work-shown.html': { theme: 'light', showWork: true },
  'light-empty.html': { theme: 'light', items: [], busy: false },
  // The README screenshots: light-pink.html (light.png), dark-short.html (dark.png).
  'light-pink.html': { theme: 'light', botIndex: 4, items: USER_ITEMS, busy: false, pins: ['scholar', 'recipes', 'sunny'] },
  'dark-pink.html': { theme: 'dark', botIndex: 4, items: USER_ITEMS, busy: false, pins: ['scholar'] },
  'light-yellow.html': { theme: 'light', botIndex: 5, items: USER_ITEMS, busy: false, pins: ['scholar', 'recipes', 'sunny'] },
  'dark-yellow.html': { theme: 'dark', botIndex: 5, items: USER_ITEMS, busy: false, pins: ['scholar', 'recipes', 'sunny', 'travel'] },
  ...slackPages(),
  // Cards 7: the choice card waiting (the composer asks for the answer),
  // settled, and with two questions.
  'light-card-waiting.html': { theme: 'light', botIndex: 1, items: CARD_ITEMS, busy: true, waiting: CARD_WAITING, hasMore: false, pins: ['scholar'] },
  'dark-card-waiting.html': { theme: 'dark', botIndex: 1, items: CARD_ITEMS, busy: true, waiting: CARD_WAITING, hasMore: false, pins: ['scholar'] },
  'light-card-settled.html': { theme: 'light', botIndex: 1, items: CARD_SETTLED_ITEMS, busy: false, hasMore: false, pins: ['scholar'] },
  'dark-card-settled.html': { theme: 'dark', botIndex: 1, items: CARD_SETTLED_ITEMS, busy: false, hasMore: false, pins: ['scholar'] },
  'light-card-multi.html': { theme: 'light', botIndex: 1, items: CARD_ITEMS, busy: true, waiting: CARD_MULTI_WAITING, hasMore: false, pins: ['scholar'] },
  'dark-card-multi.html': { theme: 'dark', botIndex: 1, items: CARD_ITEMS, busy: true, waiting: CARD_MULTI_WAITING, hasMore: false, pins: ['scholar'] },
  // Live ::card and ::preview directives in the open chat.
  'light-card-directives.html': { theme: 'light', botIndex: 1, items: DIRECTIVE_ITEMS, busy: false, hasMore: false, pins: ['scholar'], directiveFiles: DIRECTIVE_FILES },
  'dark-card-directives.html': { theme: 'dark', botIndex: 1, items: DIRECTIVE_ITEMS, busy: false, hasMore: false, pins: ['scholar'], directiveFiles: DIRECTIVE_FILES }
} : {
  'dark-chat.html': { theme: 'dark' },
  'light-chat.html': { theme: 'light' },
  'dark-no-chat.html': { theme: 'dark', phase: 'no-chat' },
  'dark-pick.html': { theme: 'dark', selected: false },
  'dark-empty.html': { theme: 'dark', items: [], busy: false },
  'dark-idle.html': { theme: 'dark', busy: false },
  'light-empty.html': { theme: 'light', items: [], busy: false }
}
for (const [name, options] of Object.entries(pages)) {
  const html = render(framed ? { ...options, frame: live ? LIVE : WINDOW, hostCss: host } : options)
  writeFileSync(join(outDir, name), html)
  if (!framed) writeFileSync(join(outDir, name.replace(/\.html$/, '.svg')), toSvg(html, options.theme === 'light'))
}
if (live) writeFileSync(join(outDir, 'avatars-sheet.html'), renderAvatarSheet())
rmSync(dirname(file), { recursive: true, force: true })
console.log(`wrote ${Object.keys(pages).length} pages to ${outDir}`)
