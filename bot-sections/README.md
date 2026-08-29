# Bot Sections for Hermes Desktop

> Part of [**Hermes Bot Kit**](../README.md) — the kit root `install.sh`
> installs this plugin with the other desktop plugins. Everything below also
> works as a manual copy.

User-defined **sections** in the Bot Mode roster (the Grok-Bot pattern):
named group headers with bots listed under them, plus an automatic
**Unassigned** section at the bottom for anything you have not mapped.

```
Bots
  Apollo          8
    pricing
    pooly
    …
  OMH             3
    galen
    health
    sentinel
  HQ              7
    jarvis
    alfred
    …
  Unassigned      n
    (everyone else)
```

Sessions, group-chat rooms, and the app's own gateway / group-chat / Hidden
headings are left alone. Our sections nest **inside** the flat bot list (and
inside each gateway bucket, independently, when the roster is split per
machine).

## Install

Covered by the kit installer:

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh | bash
```

Skip just this plugin: `KIT_SKIP_SECTIONS=1` in front of that command.

Manual copy (equivalent):

```
mkdir -p ~/.hermes/desktop-plugins/bot-sections
cp plugin.js ~/.hermes/desktop-plugins/bot-sections/plugin.js
```

The folder must be named `bot-sections` (it must match the plugin id).

Then in Hermes Desktop: **⌘⇧P → Reload plugins** (or restart the app).

## How sections are managed

Since 1.1.0 the headers themselves are interactive:

- **Collapse/expand:** click a section header (persists across restarts).
- **Rename + emoji:** double-click a header, type the new label
  ("🏠 Airbnb Operations"), Enter to save, Escape to cancel. Renames are
  display-only — config keys and palette commands keep the original id.

The rest:

Three layers, first match wins:

1. **Palette cycle** — `⌘⇧P → Bot Sections: cycle <bot>`. One command per
   bot in the config block (and any extra keys you have persisted). Each run
   advances that bot along `Apollo → OMH → HQ → Unassigned → Apollo → …`
   and stores the choice in plugin storage (`sectionOverrides`). The command
   detail shows the current section.
2. **Config block** at the top of `plugin.js` (`SECTIONS.order` +
   `SECTIONS.bots`). Keys are bot handles / profile names, lowercase. Edit
   the file and reload plugins to change the default map or the section
   names/order.
3. **Unassigned** — any roster bot that is in neither overrides nor the
   config block lands under **Unassigned** at the bottom, automatically.

Master switch: **⌘⇧P → Bot Sections: toggle** (persists). Off = stock
roster.

## Honest limits

- **No native right-click.** The bot row's context menu is owned by
  hermes-bots; this plugin does not patch it. Assign a bot to a section with
  the cycle command or by editing `SECTIONS`.
- **The app's "+" creates bots (and group chats), not sections.** Section
  names live in `SECTIONS.order`. Add a name there, map bots to it, reload.
- **Overlay, not a data model.** Section membership is CSS `order` + plugin
  headers on the live roster DOM. It is not stored on the bot profile, and
  it does not survive a selector miss (the roster just looks stock).
- **Upstream PR candidate.** hermes-bots already has native *gateway* /
  *group chat* / *Hidden* section headings (`roster-sections.tsx`). A first-class
  user-defined section field on the bot — with a right-click "Move to
  section…" — would replace this plugin. Until that exists, this is the
  disk-plugin version of the same idea.

## Compatibility

Same platform rules as Bubble Mode: Hermes Desktop ≥ 0.20.5, single-file
ESM, `@hermes/plugin-sdk` only, no core patches, fails safe. Selector
research and the header-technique decision:
[docs/BUILD-NOTES.md](docs/BUILD-NOTES.md).
