// PARITY R14: gateway-owned group chats on the `groups.*` calls stock uses
// (canonical-groups.ts, canonical-group-send.ts, canonical-group-workspace.tsx;
// contracts tui_gateway/contracts/groups_bot_relay.py).

import assert from 'node:assert/strict'
import test from 'node:test'

import { actionParams, approvalPreview, createRoom, createRoomController, listRooms, roomItems, roomRoster } from '../src/core/rooms.js'
import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

const ROUTE = { connectionId: 'local', profile: 'default' }
const MEMBERS = [
  { member_id: 'alpha', profile: 'alpha', handle: 'alpha', display_name: 'Alpha' },
  { member_id: 'beta', profile: 'beta', handle: 'beta' }
]
const ROOM = { room_id: 'r1', name: 'Launch', members: MEMBERS, updated_at: 10 }
const LOG = [
  { seq: 1, event_id: 'e1', kind: 'message.user', actor: { kind: 'user', id: 'desktop' }, payload: { text: 'plan the launch', thread_id: 'e1' }, created_at: 1762560000 },
  { seq: 2, event_id: 'e2', kind: 'message.member', actor: { kind: 'member', id: 'alpha' }, payload: { text: 'On it.' }, created_at: 1762560005 },
  { seq: 3, event_id: 'e3', kind: 'turn.failed', actor: { kind: 'system', id: 'gw' }, payload: { member_id: 'beta', error: 'quota' }, created_at: 1762560006 },
  { seq: 4, event_id: 'e4', kind: 'room.activity', actor: { kind: 'system', id: 'gw' }, payload: { status: 'bounded', discussion_event_id: 'e1' }, created_at: 1762560007 }
]

function fakeRooms(over = {}) {
  const calls = []
  const requestRoom = async (route, method, params) => {
    calls.push({ route, method, params })
    if (over[method]) return over[method](params)
    switch (method) {
      case 'groups.capabilities':
        return { driver: true, methods: ['groups.stop', 'groups.continue'] }
      case 'groups.list':
        return params.offset === 0 ? { rooms: [ROOM], next_offset: 1 } : { rooms: [{ ...ROOM, room_id: 'r0', name: 'Old', updated_at: 1 }], next_offset: null }
      case 'groups.state':
        return { room: ROOM, driver_status: { running: false, working: false, blocked: false, counts: {}, pending_actions: [], member_activity: [], peer_routes: [] } }
      case 'groups.log':
        return { events: LOG.filter(e => e.seq > (params.since_seq || 0)), cursor: 4, latest_seq: 4, has_more: false }
      case 'groups.send':
        return { event: { seq: 5, event_id: params.event_id }, accepted: true }
      default:
        return {}
    }
  }
  return { calls, requestRoom }
}

test('R14 rooms list across pages, newest first', async () => {
  const { requestRoom } = fakeRooms()
  const rooms = await listRooms(requestRoom, ROUTE)
  assert.deepEqual(rooms.map(r => r.room_id), ['r1', 'r0'])
})

test('R14 a group needs 2-6 unique members on its own connection; groups.create sends stock\'s roster', async () => {
  const bot = name => ({ name, connectionId: 'local', route: { connectionId: 'local', profile: name, targetProfile: name } })
  assert.ok(roomRoster(ROUTE, [bot('a')]).problem)
  assert.ok(roomRoster(ROUTE, [bot('a'), { ...bot('b'), connectionId: 'mini', route: { connectionId: 'mini', profile: 'b', targetProfile: 'b' } }]).problem)
  assert.ok(roomRoster(ROUTE, [bot('a'), bot('a')]).problem)
  const { calls, requestRoom } = fakeRooms({ 'groups.create': params => ({ room: { room_id: params.room_id, name: params.name, members: params.members } }) })
  await createRoom(requestRoom, ROUTE, 'Ship it', [bot('a'), bot('b')])
  const create = calls.find(c => c.method === 'groups.create')
  assert.match(create.params.room_id, /\S{8,}/)
  assert.deepEqual(create.params.members, [
    { member_id: 'a', profile: 'a', handle: 'a', target: { kind: 'local', profile: 'a' } },
    { member_id: 'b', profile: 'b', handle: 'b', target: { kind: 'local', profile: 'b' } }
  ])
})

test('R14 the room log becomes the chat: your posts, members with their names, failures, a paused discussion', () => {
  const items = roomItems(LOG, MEMBERS)
  assert.deepEqual(items.map(i => [i.kind, i.author || i.text]), [
    ['room-user', 'You'],
    ['room-member', 'Alpha'],
    ['notice', 'beta could not answer: quota'],
    ['room-paused', 'The discussion reached its round limit.']
  ])
})

test('R14 posting: a fresh event id; an uncertain post is retried under the SAME id; admitted:false is not posted', async () => {
  let fail = 'unknown'
  const { calls, requestRoom } = fakeRooms({
    'groups.send': params => {
      if (fail === 'unknown') throw new Error('socket closed')
      if (fail === 'refused') throw Object.assign(new Error('room busy'), { code: 4111, data: { admitted: false } })
      return { event: { seq: 9, event_id: params.event_id } }
    }
  })
  const room = createRoomController(ROUTE, 'r1', { requestRoom, setTimer: () => () => undefined })
  await room.open()
  assert.equal(room.get().phase, 'ready')
  assert.equal(room.get().items.length, 4)
  const first = await room.post('hello team')
  assert.equal(first.posted, 'unknown')
  const sends = () => calls.filter(c => c.method === 'groups.send')
  assert.deepEqual(sends()[0].params, { room_id: 'r1', event_id: sends()[0].params.event_id, payload: { text: 'hello team', thread_id: sends()[0].params.event_id } })
  fail = 'none'
  const again = await room.retryPost(sends()[0].params.event_id)
  assert.equal(again.posted, 'yes')
  assert.deepEqual(sends()[1].params, sends()[0].params, 'the same event id and payload')
  fail = 'refused'
  const refused = await room.post('second')
  assert.equal(refused.posted, 'no')
  assert.equal(refused.text, 'second')
  assert.ok(!room.get().posts.some(p => p.text === 'second'))
  room.dispose()
})

test('R14 a member\'s pending approval: groups.approve with the exact request; Allow once only when reviewable', async () => {
  const action = { kind: 'approval', member_id: 'alpha', task_id: 't1', execution_generation: 3, request_id: 'q1', approval: { command: 'rm -rf build', choices: ['once', 'deny'] } }
  assert.equal(approvalPreview(action).reviewable, true)
  assert.deepEqual(actionParams('r1', action, 'once'), {
    method: 'groups.approve',
    params: { room_id: 'r1', member_id: 'alpha', task_id: 't1', execution_generation: 3, request_id: 'q1', choice: 'once' }
  })
  assert.throws(() => actionParams('r1', { ...action, approval: { choices: ['once', 'deny'] } }, 'once'), /reviewable/)
  assert.throws(() => actionParams('r1', action, 'always'))
  assert.equal(actionParams('r1', { kind: 'retry', member_id: 'beta', task_id: 't2', execution_generation: 1 }).method, 'groups.retry')
})

test('R14 stop, continue, rename, disband use the room\'s calls', async () => {
  const { calls, requestRoom } = fakeRooms({ 'groups.rename': params => ({ room: { ...ROOM, name: params.name } }) })
  const room = createRoomController(ROUTE, 'r1', { requestRoom, setTimer: () => () => undefined })
  await room.open()
  await room.stop()
  await room.continueDiscussion('e1')
  await room.rename('Launch v2')
  assert.equal(room.get().room.name, 'Launch v2')
  await room.disband()
  const by = m => calls.find(c => c.method === m).params
  assert.match(by('groups.stop').cancel_id, /\S{8,}/)
  assert.deepEqual(by('groups.continue'), { room_id: 'r1', discussion_event_id: 'e1' })
  assert.equal(by('groups.rename').name, 'Launch v2')
  assert.match(by('groups.disband').cancel_id, /\S{8,}/)
})

test('loader-faithful R14: rooms list in the roster; a room opens as its own tab, shows the log, posts on the room\'s authority', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { requestRoom } = fakeRooms()
  const posted = []
  const answers = {}
  for (const method of ['groups.capabilities', 'groups.list', 'groups.state', 'groups.log']) answers[method] = params => requestRoom(ROUTE, method, params)
  answers['groups.send'] = params => (posted.push(params), { event: { seq: 5, event_id: params.event_id } })
  const { panes, workspaces, mount, errors, calls } = await bootPlugin(t, { answers })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const roomRow = await waitFor(() => [...rosterEl.querySelectorAll('.gbo-room-row')].find(b => b.textContent.includes('Launch')), 'the room row')
  assert.ok(calls.some(c => c.method === 'groups.list' && c.via === 'local::default'), 'listed on the active source')
  roomRow.click()
  const [, tab] = await waitFor(() => [...workspaces.entries()].find(([id]) => id === 'grokbot-override-room-r1'), 'the room tab')
  const roomEl = mount(tab.render)
  await waitFor(() => roomEl.textContent.includes('On it.'), 'the room log')
  assert.ok(roomEl.textContent.includes('Continue'), 'a paused discussion offers Continue')
  const box = roomEl.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(box, 'ship it friday')
  box.dispatchEvent(new window.Event('input', { bubbles: true }))
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => posted.length === 1, 'the post')
  assert.equal(posted[0].payload.text, 'ship it friday')
  assert.equal(posted[0].profile, 'default')
  assert.deepEqual(errors, [])
  assert.ok(LOCAL)
})
