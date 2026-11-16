# remote-cua

Hermes's own `computer_use` tool, driving a **remote Mac** over SSH.

The bot keeps everything native: the same `computer_use` tool and schema, Hermes's approvals, Hermes's
cua-driver backend (sessions, captures, input, recovery). This plugin only changes *where* cua-driver
runs: on another Mac, reached with plain OpenSSH. It adds a take-over lease so the
[computer-viewer](../computer-viewer/) pane can let you drive that Mac while the bot waits.

- **Mac:** works (proven against a real Mac with cua-driver 0.21.0).
- **Windows:** the config is accepted, the tool refuses with "Windows support coming: needs cua
  Session proxy". Not built yet.
- **Linux VM:** you don't need this plugin. Use Hermes's native path; see
  [docs/LINUX-VM.md](../docs/LINUX-VM.md).

Requires Hermes `>=0.23.0,<0.24.0` (the plugin reuses Hermes internals and checks the version before
it touches them; see [CONTRACT.md](CONTRACT.md)).

## How it works

Per Hermes run, on the remote Mac, the gateway:

1. Finds the driver in one SSH session: `remote_cua.driver` if set, else
   `~/.hermes/tools/cua-driver-<pin>-darwin-*/cua-driver` matching **the gateway's** pinned version
   (`pm/lock.json`, 0.21.0 today), else `cua-driver` on the remote PATH. It reads the driver's
   `manifest` (version + Hermes's 0.20 contract) and `codesign -dv` of the `CuaDriver.app` that
   carries it (`com.trycua.driver`, one of Hermes's two accepted signing teams). A different version
   is refused with a plain message.
2. Starts a **private daemon** through that exact app, never by name (`open -a CuaDriver` lets macOS
   pick whatever CuaDriver it likes, which breaks):
   `open -n -g -a <…/CuaDriver.app> --args serve --embedded --socket /tmp/hc-<token>.sock
   --no-permissions-gate --permission-mode standard --no-overlay`, then polls `status --socket`.
   Started that way, the daemon carries CuaDriver's own macOS permissions, even from SSH.
3. Runs Hermes's MCP session over **one** SSH connection:
   `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 user@host '… exec <bin> mcp --no-overlay
   --embedded --socket /tmp/hc-<token>.sock'`.
4. Records each daemon in `<profile home>/remote-cua/daemons.json` **before** launching it, and
   forgets it only once the Mac proves it is gone: the driver runs, and its `status --socket` says
   "not running" (Hermes's own rule). Only then is the socket file removed. A missing driver, a status
   that still answers or fails any other way is not proof. The record file is updated under a file lock
   (`daemons.lock`), so the gateway and `hermes remote-cua check` never overwrite each other's entries. It stops the daemon on session end, at gateway exit, and if the
   SSH session drops mid-start (a remote trap). A stop that cannot be confirmed (network down) is kept
   as `pending` and retried by the next stop, at exit and at the next start, as are daemons a crashed
   gateway process left behind.

The remote driver always runs in cua-driver's `standard` mode. Hermes's approvals still apply on the
gateway as usual.

## Set up a Mac (once)

On the Mac, logged in as the user the bot will drive:

1. **Remote Login.** System Settings → General → Sharing → Remote Login on, for that user. Put the
   gateway's public key in `~/.ssh/authorized_keys`. From the gateway host, check it works without a
   password prompt: `ssh -o BatchMode=yes you@100.64.0.10 true`.
2. **Install the pinned driver** where the plugin finds it. If the Mac has Hermes:
   `hermes computer-use install` (puts `cua-driver-<pin>-darwin-*` with its `CuaDriver.app` under
   `~/.hermes/tools/`). Otherwise copy the same cua-driver release (with `CuaDriver.app` next to the
   binary) and set `remote_cua.driver` to the binary's absolute path. The version must match the
   gateway's Hermes pin.
3. **Grant permissions once, at the Mac's screen** (not over SSH): run `<path>/cua-driver permissions
   grant` and approve **Accessibility** and **Screen Recording** for **CuaDriver**
   (`com.trycua.driver`); on macOS Tahoe also approve its direct-capture prompt. The grant follows
   the app's identity, so driver updates signed by the same team keep it.
4. **Keep it logged in and awake.** The user must stay logged in at the console with the screen
   unlocked and the display awake (Energy settings, or an HDMI dummy plug on a headless Mac). A locked
   or sleeping Mac shows no windows and captures fail.

An extra `/Applications/CuaDriver.app` of another version doesn't matter: the plugin always launches
the app next to the driver it found.

## Set up the bot (gateway side)

```bash
bash remote-cua/install.sh --profiles helper      # copies to <profile>/plugins/remote-cua, enables it
```

It checks the Hermes version first (same range as at runtime) and stops before copying anything on an
unsupported Hermes. Enabling uses Hermes's own `hermes plugins enable remote-cua` per profile.

Then in that profile's `config.yaml`:

```yaml
computer_use:
  backend: remote-cua
remote_cua:
  host: 100.64.0.10        # ssh host or ~/.ssh/config alias
  user: you                # ssh user on the Mac
  os: macos                # macos | windows (windows: refused for now)
  driver: ""               # optional absolute path of cua-driver on the Mac
  vnc: ""                  # optional; read by the computer-viewer pane only
```

The gateway runs `ssh` as the user Hermes runs as, with that user's keys and `~/.ssh/config`.
Restart the profile's gateway (or Hermes Desktop), then check:

```bash
hermes -p helper remote-cua check          # or: hermes remote-cua check helper
```

It prints reachability, the driver and version, permissions (asked with `prompt: false`: never a
dialog on the Mac) and whether the screen is awake; exit code 0 = ready, 1 = not ready, 2 = not
configured. Without the CLI hook:
`~/.hermes/hermes-agent/venv/bin/python <profile>/plugins/remote-cua/check.py helper`.

Leave Hermes's own **Open Screen when the bot uses it** off for these bots: Hermes's Screen pane only
shows Linux screens and would say "No bot screen on this host". Watch the Mac in the computer-viewer
pane instead.

## Take over / hand back

The lease lives at `<profile home>/remote-cua/lease.json`
(`{"holder": "agent"|"human", "viewer": …, "since": …, "epoch": …}`; no file = the bot). While you hold
it, `computer_use` is refused with `human_has_control`, captures included, and a result that comes
back after you took over is discarded. The fence covers a whole action: every send to the driver is checked right
before it goes out (Hermes's own retries and replays included), and if you take over at any point
during an action (even take over and hand back between two of its driver calls) nothing more is sent
and its result is not returned. Screenshots only ever come back inline; a file
path in the driver's answer names a file on the Mac and is ignored, never read on the gateway. The pane changes it through `/api/plugins/remote-cua/`
(`lease`, `take`, `release`, `status`); request and response:
[computer-viewer/docs/REMOTE-CUA.md](../computer-viewer/docs/REMOTE-CUA.md). It is a tool-level fence:
the viewer must also stop sending input while the bot holds control.

## Limits

- Take-over is a tool-level fence, not an OS input lock: a driver call already sent before you took
  over cannot be undone, and the viewer itself must keep you view-only while the bot holds control.
  Any refused action (at its start or midway) forgets the bot's last capture target, so after a hand-back
  the bot must capture again before it clicks or types; pre-takeover coordinates are never reused.
- Supported gateways for this release are macOS and Linux: the lease and daemon-record files are
  locked across processes with `flock`. A Windows gateway (no `fcntl`) only gets a per-process lock.

- One bot per Mac at a time is the safe setup; two profiles pointing at one Mac each get their own
  daemon but share the screen.
- The bot's **browser** tools still run where Hermes runs them (gateway or terminal sandbox), not on
  the Mac, so the lease does not fence them.
- Screenshots travel over SSH (Hermes's `computer_use.max_image_dimension`, default 1456 px, keeps them
  small).

## Tests

```bash
~/.hermes/hermes-agent/venv/bin/python -m pytest -p no:cacheprovider remote-cua/tests
```

No network: ssh is faked, and the backend tests run Hermes's real session against a fake stdio MCP
driver. `tests/test_live.py` runs only with `REMOTE_CUA_LIVE_HOST` (and `REMOTE_CUA_LIVE_USER`) set.

## Uninstall

Remove `<profile home>/plugins/remote-cua`, `remote-cua` from `plugins.enabled`, and the
`computer_use.backend` / `remote_cua` lines; restart the gateway.
