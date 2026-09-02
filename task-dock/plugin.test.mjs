import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginPath = new URL('./plugin.js', import.meta.url)

function loadSelection({ routines = true } = {}) {
  const context = {
    __host: {
      paneVisibility: id => ({ get: () => (id === 'hermes-bots:routines' ? routines : false) }),
      state: {}
    },
    CSS: { escape: value => value },
    Date,
    document: { querySelectorAll: () => [] },
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
      '\nglobalThis.__testHooks = { matchingStoredSnapshot, workspaceBotChatVisible, markLiveSources, clearLiveSources, isCompletedView }\n'
    )

  vm.runInNewContext(source, vm.createContext(context), { filename: pluginPath.pathname })
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
