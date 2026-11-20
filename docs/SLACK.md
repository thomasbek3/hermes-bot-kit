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

## Who can talk to the bot

**After Connect, only you can.** With one-click Add to Slack (way B), the relay
writes `SLACK_ALLOWED_USERS` = the Slack member who clicked **Allow**, so the
bot answers that person and nobody else. With Socket Mode (way A), the bot
answers the people whose first DM you approve.

**To let teammates talk to it today,** add their Slack member IDs (Slack:
their profile → ⋮ → *Copy member ID*) to the bot's allowlist, comma-separated,
after your own:

1. Open the bot's profile `.env`: `~/.hermes/profiles/<bot profile>/.env`
   (or `$HERMES_HOME/profiles/<bot profile>/.env` if you set `HERMES_HOME`).
2. Change the line to, for example,
   `SLACK_ALLOWED_USERS=U0YOURID,U0TEAMMATE1,U0TEAMMATE2`.
3. Restart the bot's gateway, or reload it, so Hermes reads the new value.

Anyone on that list can ask the bot to do anything its tools can do, and it
does it **with the bot's own access** (its accounts, files, computer and
everything else you connected). Add people only if you want that. Note: while
the list names anyone besides you, the one-click **Connect** refuses to
reconnect that bot (it promises the installer is the only one allowed); put
the line back to your own ID first.

Team-wide access by default is coming in the next release.

## Pick a way

| | **A. Socket Mode** (two tokens) | **B. One-click Add to Slack** (slack-connect) |
|---|---|---|
| What you need | Hermes Desktop only | An always-on Hermes host (macOS or Linux), a public HTTPS address (Tailscale Funnel or your own proxy), one Slack configuration token per workspace |
| Human steps | Create the app from the manifest, install it, copy two tokens, approve your first DM | Generate one configuration token per workspace, then click **Allow** |
| How Slack reaches the bot | The bot connects out to Slack (no public address) | Slack sends events over HTTPS to the kit's relay |
| Who may talk to the bot | People whose first DM you approve | Only the person who clicked Allow (`SLACK_ALLOWED_USERS`), plus anyone you add (above) |

If you are not sure, use **A**. It needs nothing beyond Hermes Desktop.

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
5. **HUMAN, step 4 (First DM):** the person DMs the bot in Slack. For two
   minutes the window lists pending first DMs with the sender's name, Slack
   **member ID** and age. **Check that the member ID is your own** (Slack: your
   profile → ⋮ → *Copy member ID*) before you click **Approve**. Anyone who can
   DM the bot can show up here, and display names are not unique. Later
   requests can be approved in Hermes's Messaging settings.
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
   PUBLIC_URL='https://bots.example.com'; bash slack-connect/install.sh --public-url "$PUBLIC_URL" --dry-run && bash slack-connect/install.sh --public-url "$PUBLIC_URL"
   ```

   The installer copies the plugin, the relay and the Slack HTTP platform into
   `$HERMES_HOME`. It writes `slack-connect/config.json` (0600) and starts the
   relay as a user service on `127.0.0.1:8655`. With `--tailscale-funnel` it
   publishes only the `/slack` path, and it refuses if that would expose other
   paths. It ends with a self-check that prints **Ready** or names what is
   missing. It never restarts Hermes: tell the person to reload plugins
   (**⌘K → Reload desktop plugins**, Ctrl+K on Linux) or restart Hermes Desktop
   if the self-check says the route is not loaded yet.
2. **HUMAN, once per workspace:** on
   [api.slack.com/apps](https://api.slack.com/apps), under *Your App
   Configuration Tokens*, click **Generate Token** for the workspace. Copy the
   **Refresh token** (`xoxe-…`) into the bot's Slack window (**Connect another
   workspace**). Hermes keeps the rotating pair owner-only on the host
   (`slack-connect/config-tokens.json`) and refreshes it before each use.
3. **HUMAN:** pick the workspace and click **Connect**. Slack's page opens; click
   **Allow**. Every app the kit creates gets the scopes in
   `slack-connect/common/core.py` (`BOT_SCOPES`, including `reactions:write`)
   and the events `app_mention`, `message.im`, `message.channels`,
   `message.groups`, `message.mpim` and a few app events. Socket Mode and token
   rotation are off.
4. The window shows **Connected** and the bot sends you a welcome DM. Only you
   can talk to it (see [Who can talk to the bot](#who-can-talk-to-the-bot) to
   add teammates).
5. **Optional, recommended:** install **slack-check**, so the Slack card's
   **Test connection** asks Slack itself. Run it **after** Connect, so the
   bot's profile already has its token, and name the profile:

   ```bash
   PROFILE='my-bot'; bash slack-check/install.sh --profile "$PROFILE" --dry-run && bash slack-check/install.sh --profile "$PROFILE"
   ```
6. **Verify:** see [Check it works](#check-it-works).

To remove the bot from Slack, use **Remove from Slack** in the same window. It
deletes the app and the bot's Slack keys and restores the earlier allowlist.

## Settings that matter afterwards

- **Who may talk to the bot:** see [above](#who-can-talk-to-the-bot). Email
  sending and rule changes are refused from Slack in this kit, but other
  plugins may differ.
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
   `curl -fsS https://<your public address>/slack/healthz` prints `ok`.

## Troubleshooting

| Symptom | Check |
|---|---|
| The Slack window shows the paste-tokens dialog, though you installed slack-connect | Run the install block again with `--dry-run` on the host. Its self-check names the missing piece (config, relay, public URL, the add-on's route). |
| "Slack setup token expired, add a new one" | **HUMAN:** generate a new configuration token on api.slack.com/apps and add the workspace again. |
| A teammate gets no answer | Only you are allowed after Connect. Add their member ID (see [Who can talk to the bot](#who-can-talk-to-the-bot)) and restart or reload the bot. |
| Connect says the bot already lets other Slack users in | Set the bot's `SLACK_ALLOWED_USERS` back to only your own ID, then Connect again. |
| No 👀, but the bot answers | `reactions:write` is missing: see the acknowledgement setting above. |
| The bot never answers in Slack | **Test connection**; for slack-connect, `healthz` and then the relay log (`~/Library/Logs/hermes-slack-ingress.log` on macOS, `~/.local/state/hermes-slack-ingress.log` on Linux); then the bot's `logs/gateway.log`. |
| "Your URL didn't respond" on the app's Event Subscriptions page | Known Slack label for apps created from a manifest. Ignore it if the bot answers DMs. |
| Port 8655 is taken | Re-run the install block with `--relay-port <port>` and point the proxy there. |

More detail: [slack-connect](../slack-connect/README.md),
[slack-check](../slack-check/README.md), [slack-relay](../slack-relay/README.md),
[slack-http](../slack-http/README.md).
