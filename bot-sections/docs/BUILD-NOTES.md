# Bot Sections — roster selectors & header technique

Research source: `~/.hermes/hermes-agent/apps/desktop/src/plugins/hermes-bots/`
(read-only). Plugin idioms: `hermes-bot-kit/bubble-mode/plugin.js`.

This plugin cannot import hermes-bots module state. Every signal below is
something a disk plugin can observe through `@hermes/plugin-sdk` or the live
DOM.

---

## 1. Scope gate

Same public bit bubble-mode uses for "the user is on the Bots tab":

| Signal | Where |
|---|---|
| `host.paneVisibility('hermes-bots:pane').get() === true` | `bot-state.ts` `$botsPaneVisible`; pane id is `<pluginId>:<localId>` → `hermes-bots:pane`. `host.paneVisibility` is true only while the pane holds its zone's active tab slot. |
| DOM fallback | `[data-tree-tab="hermes-bots:pane"][aria-selected="true"]` (`tree-group.tsx` stamps `data-tree-tab={paneId}`). |

Hidden siblings stay mounted with `data-pane-hidden` (`pane-visibility.ts`
`PANE_HIDDEN_ATTR`). Every DOM read skips `el.closest('[data-pane-hidden]')`.

The pane **content layer has no `data-pane-id`**. We find the roster by the
hardcoded **Bots** header in `roster-pane.tsx` (not i18n):

```tsx
<span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)">
  Bots
</span>
```

Walk up from that span to `div.flex.h-full.flex-col` (the pane root) and
query inside it. If that header is gone after a Hermes update, the plugin
no-ops and the roster renders stock.

Never Sessions (no `data-slot="row-button"` on session rows — they use
`SidebarRowBody`). Never group-chat *rooms* (`BotsPane` returns
`GroupChatWorkspace` instead of the roster; no bot rows → no-op). Group
*rows* in the roster are skipped (see §3).

---

## 2. Roster list container

`roster-pane.tsx` (the scroll body + the list grid):

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

Per-gateway bucket (`renderGatewaySection`) when `rosterGatewaySections`
returns `sectioned: true` (`gatewayFilter === 'all'` and more than one
gateway option):

```tsx
<div className="min-w-0" key={sectionId}>
  <GatewaySectionHeading … />
  {collapsed ? null : (
    <div className="grid min-w-0 gap-0.5">{section.rows.map(row => renderBotRow(row.bot, …))}</div>
  )}
</div>
```

**Reality vs spec:** the row parent is Tailwind `grid`, **not** a flex
column. CSS `order` already applies to grid items; we still force
`display: flex; flex-direction: column` on annotated lists via
`body.hermes-bot-sections [data-hermes-bot-section-list]`, as the spec
asked, so `order` has a flex formatting context. One-column grid +
`gap-0.5` is visually the same as a flex column with the same gap.

When the roster is bucketed, bot rows' **parent** is the inner
`grid min-w-0 gap-0.5`, not the outer list. We group rows by
`parentElement` and apply ordering **inside each bucket independently**.
Native `GatewaySectionHeading` / `RosterSectionHeader` / Hidden stay in
the outer grid and are not reordered.

---

## 3. Bot row identity

`bot-row.tsx` `BotRow` — the click target is a `RowButton`
(`data-slot="row-button"`, `components/ui/row-button.tsx`) wrapped in a
Radix `ContextMenuTrigger asChild`. The trigger stamps
`data-hermes-context-menu-trigger` (survives the child's `data-slot`).
Root does not wrap in an extra DOM node, so the **grid item is the
`<button>`**.

Identity lives on `aria-label` (`rowTooltip`):

```tsx
const rowTooltip = [displayName(bot, meta), `@${handle}`, gatewayLabel, sourceStatus.label]
  .filter(Boolean)
  .join(' · ')
```

Example: `Pricing · @pricing · This device · Available`.

`botHandle` (`data.ts`): profile name, except the primary profile `'default'`
surfaces as `'hermes'`. `displayName` (`labels.ts`) is the title /
`display_name` / Title-Cased profile name.

**Reality vs spec:** the spec said rows render handles as **text**. The
handle is **always** in `aria-label`; it is visible text only when
`showHandle` is true (two bots on the same connection share a display
name). We key on `aria-label` (`/·\s*@[A-Za-z0-9]/`), handle preferred,
display-name fallback (`span.font-medium` then the first ` · ` segment),
both sides lowercased. `@hermes` also tries `default`.

Group rows use the same `RowButton` + context-menu trigger but their
`aria-label` is `"${group}, ${n} bots, ${n} of ${n} available"` — no
`· @handle`. Skipped.

Section headers (`RosterSectionHeader`) are `RowButton` **without** the
context-menu trigger and without `@handle`. Skipped.

---

## 4. Header-technique decision

Spec options:

1. Plugin-owned header elements appended to the roster container, guarded
   with a `parentNode` check (never re-parent React-owned nodes).
2. Fallback: `::before` on the first row of each section.

**Chosen: (1) plugin-owned nodes, appended at the end of each bot-row
list, visual position via CSS `order`.**

Why not re-parent / insert in the middle: computer-viewer's
`removeChild` shell crash was React commitMutationEffects hitting a node
that had been *moved* out of its fiber parent. Inserting extra nodes
*between* React children is the same class of bug (fibers vs DOM child
index). Trailing extra siblings are not used as `insertBefore` refs
during incremental updates.

Why not (2) as the primary: `BotRow`'s button is `display: flex; flex-direction:
row`. A `::before` on that button becomes a flex *item* (shifts the
avatar) unless it is absolutely positioned into a `margin-top` gap —
workable, but it cannot carry a live count that matches
`RosterSectionHeader` (`label` + tabular-nums `count`) as cleanly as a
real node. `RosterSectionHeader` look from `roster-sections.tsx`:

```tsx
className="mt-1 flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[0.6875rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary) …"
```

Plugin headers copy that type ramp / color token / padding / count, with
a CSS caret standing in for `DisclosureCaret` (chevron-right rotated 90°
when open). They are `pointer-events: none` and `aria-hidden` — not
foldable; native gateway collapse still works.

Guards (bubble-mode / computer-viewer style):

- Create once per `(list, section)`; re-append only when
  `header.parentNode !== list`.
- `order = sectionBase - 1`; bots in that section get `sectionBase`
  (Apollo 10 / OMH 20 / HQ 30 / Unassigned 40; hidden wrapper pinned at
  10000). Equal `order` keeps source recency inside a section.
- Empty sections `hidden`.
- Headers whose parent is no longer a live bot-row list are removed.
- Entire apply path is try/catch; selector miss clears annotations.

If live verification shows a re-render storm (headers flashing or a
removeChild overlay), the documented fallback is `::before` on
`[data-bot-section-lead]` with `content: attr(data-bot-section-label)`
and `position: absolute; top: -1.5rem` plus `margin-top` on the lead
row. That annotates only React-owned nodes.

---

## 5. Storage & palette

| Key | Shape | Read |
|---|---|---|
| `enabled` | boolean, default true | Promise-or-value, same as bubble-mode `readEnabled` (`!== false`). |
| `sectionOverrides` | `{ [bot: string]: section }` | Promise-or-value; keys lowercased. Wins over `SECTIONS.bots`. |

Palette ( `PALETTE_AREA` ):

- `Bot Sections: toggle`
- `Bot Sections: cycle <bot>` — one registration per key in `SECTIONS.bots`
  plus any extra override keys; detail is the current section; ladder is
  `SECTIONS.order` + `Unassigned`.
