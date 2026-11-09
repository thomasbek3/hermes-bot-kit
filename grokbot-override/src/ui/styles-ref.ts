// Layout CSS adapted from an MIT-licensed project; see LICENSE-THIRD-PARTY-MIT.
//
// REF_CSS below is that project's tokens, base, shell, chat, details and
// cards stylesheets, kept close to verbatim so its class names (sidebar,
// bot-row, chat__header, bubble, composer, details, panel-card, card, ...)
// apply 1:1 to the override's markup. refCss() adapts it for Hermes:
//  - every selector is scoped under :where([data-gbo-root]) (the override's
//    own panes, menus and dialogs), so nothing reaches Hermes, and each
//    selector keeps its original specificity;
//  - :root is the override root, and its dark block follows Hermes's theme
//    switch (.dark) like the rest of the override;
//  - custom properties are renamed --g-* (Hermes's own --color-* tokens
//    stay untouched inside the override; the few Hermes markdown variables
//    the glue sets keep their names), and the per-bot colour variables
//    map onto the override's --gbo-tint-* / --gbo-action* (core/colors.js);
//  - keyframes are renamed gbo-ref-* (keyframe names are global);
//  - every length over 1px is divided by 0.896, Hermes's 90% zoom (window
//    pt per CSS px), so the screen measures the same as the original.
// Rules that only the original's own window needed (html/body sizing, the
// boot screen, drawn traffic lights) are left out.

const REF_CSS = /* css */ `
/* ── tokens ── */
/* Design tokens: light theme. */
:root {
  --color-bg-chrome: #FCFCFC;
  --color-bg-sidebar: #F5F5F5;
  --color-bg-pane: #FFFFFF;
  --color-bg-active: #1C1C1C14;
  --color-bg-tertiary: #1C1C1C0F;
  --color-bg-scrim: #00000080;
  --color-text-primary: #1C1C1C;
  --color-text-secondary: #1C1C1CAD;
  --color-text-tertiary: #1C1C1C8F;
  --color-text-quaternary: #1C1C1C66;
  --color-icon-secondary: #1C1C1CA8;
  --color-border-secondary: #1C1C1C1F;
  --color-border-tertiary: #1C1C1C14;
  --color-primary: #1C1C1C;
  --color-bot-pink: #F93498;
  --color-bot-pink-bubble: #C82779;
  --color-bot-pink-action: #E52F8B;
  --color-bot-blue: #1E86FC;
  --color-bot-red: #FB2B3E;
  --color-bot-orange: #FD690F;
  --color-bot-yellow: #F59312;
  --color-bot-green: #14C16F;
  --color-bot-teal: #13B7A2;
  --color-bot-purple: #8F59F9;
  --color-bot-brown: #A06B39;
  --color-bot-gray: #999999;
  --text-xs: 12px;
  --text-sm: 13px;
  --text-base: 14px;
  --text-message: 15px;
  --text-lg: 17px;
  --font-weight-regular: 425;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-bubble: 18px;
  --radius-composer: 22px;
  --radius-card: 24px;
  --radius-full: 9999px;

  /* --- font stacks and interaction states --- */
  --font-stack: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif;
  --font-mono-stack: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --color-bg-hover: #1C1C1C0F;
  --color-bg-secondary-hover: #1C1C1C1A;
  --color-bg-secondary-active: #1C1C1C2E;
  --color-bg-primary-hover: #363636;
  --color-bg-elevated-hover: #F1F1F1;
  --color-border-focus: #1E86FC;
  --color-bg-scrim-heavy: #000000E5;
  --color-ink: #000000;
  --color-success: #10AB61;
  --color-warn: #DA830E;
  --color-danger: #E72E3B;
  --shadow-pill: #1C1C1C14 0px 4px 12px -1px, #1C1C1C0A 0px 1px 2px;
  --shadow-composer: #0000000D 0px 2px 8px -1px, #00000008 0px 1px 2px, #E4E4E40A 0px 0px 0px 1px;
  --shadow-card: #1C1C1C1F 0px 0px 0px 0.5px, #1C1C1C09 0px 2px 8px;
  --shadow-modal: #1C1C1C1A 0px 20px 32px -5px, #1C1C1C1A 0px 8px 12px -6px;
  --bubble-ring: #FFFFFF29 0px 0.5px 0px inset, #FFFFFF29 0px -0.5px 0px inset, #1C1C1C0F 0px 0px 0px 0.5px inset;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);

  /* --- semantic extras used for theming (light values; dark below) --- */
  --color-bg-elevated: #FFFFFF;
  --color-bg-subtle: #1C1C1C08;
  --color-bg-primary-disabled: #1C1C1C26;
  --color-bg-active-solid: #E9E9E9;
  --color-border-primary: #1C1C1C3D;
  --color-on-primary: #FCFCFC;
  --color-bubble-agent: #1C1C1C0F;
  --color-bubble-user: #1C1C1C;
  --color-danger-hover: #C82532;
  --color-danger-bg: #FB2B3E14;
  --color-danger-text: #CD2834;
  --color-warn-bg: #F5931217;
  --color-warn-text: #AA6300;
  --color-success-bg: #14C16F17;
  --color-success-text: #00854A;
  --shadow-popover: #1C1C1C1A 0 10px 20px -3px, #1C1C1C14 0 4px 6px -4px;
}

/* ---------- dark theme. Flat: no shadows. ---------- */
:root[data-theme='dark'] {
  --color-bg-chrome: #121212;
  --color-bg-sidebar: #0E0E0E;
  --color-bg-pane: #161616;
  --color-bg-active: #F5F5F514;
  --color-bg-tertiary: #F5F5F50A;
  --color-bg-scrim: #000000B2;
  --color-text-primary: #F5F5F5;
  --color-text-secondary: #F5F5F5A8;
  --color-text-tertiary: #F5F5F58A;
  --color-text-quaternary: #F5F5F561;
  --color-icon-secondary: #F5F5F5A3;
  --color-border-secondary: #F5F5F51A;
  --color-border-tertiary: #F5F5F50F;
  --color-primary: #F5F5F5;
  --color-bg-hover: #F5F5F50F;
  --color-bg-secondary-hover: #F5F5F514;
  --color-bg-secondary-active: #F5F5F533;
  --color-bg-primary-hover: #DBDBDB;
  --color-bg-elevated-hover: #2C2C2C;
  --color-border-focus: #1884FC;
  --color-bg-scrim-heavy: #000000F2;
  --color-ink: #F5F5F5;
  --color-success: #0E9F5A;
  --color-warn: #C8770C;
  --color-danger: #CF2B35;
  --shadow-pill: #F5F5F51A 0 0 0 0.5px;
  --shadow-composer: #F5F5F51A 0 0 0 0.5px;
  --shadow-card: #F5F5F51A 0 0 0 0.5px;
  --shadow-modal: #000000 0 0 0 0;
  --shadow-popover: #F5F5F51A 0 0 0 0.5px;
  --bubble-ring: #F5F5F50F 0 0 0 0.5px inset;

  --color-bg-elevated: #1F1F1F;
  --color-bg-subtle: #F5F5F505;
  --color-bg-primary-disabled: #F5F5F521;
  --color-bg-active-solid: #262626;
  --color-border-primary: #F5F5F538;
  --color-on-primary: #121212;
  --color-bubble-agent: #F5F5F50F;
  --color-bubble-user: #F5F5F52E;
  --color-danger-hover: #F73643;
  --color-danger-bg: #FC2C3E1F;
  --color-danger-text: #FF6463;
  --color-warn-bg: #F694121F;
  --color-warn-text: #E28600;
  --color-success-bg: #14C3701F;
  --color-success-text: #00BA69;
}

/* ── base ── */
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: var(--font-stack);
  font-size: var(--text-base);
  line-height: 20px;
  letter-spacing: 0.14px;
  font-weight: 400;
  color: var(--color-text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-synthesis: none;
}
button, input, textarea, select { font: inherit; letter-spacing: inherit; color: inherit; }
button { background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: inherit; }
button:disabled { cursor: default; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--color-border-focus); outline-offset: 1px; }

/* ---------- shared controls ---------- */
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border-radius: var(--radius-full);
  background: var(--color-bg-pane); border: 0.5px solid var(--color-border-tertiary);
  color: var(--color-text-primary); flex-shrink: 0;
  transition: background-color 120ms var(--ease-out);
}
.icon-btn:hover { background: var(--color-bg-elevated-hover); }
.icon-btn--bordered { border-width: 1px; }
.icon-btn--plain { width: 24px; height: 24px; background: transparent; border: 0; border-radius: 6px; }
.icon-btn--plain:hover { background: var(--color-bg-hover); }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 36px; padding: 8px 16px; border-radius: var(--radius-full);
  font-size: 14px; font-weight: 500; line-height: 20px; letter-spacing: 0.14px; white-space: nowrap; text-decoration: none;
  transition: background-color 120ms var(--ease-out), opacity 120ms;
}
.btn--sm { height: 32px; padding: 6px 12px; font-weight: 400; }
.btn--grow { flex: 1 1 0; }
.btn--primary { background: var(--color-primary); color: var(--color-bg-chrome); }
.btn--primary:hover:not(:disabled) { background: var(--color-bg-primary-hover); }
.btn--primary:disabled { background: var(--color-bg-primary-disabled); color: var(--color-text-quaternary); box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset; }
.btn--secondary { background: var(--color-bg-tertiary); color: var(--color-ink); }
.btn--sm.btn--secondary { box-shadow: var(--color-border-secondary) 0 0 0 0.5px inset; }
.btn--secondary:hover:not(:disabled) { background: var(--color-bg-secondary-hover); }
.btn--secondary:active:not(:disabled) { background: var(--color-bg-secondary-active); }
.btn--secondary:disabled { opacity: 0.5; }
.btn--light { background: var(--color-bg-elevated); color: var(--color-ink); height: 32px; padding: 6px 14px; }
.btn--light:hover { background: var(--color-bg-elevated-hover); }
.btn--bot { background: var(--bot-action, var(--color-primary)); color: var(--bot-on-action, #FFFFFF); height: 32px; padding: 6px 14px; }
.btn--bot:hover { background: var(--bot-action-hover, var(--color-bg-primary-hover)); }

.link-btn { color: var(--color-text-secondary); font-size: 13px; line-height: 18px; padding: 4px 6px; border-radius: 6px; }
.link-btn:hover:not(:disabled) { background: var(--color-bg-hover); color: var(--color-text-primary); }
.link-btn--small { font-size: 12px; line-height: 16px; letter-spacing: 0.12px; }

.text-input {
  width: 100%; height: 35px; padding: 8px 10px; border-radius: var(--radius-sm);
  border: 0.5px solid var(--color-border-secondary); background: var(--color-bg-pane);
  font-size: 13px; line-height: 18px; letter-spacing: 0.195px; outline: none;
}
.text-input::placeholder { color: var(--color-text-quaternary); }
.text-input:focus { border-color: var(--color-border-focus); box-shadow: 0 0 0 3px #1E86FC22; }

.status-dot {
  position: absolute; width: 8px; height: 8px; border-radius: 50%;
  box-shadow: 0 0 0 2.5px var(--color-bg-sidebar);
}
.status-dot.is-working { background: var(--color-success); animation: breathe 2.4s ease-in-out infinite; }
.status-dot.is-attention { background: var(--color-warn); }
.status-dot.is-unread { background: var(--color-bot-blue); }
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

.bot-avatar { position: relative; display: inline-block; flex-shrink: 0; }
.bot-avatar svg { pointer-events: none; }
.bot-avatar__star {
  position: absolute; right: 0; bottom: 0; border-radius: var(--radius-full);
  background: var(--color-bot-yellow); box-shadow: var(--color-bg-tertiary) 0 0 0 0.5px inset;
  display: flex; align-items: center; justify-content: center;
}

.toolkit-logo {
  position: relative; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden;
  background: #FFFFFF; box-shadow: #1C1C1C14 0 0 0 0.5px inset;
}
.toolkit-logo img { object-fit: contain; }
.toolkit-logo__letter { font-weight: 600; color: var(--color-text-secondary); line-height: 1; }

.menu {
  position: absolute; z-index: 50; min-width: 200px; padding: 4px; border-radius: 12px;
  background: var(--color-bg-pane); border: 0.5px solid var(--color-border-secondary);
  box-shadow: var(--shadow-popover);
  animation: rise 100ms var(--ease-out);
  max-height: 320px; overflow-y: auto;
}
.menu.is-below { top: calc(100% + 6px); }
.menu.is-above { bottom: calc(100% + 6px); }
.menu.is-left { left: 0; }
.menu.is-right { right: 0; }
.menu.is-center { left: 50%; transform: translateX(-50%); animation: none; }
.menu__item {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%;
  height: 30px; padding: 0 10px; border-radius: 6px; font-size: 13px; line-height: 18px; letter-spacing: 0.195px; white-space: nowrap;
}
.menu__item:hover { background: var(--color-bg-hover); }
.menu__item.is-danger { color: var(--color-danger); }
.menu__hint { color: var(--color-text-tertiary); font-size: 12px; }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.toast {
  position: absolute; left: 50%; top: 68px; transform: translateX(-50%); z-index: 20;
  background: var(--color-primary); color: var(--color-on-primary); font-size: 13px; line-height: 18px; padding: 7px 12px; border-radius: var(--radius-full);
  box-shadow: var(--shadow-pill); animation: rise 160ms var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}

/* ── shell ── */
/* ---------- window grid: sidebar 350 · chat · details 320 (screen 01) ---------- */
.app { display: flex; height: 100%; width: 100%; background: var(--color-bg-chrome); overflow: hidden; }


.sidebar {
  position: relative; display: flex; flex-direction: column; flex-shrink: 0;
  width: 350px; height: 100%;
  background: var(--color-bg-sidebar); border-right: 0.5px solid var(--color-border-tertiary);
  transition: width 0.2s var(--ease-out);
}
.sidebar.is-collapsed { width: 88px; }
.sidebar__titlebar { position: relative; display: flex; align-items: center; justify-content: flex-end; height: 60px; flex-shrink: 0; padding: 12px 16px 12px 10px; }
.sidebar__controls { display: flex; align-items: center; gap: 10px; }
.sidebar.is-collapsed .sidebar__titlebar { justify-content: center; padding: 34px 0 0; height: 66px; }

.sidebar__scroll { flex: 1 1 0; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 4px 12px 40px; scrollbar-width: none; }
.sidebar__scroll::-webkit-scrollbar { display: none; }

.pinned { display: flex; justify-content: center; padding: 6px 0 18px; }
.pinned__tile {
  display: flex; flex-direction: column; align-items: center; gap: 6px; width: 95px;
  padding: 6px 8px 4px; border-radius: 12px; transition: background-color 120ms var(--ease-out);
}
.pinned__tile:hover { background: var(--color-bg-hover); }
.pinned__tile.is-selected { background: var(--color-bg-active); }
.pinned__avatar { position: relative; display: inline-flex; }
.pinned__dot { left: 2px; bottom: 2px; }
.pinned__label {
  width: 79px; font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-ink); text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sidebar.is-collapsed .pinned__tile { width: 64px; padding: 6px; }

.bot-list { display: flex; flex-direction: column; gap: 4px; }
.bot-row {
  display: flex; align-items: center; gap: 10px; height: 54px; padding: 8px; border-radius: 12px; width: 100%;
  transition: background-color 120ms var(--ease-out);
}
.bot-row:hover { background: var(--color-bg-hover); }
.bot-row.is-selected { background: var(--color-bg-active); }
.bot-row__avatar { position: relative; display: inline-flex; }
.bot-row__avatar .status-dot { right: -1px; top: -1px; }
.bot-row.is-selected .status-dot, .bot-row:hover .status-dot { box-shadow: 0 0 0 2.5px var(--color-bg-active-solid); }
.bot-row__text { display: flex; flex-direction: column; gap: 1px; flex: 1 1 0; min-width: 0; }
.bot-row__name, .bot-row__preview { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bot-row__name { font-size: 14px; font-weight: 500; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); }
.bot-row__preview { font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-secondary); }
.bot-rail-item { display: flex; align-items: center; justify-content: center; height: 54px; border-radius: 12px; }
.bot-rail-item:hover { background: var(--color-bg-hover); }
.bot-rail-item.is-selected { background: var(--color-bg-active); }
.bot-list__empty { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; border: 0.5px dashed var(--color-border-secondary); }
.bot-list__empty:hover { background: var(--color-bg-hover); }
.bot-list__empty > span:last-child { display: flex; flex-direction: column; min-width: 0; }
.bot-list__empty-plus { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: var(--color-bg-pane); border: 0.5px solid var(--color-border-tertiary); }

.sidebar__footer { position: relative; display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 16px 16px; flex-shrink: 0; }
.sidebar__fade { position: absolute; left: 0; right: 0; top: -40px; height: 40px; pointer-events: none; background: linear-gradient(180deg, transparent 0%, var(--color-bg-sidebar) 100%); }
.sidebar.is-collapsed .sidebar__footer { justify-content: center; padding: 0 0 16px; }
.account { position: relative; display: flex; align-items: center; gap: 8px; flex: 1 1 0; min-width: 0; padding-right: 4px; border-radius: var(--radius-full); }
.account__btn { display: flex; align-items: center; gap: 8px; min-width: 0; border-radius: var(--radius-full); padding-right: 10px; }
.account__btn:hover { background: var(--color-bg-hover); }
.account__initials {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: var(--radius-full);
  background: var(--color-bg-active); box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset;
  color: var(--color-text-secondary); font-size: 14px; font-weight: 500; letter-spacing: -0.35px; line-height: 14px;
}
.account__name { font-size: 14px; font-weight: 500; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── chat ── */
/* ---------- chat column (screens 01/02) ---------- */
.chat {
  position: relative; display: flex; flex-direction: column; flex: 1 1 0; min-width: 424px; height: 100%;
  background: var(--color-bg-chrome); overflow: hidden;
}
.chat--empty { align-items: center; justify-content: center; }

.chat__header {
  position: absolute; left: 0; right: 0; top: 0; height: 60px; z-index: 5;
  display: flex; align-items: center; justify-content: center; padding: 0 12px 0 8px;
  background: linear-gradient(180deg, var(--color-bg-chrome) 0%, transparent 100%);
  pointer-events: none;
}
.chat__header > * { pointer-events: auto; }
.chat__pill-anchor { position: relative; max-width: calc(100% - 240px); display: inline-flex; }
.chat__pill {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%;
  padding: 7.5px 13.5px 7.5px 7.5px; border-radius: var(--radius-full);
  background: var(--color-bg-pane); border: 0.5px solid var(--color-border-tertiary); box-shadow: var(--shadow-pill);
  transition: background-color 120ms var(--ease-out);
}
.chat__pill:hover { background: var(--color-bg-elevated-hover); }
.chat__pill-name { font-size: 14px; font-weight: 500; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat__header-right { position: absolute; right: 12px; top: 12px; display: flex; gap: 8px; }
.share-btn {
  height: 36px; padding: 8px 16px; border-radius: var(--radius-full);
  background: var(--color-bg-pane); border: 1px solid var(--color-border-tertiary);
  font-size: 14px; line-height: 18px; letter-spacing: 0.14px; color: var(--color-ink);
}
.share-btn:hover { background: var(--color-bg-elevated-hover); }

/* ---------- transcript ---------- */
.transcript-wrap { position: relative; flex: 1 1 0; min-height: 0; }
.transcript { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; padding: 60px 16px 16px; overflow-anchor: none; }
.transcript__col { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; max-width: 960px; margin: 0 auto; min-height: 100%; justify-content: flex-end; }
.transcript__col > * { max-width: 100%; }

.group { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.group.is-right { align-items: flex-end; padding-top: 4px; }
.group.is-left { align-items: flex-start; }

.bubble-wrap { position: relative; display: flex; align-items: flex-end; gap: 8px; max-width: 100%; }
.bubble-wrap.is-right { flex-direction: row-reverse; }
.bubble__time {
  flex-shrink: 0; font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-tertiary);
  padding-bottom: 9px; opacity: 0; transform: translateX(-4px); transition: opacity 160ms, transform 160ms var(--ease-out); white-space: nowrap; user-select: none;
}
.bubble-wrap.is-right .bubble__time { transform: translateX(4px); }
.bubble-wrap:hover .bubble__time { opacity: 1; transform: none; }

.bubble {
  max-width: 560px; min-width: 0; padding: 7px 12px; border-radius: var(--radius-bubble);
  font-size: var(--text-message); line-height: 22px; letter-spacing: 0.15px;
  box-shadow: var(--bubble-ring); overflow-wrap: anywhere;
}
.bubble.is-agent { background: linear-gradient(180deg, #FFFFFF29 0%, #FFFFFF00 100%), var(--color-bubble-agent); color: var(--color-ink); }
.bubble.is-user { background: linear-gradient(180deg, #FFFFFF0F 0%, #FFFFFF00 100%), var(--bot-bubble, var(--color-bubble-user)); color: #FFFFFF; }
.bubble__plain { white-space: pre-wrap; }
/* Grouped bubble "tail" corners (README: bottom-left on first, top-left on last). Mirrored for user bubbles. */
.bubble.is-agent.is-first { border-bottom-left-radius: 6px; }
.bubble.is-agent.is-mid { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
.bubble.is-agent.is-last { border-top-left-radius: 6px; }
.bubble.is-user.is-first { border-bottom-right-radius: 6px; }
.bubble.is-user.is-mid { border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
.bubble.is-user.is-last { border-top-right-radius: 6px; }
.bubble.is-streaming .md > :last-child::after {
  content: ''; display: inline-block; width: 7px; height: 7px; margin-left: 4px; border-radius: 50%;
  background: currentColor; opacity: 0.4; vertical-align: middle; animation: breathe 1s ease-in-out infinite;
}
.bubble__cites { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.cite-chip {
  font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-secondary); text-decoration: none;
  padding: 2px 8px; border-radius: var(--radius-full); background: var(--color-bg-elevated); box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset;
}
.cite-chip:hover { color: var(--color-text-primary); background: var(--color-bg-elevated-hover); }

.sender-label { display: flex; align-items: center; gap: 6px; padding: 0 0 2px 4px; font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-secondary); }

/* ---------- markdown (agent bubbles) ---------- */
.md > * { margin: 0; }
.md > * + * { margin-top: 10px; }
.md ul, .md ol { padding-left: 22px; }
.md li + li { margin-top: 2px; }
.md li > p { margin: 0; }
.md a { color: var(--color-text-primary); text-decoration: underline; text-decoration-color: var(--color-border-primary); text-underline-offset: 2px; }
.md a:hover { text-decoration-color: currentColor; }
.md strong { font-weight: 600; }
.md h1, .md h2, .md h3, .md h4 { font-size: 15px; line-height: 22px; font-weight: 600; }
.md h1 { font-size: 17px; line-height: 24px; }
.md blockquote { padding-left: 10px; border-left: 2px solid var(--color-border-primary); color: var(--color-text-secondary); }
.md code { font-family: var(--font-mono-stack); font-size: 13px; background: var(--color-bg-tertiary); padding: 1px 4px; border-radius: 4px; }
.md pre {
  background: var(--color-bg-subtle); border-radius: var(--radius-sm); padding: 8px 12px; overflow-x: auto;
  font-family: var(--font-mono-stack); font-size: 13px; line-height: 20px; letter-spacing: 0.15px; color: var(--color-text-secondary);
  white-space: pre; scrollbar-width: thin;
}
.md pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; }
.md hr { border: 0; border-top: 1px solid var(--color-border-tertiary); }
.md-table { overflow-x: auto; }
.md table { border-collapse: collapse; font-size: 14px; line-height: 20px; }
.md th, .md td { border-bottom: 0.5px solid var(--color-border-secondary); padding: 4px 10px 4px 0; text-align: left; vertical-align: top; }
.md th { font-weight: 600; }
.md img { max-width: 100%; border-radius: 8px; }

/* ---------- dividers, events, notices ---------- */
.divider { align-self: center; padding: 12px 0 6px; font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-secondary); }
.system-event { align-self: center; max-width: 560px; text-align: center; font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-secondary); padding: 0 12px; }
.notice {
  align-self: center; max-width: 560px; padding: 8px 12px; border-radius: 12px;
  font-size: 13px; line-height: 18px; letter-spacing: 0.195px; text-align: center;
  background: var(--color-bg-tertiary); color: var(--color-text-secondary);
}
.notice.is-warn { background: var(--color-warn-bg); color: var(--color-warn-text); }
.notice.is-error { background: var(--color-danger-bg); color: var(--color-danger-text); }

/* ---------- tool-call steps (collapsed) ---------- */
.steps { display: flex; flex-direction: column; align-items: flex-start; margin: -4px 0; }
.steps__toggle {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; margin-left: 4px; border-radius: var(--radius-full);
  font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-tertiary);
}
.steps__toggle:hover { background: var(--color-bg-hover); color: var(--color-text-secondary); }
.steps__chev { transition: transform 160ms var(--ease-out); }
.steps.is-open .steps__chev { transform: rotate(180deg); }
.steps__list { list-style: none; margin: 6px 0 4px 12px; padding: 0 0 0 12px; border-left: 1px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 6px; }
.step { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-primary); }
.step__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-success); margin-left: -15.5px; position: relative; top: -1px; box-shadow: 0 0 0 2px var(--color-bg-chrome); }
.step.is-error .step__dot, .step.is-denied .step__dot { background: var(--color-danger); }
.step.is-running .step__dot, .step.is-awaiting-approval .step__dot { background: var(--color-warn); }
.step__summary { color: var(--color-text-tertiary); font-size: 12px; }
.step__shot { flex-basis: 100%; max-width: 240px; border-radius: 6px; box-shadow: var(--color-border-tertiary) 0 0 0 0.5px; margin-top: 2px; }

/* ---------- live activity line ---------- */
.activity-line { display: flex; align-items: center; gap: 8px; padding: 2px 4px; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; }
.activity-line__mark { display: inline-flex; animation: bob 2.4s ease-in-out infinite; }
.activity-line__time { color: var(--color-text-tertiary); }
.shimmer {
  color: transparent;
  background: linear-gradient(90deg, var(--color-text-tertiary) 0%, var(--color-text-tertiary) 35%, var(--color-text-primary) 50%, var(--color-text-tertiary) 65%, var(--color-text-tertiary) 100%);
  background-size: 250% 100%; -webkit-background-clip: text; background-clip: text;
  animation: shimmer 1.4s linear infinite;
}
.activity-line.is-waiting .shimmer { animation: none; background: none; color: var(--color-warn-text); }
.activity-line.is-waiting .activity-line__mark { animation: none; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: 0% 0; } }
@keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }

/* ---------- jump to bottom ---------- */
.jump-btn {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 4;
  width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--color-bg-pane); border: 0.5px solid var(--color-border-tertiary); box-shadow: var(--shadow-composer);
  animation: rise 160ms var(--ease-out);
}
.jump-btn:hover { background: var(--color-bg-elevated-hover); }

/* ---------- empty chat ---------- */
.empty-chat { display: flex; flex-direction: column; align-items: center; gap: 10px; margin: auto; padding: 40px 24px; text-align: center; align-self: center; }
.empty-chat__title { font-size: 17px; font-weight: 500; line-height: 24px; letter-spacing: 0.17px; margin-top: 12px; }
.empty-chat__sub { max-width: 380px; font-size: 14px; line-height: 20px; color: var(--color-text-secondary); }

/* ---------- composer ---------- */
.composer-area { flex-shrink: 0; padding: 0 16px 16px; position: relative; }
.composer {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 8px;
  max-width: 960px; min-height: 44px; margin: 0 auto; padding: 0 8px;
  background: var(--color-bg-pane); border: 0.5px solid var(--color-border-secondary); border-radius: var(--radius-composer);
  box-shadow: var(--shadow-composer);
  transition: border-color 120ms;
}
.composer:focus-within { border-color: var(--color-border-primary); }
.composer__left { display: flex; align-items: flex-end; gap: 8px; flex: 1 1 0; min-width: 0; }
.composer__right { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.composer__plus-anchor { position: relative; display: inline-flex; padding: 8px 0; }
.composer__btn {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%;
  background: var(--color-bg-tertiary); box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset; flex-shrink: 0; color: var(--color-text-primary);
}
.composer__btn:hover:not(:disabled) { background: var(--color-bg-secondary-hover); }
.composer__input {
  flex: 1 1 0; min-width: 0; border: 0; outline: none; resize: none; background: transparent;
  padding: 12px 0; margin: 0; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink);
  max-height: 200px; display: block;
}
.composer__input::placeholder { color: var(--color-text-quaternary); opacity: 1; }
.composer__cta {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%;
  background: var(--bot-action, var(--color-primary)); color: var(--bot-on-action, #FFFFFF); flex-shrink: 0; transition: background-color 120ms, transform 120ms;
}
.composer__cta:hover:not(:disabled) { background: var(--bot-action-hover, var(--color-bg-primary-hover)); }
.composer__cta:active:not(:disabled) { transform: scale(0.94); }
.composer__error {
  max-width: 960px; margin: 0 auto 8px; padding: 6px 12px; border-radius: 12px; background: var(--color-danger-bg); color: var(--color-danger-text);
  font-size: 13px; line-height: 18px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
}

/* ── details ── */
/* ---------- details panel, 320px (screen 01) ---------- */
.details {
  display: flex; flex-direction: column; width: 320px; flex-shrink: 0; height: 100%;
  background: var(--color-bg-chrome); border-left: 0.5px solid var(--color-border-tertiary);
  animation: slideIn 200ms var(--ease-out);
}
@keyframes slideIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
.details__top { display: flex; align-items: center; justify-content: flex-end; height: 60px; padding: 12px; flex-shrink: 0; }
.details__scroll { flex: 1 1 0; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.details__identity { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 8px 16px 12px; }
.details__name {
  width: 288px; max-width: 100%; padding: 2px 10px; border-radius: 8px; text-align: center;
  font-size: 17px; font-weight: 500; line-height: 24px; letter-spacing: 0.17px; color: var(--color-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.details__tabs { display: flex; justify-content: center; padding: 4px 16px 10px; }
.segmented { display: flex; align-items: center; gap: 2px; }
.segmented button { padding: 4px 8px; border-radius: var(--radius-full); font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-secondary); }
.segmented button:hover { color: var(--color-text-primary); }
.segmented button.is-active { background: var(--color-bg-tertiary); color: var(--color-ink); }
.details__sections { display: flex; flex-direction: column; gap: 22px; padding: 10px 16px 16px; }
.details__sections > section { display: flex; flex-direction: column; gap: 10px; }
.section-label { padding: 0 12px; font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-secondary); }
.section-label--row { display: flex; align-items: center; justify-content: space-between; height: 18px; padding-right: 6px; }

.panel-card { display: flex; flex-direction: column; padding: 4px; border-radius: 12px; background: var(--color-bg-pane); border: 0.5px solid var(--color-border-tertiary); }
.panel-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; width: 100%; text-align: left; }
.panel-row--routine { height: 48px; }
.panel-row--link, .panel-row--computer, .panel-row--action { cursor: pointer; }
.panel-row--link { height: 36px; gap: 6px; }
.panel-row--link:hover, .panel-row--computer:hover, .panel-row--action:hover { background: var(--color-bg-hover); }
.panel-row--computer { height: 52px; gap: 6px; }
.panel-row--action { height: 32px; gap: 8px; font-size: 13px; line-height: 18px; color: var(--color-text-secondary); }
.panel-row--setting { height: 30px; justify-content: space-between; padding: 6px 4px 6px 8px; font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-ink); }
.panel-row__icon { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex-shrink: 0; }
.panel-row__glyph { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex-shrink: 0; }
.panel-row__text { display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; }
.panel-row__title, .panel-row__sub { display: block; font-size: 13px; line-height: 18px; letter-spacing: 0.195px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-row__title { color: var(--color-ink); }
.panel-row__sub { color: var(--color-text-secondary); }
.panel-row__meta { font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-empty { padding: 10px 8px; font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-tertiary); }
.panel-empty--center { text-align: center; padding: 32px 16px; }

.toggle {
  display: flex; align-items: center; justify-content: flex-start; width: 32px; height: 20px; padding: 2px; flex-shrink: 0;
  border-radius: var(--radius-full); background: var(--color-bg-tertiary); box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset;
  transition: background-color 160ms var(--ease-out);
}
.toggle__knob { width: 16px; height: 16px; border-radius: 50%; background: #FFFFFF; box-shadow: #1C1C1C1F 0 1px 3px; transition: transform 200ms var(--ease-out); }
.toggle.is-on { background: var(--bot-action, var(--color-primary)); }
.toggle.is-on .toggle__knob { transform: translateX(12px); }

.computer-thumb {
  position: relative; display: flex; align-items: center; justify-content: center; width: 64px; height: 40px; flex-shrink: 0; border-radius: 6px;
  background: radial-gradient(ellipse 115% 90% at 15% 8%, #B9B9B942 0%, #B9B9B900 68%), radial-gradient(ellipse 95% 75% at 90% 82%, #7A7A7A33 0%, #7A7A7A00 70%), var(--color-bg-tertiary);
  box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset;
}
.computer-thumb.has-shot { background: #000; overflow: hidden; }
.computer-thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; }
.computer-thumb__face { display: flex; align-items: center; justify-content: center; gap: 4px; width: 24px; height: 24px; border-radius: 50%; background: #1C1C1C59; }
.computer-thumb__face i { width: 5px; height: 2px; border-radius: 1px; background: #E9E9E9; }
.computer-thumb__z1, .computer-thumb__z2 { position: absolute; color: var(--color-text-tertiary); font-weight: 600; }
.computer-thumb__z1 { left: 40px; top: -3px; font-size: 9px; line-height: 9px; opacity: 0.9; }
.computer-thumb__z2 { left: 46px; top: -8px; font-size: 7px; line-height: 7px; opacity: 0.4; }
.computer-thumb__awake { position: relative; width: 8px; height: 8px; }
.computer-thumb__awake .status-dot { inset: 0; box-shadow: none; }

.mini-select { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 2px 4px 2px 6px; border-radius: 8px; border: 1px solid var(--color-border-tertiary); font-size: 13px; line-height: 18px; letter-spacing: -0.08px; color: var(--color-ink); }

/* group chat members */
.members__row { gap: 8px; height: 40px; }
.members__text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.members__name { font-size: 13px; line-height: 18px; color: var(--color-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.members__label { font-size: 12px; line-height: 16px; color: var(--color-text-tertiary); }
.members__remove { width: 22px; height: 22px; border-radius: 6px; }
.members__remove:disabled { opacity: 0.3; cursor: default; }
.members__dot { width: 24px; height: 24px; border-radius: 50%; background: var(--color-bg-hover); }
.members__add { border-top: 0.5px solid var(--color-border-tertiary); margin-top: 4px; padding-top: 4px; }
.members__hint { font-size: 12px; line-height: 16px; color: var(--color-text-tertiary); padding: 6px 8px 2px; }

/* ── cards ── */
/* ---------- transcript cards (screen 02 draft card language) ---------- */
.card {
  width: 414px; max-width: 100%; background: var(--color-bg-pane); border-radius: var(--radius-card);
  box-shadow: var(--shadow-card); display: flex; flex-direction: column; overflow: clip;
}
.card__head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 16px 4px; }
.card__titles { display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; padding: 2px 0; }
.card__title { font-size: 14px; font-weight: 500; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); }
.card__sub { font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-text-secondary); }
.card__body { padding: 8px 16px 0; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
.card__actions { display: flex; gap: 8px; padding: 14px 16px 16px; }
.card__actions .btn { flex: 1 1 0; padding: 8px 10px; }
.card__outcome { display: flex; align-items: center; gap: 6px; padding: 12px 16px 16px; font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-tertiary); }
.card__error { padding: 0 16px 12px; font-size: 13px; line-height: 18px; color: var(--color-danger-text); }
.card.is-resolved .card__head { padding-bottom: 0; }

/* question card (screen 01) */
.question-card { width: 560px; box-shadow: var(--color-border-tertiary) 0 0 0 1px inset; }
.question-card__head { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px 4px; }
.question-card__q { font-size: 15px; font-weight: 600; line-height: 22px; letter-spacing: 0.15px; color: var(--color-text-primary); }
.question-card__hint { font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-text-tertiary); }
.question-card__options { display: flex; flex-direction: column; gap: 1px; padding: 8px; }
.question-option { display: flex; align-items: flex-start; gap: 4px; padding: 8px; border-radius: 12px; width: 100%; text-align: left; }
.question-option:hover:not(:disabled) { background: var(--color-bg-hover); }
.question-option__key {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex-shrink: 0; border-radius: 8px;
  background: var(--color-bg-tertiary); border: 0.5px solid var(--color-border-tertiary);
  font-size: 12px; font-weight: 500; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-secondary);
}
.question-option__label { padding: 2px 6px 0; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-text-primary); }
.question-option:hover:not(:disabled) .question-option__key { background: var(--color-primary); color: var(--color-on-primary); border-color: transparent; }
.question-card.is-resolved .question-card__q, .question-card.is-resolved .question-card__hint { color: var(--color-text-tertiary); }
.question-card.is-resolved .question-option__key, .question-card.is-resolved .question-option__label { color: var(--color-text-quaternary); }
.question-card.is-resolved .question-option.is-chosen .question-option__label { color: var(--color-text-primary); }
.question-card.is-resolved .question-option.is-chosen .question-option__key { background: var(--bot-action, var(--color-primary)); color: var(--bot-on-action, #FFFFFF); border-color: transparent; }
.question-card__foot { display: flex; justify-content: flex-end; padding: 0 12px 10px; margin-top: -4px; }

/* draft card (screen 02) */
.draft-card__head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 16px 4px; }
.draft-card__tile { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 8px; background: var(--color-primary); flex-shrink: 0; }
.draft-card__titles { display: flex; flex-direction: column; flex: 1 1 0; padding: 2px 0; }
.draft-card__channel { font-size: 14px; font-weight: 500; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); }
.draft-card__from { font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-text-secondary); }
.draft-card__copy { display: flex; align-items: center; justify-content: center; width: 20px; height: 44px; border-radius: 6px; }
.draft-card__copy:hover { background: var(--color-bg-hover); }
.draft-card__content { display: flex; flex-direction: column; padding: 12px 16px 14px; }
.draft-card__to { display: flex; align-items: center; gap: 8px; padding: 10px 0; border-top: 1px solid var(--color-border-tertiary); border-bottom: 1px solid var(--color-border-tertiary); }
.draft-card__to-label { font-size: 14px; line-height: 20px; color: var(--color-text-secondary); }
.draft-card__to-avatar { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: #2F3336; color: #FFFFFF; font-size: 11px; font-weight: 600; line-height: 12px; box-shadow: #1C1C1C14 0 0 0 0.5px inset; }
.draft-card__to-name { font-size: 14px; font-weight: 600; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.draft-card__subject { padding-top: 12px; font-size: 14px; font-weight: 600; line-height: 20px; }
.draft-card__text { padding-top: 12px; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
.draft-card__actions { display: flex; gap: 8px; padding: 10px 16px 16px; }
`

const SCOPE = ':where([data-gbo-root], [data-gbo-root] *)'
const ROOT = '[data-gbo-root]'
const DARK_ROOT = '.dark [data-gbo-root], [data-gbo-root][data-gbo-theme="dark"]'
const KEYFRAMES = ['rise', 'breathe', 'shimmer', 'bob', 'slideIn']
const ZOOM = 0.896

/** Split on a character at the top level (not inside (), [] or quotes). */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth += 1
    else if (c === ')' || c === ']') depth -= 1
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

/** One selector, scoped on its first compound: that element is the override
 *  root or inside it. :where() adds no specificity. */
function scopeSelector(raw: string): string {
  const sel = raw.trim()
  if (sel === ':root') return ROOT
  if (sel === ":root[data-theme='dark']") return DARK_ROOT
  if (sel === 'body') return ':where([data-gbo-root])'
  let depth = 0
  let end = sel.length
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i]
    if (c === '(' || c === '[') depth += 1
    else if (c === ')' || c === ']') depth -= 1
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) {
      end = i
      break
    }
  }
  const first = sel.slice(0, end)
  const pseudo = first.indexOf('::')
  const at = pseudo >= 0 ? pseudo : first.length
  return `${first.slice(0, at)}${SCOPE}${first.slice(at)}${sel.slice(end)}`
}

const px = (value: string) => {
  const n = Number(value)
  if (!(Math.abs(n) > 1)) return `${value}px`
  return `${Number((n / ZOOM).toFixed(2))}px`
}

/** Declarations: renamed custom properties, bot colours, keyframes, zoom. */
function adaptBlock(block: string): string {
  return block
    .replace(/var\(--bot-on-action, #FFFFFF\)/g, 'var(--gbo-tint-fg, var(--g-color-on-primary))')
    .replace(/--bot-bubble\b/g, '--gbo-tint-bg')
    .replace(/--bot-action-hover\b/g, '--gbo-action-hover')
    .replace(/--bot-action\b/g, '--gbo-action')
    .replace(/--bot-on-action\b/g, '--gbo-tint-fg')
    .replace(/--(?!gbo-|g-|paragraph-gap\b|conversation-text-font-size\b|dt-line-height\b)([a-z][\w-]*)/g, '--g-$1')
    .replace(/(animation:[^;]*)/g, decl => decl.replace(new RegExp(`\\b(${KEYFRAMES.join('|')})\\b`, 'g'), 'gbo-ref-$1'))
    .replace(/(?<![\w.#-])(-?\d*\.?\d+)px\b/g, (_m, v) => px(v))
}

/** Adapt a stylesheet: scope every rule, rename keyframes, recurse into @media. */
export function refCss(css: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let out = ''
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    const prelude = text.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < text.length && depth) {
      if (text[j] === '{') depth += 1
      else if (text[j] === '}') depth -= 1
      j += 1
    }
    const inner = text.slice(open + 1, j - 1)
    if (prelude.startsWith('@keyframes')) {
      const name = prelude.slice('@keyframes'.length).trim()
      out += `@keyframes gbo-ref-${name} {${adaptBlock(inner)}}\n`
    } else if (prelude.startsWith('@media')) {
      out += `${prelude} {\n${refCss(inner)}}\n`
    } else {
      const selectors = splitTop(prelude, ',').map(scopeSelector).join(', ')
      out += `${selectors} {${adaptBlock(inner)}}\n`
    }
    i = j
  }
  return out
}

export const REF_STYLES = refCss(REF_CSS)
