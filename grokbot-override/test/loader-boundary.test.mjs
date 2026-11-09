// fix: live Transcript crash, part 2. Whatever breaks inside the override
// stays inside it: the pane shows the error inline with "Turn override off",
// and nothing reaches Hermes's workspace or root error boundary (the live
// crash took the whole window down).

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

test('loader-faithful: a render error stays inside the override (inline error + Turn override off)', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount, errors, store } = await bootPlugin(t, {
    tweak: sdk => {
      sdk.MessageTextContent = () => {
        throw new Error('renderer exploded')
      }
    }
  })
  const quiet = console.error
  console.error = () => undefined
  t.after(() => (console.error = quiet))
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Security')), 'row')
  row.click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => chatEl.querySelector('[data-gbo-error]'), 'the inline error')
  assert.deepEqual(errors.filter(e => e.kind === 'uncaught'), [], 'nothing escaped to the host root')
  assert.match(chatEl.textContent, /renderer exploded/)
  const off = [...chatEl.querySelectorAll('button')].find(b => /Turn override off/.test(b.textContent))
  assert.ok(off, 'offers Turn override off')
  off.click()
  assert.equal(store.get('enabled'), false, 'the toggle is persisted off')
})
