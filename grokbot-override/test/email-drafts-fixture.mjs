// Shared fixture for the email draft card loader tests (one boot per test
// file, as every loader test in this suite: test/email-drafts*.test.mjs).
// A stand-in for the bot's email-drafts plugin; demo addresses only.

import { bootPlugin, history, waitFor } from './loader-boot.mjs'

export const ID = 'ed_0123456789abcdef'
export const ID2 = 'ed_fedcba9876543210'
export const created = (id = ID, status = 'pending') => JSON.stringify({ ok: true, email_draft: { id, status, rev: 1, subject: 'Pricing', to: ['sam@example.com'] }, message: 'Draft created. Not sent.' })
export const notServed = () => Object.assign(new Error('unknown method'), { code: -32601 })


/** A stand-in for the bot's email-drafts plugin. */
export function fakePlugin({ legacy = false, failFirstSend = false, autoSent = false } = {}) {
  const now = () => 1762560200
  const drafts = new Map([
    [
      ID,
      {
        id: ID,
        rev: 1,
        status: autoSent ? 'sent' : 'pending',
        ...(autoSent ? { sent_at: now(), sent_by: 'allow-rule' } : {}),
        from: 'me@example.com',
        from_name: '',
        signature: 'Demo Sender\nexample.com',
        to: ['sam@example.com'],
        cc: [],
        bcc: [],
        subject: 'Re: pricing',
        body: 'Hi Sam,\n\nThe price sheet is attached.',
        attachments: [{ path: '/workspace/demo/price-sheet.csv', name: 'price-sheet.csv', size: 22 }],
        in_reply_to: { message_id: '<orig@example.com>', subject: 'pricing', from: 'Sam <sam@example.com>' }
      }
    ]
  ])
  const rules = { mode: 'approval', allowed: [] }
  const ops = []
  let failed = !failFirstSend
  const view = d => ({ ...d, rules: { ...rules } })
  const handle = (op, p) => {
    ops.push({ op, ...p })
    const d = drafts.get(p.id)
    switch (op) {
      case 'get':
        return d ? { ok: true, draft: view(d) } : { ok: false, error: 'Unknown draft id' }
      case 'send': {
        if (d.status === 'sent' || d.status === 'sending') return { ok: true, already: d.status, draft: view(d) }
        if (p.rev !== d.rev) return { ok: false, error: 'The bot changed this draft; review it again' }
        for (const key of ['to', 'cc', 'subject', 'body']) if (key in p) d[key] = p[key]
        if (!failed) {
          failed = true
          Object.assign(d, { status: 'failed', error: 'Gmail is not signed in: run hermes auth add email-drafts:google' })
          return { ok: false, error: d.error, draft: view(d) }
        }
        Object.assign(d, { status: 'sent', sent_at: now(), sent_by: 'human', error: null })
        return { ok: true, draft: view(d) }
      }
      case 'discard':
        d.status = 'discarded'
        return { ok: true, draft: view(d) }
      case 'allow':
        rules.allowed = [...new Set([...rules.allowed, ...d.to])]
        rules.mode = 'allow'
        return { ok: true, rules: { ...rules } }
      case 'set_mode':
        rules.mode = p.mode
        return { ok: true, rules: { ...rules } }
      case 'unallow':
        rules.allowed = rules.allowed.filter(a => !p.addresses.includes(a))
        return { ok: true, rules: { ...rules } }
      default:
        return { ok: false, error: `Unknown operation ${op}` }
    }
  }
  const answers = legacy
    ? {
        'plugin.email-drafts.api': () => {
          throw notServed()
        },
        'slash.exec': params => {
          const [, , op, ...rest] = params.command.split(' ')
          return { output: JSON.stringify(handle(op, JSON.parse(rest.join(' ')))) }
        }
      }
    : { 'plugin.email-drafts.api': ({ op, session_id: _sid, ...p }) => handle(op, p) }
  return { answers, ops, drafts, rules }
}

export const withDraft = profile => {
  const page = history(profile)
  page.messages = [
    ...page.messages,
    { id: 20, role: 'user', content: 'email Sam the price sheet', timestamp: 1762560100 },
    { id: 21, role: 'assistant', content: '', tool_calls: [{ id: 'd1', function: { name: 'email_draft_create', arguments: '{"to":["sam@example.com"]}' } }], timestamp: 1762560101 },
    { id: 22, role: 'tool', tool_call_id: 'd1', name: 'email_draft_create', content: created(), timestamp: 1762560102 },
    { id: 23, role: 'assistant', content: 'Draft to Sam is ready on the card above.', timestamp: 1762560103 }
  ]
  return page
}

export function typeInto(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

export async function openScholar(t, plugin, extra = {}) {
  const booted = await bootPlugin(t, { historyFor: withDraft, answers: plugin.answers, ...extra })
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = booted.mount((await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')).render)
  const card = await waitFor(() => chatEl.querySelector('.gbo-email-draft textarea.gbo-ed-body') && chatEl.querySelector('.gbo-email-draft'), 'the draft card, loaded')
  return { booted, chatEl, card }
}

export const button = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text)

