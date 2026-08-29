# Changelog

## 1.0.0 — 2026-08-29

- First release. Named group headers in the Bot Mode roster (Apollo / OMH /
  HQ, plus automatic Unassigned), driven by a `SECTIONS` config block and
  per-bot palette cycle commands.
- Annotates React-owned bot rows (`data-bot-section` + CSS `order`); appends
  plugin-owned headers at the end of each bot-row list and positions them
  with `order`. Never re-parents React nodes.
- Scoped to `hermes-bots:pane`. Native gateway / group-chat / Hidden
  headings stay. Ordering is per gateway bucket when the roster is split.
- Fails safe: selector miss → stock roster.
