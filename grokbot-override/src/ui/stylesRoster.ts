/*
 * Styles for the roster-side parity surfaces: menus, dialogs, forms, the
 * filter bar, the Hidden section, the attention badge, the cron editor, the
 * profile config, the bot screen and the usage meter.
 *
 * Look adapted from Rakazo (https://github.com/elie222/rakazo @ c800ad5):
 * packages/ui-web/src/components/ui/{dialog,context-menu,dropdown-menu,
 * switch,checkbox,input}.tsx — rounded-xl dialog with a muted footer strip,
 * rounded-lg menus with a 1px ring, 6px item radius. Copyright 2026 Rakazo
 * contributors, Apache License 2.0 (LICENSE-APACHE-2.0). Modified 2026-11-08
 * by Thomas Bekkers: rewritten as plain CSS on the --gbo-* tokens.
 *
 * Menus and dialogs portal out of the plugin's panes (SDK Radix primitives),
 * so their roots carry [data-gbo-root] themselves; `height:auto` undoes the
 * pane rule for them.
 */

export const ROSTER_CSS = /* css */ `
[data-gbo-root].gbo-menu, [data-gbo-root].gbo-dialog-body, [data-gbo-root].gbo-floating { height: auto; width: auto; }

/* ── menus ─────────────────────────────────────────────────────────── */
[data-gbo-root].gbo-menu {
  min-width: 223px; max-width: 380px; max-height: min(560px, calc(100vh - 16px)); overflow-y: auto;
  padding: 4.5px; border-radius: 13.4px; border: .5px solid var(--g-color-border-secondary); background: var(--g-color-bg-pane); color: var(--g-color-text-primary);
  box-shadow: var(--g-shadow-popover); font: 14.5px/20px var(--gbo-font); letter-spacing: .2px;
}
[data-gbo-root] .gbo-menu-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 33.5px; padding: 0 11px; border: 0;
  border-radius: 6.7px; background: transparent; color: inherit; font: inherit; text-align: left; white-space: nowrap;
  cursor: default; outline: none; user-select: none;
}
[data-gbo-root] .gbo-menu-item:hover, [data-gbo-root] .gbo-menu-item:focus, [data-gbo-root] .gbo-menu-item[data-highlighted] { background: var(--g-color-bg-hover); }
[data-gbo-root] .gbo-menu-item[data-disabled], [data-gbo-root] .gbo-menu-item:disabled { opacity: .45; pointer-events: none; }
[data-gbo-root] .gbo-menu-item.is-destructive { color: var(--g-color-danger); }
[data-gbo-root] .gbo-menu-item svg { width: 16px; height: 16px; flex: none; opacity: .66; }
[data-gbo-root] .gbo-menu-item .gbo-menu-check { margin-left: auto; color: var(--gbo-fg); }
[data-gbo-root] .gbo-menu-item .gbo-menu-meta { margin-left: auto; color: var(--g-color-text-tertiary); font-size: 13.4px; }
[data-gbo-root] .gbo-menu-sep { height: .5px; margin: 4px -4.5px; background: var(--g-color-border-secondary); border: 0; }
[data-gbo-root] .gbo-menu-label { padding: 6.7px 11px 2px; color: var(--g-color-text-tertiary); font-size: 13.4px; }
.gbo-row-wrap { position: relative; }
.gbo-row-more {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%); opacity: 0; width: 32px; height: 32px;
  background: var(--gbo-popover); box-shadow: 0 0 0 1px var(--gbo-border);
}
.gbo-row-wrap:hover .gbo-row-more, .gbo-row-more:focus-visible, .gbo-row-more[data-state="open"] { opacity: 1; }
/* Without the SDK dropdown the ⋯ trigger sits in an inline wrapper (inline
   position:relative, hence !important); pin that wrapper to the row's right
   edge so it never adds a line under the row. */
.gbo-row-wrap > span:has(> .gbo-row-more) { position: absolute !important; top: 0; right: 0; bottom: 0; width: 0; }
.gbo-inline-menu { position: absolute; right: 6px; top: calc(100% - 6px); z-index: 20; }

/* ── roster additions ──────────────────────────────────────────────── */
.gbo-filter-count {
  position: absolute; transform: translate(9px, -9px); min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px;
  background: var(--gbo-ring); color: #fff; font: 600 10px/15px var(--gbo-font);
}
.gbo-attn { width: 14px; height: 14px; flex: none; color: var(--gbo-warning); }
.gbo-row-flag { width: 11px; height: 11px; flex: none; color: var(--gbo-faint-fg); }
.gbo-hidden-head { border-top: 1px solid var(--gbo-border); margin-top: 6px; }
.gbo-row.is-hidden { opacity: .6; }
.gbo-source-retry {
  display: flex; align-items: center; gap: 8px; margin: 2px 10px 4px; padding: 8px 10px; border-radius: 12px;
  background: color-mix(in srgb, var(--gbo-warning) 12%, transparent); color: var(--gbo-fg); font: var(--gbo-text-label);
}
.gbo-source-retry span { flex: 1; min-width: 0; }
.gbo-link-btn { border: 0; background: transparent; padding: 0; color: var(--gbo-link); font: inherit; cursor: pointer; }
.gbo-link-btn:disabled { opacity: .5; cursor: default; }
.gbo-empty-card { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 18px 16px; color: var(--gbo-muted-fg); font: var(--gbo-text-body-sm); }

/* ── dialogs ───────────────────────────────────────────────────────── */
[data-gbo-root].gbo-dialog-body {
  display: flex; flex-direction: column; gap: 16px; padding: 22px 22px 0; background: var(--gbo-popover); color: var(--gbo-fg);
  max-height: calc(85vh - 2rem); overflow-y: auto; border-radius: 12px;
}
[data-gbo-root].gbo-dialog-body.is-wide { min-width: min(720px, 90vw); }
.gbo-dialog-title { margin: 0; font: var(--gbo-text-h3); font-weight: 600; }
.gbo-dialog-desc { margin: -10px 0 0; color: var(--gbo-muted-fg); font: var(--gbo-text-body-sm); }
.gbo-dialog-foot {
  position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 8px; margin: 4px -22px 0; padding: 14px 22px;
  border-top: 1px solid var(--gbo-border); background: color-mix(in srgb, var(--gbo-muted) 60%, var(--gbo-popover));
}
.gbo-dialog-foot .gbo-spacer { flex: 1; }
.gbo-modal-fallback { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: color-mix(in srgb, #000 40%, transparent); }
.gbo-modal-fallback > [data-gbo-root].gbo-dialog-body { width: min(660px, 92vw); box-shadow: var(--gbo-shadow); }

.gbo-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 18px;
  border-radius: 999px; border: 1px solid var(--gbo-border); background: var(--gbo-bg); color: var(--gbo-fg);
  font: var(--gbo-text-body-sm); font-weight: 500; cursor: pointer;
}
.gbo-btn:hover { background: var(--gbo-accent); }
.gbo-btn:disabled { opacity: .5; cursor: default; }
.gbo-btn.is-primary { background: var(--gbo-primary); color: var(--gbo-primary-fg); border-color: transparent; }
.gbo-btn.is-primary:disabled { background: var(--gbo-primary-disabled); color: var(--gbo-faint-fg); }
.gbo-btn.is-danger { background: var(--gbo-destructive); color: #fff; border-color: transparent; }
.gbo-btn.is-ghost { border-color: transparent; background: transparent; }
.gbo-btn.is-small { height: 32px; padding: 0 13px; font: var(--gbo-text-label); }
.gbo-btn svg { width: 18px; height: 18px; }

.gbo-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.gbo-field > span:first-child { color: var(--gbo-muted-fg); font: var(--gbo-text-label); font-weight: 500; }
.gbo-field-hint { color: var(--gbo-faint-fg); font: var(--gbo-text-caption); }
.gbo-input, .gbo-textarea, .gbo-select {
  width: 100%; min-width: 0; border-radius: 10px; border: 1px solid var(--gbo-input); background: var(--gbo-bg); color: var(--gbo-fg);
  font: var(--gbo-text-body-sm); padding: 9px 13px; outline: none;
}
.gbo-input:focus, .gbo-textarea:focus, .gbo-select:focus { border-color: var(--gbo-ring); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gbo-ring) 25%, transparent); }
.gbo-textarea { min-height: 72px; resize: vertical; }
.gbo-textarea.is-mono { font: 12px/18px var(--gbo-mono); min-height: 140px; }
.gbo-select { appearance: none; padding-right: 26px; background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%); background-position: calc(100% - 13px) 50%, calc(100% - 9px) 50%; background-size: 4px 4px; background-repeat: no-repeat; }
.gbo-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.gbo-check { display: flex; align-items: center; gap: 8px; font: var(--gbo-text-body-sm); color: var(--gbo-fg); cursor: pointer; min-width: 0; }
.gbo-check input { width: 15px; height: 15px; accent-color: var(--gbo-ring); flex: none; margin: 0; }
.gbo-check .gbo-check-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gbo-check .gbo-check-meta { margin-left: auto; color: var(--gbo-faint-fg); font: var(--gbo-text-caption); }
.gbo-check-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 14px; max-height: 190px; overflow-y: auto; padding: 8px 10px; border-radius: 12px; background: var(--gbo-card); }
.gbo-check-list.is-one { grid-template-columns: minmax(0, 1fr); }
.gbo-form-error { border-radius: 10px; padding: 8px 10px; color: var(--gbo-destructive); background: color-mix(in srgb, var(--gbo-destructive) 10%, transparent); font: var(--gbo-text-label); }
.gbo-form-note { border-radius: 10px; padding: 8px 10px; color: var(--gbo-muted-fg); background: var(--gbo-card); font: var(--gbo-text-label); }
.gbo-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--gbo-card); align-self: flex-start; }
.gbo-tabs button { border: 0; border-radius: 999px; padding: 4px 12px; background: transparent; color: var(--gbo-muted-fg); font: var(--gbo-text-label); font-weight: 500; cursor: pointer; }
.gbo-tabs button[aria-selected="true"] { background: var(--gbo-popover); color: var(--gbo-fg); box-shadow: 0 1px 2px #0002; }
.gbo-disclosure { border: 0; background: transparent; padding: 0; display: inline-flex; gap: 6px; align-items: center; color: var(--gbo-muted-fg); font: var(--gbo-text-label); font-weight: 500; cursor: pointer; align-self: flex-start; }
.gbo-disclosure svg { width: 12px; height: 12px; transition: transform .15s; }
.gbo-disclosure[aria-expanded="false"] svg { transform: rotate(-90deg); }
.gbo-section-card { border-radius: 14px; border: 1px solid var(--gbo-border); padding: 12px; display: flex; flex-direction: column; gap: 12px; }

/* avatar picker */
.gbo-avatar-hero { display: flex; justify-content: center; padding: 4px 0; }
.gbo-swatches { display: flex; flex-wrap: wrap; gap: 6px; }
.gbo-swatch { width: 24px; height: 24px; border-radius: 999px; border: 2px solid transparent; cursor: pointer; padding: 0; }
.gbo-swatch[aria-pressed="true"] { border-color: var(--gbo-fg); }
.gbo-swatch.is-auto { background: conic-gradient(#ff6b35, #eab308, #22c55e, #3b82f6, #a855f7, #ff6b35); }
.gbo-face-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 6px; }
.gbo-face-btn { border: 2px solid transparent; border-radius: 12px; background: var(--gbo-card); padding: 4px; cursor: pointer; display: grid; place-items: center; }
.gbo-face-btn[aria-pressed="true"] { border-color: var(--gbo-ring); }

/* jobs: the run / edit / delete buttons float over the row's right side on
   hover or focus, so the job name gets the full width otherwise. */
.gbo-job { position: relative; }
.gbo-job-actions {
  position: absolute; right: 58px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; opacity: 0;
  padding: 2px; border-radius: 999px; background: var(--gbo-surface); box-shadow: -10px 0 10px var(--gbo-surface); pointer-events: none;
}
.gbo-job:hover .gbo-job-actions, .gbo-job:focus-within .gbo-job-actions { opacity: 1; pointer-events: auto; }
.gbo-job-actions .gbo-icon-btn { width: 30px; height: 30px; }
.gbo-job-actions .gbo-icon-btn svg { width: 16px; height: 16px; }
.gbo-job-open > span { display: block; }
.gbo-job-open { flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; text-align: left; cursor: pointer; color: inherit; }
.gbo-detail-rows { display: flex; flex-direction: column; gap: 6px; }
.gbo-detail-row { display: flex; justify-content: space-between; gap: 12px; font: var(--gbo-text-label); }
.gbo-detail-row > span:first-child { color: var(--gbo-muted-fg); flex: none; }
.gbo-detail-row > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.gbo-pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12rem; overflow-y: auto; border-radius: 10px; background: var(--gbo-card); padding: 8px 10px; font: var(--gbo-text-label); }

/* Slack: the panel's two cards (one line "Add to Slack", "Slack · status")
   and the centred card modal both Slack dialogs use (kit Sheet). */
/* The panel cards themselves are reference panel rows (styles-ref.ts,
   styles-adapt.ts); only the mark's box is set here. */
.gbo-slack-card-mark { display: grid; place-items: center; }
.gbo-slack-ok { border-radius: 12px; padding: 9px 12px; color: var(--gbo-fg); background: color-mix(in srgb, var(--gbo-working-dot) 14%, transparent); font: var(--gbo-text-label); font-weight: 500; }
.gbo-slack-pairing { display: flex; flex-direction: column; gap: 8px; }
.gbo-slack-check { display: flex; flex-direction: column; gap: 6px; }
.gbo-slack-log { padding: 0 2px; color: var(--gbo-muted-fg); font: var(--gbo-text-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gbo-slack-hint { color: var(--gbo-muted-fg); font: var(--gbo-text-caption); text-align: center; }

.gbo-modal-fallback.is-sheet { background: color-mix(in srgb, #000 32%, transparent); }
[data-gbo-root].gbo-sheet {
  position: relative; box-sizing: border-box; width: min(520px, calc(100vw - 32px)); height: auto; min-height: 0; align-self: center; max-height: calc(100vh - 48px); overflow-y: auto;
  display: flex; flex-direction: column; gap: 12px; padding: 30px 32px 22px; border-radius: 24px;
  background: var(--gbo-popover); color: var(--gbo-fg);
  box-shadow: 0 24px 70px rgb(0 0 0 / .20), 0 4px 16px rgb(0 0 0 / .08), 0 0 0 1px rgb(0 0 0 / .04);
}
.dark [data-gbo-root].gbo-sheet, .dark[data-gbo-root].gbo-sheet { box-shadow: 0 24px 70px rgb(0 0 0 / .55), 0 0 0 1px rgb(255 255 255 / .07); }
.gbo-sheet-close {
  position: absolute; top: 18px; right: 18px; width: 30px; height: 30px; display: grid; place-items: center;
  border: 0; border-radius: 999px; background: transparent; color: var(--gbo-muted-fg); cursor: pointer; padding: 0;
}
.gbo-sheet-close:hover { background: var(--gbo-accent); color: var(--gbo-fg); }
.gbo-sheet-close svg { width: 18px; height: 18px; }
.gbo-sheet-emblem {
  align-self: center; width: 64px; height: 64px; display: grid; place-items: center; margin-bottom: 4px;
  border-radius: 18px; background: var(--gbo-popover); box-shadow: 0 0 0 1px var(--gbo-border), 0 2px 6px rgb(0 0 0 / .05);
}
.gbo-sheet-title { margin: 0; text-align: center; font: 600 18px/24px var(--gbo-font); letter-spacing: -.01em; }
.gbo-sheet-subtitle { margin-top: -8px; text-align: center; color: var(--gbo-muted-fg); font: 13px/18px var(--gbo-font); }
.gbo-sheet-text { margin: 2px 0 2px; text-align: center; color: var(--gbo-muted-fg); font: 14px/21px var(--gbo-font); text-wrap: pretty; }
.gbo-sheet-step { color: var(--gbo-faint-fg); font: var(--gbo-text-caption); text-align: center; }
.gbo-sheet-note { border-radius: 12px; padding: 10px 12px; background: var(--gbo-card-muted, color-mix(in srgb, var(--gbo-muted) 70%, transparent)); color: var(--gbo-fg); font: var(--gbo-text-label); }
.gbo-sheet-warn { color: var(--gbo-muted-fg); font: var(--gbo-text-caption); text-align: center; }
.gbo-sheet-quiet { color: var(--gbo-faint-fg); font: var(--gbo-text-caption); text-align: center; }
.gbo-sheet-hint { color: var(--gbo-muted-fg); font: var(--gbo-text-caption); }
.gbo-sheet-choice {
  display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px 6px 14px; border-radius: 12px;
  background: color-mix(in srgb, var(--gbo-muted) 70%, transparent); font: var(--gbo-text-label);
}
.gbo-sheet-choice > span:not(.gbo-sheet-check) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gbo-sheet-check { width: 18px; height: 18px; flex: none; display: grid; place-items: center; border-radius: 5px; background: var(--gbo-fg); color: var(--gbo-popover); }
.gbo-sheet-check svg { width: 13px; height: 13px; }
.gbo-slack-workspace-choice {
  appearance: none; width: 16px; height: 16px; flex: none; margin: 0; border: 1px solid var(--gbo-faint-fg); border-radius: 4px; cursor: pointer;
}
.gbo-slack-workspace-choice:checked {
  border-color: #202020; background: #202020 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8l2.5 2.5L12 5' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 14px 14px no-repeat;
}
.gbo-slack-workspace-choice:focus-visible { outline: 2px solid var(--gbo-fg); outline-offset: 2px; }
.gbo-link-btn.gbo-slack-add-workspace { align-self: flex-start; color: var(--gbo-muted-fg); text-decoration: none; }
.gbo-sheet-rows { display: flex; flex-direction: column; border: 1px solid var(--gbo-border); border-radius: 14px; background: var(--gbo-popover); }
.gbo-sheet-row { display: flex; justify-content: space-between; gap: 12px; padding: 10px 14px; font: var(--gbo-text-label); }
.gbo-sheet-row + .gbo-sheet-row { border-top: 1px solid var(--gbo-border); }
.gbo-sheet-row > span:first-child { color: var(--gbo-muted-fg); flex: none; }
.gbo-sheet-row > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.gbo-sheet-form { display: flex; flex-direction: column; gap: 12px; }
.gbo-sheet-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.gbo-sheet-field > span:first-child { font: var(--gbo-text-label); font-weight: 500; }
.gbo-sheet-field .gbo-input { border-radius: 12px; padding: 9px 13px; }
.gbo-field-hint.is-error { color: var(--gbo-destructive); }
.gbo-input[aria-invalid="true"] { border-color: var(--gbo-destructive); }
.gbo-sheet-back { align-self: flex-start; font: var(--gbo-text-caption); color: var(--gbo-muted-fg); }
.gbo-sheet-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.gbo-sheet-cancel {
  border: 0; background: transparent; padding: 6px 2px; color: var(--gbo-muted-fg); font: 14px/20px var(--gbo-font); cursor: pointer;
}
.gbo-sheet-cancel:hover:not(:disabled) { color: var(--gbo-fg); }
.gbo-sheet-cancel:disabled { opacity: .5; cursor: default; }
.gbo-sheet-primary {
  display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 16px; border: 0; border-radius: 999px;
  background: var(--gbo-fg); color: var(--gbo-popover); font: 500 14px/20px var(--gbo-font); cursor: pointer; white-space: nowrap;
}
.gbo-sheet-primary:hover:not(:disabled) { opacity: .88; }
.gbo-sheet-primary:disabled { opacity: .35; cursor: default; }
.gbo-sheet-cancel.gbo-slack-remove, .gbo-sheet-cancel.gbo-slack-remove:hover:not(:disabled) { color: var(--gbo-destructive); }
.gbo-sheet-primary.gbo-slack-remove-primary { background: var(--gbo-destructive); color: #fff; }
.gbo-sheet-primary.is-small { height: 30px; padding: 0 13px; font-size: 13px; }
.gbo-sheet-out { font-size: 13px; line-height: 1; }

/* usage meter (the status-bar chip) */
.gbo-meter-bar { height: 6px; border-radius: 999px; background: var(--gbo-input); overflow: hidden; }
.gbo-meter-bar > span { display: block; height: 100%; border-radius: 999px; background: var(--gbo-ring); }
.gbo-meter-bar.is-high > span { background: var(--gbo-warning); }
.gbo-status-meter { display: inline-flex; align-items: center; gap: 6px; font: 11px/16px var(--gbo-font); }
.gbo-status-meter .gbo-meter-bar { width: 44px; height: 4px; }

/* bot screen */
.gbo-screen { display: flex; flex-direction: column; background: var(--gbo-bg); }
.gbo-screen-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--gbo-border); font: var(--gbo-text-label); flex-wrap: wrap; }
.gbo-screen-bar .gbo-spacer { flex: 1; }
.gbo-screen-tag { border-radius: 999px; padding: 2px 10px; background: var(--gbo-card); color: var(--gbo-muted-fg); }
.gbo-screen-tag.is-you { background: color-mix(in srgb, var(--gbo-destructive) 15%, transparent); color: var(--gbo-destructive); font-weight: 600; }
.gbo-screen-tag.is-reason { background: color-mix(in srgb, var(--gbo-warning) 15%, transparent); color: var(--gbo-warning); max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gbo-screen-stage { position: relative; flex: 1; min-height: 0; background: #000; }
.gbo-screen-stage.is-held { box-shadow: inset 0 0 0 2px var(--gbo-destructive); }
.gbo-screen-canvas { position: absolute; inset: 0; }
.gbo-screen-overlay { position: absolute; inset: 0; display: grid; place-items: center; color: #fffb; font: var(--gbo-text-label); pointer-events: none; text-align: center; padding: 16px; }
.gbo-screen-banner { position: absolute; left: 0; right: 0; padding: 6px 12px; font: var(--gbo-text-label); text-align: center; }
.gbo-screen-banner.is-top { top: 0; background: #451a03cc; color: #fde68a; }
.gbo-screen-banner.is-bottom { bottom: 0; background: #450a0acc; color: #fecaca; text-align: left; }
.gbo-screen-thumb { width: 100%; border-radius: 10px; display: block; background: #000; aspect-ratio: 16 / 10; object-fit: contain; }
.gbo-log { max-height: 10rem; overflow: auto; border-radius: 10px; background: #000; color: #ddd; padding: 8px; font: 11px/15px var(--gbo-mono); white-space: pre-wrap; text-align: left; width: min(520px, 100%); }
`
