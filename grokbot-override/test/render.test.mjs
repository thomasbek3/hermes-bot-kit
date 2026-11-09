// Server-render the real UI components with fixture data. Needs the dev
// dependencies (`npm ci` in grokbot-override/); skipped without them.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

test('the roster, chat and profile panel render every transcript state', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const { render } = await import(pathToFileURL(file).href)

  // Work rows shown (Bubble Mode's preference); hidden by default is
  // covered in test/look-pass4.test.mjs.
  const html = render({ theme: 'dark', showWork: true })
  for (const text of [
    'Travel', // roster row + header pill
    'Scholar',
    'HOME-SERVER', // connection section
    'placeholder="Message Travel"',
    'May I run this?',
    'Allow once',
    'Always allow',
    'Deny',
    '2 tools',
    'Listing the trip folder…', // running tool line
    'Thought', // collapsed reasoning
    'Show earlier messages',
    'Scheduled',
    'Trip price check',
    'role="switch"',
    'aria-checked="false"', // the paused job
    'Bot’s computer · Asleep',
    'aria-label="Regenerate reply"', // C22
    'aria-label="React"' // C23
  ]) {
    assert.ok(html.includes(text), `missing: ${text}`)
  }
  assert.match(html, /class="divider gbo-divider">(Today|Yesterday|\w+day|\w{3} \d+) \d/)
  assert.match(html, /--gbo-tint-bg:#[0-9A-F]{6}/, 'user bubbles wear the bot colour')
  assert.ok(html.includes('<html class="dark">'))

  const light = render({ theme: 'light', busy: false })
  assert.ok(!light.includes('class="dark"'))
  assert.ok(!light.includes('class="composer__cta gbo-round is-stop"'), 'no stop button when idle')
  assert.ok(html.includes('class="composer__cta gbo-round is-stop"'), 'stop button while a turn runs')

  const noChat = render({ phase: 'no-chat' })
  assert.ok(noChat.includes('No Bot Chat yet'))
  assert.ok(noChat.includes('Start Bot Chat'))

  const failed = render({ phase: 'error' })
  assert.ok(failed.includes('Try again'))
  assert.ok(failed.includes('socket closed'))

  const opening = render({ phase: 'resolving' })
  assert.ok(opening.includes('Opening Travel’s chat…'))

  const pick = render({ selected: false })
  assert.ok(pick.includes('Pick a bot'))
})

test('review r1: owner-safe markdown, narrow drawer, waiting card, stop error', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const { render } = await import(pathToFileURL(file).href)
  const { CSS } = await import(pathToFileURL(file).href)

  // #2: assistant markdown never resolves media/file paths against the active gateway
  const html = render({ busy: false })
  assert.match(html, /class="aui-md [^"]*" data-media="false" data-preview-only="true"/)
  assert.doesNotMatch(html, /data-media="true"/)

  // #9: below 900px of pane width the profile is a drawer, closed until asked for
  assert.doesNotMatch(CSS, /\.gbo-panel\s*\{\s*display:\s*none/, 'no rule hides the panel outright')
  const closed = render({ narrow: true, drawerOpen: false })
  const panelClass = /class="[^"]*\bgbo-panel"/
  assert.doesNotMatch(closed, panelClass, 'drawer closed: no panel')
  assert.ok(closed.includes('aria-label="Show profile"'))
  const open = render({ narrow: true, drawerOpen: true })
  assert.ok(open.includes('role="dialog"'))
  assert.ok(open.includes('class="gbo-drawer"'))
  assert.ok(open.includes('Trip price check'), 'scheduled jobs are reachable in the drawer')
  assert.ok(open.includes('aria-label="Close profile"'))
  const wide = render({ narrow: false })
  assert.ok(panelClass.test(wide) && !wide.includes('class="gbo-drawer"'))

  // #7: a turn blocked on a clarify/secret answer says so and hands off
  const waiting = render({ waiting: { kind: 'clarify', id: 'c1', text: 'Which branch?', questions: [{ qid: 'c1', question: 'Which branch?', choices: ['main (Recommended)', 'dev'], multiSelect: false }] } })
  assert.ok(waiting.includes('Waiting for your answer'))
  assert.ok(waiting.includes('Which branch?'))
  assert.ok(waiting.includes('Recommended') && waiting.includes('>dev<') && waiting.includes('Skip'), 'answerable here (C11)')
  assert.ok(!waiting.includes('Thinking…'), 'not shown as thinking')
  const sudo = render({ waiting: { kind: 'sudo', id: 's1', text: 'apt install jq' } })
  assert.ok(sudo.includes('type="password"') && sudo.includes('apt install jq') && sudo.includes('Cancel'))
  const conn = render({ waiting: { kind: 'connection', id: 'op1', opId: 'op1', targets: [{ name: 'github', state: 'pending', connect_url: 'https://example.com/auth' }, { name: 'mcp-x', state: 'pending', required_env: [{ name: 'X_TOKEN', required: true, secret: true, default: '' }] }] } })
  assert.ok(conn.includes('Sign in') && conn.includes('Approve') && conn.includes('Not now') && conn.includes('Continue'))
  assert.ok(conn.includes('name="X_TOKEN"') && conn.includes('type="password"'))
  const unsupported = render({ waiting: { kind: 'secret', id: 'r1', envVar: 'GH_TOKEN', text: 'GitHub token', error: 'This Hermes version cannot take this answer from here.', unsupported: true } })
  assert.ok(unsupported.includes('Answer in Hermes Bot Mode'), 'the one error-state link')

  // a failed stop is reported
  assert.ok(render({ stopError: 'socket closed' }).includes('Could not stop: socket closed'))
})
