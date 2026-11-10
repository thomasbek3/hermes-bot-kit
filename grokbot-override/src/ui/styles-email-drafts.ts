// Email draft cards (ui/EmailDraft.tsx), drawn like Grok Bot's: a white
// (dark: elevated grey) card, the subject as its heading, label rows split by
// hairlines (From, In reply to, To, Cc), the body in a soft grey box, the
// signature muted under it, the attachments as file cards, and a footer with
// the rules menu on the left and Discard / Send on the right. Written in the
// reference's units and token names and run through refCss() like
// styles-adapt.ts (scoped to the override root, zoom-scaled, light and dark).

import { refCss } from './styles-ref'

const SRC = /* css */ `
.gbo-email-draft {
  display: flex; flex-direction: column; gap: 0; width: 100%; max-width: 560px; min-width: 0; margin: 4px 0;
  padding: 18px 20px 14px; border-radius: 20px; background: var(--color-bg-elevated); color: var(--color-text-primary);
  box-shadow: var(--shadow-card);
}
.gbo-ed-subject {
  width: 100%; min-width: 0; margin: 0 0 6px; padding: 0; border: 0; background: transparent; color: var(--color-text-secondary);
  font: inherit; font-size: 15px; line-height: 22px; font-weight: 600; outline: 0;
}
.gbo-ed-subject:focus-visible { color: var(--color-text-primary); }
.gbo-ed-row {
  display: flex; align-items: baseline; gap: 10px; min-width: 0; padding: 10px 0;
  border-bottom: 0.5px solid var(--color-border-tertiary); font-size: 14px; line-height: 20px;
}
.gbo-ed-label { flex: none; min-width: 26px; color: var(--color-text-tertiary); }
.gbo-ed-value { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: var(--color-text-primary); }
.gbo-ed-value.is-empty { color: var(--color-text-quaternary); }
.gbo-ed-input {
  flex: 1 1 auto; min-width: 0; margin: 0; padding: 0; border: 0; background: transparent; color: var(--color-text-primary);
  font: inherit; outline: 0;
}
.gbo-ed-input::placeholder { color: var(--color-text-quaternary); }
.gbo-ed-row.is-bad .gbo-ed-input { color: var(--color-danger-text); }
.gbo-ed-body {
  display: block; width: 100%; min-height: 96px; margin: 12px 0 0; padding: 10px 12px; box-sizing: border-box; resize: none;
  border: 0; border-radius: 12px; background: var(--color-bg-subtle); color: var(--color-text-primary);
  font: inherit; font-size: 15px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; outline: 0; overflow: hidden;
}
.gbo-ed-body:focus-visible { box-shadow: var(--color-border-focus) 0 0 0 1px inset; }
div.gbo-ed-body { min-height: 0; }
.gbo-ed-signature {
  margin: 10px 0 0; padding: 0 2px; white-space: pre-wrap; overflow-wrap: anywhere;
  font-size: 13px; line-height: 19px; color: var(--color-text-tertiary);
}
.gbo-ed-signature::first-line { font-weight: 600; color: var(--color-text-secondary); }
.gbo-ed-files { display: flex; flex-direction: column; gap: 8px; margin: 14px 0 0; }
.gbo-ed-note { margin: 10px 0 0; font-size: 13px; line-height: 18px; color: var(--color-text-tertiary); }
.gbo-ed-note.is-error { color: var(--color-danger-text); }
.gbo-ed-foot { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 14px 0 0; }
.gbo-ed-spacer { flex: 1 1 auto; }
.gbo-ed-rules {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px; margin-left: -6px; border: 0; border-radius: 8px;
  background: transparent; color: var(--color-text-tertiary); font: inherit; font-size: 13px; cursor: pointer;
}
.gbo-ed-rules:hover { background: var(--color-bg-hover); color: var(--color-text-secondary); }
.gbo-ed-rules svg { width: 12px; height: 12px; }
.gbo-ed-state { font-size: 13px; line-height: 18px; color: var(--color-text-tertiary); }
.gbo-ed-state.is-sent { color: var(--color-success-text); }
.gbo-ed-state.is-failed { color: var(--color-danger-text); }
.gbo-ed-discard {
  height: 34px; padding: 0 12px; border: 0; border-radius: var(--radius-full); background: transparent;
  color: var(--color-text-secondary); font: inherit; font-size: 14px; cursor: pointer;
}
.gbo-ed-discard:hover:not(:disabled) { background: var(--color-bg-hover); color: var(--color-text-primary); }
.gbo-ed-send {
  height: 34px; padding: 0 16px; border: 0; border-radius: var(--radius-full); background: var(--color-primary);
  color: var(--color-bg-chrome); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer;
}
.gbo-ed-send:hover:not(:disabled) { background: var(--color-bg-primary-hover); }
.gbo-ed-send:disabled, .gbo-ed-discard:disabled { cursor: default; opacity: 0.55; }
.gbo-email-draft.is-done .gbo-ed-subject { color: var(--color-text-secondary); }
.gbo-ed-rules-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.gbo-ed-rules-item {
  display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 4px 6px 10px; border-radius: 10px;
  background: var(--color-bg-subtle); font-size: 14px; line-height: 20px;
}
.gbo-ed-rules-item > span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.gbo-ed-rules-modes { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
.gbo-ed-mode {
  height: 30px; padding: 0 12px; border: 0; border-radius: var(--radius-full); background: var(--color-bg-subtle);
  color: var(--color-text-secondary); font: inherit; font-size: 13px; cursor: pointer;
  box-shadow: var(--color-border-tertiary) 0 0 0 0.5px inset;
}
.gbo-ed-mode.is-on { background: var(--color-primary); color: var(--color-bg-chrome); box-shadow: none; }
.gbo-ed-rules-empty { margin: 0; font-size: 13px; color: var(--color-text-tertiary); }
`

export const EMAIL_DRAFT_CSS = refCss(SRC)
