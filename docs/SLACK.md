# Put a bot in Slack

A runbook for people and for their AI agents. It sets up one Hermes bot so your
**team** can DM it and @mention it in a Slack workspace. The bot acknowledges
each message with an emoji (👀) while it works.

Some steps can only be done by the human: creating or allowing a Slack app,
installing it to the workspace, and copying tokens out of Slack. They are marked
**HUMAN**. An agent stops at those steps and asks the person to do them.

> **Tokens never go in chat and never in this repository.** They are typed
> or pasted only into the bot's Slack window in Hermes Desktop. Hermes stores
> them in that bot's profile (`<profile home>/.env`, owner-only, or the profile's
> secret store), and the kit's own Slack files are mode 0600. An agent must not
> ask the person to paste a token into a chat, a file or a command line.

## Who can talk to the bot

**By default your team can.** With one-click Add to Slack (way B below),
everyone who is a **full member** of the workspace can DM and @mention the bot.
**Guests** (single- and multi-channel) and **Slack Connect** people from other
companies cannot. The kit keeps this list in step with the workspace: the relay
refreshes it from Slack every 15 minutes, so people who join can talk to the bot
and people who leave or become guests stop.

**What that means:** anyone who can message the bot can ask it to do anything
its tools can do, and it does it **with the bot's own access**. That includes
the bot's accounts and files, its computer if it has one, email it can send
and everything else you connected. Give a bot that your whole team can reach
only the tools you are happy for all of them to use. Keep a bot with powerful
tools (your email, your own accounts) restricted to you.

**To restrict it,** choose in the bot's Slack window, before Connect or later
with **Change who can talk to it**:

| Choice | Who |
|---|---|
| **Everyone in the workspace** (default) | Full members that Slack's member list confirms; not guests, not Slack Connect users |
| **Only me** | Only the person who added the bot |
| **Only these people** | Slack member IDs you list (Slack: profile → ⋮ → *Copy member ID*); you are always included |

**Only verified members.** With **Everyone in the workspace**, the bot's
allowlist is exactly the full members in Slack's member list (`users.list`,
read in full: one failed page fails the whole read, and nothing is written from
a partial list). You, the person who added the bot, are in it only because
Slack lists you as a full member. If you become a guest, the next refresh
removes you too.

**When Slack can't be read.** A failed refresh keeps the current list and the
window says why (for example *the app lacks the users:read permission*). If
Slack asks the relay to wait (`ratelimited`, with a `Retry-After`), the relay
makes no Slack call for that bot until then. A list is trusted for **24
hours**: when the last good read is older than that (or there never was one)
and Slack still can't be read, the bot falls back to **only you**, if Slack
last said you are a full member, and otherwise to **nobody**. A wait Slack asked
for never stretches those 24 hours: the fallback happens on time even while
the relay is still waiting. Nobody is written as
`SLACK_ALLOWED_USERS=NOBODY`, a value that matches no Slack ID; an empty value
would make Hermes fall through to other settings. A new Connect whose first
member read fails starts at nobody, because nobody is verified yet; the relay
tries again at its next refresh. The window shows the member list's health on
its own line: *Member list read …*, or *Member list stale since …* /
*Member list never read*.

**What the window shows is the truth.** After Connect, the window, Slack's
confirmation page and the welcome DM show **how many people can actually talk
to the bot**, for example *12 people can talk to this bot: the 11 full members
of Acme, plus 1 from GATEWAY_ALLOWED_USERS (`<profile home>/.env`).* That is
worked out from every setting Hermes honours for that bot, read the way Hermes
reads them for the profile (its own `.env`, external secret sources, the
administrator-managed env; never the root `.env`): `SLACK_ALLOWED_USERS`,
`SLACK_ALLOW_ALL_USERS`, `GATEWAY_ALLOWED_USERS`, `GATEWAY_ALLOW_ALL_USERS`
(which counts only when no allowlist is set) and the people approved through
Hermes's first-DM pairing. Each list is read exactly as Hermes reads it: a JSON
list (`["U1","U2"]`) or a comma list, and `*` in either form (`'["*"]'`) means
anyone. Two settings Hermes checks before any list are named in the same
sentence: a channel allowlist (`group_allowed_chats` in the bot's
`config.yaml`, under `platforms.slack` or `slack:`) lets **anyone posting in
those channels** in, and `allow_bots: mentions` or `all` (`SLACK_ALLOW_BOTS`,
which wins over `config.yaml`) lets **bots and workflows** in. The window
keeps all of it current while it is open, from local settings only; it asks
Slack (and tests the connection) only when you open it and when you click
**Test connection**.

Any other setting that lets people in is listed with **where it is set and how
to change it**. The kit changes none of them for you: the only value it ever
writes is `SLACK_ALLOWED_USERS` in the `.env` of the bot whose `SLACK_APP_ID`
is the app it created.

| Grant | How to change it |
|---|---|
| `SLACK_ALLOW_ALL_USERS=true` | Remove it from the file the window names (usually `<profile home>/.env`) |
| `GATEWAY_ALLOWED_USERS` | Edit it where the window says; it applies to every messaging platform of the bot |
| `GATEWAY_ALLOW_ALL_USERS=true` with no allowlist | Remove it where the window says |
| `group_allowed_chats` (anyone posting in those channels) | Remove it from the file the window names (the bot's `config.yaml`) |
| `SLACK_ALLOW_BOTS` / `allow_bots` = `mentions` or `all` (bots and workflows) | Remove it from the file the window names |
| A Slack pairing approval | `hermes -p <profile> pairing revoke slack <member id>` |
| A value from the administrator-managed env or an external secret source | Change it there; the bot's `.env` cannot override it |

**Bots connected before team access** (an earlier release of the kit) keep
their list. Nothing rewrites it on upgrade, and the relay never refreshes it.
The window says *Allowed now: U123 (from the earlier version)* and offers
**Keep these people** or **Everyone in the workspace**. **Only me** needs the
person who added the bot, recorded by this release's Connect, so for such a
bot the window says *To choose Only me, reconnect the bot.* On first sight
after the upgrade the kit marks such a bot as connected (when its `.env` still
has that app's `SLACK_APP_ID` and a bot token) without changing who can talk
to it; a "full members" bot from an earlier build of team access is then
refreshed again like any other. A bot whose earlier Connect ended in an error
after its token was saved (for example, the welcome DM failed) is checked once
with Slack (`auth.test`) when you open its window: if the token works for that
workspace it reads as connected, otherwise it stays as it is. A Connect of
this release that failed is never taken as connected.

**When Hermes won't take the change.** On a managed Hermes, or when an
administrator pins `SLACK_ALLOWED_USERS`, Hermes refuses the write. The window
then shows Hermes's refusal, or *Hermes kept SLACK_ALLOWED_USERS=…
(administrator-managed?)*, and keeps the audience it had: the kit reads the
allowlist back the way Hermes reads it before it records any change. If
Hermes's own settings can't be read at all, nothing is written: *Couldn't read
Hermes's settings, so nothing was changed.* If the write went through but the
read-back fails or shows another value, the kit puts the bot's previous values
back (a key that wasn't there is removed again, including a first Connect's
new token) and checks that with the same reader: *…; nothing was changed.* If
even that can't be confirmed, the window says what is left and where: *Couldn't
undo the change: SLACK_ALLOWED_USERS is now …; set it back in
<profile home>/.env*. A first Connect that can't be undone is left with
`SLACK_ALLOWED_USERS=NOBODY`, so nobody can talk to the bot until you remove
the app and connect again.

How the kit does it: Hermes has no "full members only" switch.
`SLACK_ALLOW_ALL_USERS=true` would also let guests in (Hermes refuses only
other companies' DMs). So the kit writes the verified member list into the
bot's `SLACK_ALLOWED_USERS` and the relay keeps it current. A change of
audience in the window always wins over a refresh that was already running.

## Pick a way

| | **A. Socket Mode** (two tokens) | **B. One-click Add to Slack** (slack-connect) |
|---|---|---|
| What you need | Hermes Desktop only | An always-on Hermes host (macOS or Linux), a public HTTPS address (Tailscale Funnel or your own proxy), one Slack configuration token per workspace |
| Who can talk to the bot | People whose first DM you approve, one by one | Your team (full members), or the restriction you choose |
| Human steps | Create the app from the manifest, install it, copy two tokens, approve each person's first DM | Generate one configuration token per workspace, then click **Allow** |
| How Slack reaches the bot | The bot connects out to Slack (no public address) | Slack sends events over HTTPS to the kit's relay |

For a bot your **team** uses, pick **B**. **A** needs nothing beyond Hermes
Desktop, but each person has to be approved separately.

Both ways use the Grokbot Override's **Slack** card in the bot's profile panel
(or Hermes's own Slack window when the override is off).

## A. Socket Mode

1. **Agent:** check that Hermes Desktop is at least 0.23.0 and the kit is
   installed (see [AGENTS.md](../AGENTS.md)). Tell the person to open the bot in
   the Bots tab, open its profile panel and click **Add to Slack** on the Slack
   card. Without slack-connect this opens the four-step Socket Mode window.
2. **HUMAN, step 1 (Create):** click the link in the window. Slack opens
   *Create an app* with the kit's manifest already filled in: Socket Mode on, no
   slash commands, and the bot scopes in `grokbot-override/src/core/slack.js`
   (`SLACK_BOT_SCOPES`, including `reactions:write` for the 👀 acknowledgement).
   Pick the workspace, press **Create**, then **Install to Workspace** and
   **Allow**.
3. **HUMAN, step 2 (Tokens):** copy two tokens from the app's Slack pages into
   the window. Nowhere else.
   - **App-level token** (`xapp-…`): *Basic Information → App-Level Tokens →
     Generate*, with the `connections:write` scope.
   - **Bot token** (`xoxb-…`): *OAuth & Permissions → Bot User OAuth Token*.

   The window checks each token's shape and saves only those two values, to the
   bot's profile, through Hermes's own messaging API
   (`PUT /api/messaging/platforms/slack`), then turns Slack on for that bot.
4. **Step 3 (Connect):** the window waits until Hermes reports Slack connected.
   If it says a restart is needed, the person clicks **Restart now**. That
   restarts only this bot's gateway and cuts off a reply in progress.
5. **HUMAN, step 4 (First DM):** each person who wants to use the bot DMs it.
   For two minutes the window lists pending first DMs with the sender's name,
   Slack **member ID** and age. **Check the member ID** before you click
   **Approve**: anyone who can DM the bot can show up here, and display names
   are not unique. Later requests are approved in Hermes's Messaging settings.
6. **Verify:** see [Check it works](#check-it-works).

## B. One-click Add to Slack (slack-connect)

Done once per Hermes host, on that host, as the user that runs Hermes, from a
clone of this repository.

1. **Agent:** check the requirements: macOS or Linux, Hermes's API server on,
   and either Tailscale Funnel available or a public HTTPS URL the person gives
   you. Pick **one** of these two blocks, preview it, then run it for real.

   With Tailscale Funnel:

   ```bash
   bash slack-connect/install.sh --tailscale-funnel --dry-run && bash slack-connect/install.sh --tailscale-funnel
   ```

   Or with your own tunnel or proxy that forwards `/slack/*` to
   `127.0.0.1:8655` (replace the address with the person's real one first):

   ```bash
   PUBLIC_URL=https://bots.example.com; bash slack-connect/install.sh --public-url "$PUBLIC_URL" --dry-run && bash slack-connect/install.sh --public-url "$PUBLIC_URL"
   ```

   The installer copies the plugin, the relay and the Slack HTTP platform into
   `$HERMES_HOME`. It writes `slack-connect/config.json` (0600) and starts the
   relay as a user service on `127.0.0.1:8655`. With `--tailscale-funnel` it
   publishes only the `/slack` path, and it refuses if that would expose other
   paths. It never restarts Hermes: tell the person to reload plugins or restart
   Hermes Desktop so the dashboard loads the add-on.
2. **HUMAN, once per workspace:** on
   [api.slack.com/apps](https://api.slack.com/apps), under *Your App
   Configuration Tokens*, click **Generate Token** for the workspace. Copy the
   **Refresh token** (`xoxe-…`) into the bot's Slack window (**Connect another
   workspace**). Hermes keeps the rotating pair owner-only on the host
   (`slack-connect/config-tokens.json`) and refreshes it before each use.
3. **Agent:** check it is ready. It prints **Ready** and exits 0, or exits
   non-zero and names what is missing:

   ```bash
   python3 -I -B slack-connect/install.py --check
   ```
4. **HUMAN:** in the window, check **Who can talk to it** (the default is
   everyone in the workspace; see above), pick the workspace and click
   **Connect**. Slack's page opens; click **Allow**. Every app the kit creates
   gets the scopes in `slack-connect/common/core.py` (`BOT_SCOPES`, including
   `reactions:write` and `users:read`, which the member list needs). It also
   gets the events `app_mention`, `message.im`, `message.channels`,
   `message.groups`, `message.mpim` and a few app events. Socket Mode and token
   rotation are off.
5. The window shows **Connected** and **who can talk to it**. The bot sends a
   welcome DM that says the same. If that DM can't be sent, the bot is still
   connected (its member list is kept current all the same): Slack's page and
   the window say *Welcome message couldn't be sent: <Slack's reason>*.
6. **Optional, recommended:** install **slack-check** so the Slack card's
   **Test connection** asks Slack itself. Run it **after** Connect, so the bot's
   profile already has its token. Put the bot's profile name in `PROFILE`
   first:

   ```bash
   PROFILE='my-bot'   # the bot's profile name
   bash slack-check/install.sh --profile "$PROFILE" --dry-run && bash slack-check/install.sh --profile "$PROFILE"
   ```
7. **Verify:** see [Check it works](#check-it-works).

To remove the bot from Slack, use **Remove from Slack** in the same window and
confirm. It deletes the app and the bot's Slack keys, and restores the
allowlist the profile had before. **Cancel** or closing the window removes
only an app that was never installed; once the bot has its Slack token, only
the confirmed **Remove from Slack** deletes the app. That holds even when you
cancel at the moment Slack finishes authorizing. Remove deletes only the
connection the window was showing: if the bot was reconnected meanwhile (from
another window, say), it answers *This Slack connection changed; reopen the
window* and deletes nothing.

## Settings that matter afterwards

- **Who can talk to it:** see the top of this page. The bot's Slack window
  always shows the current answer.
- **👀 acknowledgement.** Hermes's Slack adapter adds a reaction when it starts
  on a message and again when it finishes. It needs the `reactions:write` bot
  scope. **Test connection** says *Works, but a Slack permission is missing* if
  the app lacks it. Fix an app created by slack-connect with its scope repair
  ([slack-connect README](../slack-connect/README.md#missing-permissions-on-an-existing-app)).
  Then a **HUMAN** clicks **Reinstall** and **Allow** on the app's page. For a
  Socket Mode app, add the scope on its *OAuth & Permissions* page and reinstall.
- **Home channel.** A Hermes setting, not a kit one: the Slack channel Hermes
  uses for the bot's messages that are not replies to someone. When Hermes
  reports it, the Slack card shows it as *Home channel*. Set or change it with
  Hermes's own Slack commands or settings (see Hermes's Slack documentation).
- **Channels.** The bot hears a public or private channel only after someone
  invites it there (`/invite @botname`). In channels it answers @mentions.

## Check it works

1. In the bot's Slack card, click **Test connection** (needs slack-check). The
   result is Slack's own answer, for example *Works · @helper in Example
   Workspace*, or the real error (`invalid_auth`, `account_inactive`, a network
   error).
2. **HUMAN:** DM the bot "hi". Expect a 👀 reaction within a few seconds and
   then an answer. Ask a teammate to do the same.
3. slack-connect only: `python3 -I -B slack-connect/install.py --check` prints
   **Ready** and exits 0. It checks the local relay, the public address (from
   this host) and the add-on's routes.

## Troubleshooting

| Symptom | Check |
|---|---|
| The Slack window shows the paste-tokens dialog, though you installed slack-connect | Run `python3 -I -B slack-connect/install.py --check` on the host. It names the missing piece (config, relay, public URL, the add-on's route). |
| "Slack setup token expired, add a new one" | **HUMAN:** generate a new configuration token on api.slack.com/apps and add the workspace again. |
| A teammate gets no answer | Look at who can talk to it in the bot's Slack window. A guest or a Slack Connect user is not included by design. A new member is included at the next refresh (up to 15 minutes). |
| "the app lacks the users:read permission" (member list) | The kit's apps are created with `users:read`; it was removed later. **HUMAN:** on the app's page on api.slack.com/apps, *OAuth & Permissions → Bot Token Scopes*, add `users:read`, then **Reinstall** and **Allow**. The [scope repair](../slack-connect/README.md#missing-permissions-on-an-existing-app) (`scope_repair.py check` / `repair --profile "$PROFILE"`) adds only the scopes it lists as required, which today is `reactions:write`. |
| "Member list stale since …" or "never read", and fewer people can talk to the bot | Slack's member list could not be read for over 24 hours (or never), so the bot fell back to only you, or to nobody. Fix the reason shown on the same line; the relay retries every 15 minutes, or choose **Everyone in the workspace** again to read it now. |
| "Slack asked to wait" | Slack rate-limited the member list. The relay waits the time Slack asked for, then retries. Nothing to do. |
| No 👀, but the bot answers | `reactions:write` is missing: see the acknowledgement setting above. |
| The bot never answers in Slack | Check that the window doesn't say *Nobody can talk to this bot*. Then **Test connection**; then `install.py --check`; then the relay log (`~/Library/Logs/hermes-slack-ingress.log` on macOS, `~/.local/state/hermes-slack-ingress.log` on Linux); then the bot's `logs/gateway.log`. |
| "Your URL didn't respond" on the app's Event Subscriptions page | Known Slack label for apps created from a manifest. Ignore it if the bot answers DMs. |
| Port 8655 is taken | Re-run the install block with `--relay-port <port>` and point the proxy there. |

More detail: [slack-connect](../slack-connect/README.md),
[slack-check](../slack-check/README.md), [slack-relay](../slack-relay/README.md),
[slack-http](../slack-http/README.md).
