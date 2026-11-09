// The override's glue on top of the reference layout CSS (styles-ref.ts):
// how its classes sit inside Hermes's panes, and the override's own features
// (pins, filters, sections, jobs, Slack, hover actions, work rows, markdown
// inside bubbles, question cards) drawn in the same idiom. Written in the
// reference's own units and token names and run through the same refCss()
// adapter, so it is scoped, uses the same --g-* tokens and is divided by
// Hermes's zoom exactly like the reference rules. It comes last in CSS, so
// it wins ties.

import { refCss } from './styles-ref'

const ADAPT_SRC = /* css */ `
/* ── panes ──────────────────────────────────────────────────────────── */
/* The roster fills Hermes's sidebar zone (its width is Hermes's); Hermes
   draws the sidebar | workspace hairline itself. */
.gbo-roster.sidebar { width: 100%; border-right: 0; }
.sidebar__titlebar { -webkit-app-region: drag; }
.sidebar__controls { -webkit-app-region: no-drag; }
.gbo-ws { position: relative; display: flex; overflow: hidden; background: var(--color-bg-chrome); }
.gbo-ws .chat { min-width: 0; }

/* Icons inside the reference's round and plain buttons. */
.icon-btn svg, .composer__btn svg, .composer__cta svg { width: 16px; height: 16px; flex: none; }
.icon-btn > svg { opacity: 0.66; }
.composer__btn > svg { opacity: 0.56; }
.icon-btn.is-on { background: var(--color-bg-active); }
.icon-btn:disabled { opacity: 0.4; cursor: default; }
.icon-btn--plain { color: var(--color-text-primary); }

/* ── roster: search field (with the filters), sections, rows ────────── */
.gbo-search-row { padding: 0 12px 8px; }
.gbo-search.text-input { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 4px 0 10px; cursor: text; }
.gbo-search.text-input:focus-within { border-color: var(--color-border-focus); box-shadow: 0 0 0 3px #1E86FC22; }
.gbo-search > svg { width: 14px; height: 14px; opacity: 0.56; flex: none; }
.gbo-search input { flex: 1 1 0; min-width: 0; height: 100%; border: 0; outline: none; padding: 0; background: transparent; color: var(--color-ink); }
.gbo-search input::placeholder { color: var(--color-text-quaternary); }
.gbo-search-filter { position: relative; display: inline-flex; flex: none; }
.gbo-search-filter .icon-btn.has-filters { color: var(--color-border-focus); background: var(--color-bg-hover); }
.gbo-search-filter .gbo-filter-count { right: -2px; top: -4px; transform: none; }

.bot-list + .bot-list, .pinned + .bot-list { margin-top: 2px; }
.gbo-section-head {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 14px 8px 6px;
  font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-secondary); text-align: left;
}
.bot-list:first-child > .gbo-section-head, .pinned + .bot-list > .gbo-section-head { padding-top: 4px; }
.gbo-section-head:hover { color: var(--color-text-primary); }
.gbo-section-head svg { order: 1; width: 12px; height: 12px; opacity: 0; transition: transform 160ms var(--ease-out), opacity 120ms; }
.gbo-section-head:hover svg, .gbo-section-head:focus-visible svg, .gbo-section-head[aria-expanded="false"] svg { opacity: 0.66; }
.gbo-section-head[aria-expanded="false"] svg { transform: rotate(-90deg); }
.gbo-section-head .gbo-count { order: 2; margin-left: auto; font-size: 12px; color: var(--color-text-tertiary); opacity: 0; transition: opacity 120ms; }
.gbo-section-head:hover .gbo-count, .gbo-section-head:focus-visible .gbo-count { opacity: 1; }
.gbo-section-head:disabled { cursor: default; }
.gbo-section-head.is-rooms { padding-right: 4px; }
.gbo-section-head.is-rooms .icon-btn--plain { width: 22px; height: 22px; }

.bot-row { color: inherit; text-align: left; }
.bot-row.is-dim { opacity: 0.55; }
.bot-row.is-hidden { opacity: 0.6; }
.gbo-row-line { display: flex; align-items: center; gap: 4px; min-width: 0; }
.gbo-row-line > .bot-row__name { flex: 0 1 auto; min-width: 0; }
.gbo-row-line > svg, .gbo-row-line .gbo-attn, .gbo-row-line .gbo-row-flag { width: 12px; height: 12px; flex: none; color: var(--color-text-tertiary); }
.gbo-row-line .gbo-attn { color: var(--color-warn); }
.gbo-row-line .gbo-attn svg, .gbo-row-line .gbo-row-flag svg { width: 100%; height: 100%; display: block; }
/* The live status (unread, working, needs input) is Hermes's own dot,
   placed as the reference's status dot: the avatar's top right, ringed in
   the sidebar colour. Its idle and draft dots carry no live state (no
   role="status") and are not drawn. */
.bot-row__avatar .gbo-row-dot, .pinned__avatar .gbo-row-dot { position: absolute; right: -1px; top: -1px; line-height: 0; }
.pinned__avatar .gbo-row-dot { right: 4px; top: 4px; }
.gbo-row-face .gbo-row-dot:not(:has([role="status"])) { display: none; }
.gbo-row-face .gbo-row-dot [role="status"] { width: 8px; height: 8px; border-width: 0; box-shadow: 0 0 0 2.5px var(--color-bg-sidebar); }
.bot-row.is-selected .gbo-row-dot [role="status"], .bot-row:hover .gbo-row-dot [role="status"] { box-shadow: 0 0 0 2.5px var(--color-bg-active-solid); }
.gbo-room-row .bot-row__avatar { width: 36px; justify-content: center; }
.gbo-row-more {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%); width: 28px; height: 28px; opacity: 0;
  background: var(--color-bg-pane); box-shadow: var(--shadow-pill);
}

/* Pinned bots: the reference's one centred tile; two to four share the row. */
.pinned.gbo-pins { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 4px; }
.pinned.gbo-pins.is-1 { display: flex; justify-content: center; }
.gbo-pin-wrap { min-width: 0; display: flex; justify-content: center; }
.pinned__tile { color: inherit; max-width: 100%; }
.pinned:not(.is-1) .pinned__tile { width: 100%; padding: 6px 4px 4px; }
.pinned:not(.is-1) .pinned__label { width: 100%; }
.pinned__tile.is-dim { opacity: 0.55; }
.pinned__tile[aria-current="true"] .pinned__label { font-weight: 500; }

.gbo-roster-empty { padding: 24px 16px; font-size: 13px; line-height: 18px; color: var(--color-text-secondary); text-align: center; }
.gbo-hidden-head { margin-top: 6px; border-top: 0.5px solid var(--color-border-tertiary); }
.gbo-source-retry { margin: 0 12px 8px; border-radius: 12px; font-size: 13px; line-height: 18px; }
.account__btn { cursor: default; }
.account__btn:hover { background: none; }

/* ── chat header ────────────────────────────────────────────────────── */
.chat__header { -webkit-app-region: drag; }
.chat__header > * { -webkit-app-region: no-drag; }
/* The sidebar toggle while Hermes's sidebar is collapsed: past the
   window's traffic lights. */
.gbo-head-left { position: absolute; left: 76px; top: 18px; display: flex; }
.chat__pill { color: inherit; }
.share-btn { white-space: nowrap; }
.chat__header-right .icon-btn--bordered { color: var(--color-text-primary); }

/* ── transcript: groups, bubbles, hover times and actions ───────────── */
.transcript.gbo-oscroll-view { position: absolute; inset: 0; }
.gbo-room-transcript.transcript { position: relative; inset: auto; flex: 1 1 0; min-height: 0; }
.transcript__col > .gbo-msg { max-width: 100%; }
.gbo-msg { position: relative; display: flex; flex-direction: column; max-width: 100%; min-width: 0; }
.group.is-right > .gbo-msg, .transcript__col > .gbo-msg.is-user { align-items: flex-end; align-self: flex-end; }
.group.is-left > .gbo-msg { align-items: flex-start; }
.gbo-msg:has(> .gbo-edit) { align-self: stretch; }
.bubble.is-user { color: var(--gbo-tint-fg, #FFFFFF); }
.bubble.is-user a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.bubble.is-user code { background: #FFFFFF2E; border-radius: 4px; padding: 1px 4px; font-family: var(--font-mono-stack); font-size: 13px; }
.bubble.is-streaming > .bubble__plain::after {
  content: ''; display: inline-block; width: 7px; height: 7px; margin-left: 4px; border-radius: 50%;
  background: currentColor; opacity: 0.4; vertical-align: middle; animation: breathe 1s ease-in-out infinite;
}
/* Copy, react, edit, rewind, regenerate: a small pill that floats under the
   message while it is pointed at, taking no room in the transcript. */
.gbo-msg > .gbo-msg-actions {
  position: absolute; top: calc(100% - 6px); z-index: 3; display: flex; align-items: center; gap: 2px; margin: 0; padding: 2px;
  border-radius: var(--radius-full); background: var(--color-bg-pane); border: 0.5px solid var(--color-border-tertiary); box-shadow: var(--shadow-pill);
  opacity: 0; pointer-events: none; transition: opacity 120ms var(--ease-out);
}
.gbo-msg:hover > .gbo-msg-actions, .gbo-msg:focus-within > .gbo-msg-actions { opacity: 1; pointer-events: auto; }
.gbo-msg.is-bot > .gbo-msg-actions { left: 8px; }
.gbo-msg.is-user > .gbo-msg-actions { right: 8px; }
.gbo-msg-actions .gbo-icon-btn { width: 24px; height: 24px; font-size: 13px; }
.gbo-msg-actions .gbo-icon-btn svg { width: 14px; height: 14px; }
.gbo-msg-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; padding: 0 4px; font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-tertiary); }
.gbo-msg-failed { color: var(--color-danger-text); }
.gbo-reactions { margin-top: 4px; }
.gbo-reaction { height: 22px; padding: 0 7px; border: 0; border-radius: var(--radius-full); background: var(--color-bg-elevated); box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset; font-size: 12px; }
.gbo-reaction.is-mine { box-shadow: var(--color-border-focus) 0 0 0 1px inset; }
.gbo-attach-chips { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; margin-bottom: 4px; }
.gbo-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: var(--radius-full);
  background: var(--color-bg-elevated); box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset;
  font-size: 12px; line-height: 16px; letter-spacing: 0.12px; color: var(--color-text-secondary);
}
.gbo-chip button { border: 0; background: transparent; padding: 0; line-height: 0; color: inherit; cursor: pointer; }
.gbo-chip svg { width: 12px; height: 12px; }
.gbo-edit { display: flex; flex-direction: column; gap: 6px; align-self: stretch; }
.gbo-confirm { font-size: 13px; line-height: 18px; color: var(--color-text-secondary); }

/* Bot markdown goes through Hermes's own renderer (.aui-md, sized for its
   13px conversation text); inside a bubble it takes the reference's
   markdown rules at the bubble's own size and rhythm. */
.md .aui-md {
  --paragraph-gap: 10px; --conversation-text-font-size: 15px; --dt-line-height: 22px;
  font: inherit; color: inherit; letter-spacing: inherit; max-width: none; width: auto; overflow: visible;
}
.md .aui-md :is(p, li, ul, ol, blockquote, table, dl) { font-size: inherit; line-height: inherit; letter-spacing: inherit; }
.md .aui-md > *, .md .aui-md :is(p, ul, ol, blockquote, pre, h1, h2, h3, h4, table) { margin: 0; }
.md .aui-md > * + *,
.md .aui-md :is(p, ul, ol, blockquote, pre, h1, h2, h3, h4, table, div) + :is(p, ul, ol, blockquote, pre, h1, h2, h3, h4, table, div) { margin-top: 10px; }
.md .aui-md :is(ul, ol) { padding-left: 22px; }
.md .aui-md ul { list-style: disc; }
.md .aui-md ol { list-style: decimal; }
.md .aui-md li { margin: 0; padding-left: 0; }
.md .aui-md li + li { margin-top: 2px; }
.md .aui-md li > p { margin: 0; }
.md .aui-md li::marker { color: var(--color-text-tertiary); }
.md .aui-md a { color: var(--color-text-primary); font-weight: inherit; text-decoration: underline; text-decoration-color: var(--color-border-primary); text-underline-offset: 2px; }
.md .aui-md a:hover { text-decoration-color: currentColor; }
.md .aui-md :is(strong, b) { font-weight: 600; color: inherit; }
.md .aui-md :is(h1, h2, h3, h4, h5, h6) { font-size: 15px; line-height: 22px; font-weight: 600; letter-spacing: inherit; color: inherit; }
.md .aui-md h1 { font-size: 17px; line-height: 24px; }
.md .aui-md blockquote { padding-left: 10px; border-left: 2px solid var(--color-border-primary); color: var(--color-text-secondary); font-style: normal; }
.md .aui-md :not(pre) > code { font-family: var(--font-mono-stack); font-size: 13px; font-weight: inherit; line-height: inherit; background: var(--color-bg-tertiary); padding: 1px 4px; border-radius: 4px; color: inherit; }
.md .aui-md code::before, .md .aui-md code::after { content: none; }
.md .aui-md pre {
  background: var(--color-bg-subtle); border-radius: var(--radius-sm); padding: 8px 12px; overflow-x: auto;
  font-family: var(--font-mono-stack); font-size: 13px; line-height: 20px; letter-spacing: 0.15px; color: var(--color-text-secondary);
}
.md .aui-md pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; }
.md .aui-md hr { border: 0; border-top: 1px solid var(--color-border-tertiary); }
.md .aui-md table { border-collapse: collapse; font-size: 14px; line-height: 20px; }
.md .aui-md :is(th, td) { border-bottom: 0.5px solid var(--color-border-secondary); padding: 4px 10px 4px 0; text-align: left; vertical-align: top; }
.md .aui-md img { max-width: 100%; border-radius: 8px; }
/* Small images and emoji inside a line of text sit on the text. */
.md .aui-md :is(p, li) > img { display: inline-block; height: 1.15em; width: auto; vertical-align: -0.2em; border-radius: 3px; }
.gbo-media { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }

/* Thought and tool rows (when shown): the reference's collapsed steps. */
.gbo-think, .gbo-tools-wrap { margin: -4px 0 0; }
.gbo-think > summary, .gbo-tools > summary {
  list-style: none; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; margin-left: 4px; border-radius: var(--radius-full);
  font-size: 12px; line-height: 16px; letter-spacing: 0.12px; font-weight: 400; color: var(--color-text-tertiary); cursor: pointer; user-select: none;
}
.gbo-think > summary:hover, .gbo-tools > summary:hover { background: var(--color-bg-hover); color: var(--color-text-secondary); }
.gbo-think > summary svg, .gbo-tools > summary svg { order: 1; width: 10px; height: 10px; opacity: 0.66; transform: rotate(90deg); transition: transform 160ms var(--ease-out); }
.gbo-think[open] > summary svg, .gbo-tools[open] > summary svg { transform: rotate(-90deg); }
.gbo-think-body {
  margin: 6px 0 4px 12px; padding: 0 0 0 12px; border-left: 1px solid var(--color-border-tertiary);
  font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-secondary); white-space: pre-wrap;
}
.gbo-tools ul {
  list-style: none; margin: 6px 0 4px 12px; padding: 0 0 0 12px; border-left: 1px solid var(--color-border-tertiary);
  display: flex; flex-direction: column; gap: 6px;
}
.gbo-tools li { display: flex; align-items: baseline; gap: 6px; font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-primary); }
.gbo-tools li .gbo-tool-mark { width: 12px; flex: none; text-align: center; color: var(--color-success); }
.gbo-tools li.is-error .gbo-tool-mark { color: var(--color-danger); }
.gbo-tools li.is-running .gbo-tool-mark { color: var(--color-warn); }
.gbo-tool-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gbo-tool-dur { flex: none; font-size: 12px; color: var(--color-text-tertiary); }
.gbo-activity { display: flex; align-items: center; gap: 8px; padding: 2px 4px; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; }
.gbo-plain { white-space: pre-wrap; }
.gbo-activity .gbo-shimmer, .gbo-tools-wrap .gbo-shimmer {
  color: transparent; background: linear-gradient(90deg, var(--color-text-tertiary) 0%, var(--color-text-tertiary) 35%, var(--color-text-primary) 50%, var(--color-text-tertiary) 65%, var(--color-text-tertiary) 100%);
  background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; animation: shimmer 1.4s linear infinite;
}
.activity-line__mark .gbo-avatar { width: 20px; height: 20px; }

/* Approval card (the reference's card) and the override's other cards
   (questions, group chats) in its question-card idiom. */
.card__body code {
  display: block; max-height: 144px; overflow: auto; padding: 8px 12px; border-radius: var(--radius-sm); background: var(--color-bg-subtle);
  font-family: var(--font-mono-stack); font-size: 13px; line-height: 20px; color: var(--color-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere;
}
.card__actions { flex-wrap: wrap; }
.card__actions .btn { flex: 1 1 auto; }
.card__outcome.is-ok { color: var(--color-success-text); }
.gbo-card {
  align-self: flex-start; width: 560px; max-width: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px; border: 0; border-radius: var(--radius-card); background: var(--color-bg-pane); box-shadow: var(--shadow-card);
}
.gbo-card.is-question { box-shadow: var(--color-border-tertiary) 0 0 0 1px inset; }
.gbo-card-title { font-size: 15px; font-weight: 600; line-height: 22px; letter-spacing: 0.15px; color: var(--color-text-primary); }
.gbo-card-desc { font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-text-tertiary); }
.gbo-card-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.gbo-card-error { font-size: 13px; line-height: 18px; color: var(--color-danger-text); }
.gbo-q legend { font-size: 15px; font-weight: 600; line-height: 22px; }
.gbo-choice {
  padding: 8px 12px; border: 0; border-radius: 12px; background: var(--color-bg-tertiary); box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset;
  font-size: 14px; line-height: 20px; color: var(--color-text-primary);
}
.gbo-choice:hover { background: var(--color-bg-secondary-hover); }
.gbo-choice.is-on { background: var(--color-primary); color: var(--color-on-primary); }
.gbo-command { border: 0; border-radius: 12px; background: var(--color-bg-subtle); }

/* Buttons the override keeps: in the reference's .btn--sm idiom. */
.gbo-pill-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 6px 12px;
  border: 0; border-radius: var(--radius-full); background: var(--color-bg-tertiary); box-shadow: var(--color-border-secondary) 0 0 0 0.5px inset;
  color: var(--color-ink); font-size: 14px; line-height: 20px; letter-spacing: 0.14px; white-space: nowrap; cursor: pointer;
  transition: background-color 120ms var(--ease-out);
}
.gbo-pill-btn:hover:not(:disabled) { background: var(--color-bg-secondary-hover); }
.gbo-pill-btn:disabled { opacity: 0.5; cursor: default; }
.gbo-pill-btn.is-primary { background: var(--color-primary); color: var(--color-bg-chrome); box-shadow: none; }
.gbo-pill-btn.is-primary:hover:not(:disabled) { background: var(--color-bg-primary-hover); }
.gbo-pill-btn.is-primary:disabled { background: var(--color-bg-primary-disabled); color: var(--color-text-quaternary); opacity: 1; }
.gbo-msg-meta .gbo-pill-btn { height: 24px; padding: 2px 10px; font-size: 12px; line-height: 16px; }
.gbo-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: none;
  border: 0; border-radius: 6px; background: transparent; color: var(--color-icon-secondary); cursor: pointer;
}
.gbo-icon-btn:hover:not(:disabled) { background: var(--color-bg-hover); color: var(--color-text-primary); }
.gbo-icon-btn:disabled { opacity: 0.4; cursor: default; }
.gbo-icon-btn svg { width: 16px; height: 16px; }
.btn:disabled { cursor: default; }
.gbo-link-btn { color: var(--color-text-secondary); text-decoration: underline; text-underline-offset: 2px; }
.gbo-link-btn:hover:not(:disabled) { color: var(--color-text-primary); }

/* Opening, empty and error states. */
.gbo-center { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px 24px; text-align: center; }
.gbo-center h2 { margin: 12px 0 0; font-size: 17px; font-weight: 500; line-height: 24px; letter-spacing: 0.17px; color: var(--color-text-primary); }
.gbo-center p { margin: 0; max-width: 380px; font-size: 14px; line-height: 20px; color: var(--color-text-secondary); }
.gbo-center .gbo-card-actions { justify-content: center; margin-top: 6px; }
.empty-chat .gbo-avatar { margin-bottom: 0; }

/* ── composer ───────────────────────────────────────────────────────── */
.composer-area { z-index: 2; }
.composer.has-chips { flex-wrap: wrap; }
.gbo-composer-chips { flex: 1 0 100%; display: flex; flex-wrap: wrap; gap: 4px; padding: 10px 2px 0; }
.composer__btn:disabled, .composer__cta:disabled { opacity: 0.45; cursor: default; }
.composer__btn.is-recording { color: var(--color-danger); background: var(--color-danger-bg); }
.composer__btn.is-recording > svg { opacity: 1; }
.composer__input:disabled { cursor: default; }
.gbo-composer-note {
  max-width: 960px; margin: 8px auto 0; display: flex; align-items: center; justify-content: center; gap: 8px;
  font-size: 13px; line-height: 18px; color: var(--color-text-secondary);
}
.gbo-composer-note.gbo-msg-failed { padding: 6px 12px; border-radius: 12px; background: var(--color-danger-bg); color: var(--color-danger-text); justify-content: space-between; }
.gbo-composer-note button { border: 0; background: transparent; padding: 4px 6px; border-radius: 6px; color: inherit; font-size: 13px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.gbo-composer-note button:hover { background: var(--color-bg-hover); }
/* Command and @mention completions: the reference's menu. */
.gbo-popover {
  position: absolute; left: 16px; right: 16px; bottom: calc(100% - 10px); z-index: 5; max-width: 960px; max-height: 280px; margin: 0 auto; overflow: auto;
  padding: 4px; border-radius: 12px; background: var(--color-bg-pane); border: 0.5px solid var(--color-border-secondary); box-shadow: var(--shadow-popover);
}
.gbo-popover-row { display: flex; align-items: center; gap: 12px; min-height: 30px; padding: 4px 10px; border: 0; border-radius: 6px; font-size: 13px; line-height: 18px; }
.gbo-popover-row.is-active, .gbo-popover-row:hover { background: var(--color-bg-hover); }
.gbo-popover-main { font-size: 13px; font-weight: 500; }
.gbo-popover-meta { font-size: 12px; color: var(--color-text-tertiary); }

/* ── profile panel ──────────────────────────────────────────────────── */
.details.gbo-panel-dock { display: flex; flex-direction: row; }
.details__scroll.gbo-oscroll { flex: 1 1 0; min-width: 0; }
.details__top { -webkit-app-region: drag; }
.details__top > * { -webkit-app-region: no-drag; }
.gbo-drawer .details__top { height: 60px; }
.details__identity .gbo-panel-sub {
  max-width: 100%; margin-top: -12px; padding: 0 10px; text-align: center; overflow-wrap: anywhere;
  font-size: 13px; line-height: 18px; letter-spacing: 0.195px; color: var(--color-text-secondary);
}
.details__identity .gbo-panel-sub + .gbo-panel-sub { margin-top: -14px; }
.gbo-label-actions { display: flex; align-items: center; gap: 2px; }
.section-label .icon-btn--plain { width: 22px; height: 22px; }
.section-label .icon-btn--plain svg { width: 14px; height: 14px; }
.panel-row { border: 0; background: transparent; color: inherit; font: inherit; }
.panel-row__glyph > svg, .panel-row__icon > svg { width: 16px; height: 16px; opacity: 0.56; }
.panel-row__icon > svg { opacity: 0.52; }
.panel-row--link > svg:last-child { width: 12px; height: 12px; flex: none; opacity: 0.56; }
.panel-row--link > .panel-row__title { flex: 1 1 0; min-width: 0; }
.gbo-status-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--color-text-quaternary); }
.gbo-status-dot.is-on { background: var(--color-success); }
/* A job: the row opens its details; run, edit and delete float over its
   right side on hover or focus; the switch is the reference's toggle. */
.panel-row--routine { position: relative; height: auto; min-height: 48px; }
.panel-row--routine .panel-row__text { padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.panel-row--routine .gbo-job-error { color: var(--color-danger-text); }
.gbo-job-actions {
  position: absolute; right: 46px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; padding: 2px;
  border-radius: var(--radius-full); background: var(--color-bg-pane); box-shadow: var(--shadow-pill);
  opacity: 0; pointer-events: none; transition: opacity 120ms var(--ease-out);
}
.gbo-job:hover .gbo-job-actions, .gbo-job:focus-within .gbo-job-actions { opacity: 1; pointer-events: auto; }
.gbo-job-actions .icon-btn--plain { width: 24px; height: 24px; }
.gbo-job-actions .icon-btn--plain svg { width: 14px; height: 14px; }
.toggle { border: 0; cursor: pointer; }
.toggle:disabled { opacity: 0.5; cursor: default; }
.panel-empty { overflow-wrap: anywhere; }
.gbo-slack-card.is-status { height: auto; min-height: 48px; }
.gbo-slack-card .gbo-slack-card-sub.is-error { color: var(--color-danger-text); }
.gbo-slack-card .gbo-slack-card-sub.is-warn { color: var(--color-warn-text); }
.gbo-meter { padding: 8px; }
.gbo-meter-line { font-size: 13px; line-height: 18px; color: var(--color-text-secondary); }
.gbo-meter-bar { background: var(--color-bg-tertiary); }
.gbo-meter-bar > span { background: var(--gbo-action, var(--color-primary)); }
.gbo-drawer { background: var(--color-bg-chrome); }
.gbo-drawer .details__body, .gbo-drawer .details__scroll { width: 100%; }
`

export const ADAPT_CSS = refCss(ADAPT_SRC)
