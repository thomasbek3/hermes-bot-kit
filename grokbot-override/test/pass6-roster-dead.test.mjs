// Pass 6: bots deleted on a machine (Bouncer and Meta on home-server) leave
// the roster once a fresh read of that source no longer lists them, even
// when the stock roster snapshot still carries them.

import assert from 'node:assert/strict'
import test from 'node:test'

import { dropDeadRows, liveRosterNames } from '../src/core/roster.js'

const row = (name, connectionId) => ({ name, connectionId })
const STALE = [row('security', 'local'), row('bouncer', 'home-server'), row('meta', 'home-server'), row('notes', 'home-server'), row('scout', 'mini'), row('orphan', '')]

test('a reachable source’s fresh listing prunes the rows it no longer returns', () => {
  const union = {
    sources: [
      { connectionId: 'local', reachable: true },
      { connectionId: 'home-server', reachable: true },
      { connectionId: 'mini', reachable: false }
    ],
    agents: [
      { profile: 'security', connectionId: 'local' },
      { profile: 'notes', connectionId: 'home-server' }
    ]
  }
  const live = liveRosterNames(union)
  assert.deepEqual([...live.keys()].sort(), ['home-server', 'local'])
  assert.deepEqual(dropDeadRows(STALE, live).map(r => r.name), ['security', 'notes', 'scout', 'orphan'], 'Bouncer and Meta gone; an unreachable source and a row without a source are kept')
})

test('no answer, an error, a remembered listing or an empty list never prunes', () => {
  for (const source of [
    { connectionId: 'home-server', reachable: true, error: 'timeout' },
    { connectionId: 'home-server', reachable: true, stale: true },
    { connectionId: 'home-server', reachable: true, cached: true },
    { connectionId: 'home-server' }
  ]) {
    const live = liveRosterNames({ sources: [source], agents: [{ profile: 'notes', connectionId: 'home-server' }] })
    assert.equal(dropDeadRows(STALE, live).length, STALE.length, JSON.stringify(source))
  }
  const empty = liveRosterNames({ sources: [{ connectionId: 'home-server', reachable: true }], agents: [] })
  assert.equal(dropDeadRows(STALE, empty).length, STALE.length, 'a source that listed nothing is not trusted to empty the roster')
  assert.equal(dropDeadRows(STALE, new Map()), STALE)
})
