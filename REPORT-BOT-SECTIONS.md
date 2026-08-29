# REPORT — bot-sections 1.0.0

Branch: `bot-sections` (cut from `master`). Not pushed. `~/.hermes/` was not touched.

**Not verified in the Hermes Desktop app.** This report is source-derived plus `node --check`. Live roster behavior is for the reviewer.

## What was built

Fourth kit plugin, desktop disk plugin, single ESM file, `@hermes/plugin-sdk` only.

- `bot-sections/plugin.js` — id `bot-sections`. Body class + injected CSS. MutationObserver + `host.paneVisibility('hermes-bots:pane')`. Annotates bot rows with `data-bot-section` and `style.order`. Appends plugin-owned section headers at the **end** of each bot-row list (`parentNode` guard); visual position via CSS `order`. `SECTIONS` config block + `ctx.storage` `sectionOverrides` (promise-or-value, same as bubble-mode `readEnabled`). Palette: `Bot Sections: toggle`; one `Bot Sections: cycle <bot>` per config/override key. Unassigned is automatic at the bottom.
- `bot-sections/README.md`, `CHANGELOG.md` (1.0.0), `docs/BUILD-NOTES.md`
- Root `install.sh` loop + `KIT_SKIP_SECTIONS=1` + sanity marker `hermes-bot-sections-style`
- Root `README.md` (plugins badge 3→4, table row, layout line), `CHANGELOG.md` (dated), `AGENTS.md` (install/verify/uninstall)

## Selector evidence (markup keyed on)

Read-only source: `~/.hermes/hermes-agent/apps/desktop/src/plugins/hermes-bots/`.

**Pane scope** — hardcoded Bots header (`roster-pane.tsx`). Pane content layers have no `data-pane-id`; hidden layers use `data-pane-hidden`.

```tsx
<div className="flex h-full flex-col">
  <div className="flex items-center justify-between gap-2 px-2.5 pt-2.5 pb-1.5">
    <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)">
      Bots
    </span>
```

**List** — CSS Grid, not flex (`roster-pane.tsx`):

```tsx
<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
  <div className="grid w-full min-w-0 gap-0.5 px-1.5 pb-2">
    {showGatewaySections
      ? [
          sortedGroupRows.length ? renderGroupChatSection() : null,
          ...gatewaySections.sections.map(renderGatewaySection)
        ].filter(Boolean)
      : rosterRows.map(row => (row.kind === 'group' ? renderGroupRow(row) : renderBotRow(row.bot)))}
```

Per-gateway bucket inner list:

```tsx
<div className="grid min-w-0 gap-0.5">{section.rows.map(row => renderBotRow(row.bot, `${section.id}:`))}</div>
```

**Bot row** — `RowButton` (`data-slot="row-button"`) + Radix `ContextMenuTrigger asChild` (`data-hermes-context-menu-trigger`). Identity is `aria-label` (`bot-row.tsx`):

```tsx
const rowTooltip = [displayName(bot, meta), `@${handle}`, gatewayLabel, sourceStatus.label]
  .filter(Boolean)
  .join(' · ')

const row = (
  <RowButton
    aria-label={rowTooltip}
    className={cn(
      'flex w-full min-w-0 max-w-full items-center gap-2.5 overflow-hidden rounded-md px-2 py-2 text-left transition-colors',
      …
    )}
```

Expected live string: `Pricing · @pricing · This device · Available`.

Handle matcher: `/·\s*@[A-Za-z0-9]/`. Group rows use `"${group}, ${n} bots, …"` — no `· @handle`. Native `RosterSectionHeader` is a `RowButton` without the context-menu trigger.

**Native header look** (`roster-sections.tsx` `RosterSectionHeader`):

```tsx
className="mt-1 flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[0.6875rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary) transition-colors hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)"
```

Plugin headers copy that type ramp / padding / `--ui-text-quaternary` / tabular-nums count. CSS caret stands in for `DisclosureCaret`.

**Hidden wrapper** (pinned to `order: 10000` so it stays last when the unsectioned list becomes a flex column):

```tsx
<div className="mt-1 border-t border-(--ui-stroke-tertiary) pt-1" key={'hidden-section'}>
```

## Header technique

**Chosen: plugin-owned nodes, appended at the end of each bot-row parent, positioned with `order = sectionBase - 1`.** Re-append only when `header.parentNode !== list`. Empty sections `hidden`.

Why not insert in the middle / wrap React rows: computer-viewer's `removeChild` crash was React commit vs a node that was not where the fiber expected. Trailing extra siblings are not used as `insertBefore` refs on incremental updates.

Why not `::before` as primary: the row button is a horizontal flex container; `::before` becomes a flex item (or needs absolute + margin hacks) and cannot carry a live count as cleanly. Fallback if live re-render storms: `::before` on a lead-row class — documented in `bot-sections/docs/BUILD-NOTES.md`.

## `node --check`

```
$ node --check bot-sections/plugin.js
$ printf 'exit:%s\n' "$?"
exit:0
```

Node `v22.22.3`. No stdout/stderr from `--check` (parse-only success). Sanity marker `hermes-bot-sections-style` is present (install.sh `check_js`).

## Spec vs reality

| Spec | Reality |
|---|---|
| Roster parent may need `display:flex; flex-direction:column` so `order` works | Parent is Tailwind `grid` (`grid w-full min-w-0 gap-0.5 px-1.5 pb-2`). `order` already applies to grid items. We still force flex-column on annotated lists as specified. |
| Rows render handles as text | Handle is **always** in `aria-label`; visible text only when `showHandle` (duplicate display names on one connection). Plugin keys on `aria-label`. |
| Pane roster via `hermes-bots:pane` | Pane **content** has no `data-pane-id`. Gate = `paneVisibility('hermes-bots:pane')` + hardcoded `Bots` header + skip `[data-pane-hidden]`. |
| Keys match handles/profile names | Primary profile handle is `hermes`, not `default` (`botHandle` in `data.ts`). Plugin also tries `default` when handle is `hermes`. |

No contradiction that blocked the build; the four deltas above are implemented against the live source.

## Open risks (unverified in-app)

1. **Plugin-owned extra children** in a React-managed list — theoretically the computer-viewer class of bug if React ever `replaceChildren`s the grid. Not observed here; no live app run. Fallback is documented.
2. **Bots header is English-hardcoded.** If hermes-bots i18n's that span, `findBotsPaneRoots` misses and the plugin no-ops (fail safe).
3. **`aria-label` shape.** If `rowTooltip` stops using ` · @handle`, bot rows are not recognized (fail safe).
4. **Unsectioned mixed list:** group rows keep default `order: 0`, so they collect at the top of the flex column instead of interleaving with bots by recency. Gateway-sectioned UI already puts Group chats first, so this matches that layout.
5. **ContextMenu `asChild`.** Assumed the grid item is the `<button>`. If a wrapper appears, each wrapper becomes a one-row "list" (ugly, should not crash).
6. **Forcing `display:flex` on a `grid` container** could fight a future `grid-template` on that node. Current class list is one-column `grid` + `gap-0.5` only.
7. Palette grows by one command per mapped bot (~18). Same as spec.
8. Dual-gateway: sections repeat **inside each bucket**. By spec.

## Not done (needs the human)

Reload plugins in Hermes Desktop (or restart the app). Confirm the Bots roster shows Apollo / OMH / HQ / Unassigned, gateway headings still work, Sessions is untouched, toggle off restores stock, cycle persists. This agent did not install into `~/.hermes/` and did not launch the app.
