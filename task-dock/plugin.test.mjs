import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { botChatGateCases, buildGateDocument } from '../tests/bot-chat-gate.cases.mjs'

const pluginPath = new URL('./plugin.js', import.meta.url)

function loadSelection(setup = {}) {
  const { bots = true, routines = true, now = null } = setup
  const paneValues = {
    'hermes-bots:pane': bots,
    'hermes-bots:routines': routines
  }
  const context = {
    __host: {
      paneVisibility: id => ({ get: () => Boolean(paneValues[id]) }),
      state: {}
    },
    CSS: { escape: value => value },
    Date: now ? { now } : Date,
    document: buildGateDocument(setup),
    globalThis: null,
    setInterval: () => 0,
    setTimeout: () => 0
  }
  context.globalThis = context

  const source = fs
    .readFileSync(pluginPath, 'utf8')
    .replace(
      "import { PALETTE_AREA, host } from '@hermes/plugin-sdk'",
      "const PALETTE_AREA = 'palette'; const host = globalThis.__host"
    )
    .replace('export default {', 'globalThis.__plugin = {')
    .concat(
      '\nglobalThis.__testHooks = { matchingStoredSnapshot, workspaceBotChatVisible, botModeChatVisible,' +
        ' isCanonicalBotChatLabel, knownBotChatTabs, markLiveSources, clearLiveSources, isCompletedView,' +
        ' viewKey, relativeTime }\n'
    )

  vm.runInNewContext(source, vm.createContext(context), { filename: pluginPath.pathname })
  for (const id of setup.remembered || []) context.__testHooks.knownBotChatTabs.add(id)
  return context.__testHooks
}

function snapshot({ bot = 'gamer-boy', sessionId = 'gamer-session' } = {}) {
  return {
    bot,
    sessionId,
    done: 2,
    total: 3,
    items: [{ text: 'Old Gamer Boy task', status: 'pending', statusClass: '' }],
    capturedAt: Date.now()
  }
}

test('stored tasks restore only when bot and session ownership both match', () => {
  const { matchingStoredSnapshot } = loadSelection()

  assert.ok(matchingStoredSnapshot(snapshot(), 'gamer-boy', 'gamer-session'))
  assert.equal(matchingStoredSnapshot(snapshot(), 'gamer-boy', 'alfred-session'), null)
  assert.equal(matchingStoredSnapshot(snapshot(), 'alfred', 'gamer-session'), null)
})

test('stored tasks stay hidden while session ownership is unresolved', () => {
  const { matchingStoredSnapshot } = loadSelection()

  assert.equal(matchingStoredSnapshot(snapshot(), 'gamer-boy', ''), null)
  assert.equal(matchingStoredSnapshot(snapshot({ sessionId: '' }), 'gamer-boy', 'gamer-session'), null)
})

test('workspace ownership stays active while Hermes remounts the transcript', () => {
  assert.equal(loadSelection({ routines: true }).workspaceBotChatVisible(), true)
  assert.equal(loadSelection({ routines: false }).workspaceBotChatVisible(), false)
})

test('every captured stock task widget is hidden reversibly so only one Tasks panel renders', () => {
  const { markLiveSources, clearLiveSources } = loadSelection()
  const attrsA = new Map()
  const attrsB = new Map()
  const source = attrs => ({
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name)
  })
  const a = source(attrsA)
  const b = source(attrsB)

  markLiveSources([a, b])
  assert.equal(attrsA.get('data-hermes-task-dock-source'), '')
  assert.equal(attrsB.get('data-hermes-task-dock-source'), '')

  markLiveSources([b])
  assert.equal(attrsA.has('data-hermes-task-dock-source'), false)
  assert.equal(attrsB.get('data-hermes-task-dock-source'), '')

  clearLiveSources()
  assert.equal(attrsB.has('data-hermes-task-dock-source'), false)
})

test('completed lists auto-hide by counts or terminal item statuses', () => {
  const { isCompletedView } = loadSelection()
  const done = snapshot()
  done.done = 16
  done.total = 16
  const terminal = snapshot()
  terminal.done = 1
  terminal.total = 2
  terminal.items = [
    { text: 'Finished', status: 'completed', statusClass: '' },
    { text: 'Skipped', status: 'cancelled', statusClass: '' }
  ]
  const active = snapshot()
  active.done = 1
  active.total = 2
  active.items = [{ text: 'Still running', status: 'in_progress', statusClass: '' }]

  assert.equal(isCompletedView(done), true)
  assert.equal(isCompletedView(terminal), false)
  terminal.done = 0
  terminal.total = 0
  assert.equal(isCompletedView(terminal), true)
  assert.equal(isCompletedView(active), false)
})

test('the shared Bot Chat gate matrix holds for task-dock', () => {
  for (const testCase of botChatGateCases) {
    const { botModeChatVisible } = loadSelection(testCase.setup)
    assert.equal(botModeChatVisible(), testCase.expect, testCase.name)
  }
})

test('a decorated Bot Chat caption matches; a different session name does not', () => {
  const { isCanonicalBotChatLabel } = loadSelection()

  assert.equal(isCanonicalBotChatLabel('bot chat'), true)
  assert.equal(isCanonicalBotChatLabel('bot chat, 2 unread'), true)
  assert.equal(isCanonicalBotChatLabel('bot chat ×'), true)
  assert.equal(isCanonicalBotChatLabel('bot chats'), false)
})

test('a stale snapshot ages instead of freezing at "just now"', () => {
  let clock = 1_700_000_000_000
  const { relativeTime, viewKey } = loadSelection({ now: () => clock })
  const view = { ...snapshot(), capturedAt: clock }

  assert.equal(relativeTime(view.capturedAt), 'just now')
  const fresh = viewKey(view, true)

  clock += 10 * 60 * 1000
  assert.equal(relativeTime(view.capturedAt), '10m ago')
  // The render key has to move too, or renderDock() short-circuits and the
  // "last updated …" label keeps whatever text it was first given.
  assert.notEqual(viewKey(view, true), fresh)
})
