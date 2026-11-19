// The bot's computer viewer: the collapse (Close) icon in the top-right
// corner of every state, after Reconnect; and the pointer over the desk
// image (the Mac's own pointer while watching; noVNC's remote cursor, with
// its dot cursor for an empty shape, while in control).
//
// What hid the pointer: noVNC's Cursor.attach(canvas) calls clear(), which
// sets the canvas's inline style.cursor to "none" until the server sends a
// cursor shape (computer-viewer/vendor/novnc-rfb.mjs, Cursor.clear); a
// headless desk often sends none, or a blank one, while nobody drives it.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url)) && existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

async function preview(t) {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  return import(pathToFileURL(file).href)
}

const STATES = ['watching', 'in-control', 'stale-hold', 'not-running', 'waking', 'reconnecting', 'gave-up', 'not-installed', 'no-screen']

test('Close (the collapse arrows) sits in the top-right corner in every viewer state, after Reconnect', { skip }, async t => {
  const { renderScreenState } = await preview(t)
  for (const state of STATES) {
    const html = renderScreenState(state, 'light')
    const body = html.slice(html.indexOf('<body>'))
    const corner = body.slice(body.indexOf('gbo-screen-corner'))
    assert.ok(body.includes('gbo-screen-corner'), `${state}: the corner is drawn`)
    assert.match(corner, /<button type="button" class="gbo-screen-icon-btn gbo-screen-exit" aria-label="Close" title="Close">/, `${state}: Close, tooltip "Close"`)
    const reconnectAt = corner.indexOf('aria-label="Reconnect"')
    if (reconnectAt >= 0) assert.ok(reconnectAt < corner.indexOf('aria-label="Close"'), `${state}: Reconnect first, Close at the far right`)
    // The corner belongs to the dark surround (the root), so a centred card
    // (install, no screen) gets it too.
    assert.ok(body.indexOf('gbo-screen-corner') > body.indexOf('class="gbo-screen"'), `${state}: inside the viewer root`)
  }
  assert.ok(renderScreenState('not-installed', 'light').includes('The screen is not installed'), 'the install card state')
  assert.ok(renderScreenState('no-screen', 'light').includes('No screen on this Hermes'), 'the no-screen card state')
})

test('without an exit path (a preview) there is no dead Close button', { skip }, async t => {
  const mod = await preview(t)
  const html = mod.renderElement(mod.ProfilePanel, { bot: { name: 'travel' } })
  assert.ok(!html.includes('gbo-screen-exit'), 'the panel draws no viewer button')
})

function cursorDom(css) {
  // eslint-disable-next-line no-undef
  return import('jsdom').then(({ JSDOM }) => {
    const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>
      <div data-gbo-root="" data-gbo-theme="dark" class="gbo-screen">
        <div class="gbo-screen-stage" id="watch"><div class="gbo-screen-canvas"><div><canvas style="cursor: none"></canvas></div></div></div>
        <div class="gbo-screen-stage is-held" id="held"><div class="gbo-screen-canvas"><div><canvas style="cursor: none"></canvas></div></div></div>
        <div class="gbo-screen-stage" id="watch-shape"><div class="gbo-screen-canvas"><div><canvas style="cursor: url(data:image/png;base64,AAAA) 2 2, default"></canvas></div></div></div>
      </div></body></html>`)
    const cursorOf = id => dom.window.getComputedStyle(dom.window.document.querySelector(`#${id} canvas`)).cursor
    return { cursorOf, dom }
  })
}

test('cursor: watching keeps the Mac’s pointer over the desk image; control leaves noVNC’s cursor', { skip }, async t => {
  const { CSS } = await preview(t)
  const { cursorOf } = await cursorDom(CSS)
  assert.equal(cursorOf('watch'), 'default', 'watching: noVNC’s inline "none" is overridden')
  assert.equal(cursorOf('watch-shape'), 'default', 'watching: a remote cursor shape is not used as the local pointer')
  assert.equal(cursorOf('held'), 'none', 'in control: the canvas cursor is noVNC’s (here still empty)')
})

test('cursor: in control an empty remote cursor shows noVNC’s dot cursor, never nothing', () => {
  const screen = readFileSync(new URL('../src/ui/Screen.tsx', import.meta.url), 'utf8')
  assert.match(screen, /client\.showDotCursor = true/, 'showDotCursor is set on every RFB client')
  // noVNC's own rule (vendored 1.7.0): the dot replaces a cursor whose pixels
  // are all transparent, or the initial empty one.
  const novnc = readFileSync(new URL('../../computer-viewer/vendor/novnc-rfb.mjs', import.meta.url), 'utf8')
  assert.match(novnc, /_shouldShowDotCursor\(\) \{\s*if \(!this\._showDotCursor\) \{\s*return false;\s*\}\s*for \(let i = 3; i < this\._cursorImage\.rgbaPixels\.length; i \+= 4\) \{\s*if \(this\._cursorImage\.rgbaPixels\[i\]\) \{\s*return false;/)
  assert.match(novnc, /clear\(\) \{\s*this\._target\.style\.cursor = "none";/, 'the source of the hidden pointer')
})

test('the viewer adds no Escape handling of its own (in control, keys still go to the remote desk)', () => {
  const screen = readFileSync(new URL('../src/ui/Screen.tsx', import.meta.url), 'utf8')
  assert.ok(!/Escape/.test(screen.replace(/\/\/.*$/gm, '')), 'no Escape key code in the viewer')
  assert.ok(!/addEventListener\('keydown'/.test(screen), 'no keydown listener in the viewer')
})
