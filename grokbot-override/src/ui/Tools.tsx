// Tool activity with full detail (PARITY C13): finished tools fold into
// "N tools"; each one opens to its arguments, result, inline diff and any
// image it produced (read from the bot's own backend, C15). Mirrors the app's
// tool row (components/assistant-ui/tool/fallback.tsx: Arguments / Result
// trace, FileDiffPanel, MarkdownImage), in the override's own look.

import * as React from 'react'

import { diffLines, hasDetail } from '../core/tools.js'
import { IconChevron } from './icons'
import { OwnerMedia } from './Media'
import { mediaKind, mediaName } from '../core/media.js'

const PREVIEW_CHARS = 4_000

function LongText({ text, label }: { text: string; label: string }) {
  const [all, setAll] = React.useState(false)
  const long = text.length > PREVIEW_CHARS
  return (
    <div className="gbo-tool-block">
      <div className="gbo-tool-block-label">{label}</div>
      <pre>{all || !long ? text : `${text.slice(0, PREVIEW_CHARS)}…`}</pre>
      {long ? (
        <button type="button" className="gbo-link-btn" onClick={() => setAll(v => !v)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  )
}

function Diff({ diff }: { diff: string }) {
  return (
    <div className="gbo-tool-block">
      <div className="gbo-tool-block-label">Changes</div>
      <pre className="gbo-diff">
        {diffLines(diff).map((line, i) => (
          <span key={i} className={`is-${line.kind}`}>
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  )
}

function ToolRow({ tool, bot }: { tool: any; bot: any }) {
  const mark = <span className="gbo-tool-mark">{tool.status === 'error' ? '!' : '✓'}</span>
  const dur = Number(tool.duration) >= 1 ? <span className="gbo-tool-dur">{Math.round(tool.duration)}s</span> : null
  if (!hasDetail(tool)) {
    return (
      <li className={`is-${tool.status}`}>
        {mark}
        <span className="gbo-tool-label" title={tool.summary || tool.label}>
          {tool.label}
        </span>
        {dur}
      </li>
    )
  }
  return (
    <li className={`is-${tool.status} has-detail`}>
      <details className="gbo-tool-detail">
        <summary>
          {mark}
          <span className="gbo-tool-label" title={tool.summary || tool.label}>
            {tool.label}
          </span>
          {dur}
        </summary>
        {tool.summary ? <div className="gbo-card-desc">{tool.summary}</div> : null}
        {tool.diff ? <Diff diff={tool.diff} /> : null}
        {tool.image ? (
          <div className="gbo-media">
            <OwnerMedia bot={bot} item={{ path: tool.image, kind: mediaKind(tool.image), name: mediaName(tool.image) }} />
          </div>
        ) : null}
        {tool.args ? <LongText label="Arguments" text={tool.args} /> : null}
        {tool.result ? <LongText label="Result" text={tool.result} /> : null}
      </details>
    </li>
  )
}

export function ToolGroup({ item, bot }: { item: any; bot: any }) {
  const running = item.tools.filter((tool: any) => tool.status === 'running')
  const done = item.tools.length - running.length
  const secs = item.tools.reduce((sum: number, tool: any) => sum + (Number(tool.duration) || 0), 0)
  return (
    <div className="gbo-tools-wrap">
      {done > 0 ? (
        <details className="gbo-tools">
          <summary>
            <IconChevron />
            {done === 1 ? '1 tool' : `${done} tools`}
            {secs >= 1 ? ` · ${Math.round(secs)}s` : ''}
          </summary>
          <ul>
            {item.tools
              .filter((tool: any) => tool.status !== 'running')
              .map((tool: any) => (
                <ToolRow key={tool.id} tool={tool} bot={bot} />
              ))}
          </ul>
        </details>
      ) : null}
      {running.map((tool: any) => (
        <div key={tool.id} className="gbo-activity">
          <span className="gbo-shimmer">{tool.label}…</span>
        </div>
      ))}
    </div>
  )
}
