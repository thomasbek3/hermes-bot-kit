// Owner-safe rich messages (PARITY C15): the text goes through the SDK's own
// renderer in its inert mode (sdk.ts Markdown), and the media it names are
// drawn here from the bot's OWN backend (app.ts readBotMedia, core/media.js):
// images inline, audio and video players, other files as a card under the
// bubble (FileCard: name, size, a download button on hover, a preview of
// text files with Copy all). An http(s) image the text links is NOT fetched on its own (a
// message could name any host and carry data in the URL): it shows as
// "Image from <host> · Load" and loads only when the user clicks it.

import * as React from 'react'

import { splitFences } from '../core/fences.js'
import { dataUrlBytes, dataUrlText, extractMedia, formatBytes, middleTruncate, previewKind, remoteImageHost } from '../core/media.js'
import { readBotMedia } from './app'
import { CodeBlock, COPIED_MS } from './CodeBlock'
import { IconDocument, IconDownload } from './icons'
import { Dialog } from './kit'
import { copyText } from './MessageActions'
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
  const [src, setSrc] = React.useState<string>('')
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

  if (item.kind === 'image' && item.remote && !src) {
    const host = remoteImageHost(item.path)
    return (
      <button type="button" className="gbo-media-remote" title={item.path} onClick={() => setSrc(item.path)}>
        <span className="gbo-media-remote-host">Image from {host}</span>
        <span aria-hidden="true"> · </span>
        <span className="gbo-media-remote-load">Load</span>
      </button>
    )
  }
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
  return <FileCard bot={bot} item={item} />
}

type FileState = { status: 'idle' | 'loading' | 'ready' | 'error'; size?: number; error?: string }

/** A file the bot sent, as its own card under the bubble: a document tile,
 *  the name cut in the middle (full name in the title), the size under it
 *  ("Not available" when the bot's machine cannot read it). The file is read
 *  from the bot's own backend only when the card is first pointed at or
 *  focused (never while the transcript renders); a round download button
 *  shows on hover. Clicking a text file opens a preview with Copy all and
 *  Download; clicking any other file saves it. */
export function FileCard({ bot, item }: { bot: any; item: { path: string; name: string } }) {
  const [state, setState] = React.useState<FileState>({ status: 'idle' })
  const [preview, setPreview] = React.useState<null | string>(null)
  const live = React.useRef(true)
  React.useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const kind = previewKind(item.name)
  const read = (): Promise<string | null> =>
    readBotMedia(bot, item.path)
      .then(url => {
        if (!url) throw new Error(`Could not read ${item.name}`)
        if (live.current) setState({ status: 'ready', size: dataUrlBytes(url) ?? undefined })
        return url
      })
      .catch(err => {
        if (live.current) setState({ status: 'error', error: String(err?.message || err) })
        return null
      })
  const peek = () => {
    if (state.status !== 'idle') return
    setState({ status: 'loading' })
    void read()
  }
  const save = () => {
    void read().then(url => {
      if (url) saveDataUrl(url, item.name)
    })
  }
  const open = () => {
    if (state.status === 'error') return
    if (!kind) return save()
    void read().then(url => {
      if (url && live.current) setPreview(dataUrlText(url))
    })
  }
  const missing = state.status === 'error'
  const meta = missing ? 'Not available' : state.size !== undefined ? formatBytes(state.size) : ''
  return (
    <>
      <div
        className={`gbo-file-card${missing ? ' is-error' : ''}`}
        data-path={item.path}
        onMouseEnter={peek}
        onFocus={peek}
      >
        <button
          type="button"
          className="gbo-file-card-main"
          title={missing ? `${item.name}: ${state.error || 'not available'}` : item.name}
          aria-label={missing ? `${item.name}, not available` : kind ? `Open ${item.name}` : `Save ${item.name}`}
          aria-disabled={missing || undefined}
          onClick={open}
        >
          <span className="gbo-file-card-icon">
            <IconDocument lines={kind !== ''} />
          </span>
          <span className="gbo-file-card-text">
            <span className="gbo-file-card-name">{middleTruncate(item.name)}</span>
            <span className="gbo-file-card-size">{meta || '\u00a0'}</span>
          </span>
        </button>
        {missing ? null : (
          <button type="button" className="gbo-file-card-save" aria-label={`Download ${item.name}`} title="Download" onClick={save}>
            <IconDownload />
          </button>
        )}
      </div>
      {preview !== null ? <FilePreview name={item.name} text={preview} markdown={kind === 'markdown'} onSave={save} onClose={() => setPreview(null)} /> : null}
    </>
  )
}

/** A text file the bot sent, read in a dialog: markdown through the SDK
 *  renderer in its safe mode, anything else in monospace; Copy all copies
 *  the file's exact text. */
function FilePreview({ name, text, markdown, onSave, onClose }: { name: string; text: string; markdown: boolean; onSave: () => void; onClose: () => void }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<any>(null)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => {
    void copyText(text).then(ok => {
      if (!ok) return
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }
  return (
    <Dialog
      open
      wide
      label={`Preview of ${name}`}
      title={<span className="gbo-file-preview-title" title={name}>{name}</span>}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="gbo-btn is-ghost is-small" onClick={onClose}>
            Close
          </button>
          <span className="gbo-spacer" />
          <button type="button" className="gbo-btn is-small gbo-file-preview-save" onClick={onSave}>
            Download
          </button>
          <button type="button" className="gbo-btn is-primary is-small gbo-file-preview-copy" onClick={copy}>
            {copied ? 'Copied' : 'Copy all'}
          </button>
        </>
      }
    >
      {markdown ? (
        <div className="md gbo-file-preview">
          <Markdown text={text} />
        </div>
      ) : (
        <pre className="gbo-file-preview is-mono">{text}</pre>
      )}
    </Dialog>
  )
}

/** The files a message sends, one card each, stacked under its bubble. */
export function FileCards({ bot, files }: { bot: any; files: any[] }) {
  if (!files.length) return null
  return (
    <div className="gbo-files">
      {files.map(item => (
        <FileCard key={item.path} bot={bot} item={item} />
      ))}
    </div>
  )
}

/** Images, audio and video inside the bubble (files go under it: FileCards). */
export function MediaStrip({ bot, media }: { bot: any; media: any[] }) {
  const shown = media.filter(item => item.kind !== 'file')
  if (!shown.length) return null
  return (
    <div className="gbo-media">
      {shown.map(item => (
        <OwnerMedia key={item.path} bot={bot} item={item} />
      ))}
    </div>
  )
}

/** A finished assistant message: inert markdown + owner-read media, with
 *  its fenced code blocks drawn by the override (Copy, no clipped box). */
export function BotText({ bot, text }: { bot: any; text: string }) {
  const { text: clean, media } = React.useMemo(() => extractMedia(text), [text])
  const parts = React.useMemo(() => (clean ? splitFences(clean) : []), [clean])
  return (
    <>
      {parts.map((part: any, index: number) =>
        part.kind === 'code' ? <CodeBlock key={index} code={part.code} lang={part.lang} /> : <Markdown key={index} text={part.text} />
      )}
      <MediaStrip bot={bot} media={media} />
    </>
  )
}

/** A bot message's prose as its bubble, with the files it sends as cards
 *  under the bubble (not inside it). A message that is only a file skips the
 *  empty bubble. */
export function BotProse({ bot, text, pos, time }: { bot: any; text: string; pos: string; time?: React.ReactNode }) {
  const { text: clean, media } = React.useMemo(() => extractMedia(text), [text])
  const files = media.filter(item => item.kind === 'file')
  const bubble = Boolean(clean) || media.length > files.length
  return (
    <>
      {bubble ? (
        <div className="bubble-wrap is-left">
          <div className={`bubble is-agent${pos}`}>
            <div className="md">
              <BotText bot={bot} text={text} />
            </div>
          </div>
          {time}
        </div>
      ) : null}
      <FileCards bot={bot} files={files} />
    </>
  )
}
