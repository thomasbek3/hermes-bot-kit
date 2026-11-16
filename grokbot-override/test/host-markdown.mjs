// The host's real markdown pipeline, for the tests that must see what the
// live renderer does (sanitizing, autolinks, which nodes call decorateText),
// not the fake SDK. Hermes's own Streamdown from a local Hermes Agent checkout
// (~/.hermes/hermes-agent); `null` when it is not there (CI), and the tests
// that need it skip.
//
// The components mirror apps/desktop/src/components/assistant-ui/markdown-text.tsx
// (Hermes Agent, MIT, (c) Nous Research) in its preview-only mode:
// `decorateText` on p / li / td children, h1-h4 and th plain, and the
// preview-only link (an http(s) URL to a public host is an anchor, anything
// else a span).

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(homedir(), '.hermes/hermes-agent')

function streamdownEntry() {
  const store = join(ROOT, 'node_modules/.pnpm')
  if (!existsSync(store)) return null
  const dir = readdirSync(store).find(name => name.startsWith('streamdown@'))
  const entry = dir && join(store, dir, 'node_modules/streamdown/dist/index.js')
  return entry && existsSync(entry) ? entry : null
}

let loaded
export async function hostMarkdown() {
  if (loaded !== undefined) return loaded
  const entry = streamdownEntry()
  const app = join(ROOT, 'apps/desktop/package.json')
  if (!entry || !existsSync(app)) return (loaded = null)
  try {
    const require = createRequire(app)
    const React = require('react')
    const { renderToStaticMarkup } = require('react-dom/server')
    const { Streamdown } = await import(pathToFileURL(entry).href)
    const previewLink = ({ children, href }) => {
      let target = null
      try {
        target = href && /^https?:\/\//i.test(href.trim()) ? new URL(href.trim()) : null
      } catch {
        target = null
      }
      if (!target || target.username || target.password || /^(localhost|127\.|10\.|192\.168\.)/.test(target.hostname)) {
        return React.createElement('span', null, children)
      }
      return React.createElement('a', { className: 'ref wrap-anywhere', href: target.href }, children)
    }
    const render = (text, decorateText) => {
      const deco = children => (decorateText ? decorateText(children) : children)
      const components = {
        p: ({ children, node, ...props }) => React.createElement('p', props, deco(children)),
        li: ({ children, node, ...props }) => React.createElement('li', props, deco(children)),
        td: ({ children, node, ...props }) => React.createElement('td', props, deco(children)),
        a: previewLink
      }
      return renderToStaticMarkup(React.createElement(Streamdown, { components, mode: 'static' }, text))
    }
    return (loaded = { render })
  } catch {
    return (loaded = null)
  }
}
