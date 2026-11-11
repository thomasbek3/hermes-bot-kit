# email-drafts (agent plugin)

Bots never send email on their own. A bot writes a **draft**; it shows up as a card in its Grokbot
Override chat, like Grok Bot's: subject, From, "In reply to", editable To and Cc, the editable body with
your signature under it, attachments as file cards (click one to preview it), and **Discard** / **Send**. You click **Send**, and only
then does it go out: **through Composio** (the default: the Gmail account you connected in Composio, sent
by the `composio` CLI on the bot's machine), or, optionally, through Gmail with your own Google OAuth client
or your SMTP server. The card then says "Sent · 3:42 PM" and is read-only;
a failure shows the error with **Retry**.

The card's footer has the bot's rules menu:

| Menu item | What it does |
|---|---|
| **Allow recipient** | Adds this draft's To addresses to the bot's allowed list and turns the allow rule on. Later drafts from this bot whose recipients (To, Cc and Bcc) are **all** on the list send by themselves and show as "Sent automatically · allowed recipient". The current draft still waits for **Send**. |
| **Needs approval** | The default. Every draft waits for **Send** (the allowed list is kept, unused). |
| **Disable drafts for <bot>** | The bot's draft tool refuses with a message the bot relays. Nothing is drafted. |
| **Manage rules** | The allowed list with **Remove** buttons, and the mode. |

Rules are per bot (per Hermes profile).

## What the bot gets

Three tools in the `email_drafts` toolset. There is **no send tool**.

- `email_draft_create(to, cc?, bcc?, subject, body, attachments?, in_reply_to?)` → the draft id and status
  (`pending`, `sent` when the allow rule covered it, or `disabled` with a message to relay).
- `email_draft_update(id, …)` → change a pending draft (the card refreshes).
- `email_draft_status(id)` → `pending`, `sending`, `sent` (when, and by whom), `discarded` or `failed` (with the
  error).

The tool descriptions tell the model to use `email_draft_create` instead of sending email any other way and
to answer with one short line. The plugin also registers the skill `email-drafts:email-drafts`
([skills/email-drafts/SKILL.md](skills/email-drafts/SKILL.md)) with the full rules. To make it part of a
bot's standing instructions, add this to its `SOUL.md`:

```text
Email goes through Composio. Use email_draft_create; never send email any other way.
Email: never send email yourself (no scripts, SMTP, mail APIs, Composio tools or browsers). Write it with
email_draft_create; the user sends it from the draft card. Then reply with one short line
("Draft to Sam is ready on the card above."), not the email text. Change a draft with
email_draft_update, never by creating a second one.
```

**Attachments** must be files inside the bot's working directory for the chat, or inside a folder listed in
**Extra attachment folders**. Paths are resolved with symlinks followed, so a link that points outside is
refused; hidden files and folders (`.ssh`, `.env`, `.hermes` …) are refused everywhere; the check runs again
just before sending. The home folder and `/` never count as a workspace on their own: a bot whose working
directory is your home folder can attach files only from the folders you list.

**Replies** thread: with Composio, a draft whose `in_reply_to.thread_id` is set goes out with
`GMAIL_REPLY_TO_THREAD` into that Gmail thread (Gmail keeps the thread's subject and quotes the last message
under your text). With the Gmail and SMTP senders, `in_reply_to.message_id` becomes `In-Reply-To` and
`References`, and `in_reply_to.thread_id` is sent as Gmail's `threadId`.

**Scheduled runs** (cron, a gateway with no one watching) only create drafts and return at once; nothing ever
waits for a person. A draft whose recipients are all allowed still sends under the allow rule. Type
`/email-drafts` in a chat to list a bot's drafts.

## Never twice

A draft goes `pending → sending → sent | failed`. The step to `sending` is taken under a file lock, so a double
click, a second window or a repeated request finds the draft already `sending` or `sent` and sends nothing.
**Send** carries the card's revision: if the bot changed the draft after the card showed it, nothing is sent
and the card asks you to look again. An error the plugin cannot classify (the connection dropped after the
message was handed over, or the Composio CLI timed out, crashed or lost the network mid-send) marks the draft
"Delivery unknown: check your Sent folder" and offers no Retry. The
card itself keeps one action in flight and never repeats a send whose answer was lost.

## Approval and the audit log

Your click on **Send** is the approval; the allow rule, which only you can set from the card, is the only other
way a draft leaves. Hermes's approval system has no public way for a plugin to record "a person approved this
outbound action", so the plugin does not touch it (it never answers or bypasses Hermes approval prompts). It
writes its own audit log instead: `<HERMES_HOME>/plugin-data/email-drafts/audit.jsonl`, one line per draft
created, send, failure, discard and rule change, with `actor` (`human` click or `allow-rule`), the surface
(`rpc`, `slash:<platform>` or `tool`) and the time. Message bodies are never logged.

Send, discard and rule changes are refused from the plain CLI's `/email-drafts api …` (a bot's terminal could
start a Hermes child there). This plugin is not a sandbox: like any plugin it runs as your user, and a bot
with an unrestricted terminal can read or write files your user can.

## Install (per profile)

Requires Hermes **0.23.0** or newer (the version this was checked against; `requires_hermes: ">=0.23.0"`).

```bash
cp -R email-drafts "<profile-home>/plugins/email-drafts"     # <profile-home>: ~/.hermes or ~/.hermes/profiles/<name>
hermes --profile <name> plugins enable email-drafts
```

Then restart that bot's backend (or the app) so it loads, and turn on the **Email drafts** toolset for the
bot if your profile lists toolsets explicitly. Set the bot's **From address** (and optionally **From name**,
**Signature**, **Extra attachment folders**) under **Settings → Plugins → Email drafts**.

### Composio (default)

Composio is the connector for almost everything, email included, so it is the default **Send with**. The
plugin runs the [Composio CLI](https://docs.composio.dev) that is installed and logged in **on the machine
that runs the bot** (a remote bot's mail is sent by the remote machine's CLI). It is the same CLI the catalog
plugin `composio-connections` manages accounts with.

On each bot machine, once:

1. Install the `composio` CLI and run `composio login` in a terminal.
2. Connect the Gmail account in Composio (for example from the `composio-connections` plugin in Hermes
   Desktop). `composio connections list --toolkit gmail` lists the connected Gmail accounts with their alias
   and word id.
3. In the bot's **Settings → Plugins → Email drafts**: **Send with** `composio`, **From address** = that Gmail
   account's address, and **Composio account** = its alias, word id or connected-account id (empty uses the
   CLI's default Gmail account, fine when there is only one). **Composio CLI** is only needed when the CLI is
   not on the gateway's PATH, `~/.local/bin/composio` or `~/.composio/composio`.

What a send runs (no shell; the arguments go in as a list, the email as JSON on stdin, never on the command
line; a minimal environment; a 90-second limit):

```bash
composio execute GMAIL_GET_PROFILE [--account <account>] -d -     # read only: which mailbox is this?
composio execute GMAIL_SEND_EMAIL  [--account <account>] -d -     # or GMAIL_REPLY_TO_THREAD for a reply
```

- **From:** the profile check comes first. When the account's address is not the bot's **From address**,
  nothing is sent and the card says which address the account has. (Gmail "send as" aliases are not checked
  against Composio; use the `gmail` sender for those.) If Composio ever reports a different From after a
  send, the card shows it as a failure without Retry.
- **Body:** plain text, the bot's **Signature** under it, exactly as on the card (Composio's own Gmail
  signature is turned off with `include_signature: false`).
- **Attachments:** the files' paths go in the tool's `attachment` field and the CLI uploads them to Composio
  for that send; at most 20 MB in total (the Gmail tools' limit).
- **Errors:** not logged in, no connected Gmail matching the account, an expired or revoked connection, rate
  limits, input Gmail refuses, and Composio's own approval controls (which cannot prompt anyone from a
  gateway, so they refuse) each show a clear message with **Retry**; nothing was sent. A timeout, a crash, a
  dropped connection mid-send or output the plugin cannot read is "Delivery unknown" (no Retry).
- **Key:** the CLI's own login is used. A **Composio user API key** for the profile is optional; when set,
  it is read with `agent.secret_scope.get_secret("COMPOSIO_USER_API_KEY")` and given only to that `composio`
  child process. The plugin never reads the CLI's credential files.

### Gmail (optional)

Set **Send with** to `gmail`, then:

1. In your own Google Cloud project, enable the Gmail API and create an OAuth client of type **Desktop app**.
2. Put its id and secret in the bot's settings: **Settings → Plugins → Email drafts → Google OAuth client
   ID / secret** (stored by Hermes in that profile's `.env` as `EMAIL_DRAFTS_GOOGLE_CLIENT_ID` and
   `EMAIL_DRAFTS_GOOGLE_CLIENT_SECRET`).
3. Sign in once, in a terminal on the machine that runs the bot:

   ```bash
   hermes --profile <name> auth add email-drafts:google
   ```

The only scope is `https://www.googleapis.com/auth/gmail.send`: the plugin can send as that account and cannot
read the mailbox. Hermes stores and refreshes the token and attaches it to requests to
`gmail.googleapis.com`; the plugin never sees it. `hermes auth status|logout email-drafts:google` shows or
removes it.

### SMTP (optional)

Set **Send with** to `smtp`, then **SMTP host**, **port**, **security** (`starttls` on 587 or `ssl` on 465;
plain-text SMTP is not offered) and **username**, and the **SMTP password** field (stored by Hermes like a
provider key as `EMAIL_DRAFTS_SMTP_PASSWORD`, read with the profile's secret scope).

## What it touches (disclosure)

- **Network:** only when a draft is sent. Composio (default): the `composio` CLI on the bot's machine talks
  to Composio's servers (`backend.composio.dev`), uploads the draft's attachments there and has Composio send
  through your connected Gmail. Gmail: `https://gmail.googleapis.com` (through Hermes's
  `credentialed_provider_request`). SMTP: your server over TLS.
- **Programs it runs:** with Composio, the `composio` CLI (two runs per send: the read-only profile check and
  the send), with no shell, a minimal environment and a timeout that kills it. The CLI keeps its own login and
  may keep its own local history of the tool calls it ran.
- **Files it reads:** the attachments you or the bot named, inside the allowed folders.
- **Files it writes:** `<HERMES_HOME>/plugin-data/email-drafts/` (drafts, rules, audit log).
- **Credentials:** none of its own. Composio's login stays in its CLI (an optional profile key is read with
  `agent.secret_scope.get_secret`); the Gmail grant lives in Hermes; the SMTP password is read through
  `agent.secret_scope.get_secret`.
- No background processes, no telemetry.

## The card's way in

The Grokbot Override card talks to this plugin on the bot's own gateway (a remote bot's draft is read and sent
by the remote machine): `plugin.email-drafts.api` (plugin RPC) where the gateway serves it, else
`/email-drafts api <op> <json>` through `slash.exec`. Operations: `get`, `list`, `rules` (read), `edit`, `send`,
`discard`, `set_mode`, `allow`, `unallow`.

## Tests

```bash
python3 -m unittest discover -s email-drafts/tests -p 'test_*.py'   # fake composio CLI, Gmail and SMTP; no email is sent
hermes plugins validate email-drafts
```
