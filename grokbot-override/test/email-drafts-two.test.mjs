// Email draft card in the running plugin (ui/EmailDraft.tsx): a second draft and a bot update in the same chat: one card each, refreshed by the update.
// One boot per file (test/email-drafts-fixture.mjs). Nothing is sent anywhere.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'
import { button, created, fakePlugin, ID, ID2, withDraft } from './email-drafts-fixture.mjs'

const skip = !READY && 'dev dependencies not installed'

test('loader: a second draft and a bot update in the same chat: one card each, refreshed by the update', { skip }, async t => {
  const plugin = fakePlugin()
  plugin.drafts.set(ID2, { ...plugin.drafts.get(ID), id: ID2, subject: 'Second', attachments: [], in_reply_to: null })
  const historyFor = profile => {
    const page = withDraft(profile)
    page.messages.push(
      { id: 30, role: 'assistant', content: '', tool_calls: [{ id: 'd2', function: { name: 'email_draft_create', arguments: '{}' } }, { id: 'd3', function: { name: 'email_draft_update', arguments: '{}' } }], timestamp: 1762560200 },
      { id: 31, role: 'tool', tool_call_id: 'd2', name: 'email_draft_create', content: created(ID2), timestamp: 1762560201 },
      { id: 32, role: 'tool', tool_call_id: 'd3', name: 'email_draft_update', content: JSON.stringify({ ok: true, email_draft: { id: ID, status: 'pending', rev: 2 } }), timestamp: 1762560202 }
    )
    return page
  }
  const booted = await bootPlugin(t, { historyFor, answers: plugin.answers })
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = booted.mount((await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => chatEl.querySelectorAll('.gbo-email-draft textarea').length === 2, 'two loaded cards')
  assert.deepEqual([...chatEl.querySelectorAll('.gbo-email-draft')].map(c => c.dataset.draftId), [ID, ID2])
})
