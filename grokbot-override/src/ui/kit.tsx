// Dialog and menu primitives for the roster-side parity surfaces.
//
// Runtime plugins may import only react and the SDK (no react-dom, so no
// portals of our own). The SDK's Radix-based Dialog / ContextMenu /
// DropdownMenu give focus traps, portals and positioning; the override puts
// its own Rakazo-styled body inside (stylesRoster.ts) and marks it
// [data-gbo-root] so the --gbo-* tokens apply outside its panes. Every SDK
// member is feature-detected through the namespace (a missing one is just
// undefined): without them the dialog renders in place as a fixed overlay
// and menus open inline under their button.

import * as React from 'react'

import { IconX } from './icons'
import { IconCheck, IconMore } from './iconsRoster'
import { sdk } from './sdk'

const S: any = sdk

export type MenuEntry =
  | 'sep'
  | { heading: string }
  | {
      label: string
      onSelect?: () => void
      disabled?: boolean
      destructive?: boolean
      checked?: boolean
      icon?: React.ReactNode
      meta?: string
      sub?: MenuEntry[]
    }

const isFn = (v: unknown) => typeof v === 'function' || (Boolean(v) && typeof v === 'object')

export function sdkHasMenus() {
  return isFn(S.ContextMenu) && isFn(S.ContextMenuTrigger) && isFn(S.ContextMenuContent) && isFn(S.ContextMenuItem)
}

export function sdkHasDropdown() {
  return isFn(S.DropdownMenu) && isFn(S.DropdownMenuTrigger) && isFn(S.DropdownMenuContent) && isFn(S.DropdownMenuItem)
}

export function sdkHasDialog() {
  return isFn(S.Dialog) && isFn(S.DialogContent)
}

// ── dialog ───────────────────────────────────────────────────────────────

export function Dialog({
  open,
  onClose,
  title,
  description,
  wide = false,
  busy = false,
  footer,
  children,
  label
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  description?: React.ReactNode
  wide?: boolean
  busy?: boolean
  footer?: React.ReactNode
  children?: React.ReactNode
  label?: string
}) {
  if (!open) return null
  const body = (
    <div data-gbo-root="" className={`gbo-dialog-body${wide ? ' is-wide' : ''}`} aria-label={label}>
      {isFn(S.DialogTitle) ? <S.DialogTitle className="gbo-dialog-title">{title}</S.DialogTitle> : <h2 className="gbo-dialog-title">{title}</h2>}
      {description ? (
        isFn(S.DialogDescription) ? (
          <S.DialogDescription className="gbo-dialog-desc">{description}</S.DialogDescription>
        ) : (
          <p className="gbo-dialog-desc">{description}</p>
        )
      ) : null}
      {children}
      {footer ? <div className="gbo-dialog-foot">{footer}</div> : <div style={{ height: 18 }} />}
    </div>
  )
  if (sdkHasDialog()) {
    return (
      <S.Dialog open onOpenChange={(value: boolean) => !value && !busy && onClose()}>
        <S.DialogContent className={wide ? 'max-w-3xl' : 'max-w-md'} bodyClassName="p-0 gap-0" showCloseButton={false} aria-describedby={undefined}>
          {body}
        </S.DialogContent>
      </S.Dialog>
    )
  }
  return (
    <div
      className="gbo-modal-fallback"
      role="dialog"
      aria-modal="true"
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) onClose()
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      {body}
    </div>
  )
}

/** A centred card modal (the Slack dialogs): radius 24, a close X top right,
 *  an optional emblem, a centred title and subtitle, the body, then a footer
 *  with a plain text button on the left and a pill on the right. Same SDK
 *  Dialog (focus trap, portal, Escape) as Dialog, with the same in-place
 *  fallback; the SDK content box is made transparent so the card is ours. */
export function Sheet({
  onClose,
  busy = false,
  label,
  emblem,
  title,
  subtitle,
  footer,
  children
}: {
  onClose: () => void
  busy?: boolean
  label?: string
  emblem?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  footer?: React.ReactNode
  children?: React.ReactNode
}) {
  const close = () => {
    if (!busy) onClose()
  }
  const body = (
    <div data-gbo-root="" className="gbo-sheet" aria-label={label}>
      <button type="button" className="gbo-sheet-close" aria-label="Close" title="Close" disabled={busy} onClick={close}>
        <IconX />
      </button>
      {emblem ? <div className="gbo-sheet-emblem">{emblem}</div> : null}
      {isFn(S.DialogTitle) ? <S.DialogTitle className="gbo-sheet-title">{title}</S.DialogTitle> : <h2 className="gbo-sheet-title">{title}</h2>}
      {subtitle ? <div className="gbo-sheet-subtitle">{subtitle}</div> : null}
      {children}
      {footer ? <div className="gbo-sheet-foot">{footer}</div> : null}
    </div>
  )
  if (sdkHasDialog()) {
    const box = 'min(520px, calc(100vw - 32px))'
    return (
      <S.Dialog open onOpenChange={(value: boolean) => !value && close()}>
        <S.DialogContent
          className="max-w-md gbo-sheet-content"
          bodyClassName="p-0 gap-0"
          showCloseButton={false}
          aria-describedby={undefined}
          style={{ width: box, maxWidth: box, padding: 0, border: 0, background: 'transparent', boxShadow: 'none', borderRadius: 24, overflow: 'visible' }}
        >
          {body}
        </S.DialogContent>
      </S.Dialog>
    )
  }
  return (
    <div
      className="gbo-modal-fallback is-sheet"
      role="dialog"
      aria-modal="true"
      onKeyDown={event => {
        if (event.key === 'Escape') close()
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      {body}
    </div>
  )
}

export function Field({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="gbo-field">
      <span>{label}</span>
      {children}
      {hint ? <span className="gbo-field-hint">{hint}</span> : null}
    </label>
  )
}

export function Check({ checked, onChange, children, meta, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; meta?: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className="gbo-check" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span className="gbo-check-text">{children}</span>
      {meta ? <span className="gbo-check-meta">{meta}</span> : null}
    </label>
  )
}

export function Select({ value, onChange, options, label, disabled }: { value: string; onChange: (v: string) => void; options: Array<[string, string]>; label?: string; disabled?: boolean }) {
  return (
    <select className="gbo-select" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      {options.map(([id, text]) => (
        <option key={id} value={id}>
          {text}
        </option>
      ))}
    </select>
  )
}

export function Tabs({ value, onChange, tabs }: { value: string; onChange: (v: string) => void; tabs: Array<[string, string]> }) {
  return (
    <div className="gbo-tabs" role="tablist">
      {tabs.map(([id, text]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  )
}

// ── menus ────────────────────────────────────────────────────────────────

function itemInner(entry: Exclude<MenuEntry, 'sep' | { heading: string }> & { label: string }) {
  return (
    <>
      {entry.icon ?? null}
      <span style={{ flex: 1, minWidth: 0 }}>{entry.label}</span>
      {entry.meta ? <span className="gbo-menu-meta">{entry.meta}</span> : null}
      {entry.checked ? (
        <span className="gbo-menu-check">
          <IconCheck />
        </span>
      ) : null}
    </>
  )
}

function itemClass(entry: any) {
  return `gbo-menu-item${entry.destructive ? ' is-destructive' : ''}`
}

/** Entries for one SDK menu family ('ContextMenu' | 'DropdownMenu'). A
 *  submenu uses the family's Sub parts when the SDK exports them, else it is
 *  flattened under a heading. */
function sdkEntries(family: 'ContextMenu' | 'DropdownMenu', entries: MenuEntry[], prefix = ''): React.ReactNode[] {
  const Item = S[`${family}Item`]
  const Sep = S[`${family}Separator`]
  const Sub = S[`${family}Sub`]
  const SubTrigger = S[`${family}SubTrigger`]
  const SubContent = S[`${family}SubContent`]
  const out: React.ReactNode[] = []
  entries.forEach((entry, i) => {
    const key = `${prefix}${i}`
    if (entry === 'sep') {
      out.push(isFn(Sep) ? <Sep key={key} className="gbo-menu-sep" /> : <div key={key} className="gbo-menu-sep" role="separator" />)
      return
    }
    if ('heading' in entry) {
      out.push(
        <div key={key} className="gbo-menu-label">
          {entry.heading}
        </div>
      )
      return
    }
    if (entry.sub) {
      if (isFn(Sub) && isFn(SubTrigger) && isFn(SubContent)) {
        out.push(
          <Sub key={key}>
            <SubTrigger className="gbo-menu-item">{itemInner(entry)}</SubTrigger>
            <SubContent data-gbo-root="" className="gbo-menu">
              {sdkEntries(family, entry.sub, `${key}.`)}
            </SubContent>
          </Sub>
        )
      } else {
        out.push(
          <div key={key} className="gbo-menu-label">
            {entry.label}
          </div>,
          ...sdkEntries(family, entry.sub, `${key}.`)
        )
      }
      return
    }
    out.push(
      <Item key={key} className={itemClass(entry)} disabled={entry.disabled} data-variant={entry.destructive ? 'destructive' : undefined} onSelect={() => entry.onSelect?.()}>
        {itemInner(entry)}
      </Item>
    )
  })
  return out
}

function InlineEntries({ entries, close }: { entries: MenuEntry[]; close: () => void }) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry === 'sep') return <div key={i} className="gbo-menu-sep" role="separator" />
        if ('heading' in entry) {
          return (
            <div key={i} className="gbo-menu-label">
              {entry.heading}
            </div>
          )
        }
        if (entry.sub) {
          return (
            <React.Fragment key={i}>
              <div className="gbo-menu-label">{entry.label}</div>
              <InlineEntries entries={entry.sub} close={close} />
            </React.Fragment>
          )
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={itemClass(entry)}
            disabled={entry.disabled}
            onClick={() => {
              close()
              entry.onSelect?.()
            }}
          >
            {itemInner(entry)}
          </button>
        )
      })}
    </>
  )
}

/** A button that opens a menu (SDK DropdownMenu, else an inline list). */
export function MenuButton({ entries, label, className = 'gbo-icon-btn', children, align = 'end' }: { entries: MenuEntry[]; label: string; className?: string; children?: React.ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = React.useState(false)
  const trigger = (
    <button type="button" className={className} aria-label={label} title={label} aria-haspopup="menu">
      {children ?? <IconMore />}
    </button>
  )
  if (sdkHasDropdown()) {
    return (
      <S.DropdownMenu>
        <S.DropdownMenuTrigger asChild>{trigger}</S.DropdownMenuTrigger>
        <S.DropdownMenuContent align={align} data-gbo-root="" className="gbo-menu">
          {sdkEntries('DropdownMenu', entries)}
        </S.DropdownMenuContent>
      </S.DropdownMenu>
    )
  }
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      {React.cloneElement(trigger, { onClick: () => setOpen(v => !v), 'aria-expanded': open })}
      {open ? (
        <div data-gbo-root="" className="gbo-menu gbo-floating gbo-inline-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <InlineEntries entries={entries} close={() => setOpen(false)} />
        </div>
      ) : null}
    </span>
  )
}

/** Right-click menu around one element (SDK ContextMenu). Without it the
 *  element renders as is; the row's ⋯ button still offers the same entries. */
export function ContextMenuFor({ entries, children }: { entries: MenuEntry[]; children: React.ReactElement }) {
  if (!sdkHasMenus()) return children
  return (
    <S.ContextMenu>
      <S.ContextMenuTrigger asChild>{children}</S.ContextMenuTrigger>
      <S.ContextMenuContent data-gbo-root="" className="gbo-menu">
        {sdkEntries('ContextMenu', entries)}
      </S.ContextMenuContent>
    </S.ContextMenu>
  )
}

/** A yes/no question asked in the override's own dialog (stock uses the
 *  SDK ConfirmDialog / surfaceModelSwitchConfirm). */
export function Confirm({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  description: React.ReactNode
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => Promise<void> | void
  onClose: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(null)
  return (
    <Dialog
      open={open}
      busy={busy}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <button type="button" className="gbo-btn is-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`gbo-btn ${destructive ? 'is-danger' : 'is-primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await onConfirm()
                onClose()
              } catch (err: any) {
                setError(String(err?.message || err))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {error ? <div className="gbo-form-error">{error}</div> : null}
    </Dialog>
  )
}
