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
| **Everyone in the workspace** (default) | Full members; not guests, not Slack Connect users |
| **Only me** | Only the person who added the bot |
| **Only these people** | Slack member IDs you list (Slack: profile → ⋮ → *Copy member ID*); you are always included |

**What the window shows is the truth.** After Connect, the window, Slack's
confirmation page and the welcome DM show **who can actually talk to the
bot**. That is worked out from every setting Hermes honours for that bot:
`SLACK_ALLOWED_USERS`, `SLACK_ALLOW_ALL_USERS`, `GATEWAY_ALLOWED_USERS` and the
people approved through Hermes's first-DM pairing. If any of them lets in more
people than you chose, the window names each one. **Remove the extra access**
clears the ones that belong to that bot alone: `SLACK_ALLOW_ALL_USERS`, a `*`
in `SLACK_ALLOWED_USERS`, and pairing approvals. `GATEWAY_ALLOWED_USERS`
applies to every messaging platform of the bot, so the window tells you to
edit it rather than changing it for you.

How the kit does it: Hermes has no "full members only" switch.
`SLACK_ALLOW_ALL_USERS=true` would also let guests in (Hermes refuses only
other companies' DMs). So the kit writes the member list into the bot's
`SLACK_ALLOWED_USERS` (Slack's `users.list`, filtered to full members of this
workspace) and the relay keeps it current. If Slack's member list can't be
read at Connect, only you are allowed until the next refresh, and the window
says so.

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

1. **Agent:** check that Hermes Desktop is at least 0.20.5 and the kit is
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
2. **Agent:** check it is ready (exits non-zero and names what is missing
   otherwise):

   ```bash
   python3 -I -B slack-connect/install.py --check
   ```

   Until a workspace configuration token is added (step 4), it reports that
   one as missing. That is expected at this point.
3. **HUMAN, once per workspace:** on
   [api.slack.com/apps](https://api.slack.com/apps), under *Your App
   Configuration Tokens*, click **Generate Token** for the workspace. Copy the
   **Refresh token** (`xoxe-…`) into the bot's Slack window (**Connect another
   workspace**). Hermes keeps the rotating pair owner-only on the host
   (`slack-connect/config-tokens.json`) and refreshes it before each use.
4. **HUMAN:** in the window, check **Who can talk to it** (the default is
   everyone in the workspace; see above), pick the workspace and click
   **Connect**. Slack's page opens; click **Allow**. Every app the kit creates
   gets the scopes in `slack-connect/common/core.py` (`BOT_SCOPES`, including
   `reactions:write` and `users:read`, which the member list needs). It also
   gets the events `app_mention`, `message.im`, `message.channels`,
   `message.groups`, `message.mpim` and a few app events. Socket Mode and token
   rotation are off.
5. The window shows **Connected** and **who can talk to it**. The bot sends a
   welcome DM that says the same.
6. **Optional, recommended:** install **slack-check** so the Slack card's
   **Test connection** asks Slack itself. Run it **after** Connect, so the bot's
   profile already has its token, and name the profile:

   ```bash
   bash slack-check/install.sh --profile <bot profile name> --dry-run && bash slack-check/install.sh --profile <bot profile name>
   ```
7. **Verify:** see [Check it works](#check-it-works).

To remove the bot from Slack, use **Remove from Slack** in the same window. It
deletes the app and the bot's Slack keys, and restores the allowlist the
profile had before.

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
| A teammate gets no answer | Look at **Who can talk to it** in the bot's Slack window. A guest or a Slack Connect user is not included by design. A new member is included at the next refresh (up to 15 minutes). |
| No 👀, but the bot answers | `reactions:write` is missing: see the acknowledgement setting above. |
| The bot never answers in Slack | **Test connection**; then `install.py --check`; then the relay log (`~/Library/Logs/hermes-slack-ingress.log` on macOS, `~/.local/state/hermes-slack-ingress.log` on Linux); then the bot's `logs/gateway.log`. |
| "Your URL didn't respond" on the app's Event Subscriptions page | Known Slack label for apps created from a manifest. Ignore it if the bot answers DMs. |
| Port 8655 is taken | Re-run the install block with `--relay-port <port>` and point the proxy there. |

More detail: [slack-connect](../slack-connect/README.md),
[slack-check](../slack-check/README.md), [slack-relay](../slack-relay/README.md),
[slack-http](../slack-http/README.md).
