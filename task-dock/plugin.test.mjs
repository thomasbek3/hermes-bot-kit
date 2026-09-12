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
  const observed = []
  const context = {
    __host: {
      paneVisibility: id => ({ get: () => Boolean(paneValues[id]) }),
      state: {}
    },
    CSS: { escape: value => value },
    Date: now ? { now } : Date,
    document: { ...buildGateDocument(setup), documentElement: {} },
    globalThis: null,
    MutationObserver: class {
      observe(_target, options) {
        observed.push(options)
      }
      disconnect() {}
    },
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
        ' viewKey, relativeTime, startDomObserver, findTasksHeaders, tasksSection }\n'
    )

  vm.runInNewContext(source, vm.createContext(context), { filename: pluginPath.pathname })
  for (const id of setup.remembered || []) context.__testHooks.knownBotChatTabs.add(id)
  return { ...context.__testHooks, observed }
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

test('the DOM observer watches captions and no longer watches dead chat-surface attributes', () => {
  const kit = loadSelection()

  kit.startDomObserver()
  const [options] = kit.observed

  assert.ok(options)
  assert.equal(options.characterData, true)
  assert.deepEqual(Array.from(options.attributeFilter), [
    'data-pane-hidden',
    'aria-selected',
    'aria-label',
    'data-tree-tab'
  ])
})

// --- mini-DOM for the composer status stack ---------------------------------
// findTasksHeaders/tasksSection/markLiveSources only need tag names, data-slot,
// parent/child links, textContent and closest/querySelector(All) — so the
// fixture models exactly that, and the SAME fixture proves both the capture and
// the hide path.

function matchesSelector(el, selector) {
  for (const part of selector.split(',')) {
    const sel = part.trim()
    if (!sel) continue
    if (/^[a-z]+$/.test(sel)) {
      if (el.tag === sel) return true
      continue
    }
    const prefix = /^\[data-slot\^="([^"]*)"\]$/.exec(sel)
    if (prefix) {
      if (typeof el.slot === 'string' && el.slot.startsWith(prefix[1])) return true
      continue
    }
    const exact = /^\[data-slot="([^"]*)"\]$/.exec(sel)
    if (exact) {
      if (el.slot === exact[1]) return true
      continue
    }
    const bare = /^\[([a-z-]+)\]$/.exec(sel)
    if (bare && el.attrs.has(bare[1])) return true
  }
  return false
}

function elem(tag, { slot, text = '', children = [], attrs = [] } = {}) {
  const el = {
    tag,
    slot,
    text,
    children,
    parentElement: null,
    attrs: new Map(attrs.map(name => [name, ''])),
    get textContent() {
      return el.text + el.children.map(child => child.textContent).join(' ')
    },
    getAttribute: name => (name === 'data-slot' ? el.slot ?? null : (el.attrs.get(name) ?? null)),
    hasAttribute: name => el.attrs.has(name),
    setAttribute: (name, value) => el.attrs.set(name, value),
    removeAttribute: name => el.attrs.delete(name),
    closest(selector) {
      let node = el
      while (node) {
        if (matchesSelector(node, selector)) return node
        node = node.parentElement
      }
      return null
    },
    querySelectorAll(selector) {
      const out = []
      const walk = node => {
        for (const child of node.children) {
          if (matchesSelector(child, selector)) out.push(child)
          walk(child)
        }
      }
      walk(el)
      return out
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] || null
    }
  }
  for (const child of children) child.parentElement = el
  return el
}

/** One StatusSection: `<div>[headerRow[button[label]]][body]</div>`. */
function statusSection(headerLabel, bodyRows, wrapperSlot) {
  const section = elem('div', {
    children: [
      elem('div', { children: [elem('button', { children: [elem('span', { text: headerLabel })] })] }),
      elem('div', { children: bodyRows })
    ]
  })
  if (!wrapperSlot) return { section, outer: section }
  const outer = elem('div', { slot: wrapperSlot, children: [section] })
  return { section, outer }
}

function surfaceWith(sections) {
  const stack = elem('div', { slot: 'composer-status-stack', children: sections.map(s => elem('div', { children: [s] })) })
  return elem('div', { children: [stack] })
}

test('a session control’s own prose is never captured as the stock Tasks widget', () => {
  const { findTasksHeaders } = loadSelection()
  // A `/loop … until "Tasks 3/3 done"` renders the user's clause in a plain
  // span inside the loop control's body — the exact shape that used to look
  // like a Tasks header once no stock Tasks widget was on screen.
  const loop = statusSection(
    'Loop active · Run 2/5',
    [elem('div', { children: [elem('span', { text: 'Until condition: Tasks 3/3 done' })] })],
    'session-control-loop'
  )

  assert.equal(findTasksHeaders(surfaceWith([loop.outer])).length, 0)
})

test('the stock Tasks widget is still captured, and only it is hidden', () => {
  const { findTasksHeaders, tasksSection, markLiveSources } = loadSelection()
  // A goal criterion is agent-authored text in a span, same trap.
  const goal = statusSection(
    'Goal active · Turn 3/12',
    [elem('div', { children: [elem('span', { text: '1.' }), elem('span', { text: 'Tasks 4/6 verified' })] })],
    'session-control-goal'
  )
  const todo = statusSection('Tasks 1/3', [elem('div', { children: [elem('span', { text: 'Write the report' })] })])

  const headers = findTasksHeaders(surfaceWith([goal.outer, todo.section]))
  assert.equal(headers.length, 1)
  assert.equal(tasksSection(headers[0]), todo.section)

  // Even handed both sections, the hide step refuses the control's.
  markLiveSources([goal.section, todo.section])
  assert.equal(goal.section.hasAttribute('data-hermes-task-dock-source'), false)
  assert.equal(goal.outer.hasAttribute('data-hermes-task-dock-source'), false)
  assert.equal(todo.section.getAttribute('data-hermes-task-dock-source'), '')
})

test('no plugin utility class is one upstream stopped emitting', () => {
  // A disk plugin's classes are never scanned by the app's Tailwind build, so a
  // utility the app itself no longer uses simply does not exist at runtime.
  // `pl-0.5` went unused upstream at hermes-agent 284d220ba4.
  for (const file of ['./plugin.js', '../computer-viewer/plugin.js', '../bubble-mode/plugin.js', '../bot-sections/plugin.js']) {
    // Comments may name the class; only real class strings count.
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    assert.equal(/(^|[\s'"`])pl-0\.5([\s'"`]|$)/m.test(src), false, `${file} still uses pl-0.5`)
  }
})
