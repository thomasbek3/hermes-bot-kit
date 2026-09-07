import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { botChatGateCases, buildGateDocument } from '../tests/bot-chat-gate.cases.mjs'

const pluginPath = new URL('./plugin.js', import.meta.url)
const SOURCE = fs.readFileSync(pluginPath, 'utf8')

const HOOKS =
  '\nglobalThis.__testHooks = {' +
  ' botModeChatVisible, workspaceBotChatVisible, canonicalBotChatTabSelected,' +
  ' isCanonicalBotChatLabel, knownBotChatTabs, styleText: PLUGIN_CSS }\n'

function store(value) {
  return {
    get: () => value,
    listen: () => () => undefined
  }
}

function run(context) {
  const source = SOURCE.replace(
    "import { PALETTE_AREA, host } from '@hermes/plugin-sdk'",
    "const PALETTE_AREA = 'palette'; const host = globalThis.__host"
  )
    .replace('export default {', 'globalThis.__plugin = {')
    .concat(HOOKS)

  context.globalThis = context
  vm.runInNewContext(source, vm.createContext(context), { filename: pluginPath.pathname })
  return context
}

function loadDetection(setup = {}) {
  const { bots = true, routines = true } = setup
  const paneValues = {
    'hermes-bots:pane': bots,
    'hermes-bots:routines': routines
  }
  const context = run({
    __host: {
      paneVisibility: id => store(paneValues[id]),
      state: {}
    },
    CSS: { escape: value => value },
    document: buildGateDocument(setup),
    globalThis: null
  })
  for (const id of setup.remembered || []) context.__testHooks.knownBotChatTabs.add(id)
  return context.__testHooks
}

/** A document with a real class list plus the bits `register()` touches. */
function lifecycleDocument() {
  const classes = new Set()
  const gate = buildGateDocument({ bots: true, routines: true })
  return {
    classes,
    body: {
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name)
      }
    },
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    documentElement: {},
    getElementById: () => null,
    head: { appendChild() {} },
    querySelector: gate.querySelector,
    querySelectorAll: gate.querySelectorAll
  }
}

function deferred() {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

/** Load the plugin and call register() with a storage whose `enabled` read is pending. */
function loadLifecycle() {
  const document = lifecycleDocument()
  const pending = deferred()
  const observed = []
  const commands = new Map()
  let disposer = null

  const context = run({
    __host: {
      paneVisibility: () => store(true),
      state: {}
    },
    CSS: { escape: value => value },
    document,
    globalThis: null,
    MutationObserver: class {
      observe(_target, options) {
        observed.push(options)
      }
      disconnect() {}
    }
  })

  context.__plugin.register({
    storage: {
      get: key => (key === 'enabled' ? pending.promise : key === 'knownBotChatTabs' ? [] : false),
      set: () => undefined
    },
    register: entry => commands.set(entry.data.id, entry.data),
    onDispose: fn => {
      disposer = fn
    }
  })

  return {
    classes: document.classes,
    commands,
    dispose: () => disposer && disposer(),
    observed,
    resolveEnabled: pending.resolve,
    settle: () => new Promise(r => setImmediate(r))
  }
}

test('the shared Bot Chat gate matrix holds for bubble-mode', () => {
  for (const testCase of botChatGateCases) {
    const detection = loadDetection(testCase.setup)
    assert.equal(detection.botModeChatVisible(), testCase.expect, testCase.name)
  }
})

test('Bubble Mode stays active while a Bot Chat transcript remounts during send', () => {
  assert.equal(loadDetection({ routines: true }).botModeChatVisible(), true)
})

test('Bubble Mode still rejects non-Bot-Chat workspaces', () => {
  assert.equal(loadDetection({ routines: false }).botModeChatVisible(), false)
  assert.equal(loadDetection({ bots: false }).botModeChatVisible(), false)
})

test('a decorated Bot Chat caption matches; a different session name does not', () => {
  const { isCanonicalBotChatLabel } = loadDetection()

  assert.equal(isCanonicalBotChatLabel('bot chat'), true)
  assert.equal(isCanonicalBotChatLabel('bot chat, 2 unread'), true)
  assert.equal(isCanonicalBotChatLabel('bot chat ×'), true)
  assert.equal(isCanonicalBotChatLabel('bot chats'), false)
  assert.equal(isCanonicalBotChatLabel('group: standup'), false)
})

test('a late settings read never overwrites a newer toggle', async () => {
  const app = loadLifecycle()
  assert.equal(app.classes.has('hermes-bubble-mode'), true)

  app.commands.get('bubble-mode.toggle').run()
  assert.equal(app.classes.has('hermes-bubble-mode'), false)

  app.resolveEnabled(true)
  await app.settle()

  assert.equal(app.classes.has('hermes-bubble-mode'), false)
})

test('a settings read that resolves after dispose adds no body class', async () => {
  const app = loadLifecycle()

  app.dispose()
  assert.equal(app.classes.has('hermes-bubble-mode'), false)

  app.resolveEnabled(true)
  await app.settle()

  assert.equal(app.classes.has('hermes-bubble-mode'), false)
})

test('the DOM observer watches captions and no longer watches dead chat-surface attributes', () => {
  const app = loadLifecycle()
  const [options] = app.observed

  assert.ok(options)
  assert.equal(options.characterData, true)
  assert.deepEqual(Array.from(options.attributeFilter), [
    'data-pane-hidden',
    'aria-selected',
    'aria-label',
    'data-tree-tab'
  ])
})

test('bubble colours come from Hermes theme tokens, with the dark hexes only as fallbacks', () => {
  const { styleText } = loadDetection()
  const literals = ['#4a4a4e', '#2b2b2e', '#e8e8ea', '#f2f2f3', '#6b6b70', '#b9b9bf']

  for (const hex of literals) {
    const total = (styleText.match(new RegExp(hex, 'g')) || []).length
    const fallbacks = (styleText.match(new RegExp(`var\\(--[a-z-]+,\\s*${hex}\\)`, 'g')) || []).length
    assert.ok(total > 0, `${hex} should survive as a fallback`)
    assert.equal(total, fallbacks, `${hex} appears outside a var() fallback`)
  }
  // The shared token is read, never redefined.
  assert.equal(/--ui-chat-bubble-background\s*:/.test(styleText), false)
})
