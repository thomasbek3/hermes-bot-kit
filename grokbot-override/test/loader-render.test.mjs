// fix: live Transcript crash. The built plugin.js, loaded the way Hermes
// Desktop loads a runtime plugin (test/hermes-loader.mjs: shim modules over
// the app's React namespaces, the loader's specifier rewrite, production
// React and react-dom), mounted in a DOM with createRoot, then driven like a
// user: Roster click → open chat → Transcript render, for a local and a remote
// bot, and switching between them. The switch unmounts the Transcript, which
// is where the live crash fired: an effect returned `true`, and React calls an
// effect's return value as its cleanup ("destroy is not a function", minified
// to "l is not a function" in the app).
//
// Any error React reports (uncaught, caught by a boundary, recoverable) fails.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

test('loader-faithful: Roster click opens the chat and the Transcript renders, local and remote, switching back and forth', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount, errors, calls } = await bootPlugin(t, { showWork: true })
  const rosterPane = panes.find(p => p.id === 'roster')
  assert.ok(rosterPane, 'the roster pane is registered')
  const rosterEl = mount(rosterPane.render)
  const row = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  await waitFor(() => row('Security') && row('Scholar'), 'roster rows')

  let chatEl = null
  const shows = text => chatEl && chatEl.querySelector('.gbo-transcript') && chatEl.textContent.includes(text)
  for (const [name, profile] of [['Security', 'security'], ['Scholar', 'scholar'], ['Security', 'security'], ['Scholar', 'scholar']]) {
    row(name).click()
    if (!chatEl) chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat workspace')).render)
    await waitFor(() => shows(`hello ${profile}`) || errors.length, `${name}'s transcript`)
    assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [], `no React error after opening ${name}`)
    assert.ok(chatEl.textContent.includes('answers with'), `${name}'s reply renders`)
    assert.ok(chatEl.querySelector('.aui-md'), 'markdown goes through the SDK renderer as a component')
    assert.ok(chatEl.textContent.includes('1 tool'), 'tool activity renders')
  }
  assert.ok(calls.some(c => c.via === 'home-server::scholar' && c.method === 'session.list'), 'the remote bot rides its own route')
  assert.ok(calls.some(c => c.via === 'local::security' && c.method === 'session.list'), 'the local bot rides its local route')
  assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 0, 'opening never sends')
})
