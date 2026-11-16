// Tighter T5: bot prose is memoized. A stream delta in the newest reply
// never re-renders the finished messages' Markdown above it (each delta used
// to re-render every finished message). Built plugin.js under Hermes's loader
// (test/hermes-loader.mjs); one plugin per test file.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const skip = !READY && 'dev dependencies not installed'

test('a stream delta does not re-render the finished messages above it', { skip }, async t => {
  const renders = new Map()
  const { panes, workspaces, mount, errors, calls, emit } = await bootPlugin(t, {
    tweak: sdk => {
      const inner = sdk.MessageTextContent
      sdk.MessageTextContent = props => {
        renders.set(props.text, (renders.get(props.text) || 0) + 1)
        return inner(props)
      }
    },
    answers: { 'session.active_list': () => ({ sessions: [{ id: 'rt-security', status: 'working' }] }) }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Security')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  const OLD = '**security** answers with `code`'
  await waitFor(() => renders.get(OLD), 'the finished reply')
  await waitFor(() => calls.some(c => c.method === 'session.resume'), 'attached', 8000)
  await new Promise(resolve => setTimeout(resolve, 150))

  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.delta', session_id: 'rt-security', payload: { text: 'Working on ' } })
  await waitFor(() => chatEl.querySelector('.bubble.is-streaming'), 'the streaming bubble')
  await new Promise(resolve => setTimeout(resolve, 150))
  const before = renders.get(OLD)
  for (const piece of ['it ', 'right ', 'now.']) {
    emit({ type: 'message.delta', session_id: 'rt-security', payload: { text: piece } })
    await new Promise(resolve => setTimeout(resolve, 90))
  }
  await waitFor(() => chatEl.querySelector('.bubble.is-streaming')?.textContent.includes('right'), 'the deltas drawn')
  assert.equal(renders.get(OLD), before, 'the finished reply was not re-rendered by the deltas')
  assert.deepEqual(errors, [])
})
