// Security fixes for what a bot's output can make the screen do:
//  - a remote image in bot text is not fetched until the user clicks Load;
//  - a connection's sign-in link opens only for https (http on this machine).

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { extractMedia, remoteImageHost } from '../src/core/media.js'
import { isOpenableConnectUrl, isSlackAuthorizationUrl } from '../src/core/urls.js'
import { isSlackAuthorizationUrl as fromSlackConnect } from '../src/core/slackConnect.js'
import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

test('connect_url policy: https anywhere, http only to this machine, nothing else', () => {
  for (const ok of ['https://example.invalid/oauth', 'https://accounts.example.com/o/authorize?x=1', 'http://localhost:8765/cb', 'http://127.0.0.1/cb', 'http://[::1]:9/cb']) {
    assert.equal(isOpenableConnectUrl(ok), true, ok)
  }
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'customscheme://x', 'http://example.com/oauth', 'http://localhost.example.com/', 'vbscript:x', '', 'not a url', null]) {
    assert.equal(isOpenableConnectUrl(bad), false, String(bad))
  }
  assert.equal(fromSlackConnect, isSlackAuthorizationUrl, 'one shared helper for both checks')
  assert.ok(isSlackAuthorizationUrl('https://slack.com/oauth/v2/authorize?a=1'))
  assert.ok(!isSlackAuthorizationUrl('http://slack.com/oauth/v2/authorize'))
})

test('remote images keep their host for the Load placeholder', () => {
  const { media } = extractMedia('![chart](https://images.example.com/c.png?d=secret)')
  assert.deepEqual(media.map(m => [m.remote, m.kind]), [[true, 'image']])
  assert.equal(remoteImageHost(media[0].path), 'images.example.com')
  assert.equal(remoteImageHost('::'), '')
})

test('a connection card shows a disallowed sign-in link as text and offers no Sign in', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const { render } = await import(pathToFileURL(file).href)
  const bad = render({ waiting: { kind: 'connection', id: 'op1', opId: 'op1', targets: [{ name: 'github', state: 'pending', connect_url: 'javascript:alert(1)' }] } })
  assert.ok(!bad.includes('>Sign in<'), 'no Sign in button for a javascript: link')
  assert.ok(bad.includes('class="gbo-card-desc gbo-connect-url-blocked"') && bad.includes('<code>javascript:alert(1)</code>'), 'the link is shown as text with a note')
  assert.ok(bad.includes('Not now'))
  const good = render({ waiting: { kind: 'connection', id: 'op1', opId: 'op1', targets: [{ name: 'github', state: 'pending', connect_url: 'https://example.com/auth' }] } })
  assert.ok(good.includes('>Sign in<') && !good.includes('class="gbo-card-desc gbo-connect-url-blocked"'))
})

test('loader-faithful: a remote image in bot text loads only after the user clicks Load; owner files are unchanged', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const withImages = profile => {
    const base = history(profile)
    base.messages.push({ id: 15, role: 'assistant', content: 'Look:\n\n![leak](https://tracker.example.com/p.png?d=secret)\n\nMEDIA:/tmp/chart.png', timestamp: 1762560010 })
    return base
  }
  const { panes, workspaces, mount, errors } = await bootPlugin(t, {
    historyFor: withImages,
    api: request => (String(request.path).startsWith('/api/fs/read-data-url') ? { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } : undefined)
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  const owner = await waitFor(() => chatEl.querySelector('.gbo-media-image img[src^="data:"]'), 'the owner-read image')
  assert.equal(owner.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=', 'a file from the bot’s own machine still shows at once')
  const placeholder = await waitFor(() => chatEl.querySelector('button.gbo-media-remote'), 'the remote placeholder')
  assert.match(placeholder.textContent, /Image from tracker\.example\.com · Load/)
  assert.equal([...chatEl.querySelectorAll('img')].filter(img => /^https?:/.test(img.getAttribute('src') || '')).length, 0, 'no remote <img> before the click')
  placeholder.click()
  const remote = await waitFor(() => chatEl.querySelector('img[src^="https://tracker.example.com/"]'), 'the remote image after Load')
  assert.equal(remote.getAttribute('src'), 'https://tracker.example.com/p.png?d=secret')
  assert.deepEqual(errors, [])
})
