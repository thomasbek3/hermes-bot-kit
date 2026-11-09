// Milestone 5: hiding (never removing) the stock Bots tab, and the peek that
// every "Open in Hermes Bot Mode" fallback uses.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createStockController, hideStockCss, hideTopStripCss, hideWindowChromeCss, overrideChromeCss, HIDE_STRIP_STYLE_ID, HIDE_STYLE_ID } from '../src/core/stock.js'

function tab(attr, paneId, attrs = {}) {
  const all = { [attr]: paneId, 'aria-selected': 'false', ...attrs }
  const events = []
  return {
    all,
    events,
    getAttribute: name => (name in all ? all[name] : null),
    hasAttribute: name => name in all,
    dispatchEvent: event => events.push(event)
  }
}

function dom(tabs) {
  const head = { children: [] }
  head.appendChild = child => ((child.parentNode = head), head.children.push(child), child)
  return {
    head,
    documentElement: head,
    createElement: () => {
      const node = { id: '', textContent: '' }
      node.remove = () => (head.children = head.children.filter(c => c !== node))
      return node
    },
    getElementById: id => head.children.find(c => c.id === id) || null,
    querySelectorAll: selector => {
      const m = selector.match(/^\[([\w-]+)="([^"]+)"\]$/)
      return tabs.filter(t => m && t.getAttribute(m[1]) === m[2])
    }
  }
}

const setup = (tabs, clock = { t: 10_000 }) => {
  const reveals = []
  const document = dom(tabs)
  const stock = createStockController({ document, host: { revealPane: id => reveals.push(id) }, now: () => clock.t })
  return { stock, document, reveals, clock, style: () => document.getElementById(HIDE_STYLE_ID) }
}

test('the hide rule names only the stock Bots pane, per surface', () => {
  assert.equal(hideStockCss(['data-tree-tab']), '[data-tree-tab="hermes-bots:pane"]{display:none!important}')
})

test('off by default; on hides only on surfaces that also show the override tab', () => {
  const tabs = [
    tab('data-tree-tab', 'hermes-bots:pane'),
    tab('data-tree-tab', 'grokbot-override:roster'),
    tab('data-narrow-overlay-tab', 'hermes-bots:pane')
  ]
  const kit = setup(tabs)
  assert.equal(kit.stock.sync(), false)
  assert.equal(kit.style(), null)
  kit.stock.setOn(true)
  assert.equal(kit.style().textContent, '[data-tree-tab="hermes-bots:pane"]{display:none!important}')
  kit.stock.setOn(false)
  assert.equal(kit.style(), null, 'off removes the rule at once')
})

test('a selected stock tab switches once per selection; an immediate re-select by the app is left alone', () => {
  const stockTab = tab('data-tree-tab', 'hermes-bots:pane', { 'aria-selected': 'true' })
  const kit = setup([stockTab, tab('data-tree-tab', 'grokbot-override:roster')])
  kit.stock.setOn(true)
  assert.deepEqual(kit.reveals, ['grokbot-override:roster'])
  kit.stock.sync()
  assert.equal(kit.reveals.length, 1, 'no retry while it stays selected')

  stockTab.all['aria-selected'] = 'false'
  kit.stock.sync()
  stockTab.all['aria-selected'] = 'true'
  kit.clock.t += 200
  kit.stock.sync()
  assert.equal(kit.reveals.length, 1, 'the app insisting within a second wins')

  stockTab.all['aria-selected'] = 'false'
  kit.stock.sync()
  stockTab.all['aria-selected'] = 'true'
  kit.clock.t += 5_000
  kit.stock.sync()
  assert.equal(kit.reveals.length, 2)
})

test('a minimized zone (vertical rail / inactive strip) is never un-minimized', () => {
  const kit = setup([
    tab('data-tree-tab', 'hermes-bots:pane', { 'aria-selected': 'true', 'data-vertical': '' }),
    tab('data-tree-tab', 'grokbot-override:roster')
  ])
  kit.stock.setOn(true)
  assert.deepEqual(kit.reveals, [])
})

test('the narrow overlay is handled with a keyboard activation of the override tab', () => {
  const ours = tab('data-narrow-overlay-tab', 'grokbot-override:roster')
  globalThis.KeyboardEvent ??= class {
    constructor(type, init) {
      Object.assign(this, { type, ...init })
    }
  }
  const kit = setup([tab('data-narrow-overlay-tab', 'hermes-bots:pane', { 'aria-selected': 'true' }), ours])
  kit.stock.setOn(true)
  assert.equal(ours.events.length, 1)
  assert.equal(ours.events[0].key, 'Enter')
})

test('peek: lifted for a fallback, restored when the override pane is seen again', () => {
  const kit = setup([tab('data-tree-tab', 'hermes-bots:pane'), tab('data-tree-tab', 'grokbot-override:roster')])
  kit.stock.setOn(true)
  assert.ok(kit.style())
  kit.stock.startPeek()
  assert.equal(kit.style(), null)
  kit.stock.sync()
  assert.equal(kit.style(), null, 'sync does not re-hide during a peek')
  kit.stock.overrideVisible(true)
  assert.equal(kit.style(), null, 'still on the override when the peek began: keep peeking')
  kit.stock.overrideVisible(false)
  kit.stock.overrideVisible(true)
  assert.ok(kit.style(), 'back on the override tab: hidden again')
  assert.equal(kit.stock.isPeeking(), false)
})

test('turning the override off ends any peek', () => {
  const kit = setup([tab('data-tree-tab', 'hermes-bots:pane'), tab('data-tree-tab', 'grokbot-override:roster')])
  kit.stock.setOn(true)
  kit.stock.startPeek()
  kit.stock.setOn(false)
  assert.equal(kit.stock.isPeeking(), false)
  kit.stock.setOn(true)
  assert.ok(kit.style())
})

// Owner decision 2026-11-09: while the override is on, Hermes's top tab strip
// (and the sidebar's "BOTS" tab label) is hidden too; off brings it back.
test('top tab strip: hidden only while the override is on, back at once when off or peeking', () => {
  const kit = setup([tab('data-tree-tab', 'hermes-bots:pane'), tab('data-tree-tab', 'grokbot-override:roster')])
  const strip = () => kit.document.getElementById(HIDE_STRIP_STYLE_ID)
  kit.stock.sync()
  assert.equal(strip(), null, 'off by default')
  kit.stock.setOn(true)
  assert.equal(strip().textContent, overrideChromeCss())
  assert.ok(strip().textContent.startsWith(hideTopStripCss()) && strip().textContent.endsWith(hideWindowChromeCss()))
  kit.stock.setOn(false)
  assert.equal(strip(), null, 'toggle off removes the rule at once')
  kit.stock.setOn(true)
  kit.stock.startPeek()
  assert.equal(strip(), null, 'a peek into Bot Mode shows the strip')
  kit.stock.endPeek()
  assert.ok(strip())
  kit.stock.dispose()
  assert.equal(strip(), null)
})

test('top tab strip: not hidden when the override tab is not in the sidebar tree', () => {
  const kit = setup([tab('data-narrow-overlay-tab', 'hermes-bots:pane'), tab('data-narrow-overlay-tab', 'grokbot-override:roster')])
  kit.stock.setOn(true)
  assert.ok(kit.style(), 'the overlay stock tab is still hidden')
  assert.equal(kit.document.getElementById(HIDE_STRIP_STYLE_ID), null)
})

test('top tab strip rule: hides top-edge strips only, keeps the drag band and lower zones', async t => {
  let JSDOM
  try {
    ;({ JSDOM } = await import('jsdom'))
  } catch {
    t.skip('jsdom not installed')
    return
  }
  const zone = (id, top, tabId) => `
    <div data-tree-group="${id}" ${top ? 'data-window-top="true"' : ''}>
      <div data-panel-header="" style="height:62px">
        <div style="width:var(--panel-titlebar-left, 100%)"></div>
        <div data-zone-tabstrip="${id}"><button data-tree-tab="${tabId}" role="tab">tab</button></div>
        <div data-window-drag-handle="" style="width:48px"></div>
      </div>
      <div class="body">body</div>
    </div>`
  const html = `<style>${hideTopStripCss()}</style>` + zone('side', true, 'grokbot-override:roster') + zone('main', true, 'workspace') + zone('bottom', false, 'terminal')
  const { window } = new JSDOM(`<!doctype html><body>${html}</body>`)
  const doc = window.document
  const css = el => window.getComputedStyle(el)
  for (const id of ['side', 'main']) {
    const group = doc.querySelector(`[data-tree-group="${id}"]`)
    assert.equal(css(group.querySelector('[data-zone-tabstrip]')).display, 'none', `${id} strip hidden`)
    const header = group.querySelector('[data-panel-header]')
    assert.notEqual(css(header).display, 'none', `${id} header band stays (traffic lights, drag)`)
    assert.notEqual(css(group.querySelector('[data-window-drag-handle]')).display, 'none')
    assert.notEqual(css(group.querySelector('.body')).display, 'none')
  }
  const lower = doc.querySelector('[data-tree-group="bottom"] [data-zone-tabstrip]')
  assert.notEqual(css(lower).display, 'none', 'a zone below the top keeps its strip')
  assert.match(hideTopStripCss(), /-webkit-app-region:drag/)
  assert.match(hideTopStripCss(), /height:var\(--titlebar-height,34px\)!important/)
  assert.doesNotMatch(hideTopStripCss(), /statusbar|status-bar/i, 'the strip rule leaves the status bar to the window-chrome rule')
  window.close()
})

test('window chrome: titlebar icons (both sides) and the status bar go with the strip, and come back with it', () => {
  const kit = setup([tab('data-tree-tab', 'hermes-bots:pane'), tab('data-tree-tab', 'grokbot-override:roster')])
  const strip = () => kit.document.getElementById(HIDE_STRIP_STYLE_ID)
  kit.stock.setOn(true)
  assert.match(strip().textContent, /\[data-titlebar-cluster="right"\]/)
  assert.match(strip().textContent, /\[data-titlebar-cluster="left"\]/)
  assert.match(strip().textContent, /footer\[data-slot="statusbar"\]\{display:none!important\}/)
  kit.stock.startPeek()
  assert.equal(strip(), null, 'a peek shows Hermes\'s titlebar icons and status bar again')
  kit.stock.endPeek()
  assert.match(strip().textContent, /statusbar/)
  kit.stock.setOn(false)
  assert.equal(strip(), null, 'toggle off restores them at once')
})

test('window chrome rule: left and right titlebar clusters invisible and click-through, sash kept', async t => {
  let JSDOM
  try {
    ;({ JSDOM } = await import('jsdom'))
  } catch {
    t.skip('jsdom not installed')
    return
  }
  const html = `<style>${hideWindowChromeCss()}</style>
    <div data-titlebar-cluster="left" class="left"><button>sidebar</button></div>
    <div class="tools" aria-label="App controls"><button>pane tool</button></div>
    <div data-titlebar-cluster="right" class="right"><button>settings</button></div>
    <div class="row">
      <div class="side-track"><div data-tree-group="side"><div data-gbo-root="" class="gbo-roster"><div class="list">rows</div></div></div></div>
      <div class="main-track">
        <div class="sash cursor-col-resize" data-sash-overlap="trailing" role="separator"><span class="hair" style="opacity:.1"></span><span class="hover"></span></div>
        <div data-tree-group="main"><div data-gbo-root="" class="gbo-ws">chat</div></div>
      </div>
      <div class="tool-track">
        <div class="sash cursor-col-resize" data-sash-overlap="trailing" role="separator"><span class="other-hair" style="opacity:.1"></span></div>
        <div data-tree-group="tools"><div class="list">tool</div></div>
      </div>
    </div>
    <footer data-slot="statusbar" class="status">Backend</footer>`
  const { window } = new JSDOM(`<!doctype html><body>${html}</body>`)
  const doc = window.document
  const css = sel => window.getComputedStyle(doc.querySelector(sel))
  assert.equal(css('.right').visibility, 'hidden')
  assert.equal(css('.right').pointerEvents, 'none', 'clicks reach the panel close button underneath')
  assert.notEqual(css('.right').display, 'none', 'kept mounted: Hermes still measures the cluster')
  assert.equal(css('.tools').visibility, 'hidden', 'the pane-tools cluster beside it too')
  assert.equal(css('.left').visibility, 'hidden', 'the left cluster (sidebar toggle) is hidden too')
  assert.equal(css('.left').pointerEvents, 'none', 'and click-through: nothing clickable in the top band but the override')
  assert.notEqual(css('.left').display, 'none', 'kept mounted: Hermes still measures the cluster')
  assert.equal(css('.status').display, 'none', 'the status bar is hidden')
  assert.equal(css('.hair').opacity, '1', 'the sidebar | workspace seam is a solid hairline')
  assert.notEqual(css('.other-hair').opacity, '1', 'seams away from the override keep Hermes\'s look')
  assert.notEqual(css('.sash').display, 'none', 'Hermes\'s own sash keeps resizing the sidebar')
  window.close()
})
