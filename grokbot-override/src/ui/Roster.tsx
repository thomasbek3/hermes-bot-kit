// The left sidebar: a top row (sidebar toggle, search, +), the search field
// with the roster filters, pinned bots, sections, bot rows (avatar, name,
// preview), the Hidden section, and a footer row. A row click opens the bot's
// Bot Chat in the chat tab; right-click (or ⋯) opens its menu. Markup uses the
// reference layout's class names (sidebar, bot-row, pinned, account; see
// styles-ref.ts); the gbo-* classes are hooks.

import * as React from 'react'

import { botAttentionHint } from '../core/attention.js'
import { buildSections, displayName, handleOf, previewOf, rowKey, sourceUnreachable } from '../core/roster.js'
import { pinState, withoutPinned } from '../core/pins.js'
import { deriveRosterView, unreachableSources } from '../core/rosterView.js'
import { shortAge } from '../core/time.js'
import { app, canToggleSidebar, metaFor, selectBot, toggleSection, toggleSidebar, warmBot } from './app'
import { BotAvatar } from './Avatar'
import { RosterDialogs } from './BotDialogs'
import { IconChevronDown, IconPin, IconPlus, IconSearch, IconSidebar } from './icons'
import { IconEyeOff, IconFilter, IconRefresh, IconWarn } from './iconsRoster'
import { ContextMenuFor, MenuButton } from './kit'
import { attentionFor, retrySources } from './rosterActions'
import { botMenuEntries, filterMenuEntries, newMenuEntries } from './RosterMenus'
import { roster2 } from './rosterStores'
import { useStore } from './store'
import { UnreadDot } from './Unread'
import { OverlayScroll } from './OverlayScroll'
import { RoomsSection } from './Rooms'

function useNow(ms = 30_000) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

function BotRow({ bot, selected, working, livePreview, now, hidden = false }: { bot: any; selected: boolean; working: boolean; livePreview: string; now: number; hidden?: boolean }) {
  const meta = metaFor(bot)
  const name = displayName(bot, meta)
  const { preview, at } = previewOf(bot)
  const dim = sourceUnreachable(bot)
  const line = working ? 'Working…' : livePreview || preview || handleOf(bot)
  const age = at ? shortAge(at, now) : ''
  const attention = attentionFor(bot)
  const entries = botMenuEntries(bot)
  return (
    <div className="gbo-row-wrap">
      <ContextMenuFor entries={entries}>
        <button
          type="button"
          className={`bot-row gbo-row${selected ? ' is-selected' : ''}${dim ? ' is-dim' : ''}${hidden ? ' is-hidden' : ''}`}
          aria-current={selected ? 'true' : undefined}
          title={dim ? `${name} (its connection is not reachable)` : age ? `${name} · ${age}` : name}
          onClick={() => selectBot(bot)}
          onPointerEnter={() => warmBot(bot)}
        >
          {/* The live status dot (unread, working, needs input) is a badge on
              the avatar; the idle / never-run dot is not drawn. */}
          <span className="bot-row__avatar gbo-row-face">
            <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={meta} size={40} working={working} />
            <UnreadDot bot={bot} />
          </span>
          <span className="bot-row__text gbo-row-main">
            <span className="gbo-row-line">
              <span className="bot-row__name gbo-row-name">{name}</span>
              {meta?.pinned ? <IconPin /> : null}
              {hidden ? (
                <span className="gbo-row-flag" title="Hidden from the roster">
                  <IconEyeOff />
                </span>
              ) : null}
              {attention ? (
                <span className="gbo-attn" role="img" aria-label="needs attention" title={botAttentionHint(attention.reason)}>
                  <IconWarn />
                </span>
              ) : null}
            </span>
            <span className={`bot-row__preview gbo-row-preview${working ? ' is-working' : ''}`}>{line}</span>
          </span>
        </button>
      </ContextMenuFor>
      <MenuButton entries={entries} label={`Actions for ${name}`} className="icon-btn gbo-row-more" />
    </div>
  )
}

/** Avatar size for 1, 2, 3 or 4 pins across the sidebar (one pin is the
 *  reference's 60px tile at Hermes's zoom). */
const PIN_AVATAR = [67, 58, 52, 46]

/** A bot pinned to the top: a big round avatar with its name under it. A
 *  click opens its chat exactly as its row does; the row's menu is on
 *  right-click; the unread / working badge sits on the avatar. */
function PinnedBot({ bot, size, selected, working }: { bot: any; size: number; selected: boolean; working: boolean }) {
  const meta = metaFor(bot)
  const name = displayName(bot, meta)
  const dim = sourceUnreachable(bot)
  return (
    <div className="gbo-pin-wrap">
      <ContextMenuFor entries={botMenuEntries(bot)}>
        <button
          type="button"
          className={`pinned__tile gbo-pin${selected ? ' is-selected' : ''}${dim ? ' is-dim' : ''}`}
          aria-current={selected ? 'true' : undefined}
          title={dim ? `${name} (its connection is not reachable)` : name}
          onClick={() => selectBot(bot)}
          onPointerEnter={() => warmBot(bot)}
        >
          <span className="pinned__avatar gbo-row-face gbo-pin-face">
            <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={meta} size={size} working={working} />
            <UnreadDot bot={bot} />
          </span>
          <span className="pinned__label gbo-pin-name">{name}</span>
        </button>
      </ContextMenuFor>
    </div>
  )
}

/** Tell the chat header whether the roster is on screen: a collapsed
 *  sidebar leaves the pane zero wide. Unmounting says nothing (Hermes may
 *  just be showing another sidebar tab). */
function useRosterShown(ref: React.RefObject<HTMLDivElement | null>) {
  React.useEffect(() => {
    app.rosterShown.set(true)
    const el = ref.current
    const RO = (globalThis as any).ResizeObserver
    let observer: any = null
    if (el && typeof RO === 'function') {
      observer = new RO((entries: any[]) => {
        const width = entries[0]?.contentRect?.width ?? el.clientWidth
        app.rosterShown.set(width > 0)
      })
      observer.observe(el)
    }
    return () => observer?.disconnect()
  }, [ref])
}

export function RosterPane() {
  useStore(app.roster)
  const query = useStore(app.query)
  const collapsed = useStore(app.collapsed)
  const selectedKey = useStore(app.selectedKey)
  const chat = useStore(app.chat)
  const filters = useStore(roster2.filters)
  const hiddenExpanded = useStore(roster2.hiddenExpanded)
  const retrying = useStore(roster2.retrying)
  useStore(roster2.metaWrites)
  useStore(roster2.attention)
  const pins = useStore(app.pinnedBots)
  const [searching, setSearching] = React.useState(false)
  const now = useNow()
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  useRosterShown(rootRef)
  const roster = app.roster.get()
  const workingKey = chat && chat.chat?.busy ? rowKey(chat.bot) : ''
  // R14 group rooms are the roster's group rows (R6 Groups only / Bots only).
  const rooms = useStore(app.rooms)
  const groupCount = rooms.loaded && rooms.route ? rooms.rooms.length : 0
  const showGroups = filters.kind !== 'bots'
  const view = deriveRosterView(roster.rows, { metaFor, filters, query, workingKey, keyOf: rowKey, sources: roster.sources, hiddenExpanded, groupCount, now })
  // Pins show on top unless a search or filter narrows the list (then every
  // match is listed in its section as usual); a pinned bot is not listed twice.
  const pinned = view.hasConstraint ? null : pinState(pins, (roster.rows || []).filter((bot: any) => !bot?.ghost), rowKey)
  const listed = pinned ? withoutPinned(view.rows, pinned, rowKey) : view.rows
  const hiddenListed = pinned ? withoutPinned(view.hidden, pinned, rowKey) : view.hidden
  const list = buildSections(listed, { metaFor, kitSections: roster.kitSections, query: '' })
  const unreachable = unreachableSources(view.gatewayOptions)
  const livePreview = (() => {
    if (!chat) return ''
    const items = chat.chat?.items || []
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]
      if ((item.kind === 'assistant' || item.kind === 'user') && item.text) return item.text.replace(/\s+/g, ' ').trim()
    }
    return ''
  })()
  const chatKey = chat ? rowKey(chat.bot) : ''
  const row = (bot: any, hidden = false) => {
    const key = rowKey(bot)
    return (
      <BotRow
        key={`${hidden ? 'hidden:' : ''}${key}`}
        bot={bot}
        now={now}
        hidden={hidden}
        selected={key === selectedKey}
        working={key === workingKey}
        livePreview={key === chatKey ? livePreview : ''}
      />
    )
  }
  // The filters live in the search field (the reference's top row is only
  // toggle, search and +), which stays open while a filter is on.
  const showSearchBox = searching || Boolean(query) || Boolean(view.showFilters && view.activeFilterCount)

  return (
    <div data-gbo-root="" className="sidebar gbo-roster" ref={rootRef}>
      {/* The top row shares the window's traffic-light row: empty space drags
          the window; sidebar toggle, search and + sit at its right end. */}
      <div className="sidebar__titlebar gbo-roster-top">
        <h2 className="gbo-roster-title">Bots</h2>
        <div className="sidebar__controls">
          {canToggleSidebar() ? (
            <button type="button" className="icon-btn icon-btn--plain" title="Hide sidebar (⌘B)" aria-label="Hide sidebar" onClick={() => void toggleSidebar()}>
              <IconSidebar />
            </button>
          ) : null}
          <button
            type="button"
            className={`icon-btn${showSearchBox ? ' is-on' : ''}`}
            title="Search bots"
            aria-label="Search bots"
            aria-expanded={showSearchBox}
            onClick={() => {
              setSearching(v => !v)
              if (showSearchBox) app.query.set('')
            }}
          >
            <IconSearch />
          </button>
          <MenuButton entries={newMenuEntries()} label="New bot or group" className="icon-btn">
            <IconPlus />
          </MenuButton>
        </div>
      </div>
      {showSearchBox ? (
        <div className="gbo-search-row">
          <label className="text-input gbo-search">
            <IconSearch />
            <input
              autoFocus={searching}
              placeholder="Search bots"
              value={query}
              onChange={event => app.query.set(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  app.query.set('')
                  setSearching(false)
                }
              }}
            />
            {/* roster-pane-derivation.ts:219: filters show with >1 gateway, groups, 8+ rows or an active filter. */}
            {view.showFilters ? (
              <span className="gbo-search-filter">
                <MenuButton
                  entries={filterMenuEntries(view, groupCount)}
                  label={view.activeFilterCount ? `Filter roster, ${view.activeFilterCount} active` : 'Filter roster'}
                  className={`icon-btn icon-btn--plain${view.activeFilterCount ? ' has-filters' : ''}`}
                >
                  <IconFilter />
                </MenuButton>
                {view.activeFilterCount ? <span className="gbo-filter-count">{view.activeFilterCount}</span> : null}
              </span>
            ) : null}
          </label>
        </div>
      ) : null}
      {unreachable.length ? (
        <div className="gbo-source-retry" role="status">
          <IconWarn />
          <span>
            {unreachable.length === 1
              ? `${unreachable[0].label || unreachable[0].connectionId} is not reachable`
              : `${unreachable.length} connections are not reachable`}
          </span>
          <button type="button" className="gbo-link-btn" disabled={retrying} onClick={() => void retrySources()}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : null}
      <OverlayScroll wrapClassName="gbo-roster-scroll" className="sidebar__scroll gbo-roster-list" role="list">
        {pinned?.shown.length ? (
          <div className={`pinned gbo-pins is-${pinned.shown.length}`} role="group" aria-label="Pinned bots">
            {pinned.shown.map((bot: any) => {
              const key = rowKey(bot)
              return <PinnedBot key={key} bot={bot} size={PIN_AVATAR[pinned.shown.length - 1]} selected={key === selectedKey} working={key === workingKey} />
            })}
          </div>
        ) : null}
        {roster.rows.length === 0 ? (
          <div className="gbo-roster-empty">
            {roster.origin === 'none' && !roster.error ? (
              'Loading bots…'
            ) : roster.error ? (
              <div className="gbo-empty-card">
                <span>Could not load bots: {roster.error}</span>
                <button type="button" className="gbo-btn is-small" disabled={retrying} onClick={() => void retrySources()}>
                  <IconRefresh />
                  {retrying ? 'Retrying…' : 'Retry now'}
                </button>
              </div>
            ) : (
              'No bots yet.'
            )}
          </div>
        ) : view.allHidden && !hiddenExpanded ? (
          <div className="gbo-empty-card">
            <strong>All bots are hidden</strong>
            <span>Hidden bots keep working; they are just not listed.</span>
            <button type="button" className="gbo-btn is-small" onClick={() => roster2.hiddenExpanded.set(true)}>
              Show hidden
            </button>
          </div>
        ) : list.length === 0 && hiddenListed.length === 0 && !pinned?.shown.length ? (
          filters.kind === 'groups' ? null : <div className="gbo-roster-empty" role="status">
            {query ? `No bot matches “${query}”.` : 'No bot matches these filters.'}
          </div>
        ) : (
          <>
            {list.map(section => {
              const isCollapsed = collapsed.includes(section.name)
              return (
                <div key={section.name} role="group" aria-label={section.name} className="bot-list">
                  {list.length > 1 || section.name !== 'Unassigned' ? (
                    <button type="button" className="gbo-section-head" aria-expanded={!isCollapsed} onClick={() => toggleSection(section.name)}>
                      <IconChevronDown />
                      {section.name}
                      <span className="gbo-count">{section.bots.length}</span>
                    </button>
                  ) : null}
                  {isCollapsed ? null : section.bots.map((bot: any) => row(bot))}
                </div>
              )
            })}
            {view.showHiddenSection ? (
              <div role="group" aria-label="Hidden" className="bot-list gbo-hidden-head">
                <button
                  type="button"
                  className="gbo-section-head"
                  aria-expanded={view.showHiddenRows}
                  disabled={view.hasConstraint}
                  onClick={() => roster2.hiddenExpanded.set(!hiddenExpanded)}
                >
                  <IconChevronDown />
                  Hidden
                  <span className="gbo-count">{view.hasConstraint ? view.hidden.length : view.hiddenCount}</span>
                </button>
                {view.showHiddenRows ? (hiddenListed.length ? hiddenListed.map((bot: any) => row(bot, true)) : <div className="gbo-roster-empty">No hidden bot matches.</div>) : null}
              </div>
            ) : null}
          </>
        )}
        {showGroups ? <RoomsSection query={query} /> : null}
      </OverlayScroll>
      <div className="sidebar__footer gbo-roster-foot">
        <div className="sidebar__fade" />
        <div className="account">
          <span className="account__btn">
            <span className="account__initials gbo-user-dot" aria-hidden="true">You</span>
            <span className="account__name gbo-user-name">{roster.rows.length ? `${roster.rows.length} bots` : 'Bots'}</span>
          </span>
        </div>
      </div>
      <RosterDialogs />
    </div>
  )
}
