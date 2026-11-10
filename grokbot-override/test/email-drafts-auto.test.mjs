// Email draft card in the running plugin (ui/EmailDraft.tsx): a draft the allow rule sent shows "Sent automatically … allowed recipient".
// One boot per file (test/email-drafts-fixture.mjs). Nothing is sent anywhere.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'
import { button, fakePlugin, withDraft } from './email-drafts-fixture.mjs'

const skip = !READY && 'dev dependencies not installed'

test('loader: a draft the allow rule sent shows "Sent automatically … allowed recipient"', { skip }, async t => {
  const plugin = fakePlugin({ autoSent: true })
  const booted = await bootPlugin(t, { historyFor: withDraft, answers: plugin.answers })
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = booted.mount((await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')).render)
  const card = await waitFor(() => chatEl.querySelector('.gbo-email-draft[data-status="sent"]'), 'sent card')
  assert.match(card.querySelector('.gbo-ed-state').textContent, /^Sent automatically · .* · allowed recipient$/)
  assert.equal(card.querySelector('textarea'), null)
  assert.equal(card.querySelector('.gbo-ed-rules'), null)
})
