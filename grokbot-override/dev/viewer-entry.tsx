// A live browser page for the file viewer (dev/viewer.mjs writes it): demo
// file cards that read from a fake local bot, and the viewer itself, on the
// override's real CSS. Not part of plugin.js.

import * as React from 'react'
import { createRoot } from 'react-dom/client'

import { FileCards } from '../src/ui/Media'
import { CSS } from '../src/ui/styles'

declare const __VIEWER_FILES__: Record<string, string>

const params = new URLSearchParams(location.search)
const dark = params.get('theme') === 'dark'
document.documentElement.classList.toggle('dark', dark)
document.documentElement.dataset.theme = dark ? 'dark' : 'light'
const style = document.createElement('style')
style.textContent = `${CSS}
html, body { margin: 0; height: 100%; background: ${dark ? '#161616' : '#ffffff'}; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
.demo { max-width: 720px; margin: 0 auto; padding: 40px 24px; }
.demo .bubble { display: inline-block; padding: 10px 14px; border-radius: 18px; background: ${dark ? '#242424' : '#f0f0f0'}; color: ${dark ? '#f5f5f5' : '#1c1c1c'}; }`
document.head.appendChild(style)

// The fake bot's machine: a local bot whose files the desktop bridge reads.
;(window as any).hermesDesktop = {
  readFileDataUrl: async (path: string) => {
    await new Promise(resolve => setTimeout(resolve, 120))
    return __VIEWER_FILES__[path] ?? { message: `No such file: ${path}` }
  }
}
const BOT = { name: 'demo', connectionId: 'local', connectionKind: 'local', route: { connectionId: 'local', mode: 'local', profile: 'demo', targetProfile: 'demo' } }
const FILES = Object.keys(__VIEWER_FILES__).map(path => ({ path, kind: 'file', name: path.split('/').pop() as string }))

function Page() {
  return (
    <div data-gbo-root="" className="demo">
      <div className="bubble">Here are the files you asked for.</div>
      <FileCards bot={BOT} files={FILES} />
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Page />)
const open = params.get('open')
if (open) {
  const tryOpen = (left: number) => {
    const card = [...document.querySelectorAll('.gbo-file-card')].find(el => (el as HTMLElement).dataset.path?.endsWith(`/${open}`))
    if (card) (card.querySelector('.gbo-file-card-main') as HTMLElement).click()
    else if (left) setTimeout(() => tryOpen(left - 1), 50)
  }
  tryOpen(40)
}
