// Cross-branch wiring (src/ui/wiring.ts): the roster-side surfaces calling
// into the chat-side code. Loader-faithful for the R13 kickoff (the whole
// create sequence through the built plugin.js); the room → badge rule is
// pure and tested directly. The new-tab and New group chat seams are driven
// by clicks in loader-smoke*.test.mjs and loader-clickthrough.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { attentionFromRoomEvent, clearAttention, noteAttention } from '../src/core/attention.js'
import { KICKOFF_TEXT } from '../src/core/create-chat.js'
import { LOCAL, READY, REMOTE, waitFor } from './loader-boot.mjs'
import { bootFull, reactErrors, ROOM_MEMBERS } from './loader-surfaces.mjs'

test('R14 → R15: a member\'s failed group turn badges it, its next reply clears it (stock group-round-members.ts)', () => {
  const fail = attentionFromRoomEvent({ seq: 3, kind: 'turn.failed', payload: { member_id: 'security', error: 'insufficient credits (402)' } }, ROOM_MEMBERS)
  assert.deepEqual(fail, { kind: 'fail', profile: 'security', text: 'insufficient credits (402)' })
  const coded = attentionFromRoomEvent({ seq: 4, kind: 'turn.failed', payload: { member_id: 'security', reason_code: 'provider_auth_or_access', error: 'x' } }, ROOM_MEMBERS)
  assert.equal(coded.text, 'provider_auth_or_access', 'the reason code wins over the error text')
  const ok = attentionFromRoomEvent({ seq: 5, kind: 'message.member', actor: { kind: 'member', id: 'security' }, payload: { text: 'done' } }, ROOM_MEMBERS)
  assert.deepEqual(ok, { kind: 'ok', profile: 'security' })
  assert.equal(attentionFromRoomEvent({ kind: 'message.user', actor: { kind: 'user', id: 'desktop' }, payload: { text: 'hi' } }, ROOM_MEMBERS), null, 'your own post says nothing about a member')
  assert.equal(attentionFromRoomEvent({ kind: 'message.member', actor: { kind: 'member', id: 'security' }, payload: { text: '' } }, ROOM_MEMBERS), null, 'an empty reply is not a good turn')

  let map = {}
  map = noteAttention(map, 'local::security', fail.text)
  assert.equal(map['local::security'].reason, 'provider_quota_limit')
  map = noteAttention(map, 'local::security', 'rate limit exceeded (429)')
  assert.equal(map['local::security'].reason, 'provider_quota_limit', 'a transient failure never replaces the badge')
  map = clearAttention(map, 'local::security')
  assert.deepEqual(map, {})
})

test('loader-faithful R13 → C3: a new bot is created and its Bot Chat is born once, with the intro (kickoff)', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const NEWBIE = { name: 'newbie', connectionId: 'local', route: { connectionId: 'local', mode: 'local', profile: 'newbie', targetProfile: 'newbie' } }
  let created = false
  const { internals, calls, errors, panes, workspaces, mount } = await bootFull(t, {
    answers: {
      'profiles.list': () => ({ profiles: created ? [LOCAL, REMOTE, NEWBIE] : [LOCAL, REMOTE], bot_mode_protocol: false }),
      'profiles.create': () => ((created = true), { ok: true }),
      'profiles.configure': () => ({ ok: true }),
      'setup.runtime_check': () => ({ ok: true }),
      'session.create': () => ({ stored_session_id: 'nb-stored', session_id: 'rt-newbie' }),
      'session.title': () => ({ ok: true }),
      'prompt.submit': () => ({ status: 'started' })
    }
  })
  mount(panes.find(p => p.id === 'roster').render)
  const result = await internals.createBot({
    name: 'Newbie',
    slug: 'newbie',
    title: 'Newbie',
    description: 'A new helper',
    target: '',
    cloneFrom: 'default',
    noSkills: false,
    shareAuth: true,
    customSoul: '',
    model: '',
    provider: '',
    look: { shape: 'round', color: null, image: null },
    caps: null,
    dirtyCaps: {}
  })
  assert.equal(result.kickedOff, true, 'the intro ran')
  const of = method => calls.filter(c => c.method === method)
  assert.equal(of('profiles.create').length, 1)
  assert.equal(of('session.create').length, 1, 'one Bot Chat: the click path did not mint a second one')
  assert.deepEqual(of('session.create')[0].params, { profile: 'newbie', title: 'Bot Chat', hidden: true, follow_profile_config: true })
  assert.deepEqual(of('session.title')[0].params, { session_id: 'rt-newbie', title: 'Bot Chat' })
  const intro = of('prompt.submit')
  assert.equal(intro.length, 1, 'the intro is sent exactly once')
  assert.deepEqual(intro[0].params, { session_id: 'rt-newbie', text: KICKOFF_TEXT })
  assert.ok(calls.indexOf(of('session.title')[0]) < calls.indexOf(intro[0]), 'titled before the intro, like stock')
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat workspace')).render)
  await waitFor(() => chatEl.textContent.includes('hello newbie'), 'the new Bot Chat is open')
  assert.equal(internals.app.chat.get()?.storedId, 'nb-stored')
  assert.deepEqual(reactErrors(errors), [])
})
