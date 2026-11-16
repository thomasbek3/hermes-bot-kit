// Hiding (never removing) Bot Mode's stock Bots tab while the override is on.
//
// Display only, like the retired bot-sections' "Bots only" did for SESSIONS: one
// <style> hides `hermes-bots:pane`'s tab on every tab surface, and a stock
// tab that is selected gets switched to the override's roster tab once per
// selection change. Bot Mode stays registered and keeps running.
//
// FAIL SAFE: the stock tab is hidden only while the override's roster tab is
// in the DOM, so the sidebar can never end up with no Bots surface at all.
// A "peek" (an Open in Hermes Bot Mode action) lifts the hide until the
// override's roster pane is on screen again.
//
// While the stock tab is hidden in the sidebar tree, a second <style> also
// hides Hermes's tab strips along the top of the window (owner decision,
// 2026-11-09): every zone touching the window top keeps its header band, but
// with no tabs in it. That band stays a window drag region, the traffic
// lights stay where they are, and the sidebar's band shrinks to the titlebar
// height (its "BOTS" tab label sat below the traffic lights). Lower zones'
// strips are untouched. Same lifetime as the stock hide: toggle off or a peek
// removes both styles at once.
//
// The same style also carries the rest of the window chrome the override
// replaces (owner decisions, 2026-11-09 pass 3): Hermes's titlebar icon
// clusters, left and right (made invisible and click-through, never unmounted,
// so Hermes's own titlebar measurements keep working), the bottom status bar,
// native scrollbars in the sidebar zone that holds the override's roster, and
// the sidebar | workspace sash, whose faint hairline becomes a solid one. The
// sash itself stays Hermes's: same 8px grab band, drag and double-click reset.
//
// Guarded (T10, core/contract.js): each chrome rule is written only while its
// anchor is in the DOM (CHROME_ANCHORS). A Hermes update that renames an
// anchor drops that rule instead of letting a stale selector hide the wrong
// thing; the rule comes back on the next sync once the anchor is there.

export const STOCK_PANE_ID = 'hermes-bots:pane'
export const OVERRIDE_ROSTER_PANE_ID = 'grokbot-override:roster'
export const HIDE_STYLE_ID = 'grokbot-override-hide-stock'
export const HIDE_STRIP_STYLE_ID = 'grokbot-override-hide-strip'
export const TAB_ATTRS = ['data-tree-tab', 'data-narrow-overlay-tab']
const RESELECT_GUARD_MS = 1000

export function hideStockCss(attrs = TAB_ATTRS) {
  return attrs.map(attr => `[${attr}="${STOCK_PANE_ID}"]{display:none!important}`).join('\n')
}

const TOP_HEADER = '[data-tree-group][data-window-top] > [data-panel-header]'
const LEFT_CLUSTER = '[data-titlebar-cluster="left"]'
const RIGHT_CLUSTER = '[data-titlebar-cluster="right"]'
const ROSTER_ZONE = '[data-tree-group]:has([data-gbo-root].gbo-roster)'
const SEAM = ':is(div:has(> [data-sash-overlap]):has([data-gbo-root])) > [data-sash-overlap].cursor-col-resize > span:first-child'

/** The DOM anchor each chrome rule depends on (probed before writing it). */
export const CHROME_ANCHORS = Object.freeze({
  topHeader: TOP_HEADER,
  titlebarCluster: '[data-titlebar-cluster]',
  statusbar: 'footer[data-slot="statusbar"]',
  rosterZone: '[data-tree-group]',
  seam: '[data-sash-overlap]'
})

const always = () => true

/** Hermes's top tab strips, hidden; the header band stays as a drag region.
 *  `has(anchor)` says whether an anchor is in the DOM (default: assume so). */
export function hideTopStripCss(has = always) {
  if (!has(CHROME_ANCHORS.topHeader)) return ''
  return [
    `${TOP_HEADER} [data-zone-tabstrip],${TOP_HEADER} [data-panel-page-header]{display:none!important}`,
    `${TOP_HEADER}{height:var(--titlebar-height,34px)!important;background:transparent!important;-webkit-app-region:drag}`,
    `${TOP_HEADER} > [data-window-drag-handle]{flex:1 1 auto!important;width:auto!important}`
  ].join('\n')
}

/** The window chrome hidden or restyled while the override is on; each rule
 *  only when `has` finds its anchor. */
export function hideWindowChromeCss(has = always) {
  return [
    // Titlebar icons: the left cluster beside the traffic lights (sidebar
    // toggle), the fixed right cluster and the pane-tools cluster Hermes
    // renders just before it. Nothing clickable stays in the top band but the
    // override's own buttons.
    has(CHROME_ANCHORS.titlebarCluster) ? `${LEFT_CLUSTER},${RIGHT_CLUSTER},div:has(+ ${RIGHT_CLUSTER}):not([data-titlebar-cluster]){visibility:hidden!important;pointer-events:none!important}` : '',
    // The bottom status bar.
    has(CHROME_ANCHORS.statusbar) ? `footer[data-slot="statusbar"]{display:none!important}` : '',
    // Native scrollbars in the roster's sidebar zone (the override draws its
    // own overlay thumb on hover).
    has(CHROME_ANCHORS.rosterZone) ? `${ROSTER_ZONE} *{scrollbar-width:none!important}` : '',
    // The sidebar | workspace seam: one solid hairline.
    has(CHROME_ANCHORS.seam) ? `${SEAM}{opacity:1!important;background:#e4e4e4!important}` : '',
    has(CHROME_ANCHORS.seam) ? `.dark ${SEAM}{background:#222!important}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** Everything the second style element holds: top strips plus window chrome. */
export function overrideChromeCss(has = always) {
  return [hideTopStripCss(has), hideWindowChromeCss(has)].filter(Boolean).join('\n')
}

export function createStockController({ document, host, now = () => Date.now() }) {
  let on = false
  let peek = false
  let peekSawOverrideHidden = false
  const selection = Object.create(null)
  for (const attr of TAB_ATTRS) selection[attr] = { selected: false, at: 0 }

  const tabs = (attr, paneId) => {
    try {
      return Array.from(document.querySelectorAll(`[${attr}="${paneId}"]`))
    } catch {
      return []
    }
  }

  const writeStyleAt = (id, css) => {
    let el = document.getElementById(id)
    if (!el) {
      el = document.createElement('style')
      el.id = id
      ;(document.head || document.documentElement).appendChild(el)
    }
    if (el.textContent !== css) el.textContent = css
  }

  const removeStyleAt = id => {
    try {
      document.getElementById(id)?.remove()
    } catch {
      /* already gone */
    }
  }

  // A document that cannot be queried keeps every rule (the behaviour before
  // the guard); one that can drops a rule whose anchor is missing.
  const has = anchor => {
    if (typeof document?.querySelector !== 'function') return true
    try {
      return Boolean(document.querySelector(anchor))
    } catch {
      return false
    }
  }

  const writeStyle = (css, strip) => {
    writeStyleAt(HIDE_STYLE_ID, css)
    if (strip) writeStyleAt(HIDE_STRIP_STYLE_ID, overrideChromeCss(has))
    else removeStyleAt(HIDE_STRIP_STYLE_ID)
  }

  const removeStyle = () => {
    removeStyleAt(HIDE_STYLE_ID)
    removeStyleAt(HIDE_STRIP_STYLE_ID)
  }

  const stockShowing = attr =>
    tabs(attr, STOCK_PANE_ID).some(
      tab =>
        tab.getAttribute('aria-selected') === 'true' &&
        !tab.hasAttribute?.('data-vertical') &&
        tab.getAttribute('data-active') !== 'false'
    )

  const activateOverride = attr => {
    if (attr === 'data-tree-tab' && typeof host?.revealPane === 'function') {
      try {
        host.revealPane(OVERRIDE_ROSTER_PANE_ID)
        return true
      } catch {
        /* fall through */
      }
    }
    const tab = tabs(attr, OVERRIDE_ROSTER_PANE_ID)[0]
    if (!tab || typeof tab.dispatchEvent !== 'function' || typeof KeyboardEvent !== 'function') return false
    try {
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return true
    } catch {
      return false
    }
  }

  /** Recompute the hide style and, at most once per selection change, move a
   *  selected stock tab over to the override tab. */
  function sync() {
    const surfaces = on && !peek ? TAB_ATTRS.filter(attr => tabs(attr, OVERRIDE_ROSTER_PANE_ID).length > 0) : []
    if (!surfaces.length) {
      removeStyle()
      for (const attr of TAB_ATTRS) selection[attr].selected = false
      return false
    }
    writeStyle(hideStockCss(surfaces), surfaces.includes('data-tree-tab'))
    for (const attr of TAB_ATTRS) {
      const state = selection[attr]
      if (!surfaces.includes(attr) || !stockShowing(attr)) {
        state.selected = false
        continue
      }
      if (state.selected) continue
      state.selected = true
      const t = now()
      if (state.at && t - state.at < RESELECT_GUARD_MS) continue
      state.at = t
      activateOverride(attr)
    }
    return true
  }

  return {
    sync,
    setOn(value) {
      on = Boolean(value)
      if (!on) {
        peek = false
        removeStyle()
      }
      return sync()
    },
    isOn: () => on,
    isPeeking: () => peek,
    /** Lift the hide for an Open in Hermes Bot Mode action. */
    startPeek() {
      peek = true
      peekSawOverrideHidden = false
      removeStyle()
    },
    /** Feed the override roster pane's visibility; the peek ends when the
     *  pane comes back on screen after having left it. */
    overrideVisible(visible) {
      if (!peek) return
      if (!visible) {
        peekSawOverrideHidden = true
        return
      }
      if (peekSawOverrideHidden) {
        peek = false
        sync()
      }
    },
    endPeek() {
      peek = false
      sync()
    },
    dispose() {
      on = false
      peek = false
      removeStyle()
    }
  }
}
