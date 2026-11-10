// A fenced code block in a bot's message (core/fences.js): the bubble's grey
// block in monospace, a Copy pill top-right that copies the block's raw text
// exactly ("Copied" for 1.5 s), shown in full up to CODE_FOLD_LINES lines and
// folded to CODE_FOLDED_LINES behind a "Show more" / "Show less" text button
// beyond that.

import * as React from 'react'

import { codeFolds, CODE_FOLDED_LINES } from '../core/fences.js'
import { copyText } from './MessageActions'

export const COPIED_MS = 1500

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const timer = React.useRef<any>(null)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const folds = codeFolds(code)
  const copy = () => {
    void copyText(code).then(ok => {
      if (!ok) return
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }
  const folded = folds && !open
  return (
    <div className="gbo-code" data-lang={lang || undefined}>
      <button type="button" className="gbo-code-copy" aria-label={copied ? 'Copied' : 'Copy code'} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className={folded ? 'is-folded' : undefined} style={folded ? ({ '--gbo-code-lines': CODE_FOLDED_LINES } as any) : undefined}>
        <code>{code}</code>
      </pre>
      {folds ? (
        <button type="button" className="gbo-code-more" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}
