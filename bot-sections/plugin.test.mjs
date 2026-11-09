import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginPath = new URL('./plugin.js', import.meta.url)
const SOURCE = fs.readFileSync(pluginPath, 'utf8')

const HOOKS =
  '\nglobalThis.__testHooks = { applyAssignData, applyAssignFileText, findBotsPaneRoots, cssAttr,' +
  ' HEADER_ATTR, sectionForKey, sectionLadder, getOverrides: () => overrides,' +
  ' getCustomSections: () => customSections, BOTS_ONLY_STYLE_ID, sync }\n'

/** The parts of CSS.escape a section name can actually hit. */
function cssEscape(value) {
  return String(value).replace(/[^\w-]/g, ch => '\\' + ch)
}

/** Undo CSS string escaping, the way a selector parser would. */
function cssUnescape(value) {
  return String(value).replace(/\\(.)/g, '$1')
}

function classList(...names) {
  const set = new Set(names)
  return { contains: name => set.has(name) }
}

/** A roster element. `hiddenPane` makes `inHiddenPane()` true for it. */
function el({ className = '', textContent = '', classes = [], parentElement = null, hiddenPane = false } = {}) {
  return {
    className,
    classList: classList(...classes),
    closest: selector => (hiddenPane && selector === '[data-pane-hidden]' ? { id: 'hidden-pane' } : null),
    parentElement,
    textContent
  }
}

/** A pane tab: `[attr]=paneId`, with aria-selected and a dispatch log. */
function tab(attr, paneId, { selected = false, extra = {} } = {}) {
  const attrs = { [attr]: paneId, role: 'tab', 'aria-selected': String(selected), ...extra }
  const dispatched = []
  return {
    attrs,
    dispatched,
    closest: () => null,
    dispatchEvent: event => {
      dispatched.push(event)
      return true
    },
    getAttribute: name => (name in attrs ? attrs[name] : null),
    hasAttribute: name => name in attrs,
    setAttribute: (name, value) => {
      attrs[name] = String(value)
    }
  }
}

/** Matches `[attr]` / `[attr="value"]`, the only selectors the tab code uses. */
function matchAttrSelector(selector, element) {
  const m = selector.match(/^\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]$/)
  if (!m || typeof element.getAttribute !== 'function') return false
  const value = element.getAttribute(m[1])
  if (value === null) return false
  return m[2] === undefined || value === cssUnescape(m[2])
}

/** In-memory plugin storage, shareable across loads to model a restart. */
function memoryStorage(seed = {}) {
  const data = { ...seed }
  return {
    data,
    get: (key, fallback) => (key in data ? data[key] : fallback),
    set: (key, value) => {
      data[key] = value
    }
  }
}

function load({ spans = [], tabs = [], host = {} } = {}) {
  const warnings = []
  const escaped = []
  const head = { children: [] }
  head.appendChild = child => {
    child.parentNode = head
    head.children.push(child)
    return child
  }
  const createElement = tag => {
    const node = { tagName: tag.toUpperCase(), id: '', textContent: '', parentNode: null, style: {} }
    node.remove = () => {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(c => c !== node)
      node.parentNode = null
    }
    return node
  }
  const context = {
    __host: { state: {}, ...host },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init = {}) {
        this.type = type
        Object.assign(this, init)
      }
    },
    window: { addEventListener() {}, removeEventListener() {} },
    Date,
    CSS: {
      escape: value => {
        escaped.push(value)
        return cssEscape(value)
      }
    },
    console: { warn: message => warnings.push(message) },
    document: {
      body: { classList: { add() {}, contains: () => false, remove() {} } },
      createElement,
      documentElement: head,
      getElementById: id => head.children.find(child => child.id === id) || null,
      head,
      querySelector: selector => tabs.find(t => matchAttrSelector(selector, t)) || null,
      querySelectorAll: selector => (selector === 'span' ? spans : tabs.filter(t => matchAttrSelector(selector, t)))
    },
    globalThis: null,
    setTimeout: () => 0
  }
  context.globalThis = context

  const source = SOURCE.replace(
    "import { PALETTE_AREA, host } from '@hermes/plugin-sdk'",
    "const PALETTE_AREA = 'palette'; const host = globalThis.__host"
  )
    .replace('export default {', 'globalThis.__plugin = {')
    .concat(HOOKS)

  vm.runInNewContext(source, vm.createContext(context), { filename: pluginPath.pathname })
  return { ...context.__testHooks, plugin: context.__plugin, head, warnings, escaped }
}

/** Register the plugin like the host does; returns its palette commands. */
function register(kit, storage = memoryStorage()) {
  const commands = new Map()
  const disposers = []
  kit.plugin.register({
    storage,
    register: ({ data }) => commands.set(data.id, data),
    onDispose: fn => disposers.push(fn)
  })
  return { commands, storage, dispose: () => disposers.forEach(fn => fn()) }
}

const SESSIONS_TOGGLE = 'bot-sections.sessions-tab-toggle'
const BOTS = 'hermes-bots:pane'

function botsOnlyStyle(kit) {
  return kit.head.children.find(child => child.id === kit.BOTS_ONLY_STYLE_ID) || null
}

test('a valid bot-sections.json creates its sections and assigns its bots', () => {
  const kit = load()

  kit.applyAssignFileText(JSON.stringify({ sections: ['Airbnb Ops'], assign: { helper: 'Airbnb Ops' } }))

  assert.deepEqual({ ...kit.getOverrides() }, { helper: 'Airbnb Ops' })
  assert.ok(kit.sectionLadder().includes('Airbnb Ops'))
  assert.equal(kit.sectionForKey('helper'), 'Airbnb Ops')
  assert.equal(kit.sectionForKey('@Helper'), 'Airbnb Ops')
  assert.equal(kit.sectionForKey('nobody'), 'Unassigned')
})

test('a section named only in assign is created on the spot', () => {
  const kit = load()

  kit.applyAssignFileText(JSON.stringify({ assign: { pricing: 'Revenue' } }))

  assert.ok(kit.getCustomSections().includes('Revenue'))
  assert.equal(kit.sectionForKey('pricing'), 'Revenue')
})

test('malformed bot-sections.json is ignored, warned once, and leaves the layout alone', () => {
  const kit = load()

  kit.applyAssignFileText(JSON.stringify({ assign: { helper: 'Ops' } }))
  kit.applyAssignFileText('{ not json')
  kit.applyAssignFileText('{ not json')

  assert.deepEqual({ ...kit.getOverrides() }, { helper: 'Ops' })
  assert.equal(kit.warnings.length, 1)
  assert.match(kit.warnings[0], /malformed bot-sections\.json/)
})

test('payloads that are not objects never throw and never move a bot', () => {
  const kit = load()

  kit.applyAssignFileText(JSON.stringify({ assign: { helper: 'Ops' } }))
  for (const raw of ['null', '[]', '"text"', '42']) kit.applyAssignFileText(raw)

  assert.deepEqual({ ...kit.getOverrides() }, { helper: 'Ops' })
})

test('unknown bot names are recorded verbatim; junk entries are dropped', () => {
  const kit = load()

  kit.applyAssignFileText(
    JSON.stringify({
      assign: {
        'not-a-real-bot': 'Ops',
        '  MixedCase  ': 'Ops',
        blank: '',
        '': 'Ops',
        numeric: 7,
        parked: 'Unassigned'
      }
    })
  )

  assert.deepEqual({ ...kit.getOverrides() }, {
    'not-a-real-bot': 'Ops',
    mixedcase: 'Ops',
    parked: 'Unassigned'
  })
  // An unknown bot still resolves — the roster simply may never show it.
  assert.equal(kit.sectionForKey('not-a-real-bot'), 'Ops')
  assert.equal(kit.sectionForKey('parked'), 'Unassigned')
  assert.equal(kit.sectionLadder().includes('Unassigned'), true)
})

test('findBotsPaneRoots() takes the "Bots" heading and skips native row headers', () => {
  const root = el({ classes: ['flex', 'h-full', 'flex-col'] })
  const listWrap = el({ parentElement: root })
  const anchor = el({
    className: 'text-xs font-medium uppercase tracking-wider',
    parentElement: listWrap,
    textContent: 'Bots'
  })

  // A native roster row button whose label happens to read "Bots": no
  // uppercase/tracking heading classes, so it must not seed a second root.
  const rowRoot = el({ classes: ['flex', 'h-full', 'flex-col'] })
  const rowButton = el({ parentElement: rowRoot })
  const rowLabel = el({ className: 'truncate font-medium', parentElement: rowButton, textContent: 'Bots' })

  // The same heading inside a collapsed pane is ignored too.
  const hiddenRoot = el({ classes: ['flex', 'h-full', 'flex-col'], hiddenPane: true })
  const hiddenWrap = el({ parentElement: hiddenRoot, hiddenPane: true })
  const hiddenAnchor = el({
    className: 'uppercase tracking-wider',
    parentElement: hiddenWrap,
    textContent: 'Bots',
    hiddenPane: true
  })

  const kit = load({ spans: [anchor, rowLabel, hiddenAnchor] })
  const roots = kit.findBotsPaneRoots()

  assert.equal(roots.length, 1)
  assert.equal(roots[0], root)
})

test('findBotsPaneRoots() falls back to the grandparent when no flex column is found', () => {
  const grandparent = el({})
  const parent = el({ parentElement: grandparent })
  const anchor = el({ className: 'uppercase tracking-wider', parentElement: parent, textContent: 'Bots' })

  const roots = load({ spans: [anchor] }).findBotsPaneRoots()

  assert.equal(roots.length, 1)
  assert.equal(roots[0], grandparent)
})

test('a section name with a quote and a bracket still matches its own header', () => {
  const kit = load()
  const name = 'a"b]c'

  const selector = `:scope > [${kit.HEADER_ATTR}="${kit.cssAttr(name)}"]`

  // The module used to shadow the CSS Web API with its own stylesheet
  // constant, so CSS.escape was never reached and the fallback regex ran.
  assert.deepEqual(kit.escaped, [name])
  const quoted = selector.match(/="(.*)"\]$/)
  assert.ok(quoted, selector)
  assert.equal(cssUnescape(quoted[1]), name)
})

test('Bots only: with both tabs present the Sessions tab is hidden by default', () => {
  const tabs = [tab('data-tree-tab', 'sessions'), tab('data-tree-tab', BOTS, { selected: true })]
  const kit = load({ tabs })
  register(kit)

  const style = botsOnlyStyle(kit)
  assert.ok(style, 'bots-only style injected')
  assert.match(style.textContent, /\[data-tree-tab="sessions"\]\{display:none!important\}/)
  // No narrow overlay on screen, so no overlay rule.
  assert.doesNotMatch(style.textContent, /data-narrow-overlay-tab/)
})

test('Bots only: a selected Sessions tab switches to Bots exactly once', () => {
  const sessions = tab('data-tree-tab', 'sessions', { selected: true, extra: { 'data-active': 'true' } })
  const bots = tab('data-tree-tab', BOTS)
  const revealed = []
  const kit = load({ tabs: [sessions, bots], host: { revealPane: id => revealed.push(id) } })
  register(kit)

  // Several more frames while Sessions stays selected: no retry, no loop.
  kit.sync()
  kit.sync()
  assert.deepEqual(revealed, [BOTS])

  // The narrow overlay has no SDK door: its own Bots tab gets Enter, once.
  const overlaySessions = tab('data-narrow-overlay-tab', 'sessions', { selected: true, extra: { 'data-active': 'true' } })
  const overlayBots = tab('data-narrow-overlay-tab', BOTS)
  const narrow = load({ tabs: [overlaySessions, overlayBots] })
  register(narrow)
  narrow.sync()
  assert.equal(overlayBots.dispatched.length, 1)
  assert.equal(overlayBots.dispatched[0].type, 'keydown')
  assert.equal(overlayBots.dispatched[0].key, 'Enter')
  assert.match(botsOnlyStyle(narrow).textContent, /\[data-narrow-overlay-tab="sessions"\]/)

  // A minimized zone (vertical rail) is hidden but never auto-restored.
  const rail = load({
    tabs: [tab('data-tree-tab', 'sessions', { selected: true, extra: { 'data-vertical': 'true' } }), tab('data-tree-tab', BOTS)],
    host: { revealPane: id => revealed.push(`rail:${id}`) }
  })
  register(rail)
  assert.deepEqual(revealed, [BOTS])
  assert.ok(botsOnlyStyle(rail))
})

test('Bots only: no Bots tab means nothing is hidden and nothing is activated', () => {
  const sessions = tab('data-tree-tab', 'sessions', { selected: true, extra: { 'data-active': 'true' } })
  const revealed = []
  const kit = load({ tabs: [sessions], host: { revealPane: id => revealed.push(id) } })
  register(kit)
  kit.sync()

  assert.equal(botsOnlyStyle(kit), null)
  assert.deepEqual(revealed, [])
})

test('Bots only: toggling off removes the style and stops switching tabs', () => {
  const sessions = tab('data-tree-tab', 'sessions', { extra: { 'data-active': 'true' } })
  const bots = tab('data-tree-tab', BOTS, { selected: true })
  const revealed = []
  const kit = load({ tabs: [sessions, bots], host: { revealPane: id => revealed.push(id) } })
  const { commands, storage } = register(kit)
  assert.ok(botsOnlyStyle(kit))

  const command = commands.get(SESSIONS_TOGGLE)
  assert.equal(command.label, 'Bot Sections: Sessions tab toggle')
  assert.equal(command.detail(), 'hidden')
  command.run()

  assert.equal(botsOnlyStyle(kit), null)
  assert.equal(command.detail(), 'shown')
  assert.equal(storage.data.botsOnly, false)

  // The user picks Sessions (now visible): it stays picked.
  sessions.setAttribute('aria-selected', 'true')
  bots.setAttribute('aria-selected', 'false')
  kit.sync()
  assert.deepEqual(revealed, [])
  assert.equal(botsOnlyStyle(kit), null)

  // Toggling back on restores it.
  command.run()
  assert.ok(botsOnlyStyle(kit))
})

test('Bots only: dispose removes the style', () => {
  const kit = load({ tabs: [tab('data-tree-tab', 'sessions'), tab('data-tree-tab', BOTS, { selected: true })] })
  const { dispose } = register(kit)
  assert.ok(botsOnlyStyle(kit))
  dispose()
  assert.equal(botsOnlyStyle(kit), null)
})

test('Bots only: the setting persists across a plugin re-init', () => {
  const storage = memoryStorage()
  const tabsFor = () => [tab('data-tree-tab', 'sessions'), tab('data-tree-tab', BOTS, { selected: true })]

  const first = load({ tabs: tabsFor() })
  const { commands } = register(first, storage)
  commands.get(SESSIONS_TOGGLE).run()
  assert.equal(storage.data.botsOnly, false)

  const second = load({ tabs: tabsFor() })
  const again = register(second, storage)
  assert.equal(botsOnlyStyle(second), null)
  assert.equal(again.commands.get(SESSIONS_TOGGLE).detail(), 'shown')

  // And back on survives too.
  again.commands.get(SESSIONS_TOGGLE).run()
  const third = load({ tabs: tabsFor() })
  register(third, storage)
  assert.ok(botsOnlyStyle(third))
})
