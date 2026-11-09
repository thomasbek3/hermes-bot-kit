// Round-3 review findings in the UI (src/ui/Chat.tsx, Composer note): the
// real components, bundled with the fake SDK (dev/bundle.mjs), rendered
// without a DOM. Needs the dev dependencies; skipped without them.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { failureNote } from '../src/core/drafts.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

async function load(t) {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  return import(pathToFileURL(file).href)
}

const noop = () => undefined
const bubble = patch => ({ kind: 'user', id: 'local:1', text: 'x', failed: 'request timed out', ...patch })

test('r3 #1/#2 a delivery-unknown bubble never offers a resend, in any check state', { skip }, async t => {
  const { renderElement, UserMeta } = await load(t)
  for (const state of [{ checked: false }, { checked: true }, { checked: true, checkFailed: true }]) {
    const html = renderElement(UserMeta, { item: bubble({ delivery: 'unknown', ...state }), onRetry: noop, onRecheck: noop, onOpen: noop })
    assert.ok(!/Send again|Retry/.test(html), `no resend (${JSON.stringify(state)})`)
    assert.match(html, /Open in Hermes Bot Mode/)
    assert.match(html, /Delivery unknown/)
    if (state.checked) assert.match(html, /Check again/)
  }
  const refused = renderElement(UserMeta, { item: bubble({ delivery: 'not-sent' }), onRetry: noop, onRecheck: noop, onOpen: noop })
  assert.match(refused, /Retry/, 'a definite refusal keeps Retry')
})

test('r3 #1/#2 the composer note never invites a resend of an unknown delivery', () => {
  const note = failureNote({ ok: false, delivery: 'unknown', error: 'did not confirm your message in time' }, false)
  assert.ok(!/retry|send again/i.test(note), note)
  assert.match(note, /will not be sent again/)
  assert.match(failureNote({ ok: false, delivery: 'not-sent', error: 'session busy' }, true), /back in the composer/)
})
