// Styles for the chat-parity surfaces (PARITY C11 cards, C13 tool detail, C15
// media, C19/C20 composer popovers, C22/C23 message actions, R14 rooms).
// Same tokens and scoping as styles.ts (Rakazo palette, Apache-2.0); layout is
// the override's own. Appended to CSS by styles.ts.

export const CHAT_CSS = /* css */ `
/* ── C11 question cards ─────────────────────────────────────────────── */
.gbo-card.is-question { border-color: var(--gbo-ring); }
.gbo-q { display: flex; flex-direction: column; gap: 8px; border: 0; margin: 0; padding: 0; min-width: 0; }
.gbo-q legend { font: var(--gbo-text-body); font-weight: 500; padding: 0; margin-bottom: 6px; }
.gbo-choices { display: flex; flex-wrap: wrap; gap: 6px; }
.gbo-choice {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 14px;
  border: 1px solid var(--gbo-border); background: var(--gbo-bg); cursor: pointer; text-align: left;
  font: var(--gbo-text-body-sm); white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%;
}
.gbo-choice:hover { background: var(--gbo-accent); }
.gbo-choice.is-on { border-color: var(--gbo-ring); background: var(--gbo-accent); }
.gbo-choice-tag { font: var(--gbo-text-caption); color: var(--gbo-success); }
.gbo-input {
  height: 34px; padding: 0 12px; border-radius: 12px; border: 1px solid var(--gbo-border);
  background: var(--gbo-bg); color: var(--gbo-fg); font: var(--gbo-text-body-sm); outline: 0; min-width: 0;
}
.gbo-input:focus { border-color: var(--gbo-ring); }
.gbo-link-btn { border: 0; background: none; color: var(--gbo-link); cursor: pointer; padding: 0 0 0 6px; font: inherit; }
.gbo-target { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 12px; background: var(--gbo-bg); border: 1px solid var(--gbo-border); }
.gbo-target-head { display: flex; align-items: baseline; gap: 8px; }
.gbo-target-name { flex: 1; font: var(--gbo-text-body); font-weight: 500; }
.gbo-target-state { font: var(--gbo-text-caption); color: var(--gbo-muted-fg); }
.gbo-target-state.is-connected { color: var(--gbo-success); }
.gbo-target-state.is-failed, .gbo-target-state.is-expired { color: var(--gbo-destructive); }

/* ── C13 tool detail ────────────────────────────────────────────────── */
.gbo-tools li.has-detail { display: block; }
.gbo-tool-detail > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; }
.gbo-tool-detail > summary::-webkit-details-marker { display: none; }
.gbo-tool-detail[open] { padding-bottom: 6px; }
.gbo-tool-block { margin: 6px 0 0 22px; min-width: 0; }
.gbo-tool-block-label { font: var(--gbo-text-caption); color: var(--gbo-faint-fg); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 2px; }
.gbo-tool-block pre {
  margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--gbo-accent); max-height: 18rem; overflow: auto;
  font: 12px/17px var(--gbo-mono); white-space: pre-wrap; overflow-wrap: anywhere;
}
.gbo-diff .is-add { color: var(--gbo-success); }
.gbo-diff .is-del { color: var(--gbo-destructive); }
.gbo-diff .is-hunk, .gbo-diff .is-file { color: var(--gbo-faint-fg); }

/* ── C15 media ──────────────────────────────────────────────────────── */
.gbo-media { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.gbo-media-image { display: block; max-width: min(100%, 360px); border-radius: 12px; overflow: hidden; border: 1px solid var(--gbo-border); }
.gbo-media-image img { display: block; max-width: 100%; height: auto; }
.gbo-media-image.is-loading { width: 160px; height: 110px; background: var(--gbo-accent); }
.gbo-media-audio { width: min(100%, 320px); }
.gbo-media-video { max-width: min(100%, 420px); border-radius: 12px; }
.gbo-media-file {
  display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border-radius: 999px;
  border: 1px solid var(--gbo-border); background: var(--gbo-bg); font: var(--gbo-text-body-sm); cursor: pointer;
}
.gbo-media-file.is-error { color: var(--gbo-destructive); cursor: default; }

/* ── C19 / C20 composer popover, command cards, C29 mic ─────────────── */
.gbo-composer-wrap { position: relative; }
.gbo-popover {
  position: absolute; left: 12px; right: 12px; bottom: calc(100% - 4px); z-index: 5; max-height: 260px; overflow: auto;
  background: var(--gbo-popover); border: 1px solid var(--gbo-border); border-radius: 14px; box-shadow: var(--gbo-shadow); padding: 4px;
}
.gbo-popover-row {
  display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 10px;
  background: transparent; text-align: left; cursor: pointer;
}
.gbo-popover-row.is-active, .gbo-popover-row:hover { background: var(--gbo-accent); }
.gbo-popover-main { font: var(--gbo-text-body-sm); font-weight: 500; white-space: nowrap; }
.gbo-popover-meta { font: var(--gbo-text-label); color: var(--gbo-muted-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gbo-command { align-self: stretch; border: 1px solid var(--gbo-border); border-radius: 14px; padding: 8px 12px; background: var(--gbo-card); }
.gbo-command-head { font: 12px/18px var(--gbo-mono); color: var(--gbo-muted-fg); }
.gbo-command pre { margin: 4px 0 0; font: 12px/18px var(--gbo-mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 20rem; overflow: auto; }
.gbo-command.is-error pre { color: var(--gbo-destructive); }
.gbo-round.is-recording { color: var(--gbo-destructive); }

/* ── C22 / C23 message actions and reactions ────────────────────────── */
.gbo-msg-actions { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .12s; }
.gbo-msg:hover .gbo-msg-actions, .gbo-msg:focus-within .gbo-msg-actions { opacity: 1; }
.gbo-msg.is-user .gbo-msg-actions { justify-content: flex-end; }
.gbo-act { width: 26px; height: 26px; font-size: 14px; }
.gbo-react-wrap { position: relative; display: inline-flex; }
.gbo-react-picker {
  position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); z-index: 4; display: flex; gap: 2px; padding: 4px;
  border-radius: 999px; background: var(--gbo-popover); border: 1px solid var(--gbo-border); box-shadow: var(--gbo-shadow);
}
.gbo-react-picker button { border: 0; background: transparent; font-size: 18px; width: 30px; height: 30px; border-radius: 999px; cursor: pointer; }
.gbo-react-picker button:hover { background: var(--gbo-accent); }
.gbo-reactions { display: flex; gap: 4px; margin-top: 2px; }
.gbo-msg.is-user .gbo-reactions { justify-content: flex-end; }
.gbo-reaction { border: 1px solid var(--gbo-border); background: var(--gbo-card); border-radius: 999px; padding: 0 7px; height: 24px; font-size: 13px; cursor: pointer; }
.gbo-reaction.is-mine { border-color: var(--gbo-ring); }
.gbo-reaction:disabled { cursor: default; opacity: 1; }
.gbo-edit { display: flex; flex-direction: column; gap: 6px; align-self: stretch; }
.gbo-edit-box { height: auto; min-height: 72px; padding: 8px 12px; resize: vertical; font: var(--gbo-text-body); }
.gbo-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font: var(--gbo-text-body-sm); color: var(--gbo-muted-fg); }

/* ── R16 row dot ────────────────────────────────────────────────────── */
.gbo-row-dot { display: inline-flex; align-items: center; flex: none; }

/* ── R14 group chats ────────────────────────────────────────────────── */
.gbo-section-head.is-rooms { display: flex; align-items: center; padding-right: 6px; }
.gbo-section-toggle { display: inline-flex; align-items: center; gap: 6px; flex: 1; border: 0; background: none; cursor: pointer; padding: 0; font: inherit; color: inherit; text-align: left; }
.gbo-room-faces { display: inline-flex; flex: none; }
.gbo-room-faces > * + * { margin-left: -8px; }
.gbo-room-row .gbo-room-faces { width: 38px; justify-content: center; }
.gbo-new-group { display: flex; flex-direction: column; gap: 8px; margin: 4px 10px 8px; padding: 10px; border-radius: 14px; background: var(--gbo-card); border: 1px solid var(--gbo-border); }
.gbo-pick { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
.gbo-pick-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 10px; font: var(--gbo-text-body-sm); cursor: pointer; }
.gbo-pick-row.is-on { background: var(--gbo-accent); }
.gbo-room-head { cursor: default; }
.gbo-room-bar { padding: 6px 16px; }
.gbo-room-msg { flex-direction: row; align-items: flex-start; gap: 8px; }
.gbo-room-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gbo-room-author { font: var(--gbo-text-label); color: var(--gbo-muted-fg); }
.gbo-room-author.is-user { align-self: flex-end; }
`