import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginPath = new URL('./plugin.js', import.meta.url)
const SOURCE = fs.readFileSync(pluginPath, 'utf8')

const HOOKS =
  '\nglobalThis.__testHooks = { applyAssignData, applyAssignFileText, findBotsPaneRoots, cssAttr,' +
  ' HEADER_ATTR, sectionForKey, sectionLadder, getOverrides: () => overrides,' +
  ' getCustomSections: () => customSections }\n'

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

function load({ spans = [] } = {}) {
  const warnings = []
  const escaped = []
  const context = {
    __host: { state: {} },
    CSS: {
      escape: value => {
        escaped.push(value)
        return cssEscape(value)
      }
    },
    console: { warn: message => warnings.push(message) },
    document: {
      body: { classList: { add() {}, contains: () => false, remove() {} } },
      querySelector: () => null,
      querySelectorAll: selector => (selector === 'span' ? spans : [])
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
  return { ...context.__testHooks, warnings, escaped }
}

test('a valid bot-sections.json creates its sections and assigns its bots', () => {
  const kit = load()

  kit.applyAssignFileText(JSON.stringify({ sections: ['Airbnb Ops'], assign: { alfred: 'Airbnb Ops' } }))

  assert.deepEqual({ ...kit.getOverrides() }, { alfred: 'Airbnb Ops' })
  assert.ok(kit.sectionLadder().includes('Airbnb Ops'))
  assert.equal(kit.sectionForKey('alfred'), 'Airbnb Ops')
  assert.equal(kit.sectionForKey('@Alfred'), 'Airbnb Ops')
  assert.equal(kit.sectionForKey('nobody'), 'Unassigned')
})

test('a section named only in assign is created on the spot', () => {
  const kit = load()

  kit.applyAssignFileText(JSON.stringify({ assign: { pricey: 'Revenue' } }))

  assert.ok(kit.getCustomSections().includes('Revenue'))
  assert.equal(kit.sectionForKey('pricey'), 'Revenue')
})

test('malformed bot-sections.json is ignored, warned once, and leaves the layout alone', () => {
  const kit = load()

  kit.applyAssignFileText(JSON.stringify({ assign: { alfred: 'Ops' } }))
  kit.applyAssignFileText('{ not json')
  kit.applyAssignFileText('{ not json')

  assert.deepEqual({ ...kit.getOverrides() }, { alfred: 'Ops' })
  assert.equal(kit.warnings.length, 1)
  assert.match(kit.warnings[0], /malformed bot-sections\.json/)
})

test('payloads that are not objects never throw and never move a bot', () => {
  const kit = load()

  kit.applyAssignFileText(JSON.stringify({ assign: { alfred: 'Ops' } }))
  for (const raw of ['null', '[]', '"text"', '42']) kit.applyAssignFileText(raw)

  assert.deepEqual({ ...kit.getOverrides() }, { alfred: 'Ops' })
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
