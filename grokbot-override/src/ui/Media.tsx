// Owner-safe rich messages (PARITY C15): the text goes through the SDK's own
// renderer in its inert mode (sdk.ts Markdown), and the media it names are
// drawn here from the bot's OWN backend (app.ts readBotMedia, core/media.js):
// images inline, audio and video players, other files as a card under the
// bubble (FileCard: a tile by type, name, size, a download button; a click
// opens the file viewer, ui/FileViewer.tsx). An http(s) image the text links is NOT fetched on its own (a
// message could name any host and carry data in the URL): it shows as
// "Image from <host> · Load" and loads only when the user clicks it.

import * as React from 'react'

import { splitFences } from '../core/fences.js'
import { dataUrlBytes, extractMedia, fileIconKind, formatBytes, middleTruncate, remoteImageHost } from '../core/media.js'
import { rowKey } from '../core/roster.js'
import { readBotMedia } from './app'
import { CodeBlock } from './CodeBlock'
import { FileTile } from './FileIcons'
import { FileViewer, type ViewerFile } from './FileViewer'
import { IconDownload } from './icons'
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

/** Widest an inline image is drawn (CSS px; .gbo-media-image max-width). */
export const MEDIA_IMAGE_MAX_PX = 360
const READY_MAX = 60

type ReadyMedia = { src: string; width?: number; height?: number }

/** Media already read and decoded, by bot route and path: a remount (a bot
 *  switch, a refresh) draws the image at once in its final box. Holds the
 *  same data URL strings app.ts readBotMedia caches (no extra copies). */
const readyMedia = new Map<string, ReadyMedia>()

function rememberMedia(key: string, value: ReadyMedia) {
  readyMedia.delete(key)
  readyMedia.set(key, value)
  while (readyMedia.size > READY_MAX) readyMedia.delete(readyMedia.keys().next().value as string)
}

/** The box an image of natural size w x h is drawn in, clamped to 360 wide. */
export function mediaBox(width?: number, height?: number): { width: number; height: number } | null {
  if (!(Number(width) > 0) || !(Number(height) > 0)) return null
  const w = Math.min(Number(width), MEDIA_IMAGE_MAX_PX)
  return { width: Math.round(w), height: Math.round((w * Number(height)) / Number(width)) }
}

/** Decode an image before it is shown and read its natural size; resolves
 *  without a size where decoding is unavailable or fails (never rejects,
 *  and gives up waiting after 1.5 s). */
function decodeSize(src: string): Promise<{ width?: number; height?: number }> {
  const Img = (globalThis as any).window?.Image ?? (globalThis as any).Image
  if (typeof Img !== 'function') return Promise.resolve({})
  let img: any
  try {
    img = new Img()
  } catch {
    return Promise.resolve({})
  }
  if (typeof img.decode !== 'function') return Promise.resolve({})
  img.src = src
  const read = () => (img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : {})
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({}), 1500)
    img.decode().then(
      () => {
        clearTimeout(timer)
        resolve(read())
      },
      () => {
        clearTimeout(timer)
        resolve({})
      }
    )
  })
}

export function OwnerMedia({ bot, item }: { bot: any; item: { path: string; kind: string; name: string; remote?: boolean } }) {
  // Keyed by the bot's route, not the roster's row object (a fresh one
  // arrives every refresh): a refresh never re-reads or blanks the media.
  const route = rowKey(bot)
  const cacheKey = `${route}|${item.path}`
  const cached = !item.remote ? readyMedia.get(cacheKey) : undefined
  const [ready, setReady] = React.useState<ReadyMedia | null>(cached || null)
  const [error, setError] = React.useState('')
  const botRef = React.useRef(bot)
  botRef.current = bot
  const wantsRead = !item.remote && item.kind !== 'file'
  React.useEffect(() => {
    if (!wantsRead) return undefined
    const hit = readyMedia.get(cacheKey)
    if (hit) {
      setReady(current => (current?.src === hit.src ? current : hit))
      return undefined
    }
    let live = true
    readBotMedia(botRef.current, item.path)
      .then(async url => {
        // An image is decoded first, so it appears in its final box at once.
        const size = item.kind === 'image' && url ? await decodeSize(url) : {}
        if (!live) return
        const value = { src: url, ...size }
        if (url) rememberMedia(cacheKey, value)
        setReady(value)
      })
      .catch(err => {
        if (live) setError(String(err?.message || err))
      })
    return () => {
      live = false
    }
  }, [cacheKey, item.path, item.kind, wantsRead])
  const src = ready?.src || ''

  if (item.kind === 'image' && item.remote && !src) {
    const host = remoteImageHost(item.path)
    return (
      <button type="button" className="gbo-media-remote" title={item.path} onClick={() => setReady({ src: item.path })}>
        <span className="gbo-media-remote-host">Image from {host}</span>
        <span aria-hidden="true"> · </span>
        <span className="gbo-media-remote-load">Load</span>
      </button>
    )
  }
  if (item.kind === 'image') {
    if (error) return <span className="gbo-media-file is-error" title={error}>{item.name}: not available</span>
    const box = mediaBox(ready?.width, ready?.height)
    return src ? (
      <a className="gbo-media-image" href={src} target="_blank" rel="noopener noreferrer" title={item.name}>
        <img
          alt={item.name}
          src={src}
          loading="lazy"
          {...(box ? { width: box.width, height: box.height, style: { aspectRatio: `${box.width} / ${box.height}` } } : {})}
        />
      </a>
    ) : (
      <span className="gbo-media-image is-loading" aria-label={`Loading ${item.name}`} />
    )
  }
  if (item.kind === 'audio' || item.kind === 'video') {
    if (src) {
      return item.kind === 'audio' ? (
        <audio className="gbo-media-audio" controls src={src} preload="metadata" />
      ) : (
        <video className="gbo-media-video" controls src={src} preload="metadata" />
      )
    }
    // Loading: a quiet box the player's size, not a file card that then
    // turns into a player. A file the bot's machine cannot read is a card.
    if (!error) return <span className={`gbo-media-${item.kind} is-loading`} role="img" aria-label={`Loading ${item.name}`} />
  }
  return <FileCard bot={bot} item={item} />
}

type FileState = { status: 'idle' | 'loading' | 'ready' | 'error'; size?: number; error?: string }

/** A file the bot sent, as its own card under the bubble: a tile by type
 *  (a green sheet for spreadsheets, PDF, image, document; ui/FileIcons.tsx),
 *  the name cut in the middle (full name in the title), the size under it
 *  ("Not available" when the bot's machine cannot read it), and a round
 *  download button. The file is read from the bot's own backend only when
 *  the card is first pointed at or focused (never while the transcript
 *  renders). Clicking the card opens the file viewer (ui/FileViewer.tsx);
 *  closing it puts focus back on the card. */
export function FileCard({ bot, item }: { bot: any; item: { path: string; name: string } }) {
  const [state, setState] = React.useState<FileState>({ status: 'idle' })
  const [viewer, setViewer] = React.useState<null | ViewerFile>(null)
  const live = React.useRef(true)
  const main = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
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
    setViewer({ url: null })
    void readBotMedia(bot, item.path).then(
      url => {
        if (!live.current) return
        if (!url) {
          setViewer(current => (current ? { url: null, error: `Could not read ${item.name}` } : current))
          return
        }
        setState({ status: 'ready', size: dataUrlBytes(url) ?? undefined })
        setViewer(current => (current ? { url } : current))
      },
      err => {
        if (!live.current) return
        const error = String(err?.message || err)
        setState({ status: 'error', error })
        setViewer(current => (current ? { url: null, error } : current))
      }
    )
  }
  const close = () => {
    setViewer(null)
    // Radix restores focus to the trigger too; this covers the in-place
    // fallback and a click that did not focus the button.
    setTimeout(() => main.current?.focus(), 0)
  }
  const missing = state.status === 'error'
  const meta = missing ? 'Not available' : state.size !== undefined ? formatBytes(state.size) : ''
  const icon = fileIconKind(item.name)
  return (
    <>
      <div
        className={`gbo-file-card${missing ? ' is-error' : ''}`}
        data-path={item.path}
        onMouseEnter={peek}
        onFocus={peek}
      >
        <button
          ref={main}
          type="button"
          className="gbo-file-card-main"
          title={missing ? `${item.name}: ${state.error || 'not available'}` : item.name}
          aria-label={missing ? `${item.name}, not available` : `Open ${item.name}`}
          aria-disabled={missing || undefined}
          aria-haspopup="dialog"
          onClick={open}
        >
          <span className={`gbo-file-card-icon is-${icon}`}>
            <FileTile kind={icon} />
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
      {viewer ? <FileViewer name={item.name} file={viewer} onSave={save} onClose={close} /> : null}
    </>
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

/** React.memo where the host's React has it (it always does in the app; a
 *  bare stub that loads plugin.js for its registrations may not). Called at
 *  module load, so it must never throw. */
function memo<P>(component: React.FunctionComponent<P>, equal?: (a: P, b: P) => boolean): React.FunctionComponent<P> {
  return typeof (React as any).memo === 'function' ? ((React as any).memo(component, equal) as any) : component
}

/** The SDK renderer, re-rendered only when its text changes. */
const MemoMarkdown = memo(Markdown)

/** Same bot for rendering: the same route (the roster hands out a fresh row
 *  object on every refresh). */
const sameBot = (a: any, b: any) => a === b || rowKey(a) === rowKey(b)

/** A finished assistant message: inert markdown + owner-read media, with
 *  its fenced code blocks drawn by the override (Copy, no clipped box). */
export const BotText = memo(
  function BotText({ bot, text }: { bot: any; text: string }) {
    const { text: clean, media } = React.useMemo(() => extractMedia(text), [text])
    const parts = React.useMemo(() => (clean ? splitFences(clean) : []), [clean])
    return (
      <>
        {parts.map((part: any, index: number) =>
          part.kind === 'code' ? <CodeBlock key={index} code={part.code} lang={part.lang} /> : <MemoMarkdown key={index} text={part.text} />
        )}
        <MediaStrip bot={bot} media={media} />
      </>
    )
  },
  (a: { bot: any; text: string }, b: { bot: any; text: string }) => a.text === b.text && sameBot(a.bot, b.bot)
)

/** Two React nodes that draw the same: equal, or elements of one type and
 *  key whose props are equal primitives (the bubble's time span is a new
 *  element on every render of its message). */
function sameNode(a: any, b: any): boolean {
  if (a === b) return true
  if (!React.isValidElement(a) || !React.isValidElement(b)) return false
  if (a.type !== b.type || a.key !== b.key) return false
  const pa = (a.props || {}) as Record<string, unknown>
  const pb = (b.props || {}) as Record<string, unknown>
  const keys = Object.keys(pa)
  if (keys.length !== Object.keys(pb).length) return false
  return keys.every(key => {
    const x = pa[key]
    const y = pb[key]
    return x === y || ((typeof x !== 'object' || x === null) && (typeof y !== 'object' || y === null) && Object.is(x, y)) || (key === 'children' && sameNode(x, y))
  })
}

/** A bot message's prose as its bubble, with the files it sends as cards
 *  under the bubble (not inside it). A message that is only a file skips the
 *  empty bubble. A streaming reply uses this same markup (Chat.tsx
 *  AssistantBody), so finishing it never reflows the bubble. */
type BotProseProps = {
  bot: any
  text: string
  pos: string
  time?: React.ReactNode
  /** Still streaming: the same markup, plus the bubble's live caret. */
  streaming?: boolean
}

/** Memoized on what it draws (text, corners, time, streaming, the bot's
 *  route), so a stream delta in the newest reply never re-renders the
 *  finished messages above it (React.memo below). */
function BotProseView({ bot, text, pos, time, streaming = false }: BotProseProps) {
  const { text: clean, media } = React.useMemo(() => extractMedia(text), [text])
  const files = media.filter(item => item.kind === 'file')
  const bubble = Boolean(clean) || media.length > files.length
  return (
    <>
      {bubble ? (
        <div className="bubble-wrap is-left">
          <div className={`bubble is-agent${pos}${streaming ? ' is-streaming' : ''}`}>
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

export const BotProse = memo(
  BotProseView,
  (a: BotProseProps, b: BotProseProps) =>
    a.text === b.text && a.pos === b.pos && Boolean(a.streaming) === Boolean(b.streaming) && sameBot(a.bot, b.bot) && sameNode(a.time, b.time)
)
