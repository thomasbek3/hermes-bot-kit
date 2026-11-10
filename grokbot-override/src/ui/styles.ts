/*
 * Override styles. Everything is scoped under [data-gbo-root], so nothing here
 * can restyle Hermes outside the override's own panes.
 *
 * The colour palette and type scale are adapted from Rakazo
 * (https://github.com/elie222/rakazo @ c800ad5): packages/ui-tokens/src/tokens.css
 * and packages/ui-web/src/styles.css. Copyright 2026 Rakazo contributors,
 * Apache License 2.0 (LICENSE-APACHE-2.0). Modified 2026-11-08 by Thomas
 * Bekkers: variables renamed to --gbo-*, scoped to the plugin root, light is
 * the base and Hermes's `.dark` class switches to dark. Layout rules below
 * the palette are the override's own. Modified 2026-11-09: the dark values
 * were re-sampled from Grok Bot screenshots (flat neutral greys, blue accent)
 * and the Grok-look tokens (--gbo-panel-bg, --gbo-chrome-*, --gbo-send-bg,
 * --gbo-user-bg, --gbo-card-border) were added. Modified 2026-11-09 (pass 2):
 * the light values were re-sampled from Grok Bot light screenshots (grey
 * sidebar, near-white chat and panel, grey bot bubbles, white cards and
 * composer, blue accent) and the whole layout was scaled to Grok's
 * proportions (about 1.3x the pass-1 sizes) for both themes. Modified
 * 2026-11-09 (pass 3): sizes re-measured against the live Hermes window
 * (90% zoom, 0.896 window pt per CSS px) beside Grok Bot at the same window
 * size, and the --gbo-divider / --gbo-panel-divider seam tokens added.
 * Modified 2026-11-09 (pass 4): both palettes, the type scale, weights,
 * radii, shadows and easing re-set to the chat look's measured design values
 * (sizes x 1/0.896 for Hermes's zoom); user bubbles, send and switches take
 * the bot's swatch (--gbo-tint-*, --gbo-action*); pinned bots; one-line panel
 * rows; small muted section captions. Modified 2026-11-09 (pass 5): the
 * roster, chat, composer and panel layout now come from the reference layout
 * CSS (styles-ref.ts, MIT, see LICENSE-THIRD-PARTY-MIT) with the override's
 * glue in styles-adapt.ts; this file keeps the palette, the type scale and
 * the pieces only the override has (overlay scrollbars, avatars, the panel
 * sash and drawer).
 */

import { ADAPT_CSS } from './styles-adapt'
import { CHAT_CSS } from './styles-chat'
import { EMAIL_DRAFT_CSS } from './styles-email-drafts'
import { REF_STYLES } from './styles-ref'
import { ROSTER_CSS } from './stylesRoster'

export const STYLE_ID = 'grokbot-override-style'

const LIGHT = `
  --gbo-bg: #ffffff;
  --gbo-sidebar: #f5f5f5;
  --gbo-fg: #1c1c1c;
  --gbo-card: #ffffff;
  --gbo-popover: #ffffff;
  --gbo-chat-user: #1c1c1c;
  --gbo-chat-user-fg: #ffffff;
  --gbo-muted: #1c1c1c0f;
  --gbo-muted-fg: #1c1c1cad;
  --gbo-faint-fg: #1c1c1c8f;
  --gbo-quaternary-fg: #1c1c1c66;
  --gbo-accent: #1c1c1c0f;
  --gbo-sidebar-accent: #1c1c1c14;
  --gbo-border: #1c1c1c1f;
  --gbo-input: #1c1c1c29;
  --gbo-ring: #1e86fc;
  --gbo-link: #126fd4;
  --gbo-primary: #1c1c1c;
  --gbo-primary-fg: #ffffff;
  --gbo-primary-disabled: #1c1c1c26;
  --gbo-destructive: #c82532;
  --gbo-success: #0d9655;
  --gbo-warning: #c2730b;
  --gbo-working: #126fd4;
  --gbo-working-dot: #10ab61;
  --gbo-scrollbar: #1c1c1c3d;
  --gbo-shadow: 0 8px 24px #0000001f;
  --gbo-panel-bg: #fcfcfc;
  --gbo-panel-border: #1c1c1c14;
  --gbo-divider: #1c1c1c14;
  --gbo-panel-divider: #1c1c1c14;
  --gbo-surface: #ffffff;
  --gbo-card-border: transparent;
  --gbo-card-shadow: #1c1c1c1f 0 0 0 .5px, #1c1c1c09 0 2px 8px;
  --gbo-foot-border: transparent;
  --gbo-pill-shadow: #1c1c1c14 0 4px 12px -1px, #1c1c1c0a 0 1px 2px;
  --gbo-chrome-bg: #ffffff;
  --gbo-chrome-border: transparent;
  --gbo-chrome-fg: #1c1c1cad;
  --gbo-chrome-shadow: #1c1c1c14 0 4px 12px -1px, #1c1c1c0a 0 1px 2px, #1c1c1c14 0 0 0 .5px;
  --gbo-composer-bg: #ffffff;
  --gbo-composer-border: transparent;
  --gbo-composer-shadow: #0000000d 0 2px 8px -1px, #00000008 0 1px 2px, #1c1c1c14 0 0 0 1px;
  --gbo-placeholder: #1c1c1c66;
  --gbo-user-bg: #1c1c1c;
  --gbo-user-fg: #ffffff;
  --gbo-bubble-ring: inset #ffffff29 0 .5px 0, inset #ffffff29 0 -.5px 0, inset #1c1c1c0f 0 0 0 .5px;
`

const DARK = `
  --gbo-bg: #161616;
  --gbo-sidebar: #0e0e0e;
  --gbo-fg: #f5f5f5;
  --gbo-card: #1f1f1f;
  --gbo-popover: #1f1f1f;
  --gbo-chat-user: #f5f5f52e;
  --gbo-chat-user-fg: #f5f5f5;
  --gbo-muted: #f5f5f50f;
  --gbo-muted-fg: #f5f5f5a8;
  --gbo-faint-fg: #f5f5f58a;
  --gbo-quaternary-fg: #f5f5f566;
  --gbo-accent: #f5f5f50f;
  --gbo-sidebar-accent: #f5f5f514;
  --gbo-border: #f5f5f51a;
  --gbo-input: #f5f5f52e;
  --gbo-ring: #1e86fc;
  --gbo-link: #4e9bff;
  --gbo-primary: #f5f5f5;
  --gbo-primary-fg: #121212;
  --gbo-primary-disabled: #f5f5f51f;
  --gbo-destructive: #ff6463;
  --gbo-success: #14c16f;
  --gbo-warning: #f59312;
  --gbo-working: #4e9bff;
  --gbo-working-dot: #14c16f;
  --gbo-scrollbar: #f5f5f52e;
  --gbo-shadow: 0 0 0 .5px #f5f5f51a;
  --gbo-panel-bg: #121212;
  --gbo-panel-border: #f5f5f50f;
  --gbo-divider: #f5f5f50f;
  --gbo-panel-divider: #f5f5f50f;
  --gbo-surface: #1f1f1f;
  --gbo-card-border: transparent;
  --gbo-card-shadow: 0 0 0 .5px #f5f5f51a;
  --gbo-foot-border: transparent;
  --gbo-pill-shadow: 0 0 0 .5px #f5f5f51a;
  --gbo-chrome-bg: #1f1f1f;
  --gbo-chrome-border: transparent;
  --gbo-chrome-fg: #f5f5f5a8;
  --gbo-chrome-shadow: 0 0 0 .5px #f5f5f51a;
  --gbo-composer-bg: #1f1f1f;
  --gbo-composer-border: transparent;
  --gbo-composer-shadow: 0 0 0 .5px #f5f5f51a;
  --gbo-placeholder: #f5f5f566;
  --gbo-user-bg: #f5f5f52e;
  --gbo-user-fg: #f5f5f5;
  --gbo-bubble-ring: none;
`

/* Type, radii and motion: the chat look's scale (xs 12, sm 13, base 14,
   message 15, lg 17 at 1x; radii 8 / 12 / 18 / 22 / 24) in CSS px for
   Hermes's 90% zoom (x 1/0.896, the pass-3 window measurement). */
const TYPE = `
  --gbo-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  --gbo-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --gbo-text-caption: 13.4px/18px var(--gbo-font);
  --gbo-text-label: 14.5px/20px var(--gbo-font);
  --gbo-text-body-sm: 15.6px/21.5px var(--gbo-font);
  --gbo-text-body: 16.75px/23.5px var(--gbo-font);
  --gbo-text-body-lg: 19px/26px var(--gbo-font);
  --gbo-text-h3: 21px/28px var(--gbo-font);
  --gbo-text-h2: 27px/34px var(--gbo-font);
  --gbo-weight: 425;
  --gbo-weight-medium: 500;
  --gbo-weight-semibold: 600;
  --gbo-radius-sm: 9px;
  --gbo-radius-md: 13.5px;
  --gbo-radius-bubble: 20px;
  --gbo-radius-composer: 24.5px;
  --gbo-radius-card: 27px;
  --gbo-ease: cubic-bezier(.2, 0, 0, 1);
`

export const CSS = /* css */ `
[data-gbo-root] { ${LIGHT} ${TYPE} }
.dark [data-gbo-root], [data-gbo-root][data-gbo-theme="dark"] { ${DARK} }

/* Font, size and colour come from the reference base (styles-ref.ts). */
[data-gbo-root] {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  width: 100%;
}
[data-gbo-root] *, [data-gbo-root] *::before, [data-gbo-root] *::after { box-sizing: border-box; }
/* No specificity beyond the element, so a class (section captions, panel
   rows) sets its own font and colour. */
:where([data-gbo-root]) button { font: inherit; color: inherit; }
[data-gbo-root] ::-webkit-scrollbar { width: 6px; height: 6px; }
[data-gbo-root] ::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }
[data-gbo-root] :hover::-webkit-scrollbar-thumb { background: var(--gbo-scrollbar); }
[data-gbo-root] ::-webkit-scrollbar-track { background: transparent; }

/* The roster's visually hidden heading. */
.gbo-roster-title {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ── avatar ─────────────────────────────────────────────────────────── */
.gbo-avatar { position: relative; flex: none; display: block; line-height: 0; }
.gbo-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
.gbo-avatar svg { width: 100%; height: 100%; display: block; overflow: visible; }
/* A black bot on a dark theme: a dark grey body (eyes stay white), so the
   shape does not vanish into the near-black sidebar. */
.dark .gbo-avatar svg[data-swatch="black"] > path:last-child,
[data-gbo-theme="dark"] .gbo-avatar svg[data-swatch="black"] > path:last-child { fill: #2c2c2c; }
.gbo-avatar.is-working::after {
  content: ""; position: absolute; inset: -3px; border-radius: 999px; border: 2px solid var(--gbo-working);
  border-right-color: transparent; animation: gbo-spin 1.1s linear infinite;
}
@keyframes gbo-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .gbo-avatar.is-working::after { animation: none; }
}

/* ── overlay scroll areas ───────────────────────────────────────────── */
/* The native bar is hidden; a thin thumb floats over the right edge, only
   while the pointer is over the area, and takes no layout width. */
.gbo-oscroll { position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.gbo-oscroll-view { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; }
.gbo-oscroll-view::-webkit-scrollbar { display: none; width: 0; height: 0; }
.gbo-oscroll-thumb {
  position: absolute; z-index: 4; top: 0; right: 2px; width: 6px; height: 0; border-radius: 999px;
  background: var(--gbo-scrollbar); opacity: 0; transition: opacity .15s, width .15s; cursor: default;
}
.gbo-oscroll-thumb[data-scrollable="false"] { display: none; }
.gbo-oscroll:hover > .gbo-oscroll-thumb, .gbo-oscroll.is-dragging > .gbo-oscroll-thumb { opacity: 1; }
.gbo-oscroll-thumb:hover, .gbo-oscroll.is-dragging > .gbo-oscroll-thumb { width: 8px; }

/* ── profile panel dock, sash and narrow drawer ─────────────────────── */
/* The panel dock: its width is the user's (dragged from the hairline on its
   left edge, app.panelWidth), the panel scrolls inside it. */
.gbo-panel-dock { position: relative; flex: none; display: flex; min-height: 0; }
.gbo-panel-sash {
  position: absolute; z-index: 5; top: 0; bottom: 0; left: -4px; width: 7px; cursor: col-resize;
  touch-action: none; -webkit-app-region: no-drag;
}
.gbo-panel-sash::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; background: transparent; transition: background .1s;
}
.gbo-panel-sash:hover::after, .gbo-panel-sash[data-dragging]::after { background: var(--gbo-ring); width: 2px; left: 2.5px; }
.gbo-drag-band { position: absolute; z-index: 0; top: 0; left: 0; right: 0; height: 58px; -webkit-app-region: drag; pointer-events: none; }
/* Narrow workspace pane (measured in JS, so a narrow dock in a wide window
   counts): the panel is a drawer over the chat, opened from the header. */
.gbo-scrim { position: absolute; inset: 0; z-index: 5; background: color-mix(in srgb, #000 35%, transparent); }
.gbo-drawer {
  position: absolute; z-index: 6; top: 0; right: 0; bottom: 0; width: min(380px, 92%); display: flex;
  background: var(--gbo-panel-bg); box-shadow: var(--gbo-shadow);
}
.gbo-drawer-close { position: absolute; top: 13px; right: 13px; z-index: 1; }
.gbo-drawer:focus { outline: none; }
/* Focus rings only for the keyboard: a mouse click (or focus put back after
   one) never draws Hermes's or the browser's ring anywhere in the override;
   :focus-visible keeps its ring. A selected pinned tile or row is the grey
   selected fill only. */
[data-gbo-root] :focus:not(:focus-visible), [data-gbo-root]:focus:not(:focus-visible) { outline: none !important; }
[data-gbo-root] .pinned__tile:focus:not(:focus-visible), [data-gbo-root] .bot-row:focus:not(:focus-visible) { box-shadow: none !important; }
`
  // The reference layout (roster, chat, composer, panel, cards), scoped.
  + REF_STYLES
  // Chat-side parity surfaces (prompts, tools, media, voice, rooms, tabs).
  + CHAT_CSS
  // Roster-side parity surfaces (menus, dialogs, cron, config, screen, meter).
  + ROSTER_CSS
  // Email draft cards (ui/EmailDraft.tsx).
  + EMAIL_DRAFT_CSS
  // The override's glue in the reference idiom (pins, filters, jobs, Slack,
  // markdown inside bubbles, work rows, hover actions); last, so it wins ties.
  + ADAPT_CSS
