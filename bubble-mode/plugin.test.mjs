import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginPath = new URL('./plugin.js', import.meta.url)

function store(value) {
  return {
    get: () => value,
    listen: () => () => undefined
  }
}

function loadDetection({ bots = true, home = false, routines = true, transcript = false } = {}) {
  const surface = {
    closest: () => null,
    getAttribute: name => {
      if (name === 'data-composer-target') return 'main'
      if (name === 'data-session-anchor') return 'workspace'
      return ''
    },
    querySelector: () => (transcript ? {} : null)
  }
  const paneValues = {
    'hermes-bots:pane': bots,
    'plugin-workspace:hermes-bots:home': home,
    'hermes-bots:routines': routines
  }
  const document = {
    body: { classList: { add() {}, contains: () => false, remove() {} } },
    querySelector: () => null,
    querySelectorAll: selector => (selector === '[data-chat-surface]' ? [surface] : [])
  }
  const context = {
    __host: {
      paneVisibility: id => store(paneValues[id]),
      state: {}
    },
    CSS: { escape: value => value },
    document,
    globalThis: null
  }
  context.globalThis = context

  const source = fs
    .readFileSync(pluginPath, 'utf8')
    .replace(
      "import { PALETTE_AREA, host } from '@hermes/plugin-sdk'",
      "const PALETTE_AREA = 'palette'; const host = globalThis.__host"
    )
    .replace('export default {', 'globalThis.__plugin = {')
    .concat('\nglobalThis.__testHooks = { botModeChatVisible, workspaceBotChatVisible }\n')

  vm.runInNewContext(source, vm.createContext(context), { filename: pluginPath.pathname })
  return context.__testHooks
}

test('Bubble Mode stays active while a Bot Chat transcript remounts during send', () => {
  const detection = loadDetection({ transcript: false })

  assert.equal(detection.botModeChatVisible(), true)
})

test('Bubble Mode still rejects Bots home and non-Bot-Chat workspaces', () => {
  assert.equal(loadDetection({ home: true }).botModeChatVisible(), false)
  assert.equal(loadDetection({ routines: false }).botModeChatVisible(), false)
  assert.equal(loadDetection({ bots: false }).botModeChatVisible(), false)
})
