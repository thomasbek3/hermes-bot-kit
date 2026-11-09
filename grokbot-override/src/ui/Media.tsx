// Owner-safe rich messages (PARITY C15): the text goes through the SDK's own
// renderer in its inert mode (sdk.ts Markdown), and the media it names are
// drawn here from the bot's OWN backend (app.ts readBotMedia, core/media.js):
// images inline, audio and video players, other files as a chip that saves
// the file. Public http(s) images the text links load directly.

import * as React from 'react'

import { extractMedia } from '../core/media.js'
import { readBotMedia } from './app'
import { Markdown } from './sdk'

function saveDataUrl(dataUrl: string, name: string) {
  try {
    const link = document.createElement('a')
    link.href = dataUrl
    link.download = name
    link.rel = 'noopener noreferrer'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch {
    /* no DOM */
  }
}

export function OwnerMedia({ bot, item }: { bot: any; item: { path: string; kind: string; name: string; remote?: boolean } }) {
  const [src, setSrc] = React.useState<string>(item.remote ? item.path : '')
  const [error, setError] = React.useState('')
  const wantsRead = !item.remote && item.kind !== 'file'
  React.useEffect(() => {
    if (!wantsRead) return undefined
    let live = true
    readBotMedia(bot, item.path).then(
      url => {
        if (live) setSrc(url)
      },
      err => {
        if (live) setError(String(err?.message || err))
      }
    )
    return () => {
      live = false
    }
  }, [bot, item.path, wantsRead])

  if (item.kind === 'image') {
    if (error) return <span className="gbo-media-file is-error" title={error}>{item.name}: not available</span>
    return src ? (
      <a className="gbo-media-image" href={src} target="_blank" rel="noopener noreferrer" title={item.name}>
        <img alt={item.name} src={src} loading="lazy" />
      </a>
    ) : (
      <span className="gbo-media-image is-loading" aria-label={`Loading ${item.name}`} />
    )
  }
  if ((item.kind === 'audio' || item.kind === 'video') && src) {
    return item.kind === 'audio' ? (
      <audio className="gbo-media-audio" controls src={src} preload="metadata" />
    ) : (
      <video className="gbo-media-video" controls src={src} preload="metadata" />
    )
  }
  return (
    <button
      type="button"
      className={`gbo-media-file${error ? ' is-error' : ''}`}
      title={error || `Save ${item.name}`}
      onClick={() => {
        readBotMedia(bot, item.path).then(
          url => saveDataUrl(url, item.name),
          err => setError(String(err?.message || err))
        )
      }}
    >
      {item.name}
      {error ? ': not available' : ''}
    </button>
  )
}

export function MediaStrip({ bot, media }: { bot: any; media: any[] }) {
  if (!media.length) return null
  return (
    <div className="gbo-media">
      {media.map(item => (
        <OwnerMedia key={item.path} bot={bot} item={item} />
      ))}
    </div>
  )
}

/** A finished assistant message: inert markdown + owner-read media. */
export function BotText({ bot, text }: { bot: any; text: string }) {
  const { text: clean, media } = React.useMemo(() => extractMedia(text), [text])
  return (
    <>
      {clean ? <Markdown text={clean} /> : null}
      <MediaStrip bot={bot} media={media} />
    </>
  )
}
