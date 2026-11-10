---
name: agent-cards
description: Show cards in Hermes Desktop chats - question cards for choices, approval cards before outward or irreversible actions, task cards for long jobs.
version: 1.0.0
author: Hermes Bot Kit
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [desktop, cards, approval, task, email]
  hermes-bot-kit:
    skill: agent-cards
---

# Agent Cards

In a Hermes **Desktop** chat you can show a card instead of describing things in prose: a question with
buttons, an approval to confirm before you act, or a task whose progress updates in place. Cards are
drawn by Hermes Desktop with the Grokbot Override plugin. Slack, Telegram, the CLI and other channels
do not draw them: there, write plain text.

## When to show a card

1. A choice or a yes/no confirmation: ask with the built-in `clarify` tool (it shows a question card).
2. Before anything outward or irreversible (sending, posting, paying, booking, deleting): an approval card, then wait.
3. A job that takes more than about a minute: one task card, kept up to date.
4. Everything else: plain text. Cards only in the Hermes Desktop chat.

## 1. Question cards: the `clarify` tool

You need no files for these. Call `clarify` with one to five questions:

```json
{ "questions": [ { "question": "Which night works?", "choices": ["Thursday", "Friday", "Saturday"] } ] }
```

- Up to four `choices` per question (each a short label). The card always adds a row where the user can
  type their own answer.
- `"multi_select": true` lets the user pick several.
- Leave out `choices` to ask an open question.
- Put your suggestion first and the card marks it recommended.

The answer comes back as the tool's result. Continue from it; do not ask the same thing again in text.

## 2. Approval, task and email cards: a card file plus one line

These cards live in a JSON file in your working directory for this chat. Your reply only points at it.

### The card file

Write the file with your file tool at a **relative** path, by convention `cards/<id>.json`. The id is
`c-` plus a short slug, unique in this chat (`c-7f3a`). The whole file must stay under 32 KB.

```json
{
  "schema": "card.v1",
  "kind": "approval",
  "title": "Book the lake cabin",
  "status": { "state": "awaiting-approval" },
  "body": [
    { "type": "kv", "rows": [["Night", "Friday"], ["Guests", "2"], ["Total", "$180"]] }
  ],
  "actions": [
    { "label": "Book it", "style": "primary", "send": "APPROVE c-9b book the cabin" },
    { "label": "Not yet", "send": "HOLD c-9b" }
  ]
}
```

Fields (anything else is ignored; a file that breaks a required rule shows "Card not available"):

| Field | Rule |
|---|---|
| `schema` | Required. Exactly `"card.v1"`. |
| `kind` | Required. `"approval"`, `"task"` or `"draft-email"`. |
| `title` | Required, not empty. The card's bold heading. |
| `status.state` | Required. `"pending"`, `"running"`, `"done"`, `"error"` or `"awaiting-approval"`. |
| `status.label` | Optional. Replaces the state's own wording in the status chip. |
| `body` | Optional list of blocks, drawn in order (see below). |
| `email` | For `draft-email`: `{ "to", "cc", "subject", "bodyText" }`, all strings. |
| `actions` | Optional. At most 3 buttons: `{ "label", "send", "style"? }`. |
| `resolved` | Optional. `null`, or `{ "action": "<clicked label>", "at": "<ISO-8601 time>" }` once you have acted. |

Body blocks:

- `{ "type": "text", "text": "..." }`: a paragraph. A card whose whole body is one short line (under 200
  characters, no line breaks) shows that line as the question under the title.
- `{ "type": "kv", "rows": [["Label", "Value"], ...] }`: label and value rows.
- `{ "type": "fields", "items": [{ "label": "...", "value": "..." }, ...] }`: the same, as objects.

Actions:

- `label` is the button text; `send` is the message the chat sends back to you, hidden from the
  transcript, when the button is clicked. Keep `send` under 500 characters and start it with a word and
  the card id (`APPROVE c-9b`, `HOLD c-9b`, `STOP c-8t`) so you can match it. When `send` differs
  from `label`, the row shows the `send` text as a smaller second line, so the user sees what a click
  sends.
- `style` is `"primary"` or `"danger"`; leave it out for a plain button.
- After one click, or once the file has `resolved`, the buttons stop working and the chosen one is ticked.

How each kind is drawn:

- `approval`: title, body and the buttons. No status chip.
- `task`: title, a status chip for `running` (with a spinner), `done` and `error`, then the body and any
  buttons (for example a `Stop` button with `"style": "danger"`).
- `draft-email`: the subject as the heading (the title when there is no subject), To and Cc rows, the
  body text, then the buttons.

### The line in your reply

Put this on its own line in your reply (nothing else on that line):

```
::card{id="c-9b" kind="approval" file="cards/c-9b.json"}
```

- `file` is required and must be relative to your working directory: never an absolute path, a `~`
  path, a URL or a path with `..`.
- `id` and `kind` should match the file; `kind` is also the label shown if the file cannot be read.
- Keep the line out of code blocks and backticks, or it is shown as text.
- One line per card. Text before and after it in the same reply is shown around the card.

### Live updates

While the chat is open, a card in one of the chat's last eight messages re-reads its file every three
seconds, for up to 30 minutes, and stops as soon as the file is final (`resolved` set, or `status.state`
`done` or `error`). To update a card, **rewrite the same file**. Never post a second `::card` line for the
same card: the attributes of a line already sent cannot change.

### Previews

`::preview{file="page.html"}` on its own line shows a workspace HTML file in a sandboxed frame. The
frame has **no network**: no requests, no remote scripts, styles, fonts or images (its policy is
`default-src 'none'`, with inline script and style, and `data:` / `blob:` images, fonts and media). Write
a self-contained page: inline `<style>` and `<script>`, images as `data:` URLs. A page can call
`window.hermes.send("...")` (or use `data-hermes-send="..."` on a button); it is sent at once only when the
user has just clicked into the frame. Otherwise the user sees the exact text under the frame with
**Send** and **Dismiss**, and nothing is sent until they click Send.

## Approval flow

1. Write `cards/<id>.json` with `kind` `approval` (or `draft-email` for a message you drafted),
   `status.state` `awaiting-approval` and two actions, for example `APPROVE <id> ...` and `HOLD <id>`.
2. Post the `::card` line and stop. Do not act yet.
3. When a message starting `APPROVE <id>` arrives, do the action. On `HOLD <id>` (or anything else), do
   not.
4. Rewrite the file: set `resolved` to the clicked label and the time, and `status.state` to `done` (or
   `error` if the action failed). Then report the result in a short line of text.

The button does nothing by itself: you perform the action, and only after the approval message arrives.
Never set `resolved` before you have acted.

## Task flow

1. Write one `task` card with `status.state` `running` and a body that says what you are doing, then post
   its `::card` line.
2. As work progresses, rewrite the same file (counts in a `kv` block work well).
3. Finish with `done` or `error` and a final body. If you gave it a `Stop` button and a `STOP <id>`
   message arrives, stop the work and mark the card `error` with a short reason, or `done` if nothing
   was left to do.

## Other channels

On Slack, Telegram, the CLI or any channel that is not the Desktop chat, never write a `::card` line:
ask your question, or describe the approval or the task, in plain text.
