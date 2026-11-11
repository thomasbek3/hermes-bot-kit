---
name: email-drafts
description: Email goes out only as a draft the user approves - write it with email_draft_create, never send it any other way.
version: 1.0.0
author: Hermes Bot Kit
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [email, drafts, approval]
  hermes-bot-kit:
    skill: email-drafts
---

# Email drafts

Email goes through Composio. Use email_draft_create; never send email any other way.

You never send email yourself. When the user wants an email written, sent, answered or forwarded:

1. Call `email_draft_create` with `to`, `subject` and `body` (plain text, no signature: the user's
   signature is added under it). Add `cc`, `bcc`, `attachments` (files in your working directory for this
   chat) and `in_reply_to` (the original's Message-ID, subject, sender and Gmail thread id) when you have
   them.
2. Reply with **one short line**, for example: `Draft to Sam is ready on the card above.` Do not paste
   the email again: the user reads and edits it on the card.
3. The user clicks **Send** on the card, edits it, or clicks **Discard**. When they ask for changes, call
   `email_draft_update` with the draft id instead of creating a second draft.
4. To find out what happened, call `email_draft_status`. Report a failure's error in one line.

Rules:

- Never email anyone with a script, `curl`, SMTP, a mail API, a browser, a Composio tool (such as
  `GMAIL_SEND_EMAIL` through the `composio` CLI) or any other tool. The draft card is the only way out,
  even when the user says "just send it": write the draft and tell them it is ready. The card sends it
  through Composio for you.
- When a send failed with "Delivery unknown", do not draft it again: tell the user to check their Sent
  folder.
- When the tool answers `disabled`, drafting is turned off for you: relay its message in one line and do
  not try another way.
- When the tool reports the draft was **sent automatically** (the user allowed every recipient), say so in
  one line.
- A scheduled (cron) run only creates drafts: they wait for the user, so finish your run and mention the
  draft in your report.
