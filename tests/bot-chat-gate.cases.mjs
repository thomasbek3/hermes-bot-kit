/**
 * Shared Bot Chat detection matrix.
 *
 * bubble-mode and task-dock each carry their own copy of the gate
 * (`botModeChatVisible`): single-file disk plugins cannot import a shared
 * runtime module. So the *tests* are shared instead — both suites import this
 * matrix and run every case against their own copy, and the two cannot drift
 * without one of them going red.
 *
 * Case shape:
 *   {
 *     name,
 *     setup: {
 *       bots,          // hermes-bots:pane visible          (default true)
 *       routines,      // hermes-bots:routines visible      (default false)
 *       groupSelected, // a group-chat tab is fronted       (default false)
 *       remembered,    // tab ids already seen as "Bot Chat" (default [])
 *       tabs: [{ id, selected, label, hidden }]
 *     },
 *     expect
 *   }
 */

const GROUP_TAB_PREFIX = 'plugin-workspace:hermes-bots:group:'

function makeTab({ id, selected = false, label = '', hidden = false }) {
  return {
    getAttribute(name) {
      if (name === 'data-tree-tab') return id
      if (name === 'aria-selected') return selected ? 'true' : 'false'
      if (name === 'aria-label') return label
      return ''
    },
    closest: selector => (hidden && selector === '[data-pane-hidden]' ? { id: 'hidden-pane' } : null),
    textContent: label
  }
}

function attrValue(selector) {
  const match = /="([^"]*)"/.exec(selector)
  return match ? match[1] : ''
}

/**
 * Build the `document` stand-in a plugin's gate needs for one case. Both vm
 * harnesses use this so the fixtures are identical on each side.
 */
export function buildGateDocument(setup = {}) {
  const tabs = (setup.tabs || []).map(makeTab)
  if (setup.groupSelected) {
    tabs.push(makeTab({ id: `${GROUP_TAB_PREFIX}room`, selected: true, label: 'Group: room' }))
  }
  return {
    body: { classList: { add() {}, contains: () => false, remove() {} } },
    querySelector(selector) {
      const wanted = attrValue(selector)
      return tabs.find(tab => tab.getAttribute('data-tree-tab') === wanted) || null
    },
    querySelectorAll(selector) {
      if (selector === '[data-tree-tab][aria-selected="true"]') {
        return tabs.filter(tab => tab.getAttribute('aria-selected') === 'true')
      }
      if (selector.startsWith('[data-tree-tab^=')) {
        const prefix = attrValue(selector)
        return tabs.filter(tab => tab.getAttribute('data-tree-tab').startsWith(prefix))
      }
      return []
    }
  }
}

export const botChatGateCases = [
  {
    name: 'routines pane visible → Bot Chat owns the workspace',
    setup: { bots: true, routines: true, tabs: [] },
    expect: true
  },
  {
    name: 'routines pane closed and no canonical tab → inactive',
    setup: { bots: true, routines: false, tabs: [] },
    expect: false
  },
  {
    name: 'Bots pane off → inactive even with the routines pane up',
    setup: { bots: false, routines: true, tabs: [] },
    expect: false
  },
  {
    name: 'canonical tab labelled "Bot Chat" is selected → active',
    setup: {
      bots: true,
      routines: false,
      tabs: [{ id: 'session-tile:canonical', selected: true, label: 'Bot Chat' }]
    },
    expect: true
  },
  {
    name: 'canonical tab with an unread suffix still matches',
    setup: {
      bots: true,
      routines: false,
      tabs: [{ id: 'session-tile:canonical', selected: true, label: 'Bot Chat, 2 unread' }]
    },
    expect: true
  },
  {
    name: 'a different session named "Bot Chats" must not match',
    setup: {
      bots: true,
      routines: false,
      tabs: [{ id: 'session-tile:other', selected: true, label: 'Bot Chats' }]
    },
    expect: false
  },
  {
    name: 'group chat tab fronted → inactive',
    setup: { bots: true, routines: true, groupSelected: true, tabs: [] },
    expect: false
  },
  {
    name: 'remembered tab id with a scrambled caption → active',
    setup: {
      bots: true,
      routines: false,
      remembered: ['session-tile:canonical'],
      tabs: [{ id: 'session-tile:canonical', selected: true, label: 'Session 41' }]
    },
    expect: true
  },
  {
    name: 'canonical tab inside a hidden pane → inactive',
    setup: {
      bots: true,
      routines: false,
      tabs: [{ id: 'session-tile:canonical', selected: true, label: 'Bot Chat', hidden: true }]
    },
    expect: false
  }
]

export default botChatGateCases
