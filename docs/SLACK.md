# Put a bot in Slack

A runbook for people and for their AI agents. It sets up one Hermes bot so it
answers **DMs and @mentions** in a Slack workspace and acknowledges each message
with an emoji (👀) while it works.

Some steps can only be done by the human: creating or allowing a Slack app,
installing it to the workspace, and copying tokens out of Slack. They are marked
**HUMAN**. An agent stops at those steps and asks the person to do them.

> **Tokens never go in chat and never in this repository.** They are typed
> or pasted only into the bot's Slack window in Hermes Desktop. Hermes stores
> them in that bot's profile (`<profile home>/.env`, owner-only, or the profile's
> secret store), and the kit's own Slack files are mode 0600. An agent must not
> ask the person to paste a token into a chat, a file or a command line.

## Pick a way

| | **A. Socket Mode** (two tokens) | **B. One-click Add to Slack** (slack-connect) |
|---|---|---|
| What you need | Hermes Desktop only | An always-on Hermes host (macOS or Linux), a public HTTPS address (Tailscale Funnel or your own proxy), one Slack configuration token per workspace |
| Human steps | Create the app from the manifest, install it, copy two tokens, approve your first DM | Generate one configuration token per workspace, then click **Allow** |
| How Slack reaches the bot | The bot connects out to Slack (no public address) | Slack sends events over HTTPS to the kit's relay |
| Who may talk to the bot | People whose first DM you approve | Only the person who clicked Allow (`SLACK_ALLOWED_USERS`) |

If you are not sure, use **A**. It needs nothing beyond Hermes Desktop.

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
5. **HUMAN, step 4 (First DM):** the person DMs the bot in Slack. For two
   minutes the window lists pending first DMs with the sender's name, Slack
   **member ID** and age. **Check that the member ID is your own** (Slack: your
   profile → ⋮ → *Copy member ID*) before you click **Approve**. Anyone who can
   DM the bot can show up here, and display names are not unique. Later
   requests can be approved in Hermes's Messaging settings.
6. **Verify:** see [Check it works](#check-it-works).

## B. One-click Add to Slack (slack-connect)

Done once per Hermes host, on that host, as the user that runs Hermes, from a
clone of this repository:

1. **Agent:** check the requirements: macOS or Linux, Hermes's API server on,
   and either Tailscale Funnel available or a public HTTPS URL the person gives
   you. Then preview, and run only after the preview looks right:

   ```bash
   bash slack-connect/install.sh --tailscale-funnel --dry-run
   bash slack-connect/install.sh --tailscale-funnel
   # or, with your own tunnel or proxy that forwards /slack/* to 127.0.0.1:8655:
   bash slack-connect/install.sh --public-url https://your-host.example.com
   ```

   The installer copies the plugin, the relay and the Slack HTTP platform into
   `$HERMES_HOME`. It writes `slack-connect/config.json` (0600) and starts the
   relay as a user service on `127.0.0.1:8655`. With `--tailscale-funnel` it
   publishes only the `/slack` path, and it refuses if that would expose other
   paths. It ends with **Ready** or names what is missing. It never restarts
   Hermes: tell the person to reload plugins or restart Hermes Desktop if the
   self-check says the route is not loaded yet.
2. **Optional, recommended:** install **slack-check**, so the Slack card's
   **Test connection** asks Slack itself:

   ```bash
   bash slack-check/install.sh --dry-run
   bash slack-check/install.sh
   ```

3. **HUMAN, once per workspace:** on
   [api.slack.com/apps](https://api.slack.com/apps), under *Your App
   Configuration Tokens*, click **Generate Token** for the workspace. Copy the
   **Refresh token** (`xoxe-…`) into the bot's Slack window (**Connect another
   workspace**). Hermes keeps the rotating pair owner-only on the host
   (`slack-connect/config-tokens.json`) and refreshes it before each use.
4. **HUMAN:** pick the workspace and click **Connect**. Slack's page opens; click
   **Allow**. Every app the kit creates gets the scopes in
   `slack-connect/common/core.py` (`BOT_SCOPES`, including `reactions:write`)
   and the events `app_mention`, `message.im`, `message.channels`,
   `message.groups`, `message.mpim` and a few app events. Socket Mode and token
   rotation are off.
5. The window shows **Connected** and the bot sends a welcome DM. The relay
   writes `SLACK_ALLOWED_USERS` = the Slack user who clicked Allow, so only that
   person can talk to the bot. Connect refuses a bot that already lets other
   Slack users in.
6. **Verify:** see [Check it works](#check-it-works).

To remove the bot from Slack, use **Remove from Slack** in the same window. It
deletes the app and the bot's Slack keys and restores the earlier allowlist.

## Settings that matter afterwards

- **Who may talk to the bot.** Socket Mode: whoever's first DM you approve.
  slack-connect: `SLACK_ALLOWED_USERS` in the bot's `.env`. Add other people
  only if you want them to be able to make the bot act, including any
  `/email-drafts` or other plugin commands (email sending and rule changes are
  refused from Slack in this kit, but other plugins may differ).
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
   then an answer.
3. slack-connect only, from outside your network:
   `curl -s https://<your public address>/slack/healthz` prints `ok`.

## Troubleshooting

| Symptom | Check |
|---|---|
| The Slack window shows the paste-tokens dialog, though you installed slack-connect | Run `bash slack-connect/install.sh --dry-run` on the host. Its self-check names the missing piece (config, relay, public URL). |
| "Slack setup token expired, add a new one" | **HUMAN:** generate a new configuration token on api.slack.com/apps and add the workspace again. |
| No 👀, but the bot answers | `reactions:write` is missing: see the acknowledgement setting above. |
| The bot never answers in Slack | **Test connection**; for slack-connect, `healthz` and then the relay log (`~/Library/Logs/hermes-slack-ingress.log` on macOS, `~/.local/state/hermes-slack-ingress.log` on Linux); then the bot's `logs/gateway.log`. |
| "Your URL didn't respond" on the app's Event Subscriptions page | Known Slack label for apps created from a manifest. Ignore it if the bot answers DMs. |
| Port 8655 is taken | `bash slack-connect/install.sh --relay-port <port> ...` and point the proxy there. |

More detail: [slack-connect](../slack-connect/README.md),
[slack-check](../slack-check/README.md), [slack-relay](../slack-relay/README.md),
[slack-http](../slack-http/README.md).
