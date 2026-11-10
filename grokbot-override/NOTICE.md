# Grokbot Override: notices

The override's own code is MIT (the kit's `LICENSE`, © Thomas Bekkers). Code and styles from the sources
below are included, each under its own licence.

## Rakazo (Apache License 2.0)

Source: https://github.com/elie222/rakazo at commit `c800ad5`. Copyright 2026 Rakazo contributors.
Licence text: `LICENSE-APACHE-2.0` in this folder. Rakazo ships no NOTICE file, so there is nothing to
carry forward under §4(d).

Modified 2026-11-08 by Thomas Bekkers. What was taken and how it was changed:

| Rakazo file | Used in | Kind | Change |
|---|---|---|---|
| `packages/ui-tokens/src/tokens.css` (dark and light palettes) | `src/ui/styles.ts` | Adapted tokens | Values kept; variable names prefixed `--gbo-`; scoped under the plugin root element `[data-gbo-root]` instead of `:root`. |
| `packages/ui-web/src/styles.css` (type scale, L8-40) | `src/ui/styles.ts` | Adapted CSS | Sizes and line heights kept as `--gbo-text-*` variables. |
| `packages/core/src/bot-avatar-colors.ts` (`chatUserBubbleColors` maths, `hexToOklch`, `oklchToHex`, `contrastRatio`, `expandHex`) | `src/core/colors.js` | Copied code, modified | Rakazo's colour list and avatar-string parsing removed; takes a hex colour directly. |
| `packages/ui-web/src/components/ui/{dialog,context-menu,dropdown-menu,switch,checkbox,input}.tsx` (look only) | `src/ui/stylesRoster.ts` | Adapted look | Rounded dialog with a muted footer strip, ringed menus with 6 px items: re-implemented as plain CSS on the `--gbo-*` tokens; no Rakazo code copied. |

Layout numbers (bubble radius and padding, roster row sizes, composer pill, header pill, time separator) and the
card and room layouts in `src/ui/Prompts.tsx` and `src/ui/Rooms.tsx` were read from Rakazo's `apps/web` and
re-implemented, not copied. No Rakazo logos, icons, mascots, brand
images or names are used. Apache-2.0 grants no trademark rights (§6).

Every file that contains Rakazo material carries a header naming Rakazo, the licence and the modification.

## Hermes Agent (MIT)

Copyright (c) 2025 Nous Research. Licence text (copyright and permission notice): `LICENSE-HERMES-AGENT-MIT`
in this folder, copied from the Hermes Agent repository's `LICENSE`. Ports of small pure functions so the override behaves exactly like
Bot Mode:

| Hermes file | Used in |
|---|---|
| `apps/desktop/src/plugins/hermes-bots/routing.ts` (`resolveBotConnectionRoute`, `backendTargetProfile`, `scopedBotParams`, `requestForBot`) | `src/core/routing.js` |
| `apps/desktop/src/plugins/hermes-bots/canonical-chat.ts` (title registry lookup and its fail-closed rules) | `src/core/canonical.js` |
| `apps/desktop/src/plugins/hermes-bots/data.ts` (`mergeMultiSourceRoster`, without the offline-row retention) | `src/core/roster.js` |
| `apps/desktop/src/app/session/hooks/use-message-stream/segment-identity.ts` | `src/core/segments.js` |
| `hermes-bots/data.ts` (`saveBotMeta` CAS write, `$botAttention` classifier, `botSourceStatus`), `profile-ops.ts` (`mergeServerMeta`, `duplicateBot`, `deleteBot`), `group-membership.ts` | `src/core/botMeta.js`, `src/core/attention.js`, `src/core/rosterView.js`, `src/core/profileOps.js` |
| `hermes-bots/roster-pane-derivation.ts`, `row-helpers.ts`, `roster-sections.tsx` (filters, hidden section, gateway options) | `src/core/rosterView.js` |
| `hermes-bots/create-dialog.tsx`, `labels.ts`, `soul.ts`, `edit-profile-look.ts` | `src/core/profileOps.js` |
| `hermes-bots/cron.tsx` (schedule picker, add body, detail rows); `apps/desktop/src/api/cron.ts`, `app/cron/cron-job-model.ts` (edit and run) | `src/core/cronOps.js` |
| `hermes-bots/profile-config.tsx`, `model-picker.tsx`, `skills-hub.tsx`, `mcp-setup.tsx` | `src/core/profileConfig.js`, `src/ui/ProfileConfig.tsx` |
| `hermes-bots/screen-connection.ts`, `screen-state.ts`, `screen-pane.tsx` | `src/core/screen.js`, `src/ui/Screen.tsx` |
| `app/shell/hooks/use-statusbar-items.tsx`, `lib/statusbar.tsx` (context meter labels) | `src/core/usage.js` |
| Behaviour notes and small helpers named in each file's header | `src/core/{activity,create-chat,history,media,mentions,outcomes,rewind,rooms,slack,slash,voice}.js` |
| `contrib/runtime-loader.ts` (import-specifier rewriting), `sdk/runtime.ts` (namespace shims) — test only | `test/hermes-loader.mjs` (the one loader replica every `test/loader-*.test.mjs` uses) |

Test fixtures in `test/fixtures/` copy event and payload shapes from Hermes's own tests (named in each
fixture file).

## noVNC (MPL-2.0) and pako (MIT)

The bot screen (`src/ui/Screen.tsx`) bundles the kit's vendored noVNC 1.7.0 `core/rfb.js`
(`../computer-viewer/vendor/novnc-rfb.mjs`; provenance and rebuild steps in that folder's `README.md`).
noVNC is Copyright (C) The noVNC authors, Mozilla Public License 2.0 (https://www.mozilla.org/MPL/2.0/);
its Source Code Form is carried unminified inside `plugin.js`, and upstream lives at
https://github.com/novnc/noVNC. The bundle includes pako (MIT, Copyright (C) 1995-2013 Jean-loup Gailly
and Mark Adler, (C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin).

## SheetJS Community Edition (Apache License 2.0)

The file viewer (`src/ui/FileViewer.tsx`) reads spreadsheets in the renderer with SheetJS Community Edition
**0.20.3** (`src/core/sheetRead.js`), bundled unmodified into `plugin.js` (its module is the one headed
`/*! xlsx.js (C) 2013-present SheetJS -- http://sheetjs.com */`). Copyright (C) 2012-present SheetJS LLC,
Apache License 2.0; licence text: `LICENSE-APACHE-2.0` in this folder (the same text). SheetJS ships no NOTICE
file. Installed from SheetJS's official tarball (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, pinned
with its sha512 integrity in `package-lock.json`): the `xlsx` package on the npm registry stopped at 0.18.5,
which has CVE-2023-30533 (prototype pollution, fixed in 0.19.3) and CVE-2024-22363 (ReDoS, fixed in 0.20.2).
0.20.3 has no known CVEs. It is a dev dependency: only the bundled copy ships. It makes no network requests and
uses no `eval` or `new Function`; the viewer loads it on first use (a lazy module inside `plugin.js`).

## Layout CSS (MIT)

`src/ui/styles-ref.ts` adapts the layout stylesheets (tokens, base, shell, chat, details, cards) of an
MIT-licensed project, Copyright (c) 2026 Nick Vasilescu. Its copyright and permission notice is in
`LICENSE-THIRD-PARTY-MIT` in this folder. The CSS is kept close to verbatim, scoped under the override root,
with renamed custom properties and keyframes and lengths rescaled for Hermes's 90% zoom (details in the
file's header). Nothing else from that project is used.

The avatar silhouettes in `src/ui/avatarShapes.ts` are original to this kit (MIT, the kit's `LICENSE`).

## The built file

`plugin.js` is installed and shared as a single file, so `build.mjs` copies the full text of the kit's MIT
`LICENSE`, `LICENSE-HERMES-AGENT-MIT`, `LICENSE-THIRD-PARTY-MIT` and `LICENSE-APACHE-2.0`, plus the Rakazo attribution and modification
note and the SheetJS attribution above, into its leading `/*!` comment. `test/build.test.mjs` fails the build if any of them is missing.
