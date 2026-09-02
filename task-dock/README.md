# Task Dock for Hermes Desktop

> Part of [**Hermes Bot Kit**](../README.md) — the kit root `install.sh`
> installs this plugin with the other desktop plugins. Everything below also
> works as a manual copy.

The app's **Tasks N/M** widget above the composer is live-only. Streaming
todo events fill it. Switching to another bot unmounts the view. The app
then clears that session's list. Come back and the widget is gone. There
is no reload, no setting, and no command that rebuilds it.

Task Dock copies the widget while it is on screen and pins its own panel
above the composer in Bot Chats. Switch bots and the dock swaps to that bot's
last copy once both the bot profile and canonical session ID agree. During
the brief period where Hermes has updated only one of those owners, the dock
stays hidden rather than showing another session's tasks. When the live widget
is missing, the copy renders faded with a last-updated timestamp. Snapshots
older than 24 hours are ignored and pruned.

The app widget is never moved or clicked through this plugin. Once captured,
all stock task sections are hidden while the plugin is loaded so only the
newest list renders in one dock. If the list is terminal (counts complete or
every visible item is completed/cancelled), the dock auto-hides.

## Install

Covered by the kit installer:

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh | bash
```

Skip just this plugin: `KIT_SKIP_TASK_DOCK=1` in front of that command.

Manual copy (equivalent):

```
mkdir -p ~/.hermes/desktop-plugins/task-dock
cp plugin.js ~/.hermes/desktop-plugins/task-dock/plugin.js
```

The folder must be named `task-dock` (it must match the plugin id).

Then in Hermes Desktop: **⌘K → Reload plugins** (or restart the app).

Palette: **⌘K → Task Dock: toggle** (persists). Off = no Tasks UI at all;
the plugin keeps suppressing stock task bars so they cannot flash back in.
Toggle it on to restore the current single dock. The × button on the dock is
the same persistent “off” action. Disabling Task Dock itself in Hermes'
Plugins settings unloads it completely and restores stock Hermes behavior.

Click the dock header to collapse or expand it (persists).

## How it sees the widget

It does not read app todo state after a switch. That map is already empty.
It watches the visible Bot Chat DOM the same way Bot Sections watches the
roster: a MutationObserver plus defensive queries, no hashed class names.

Discovery:

1. Find a short header whose text matches `Tasks N/M`.
2. Treat each matching header's section as a stock widget; if several exist,
   the last one in DOM order is the newest/current list.
3. Read each row's title and status affordance (dashed pending ring, running
   `role="status"` spinner, completed vs cancelled icon colour).
4. Hide every captured source section reversibly and render one normalized
   dock, avoiding duplicate stock-plus-plugin panels.

While that widget is present, a snapshot is written at most once per second
under a per-bot storage key (bot profile + session id, N/M counts, items,
timestamp). Returning to the bot renders that snapshot if the live widget is
gone and the current session ID still matches the captured owner.

## Honest limits

- If you never opened a bot while its Tasks widget was on screen, there is
  nothing to restore.
- A collapsed app widget hides its rows. The dock keeps the last rows it
  actually saw, and only while the N/M counts stay the same.
- English header only (`Tasks N/M`), matching the current desktop copy.
- Bot Chat only. Sessions, group rooms, and the Bots home screen stay stock.
- Additive overlay. A Hermes update that removes the header text means the
  dock stops capturing. It will not crash the chat.

## Compatibility

Same platform rules as Bubble Mode: Hermes Desktop ≥ 0.20.5, single-file
ESM, `@hermes/plugin-sdk` only, no core patches, fails safe.
