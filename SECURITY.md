# Security Policy

## Supported versions

Releases are tags named `vYYYY.MM.DD`. Install one-liners pin the latest
tag and verify every file against that tag's `MANIFEST.sha256`. Running
from `master` is possible with `KIT_REF=master` but unsupported.

## Reporting a vulnerability

This software streams live screens and can execute shell commands on your
machines — reports are taken seriously.

**Please do not open a public issue for security problems.**

Instead, use GitHub's private vulnerability reporting:
**Security tab → Report a vulnerability**, or contact the maintainer via a
private channel listed on the GitHub profile page.

Include: affected component (desktop plugin / host scripts / hiperf agent /
agent plugin), reproduction steps, and impact. You'll get an initial response
within a few days.

## Scope notes

- The VNC server (port 5900) is loopback-only on Windows (TightVNC/UltraVNC
  `LoopbackOnly=1`) and Linux (`x11vnc -localhost`, wayvnc on 127.0.0.1).
  **On macOS it is not:** Screen Sharing is Apple's service and listens on
  every interface, so on a Mac the VNC password is a real boundary for
  anyone on the same network. Turn on the macOS firewall (System Settings →
  Network → Firewall) or keep the Mac on networks you trust. The websockify
  bridge (6080) and HD agent (6090) are network listeners. Default bind:
  the Tailscale interface when Tailscale is up, otherwise loopback.
  `CV_BIND=0.0.0.0` exposes them on every interface and is supported only
  on a trusted LAN. Transport is plaintext `ws://`: confidentiality and
  peer authentication come from the tailnet (WireGuard) or an SSH tunnel,
  not from the bridge. No TLS/`wss` mode exists. The HD token is sent
  as the first WebSocket message (an `auth` frame), not in the URL; the agent
  still accepts the old `?token=` query from older viewers. Either way it
  crosses the network in plaintext over `ws://`: anyone who can read the
  wire can read it — keep it on the tailnet or tunnel. Public hosts need
  `wss://`; the viewer refuses plaintext (`ws://`, or `http://`, which the
  browser turns into `ws://`) to any host that is not loopback, LAN,
  `.local` or Tailscale. The VNC password is 8 characters by protocol
  (classic DES auth); treat it as a second factor, not the boundary. The
  desktop plugin refuses plaintext WebSockets to public hosts.
- HD mode tokens and session-API bearer tokens are stored locally by design
  (`.env` / plugin storage, `0600`). They are never transmitted anywhere
  except to the endpoint you configure.
- A Slack bot connected with one-click Add to Slack answers every full member
  of the workspace by default, and its tools act with the bot's own access
  for anyone who can message it. The bot's Slack window shows who can, and
  where each grant comes from; `docs/SLACK.md` says how to restrict it.
- Social-engineering reports ("the AI told me to run...") are out of scope
  here — file them with Hermes Agent core.

## Audit

**Latest: 2026-11-19**, on `master` at `cdcaad2`, with Cloudflare's
[security-audit skill](https://github.com/cloudflare/security-audit-skill)
in full-audit mode (standard profile).

**Method:** mapping first, then five waves of focused hunts with coverage
critics, an independent check of every candidate, and a second fresh check of
every surviving record. 30 coverage units in all, covering the installers and
release chain, the desktop UI's handling of bot output, cards and previews,
the Computer viewer and the host scripts, the Slack relay and connect flow,
email-drafts, remote-cua and texting-style. No code was executed: every check
was a source review, because the audit host could not enforce a memory limit
for a sandbox. The pass is **partial**: hunting stopped after wave 5, and two
areas were not reviewed: the bot's terminal and file tools versus the
remote-cua take-over lease, and Duplicate bot versus Slack credentials.

**Result:** three low-severity findings were confirmed, and all three are
fixed. They were two disclosures of the maintainer's private details in the
public tree (the privacy-guard test fixtures, and a reversible VNC password
blob in the build notes) and one binding gap (email-drafts "Allow recipient"
allowed the stored To list, not the one on screen). Two candidates were
rejected as owner-only correctness issues. No credential value was found in
the tree or in the published history; the history does still contain private
names. The full report stays outside the repository.

**Fifteen leads were not confirmed.** Each depends on facts the source cannot
show (Windows ACLs on a real machine, a second local account, Hermes Desktop
behaviour), so none was reproduced. All fifteen were changed in source, but
**none has been checked on a live system**, so treat them as mitigated, not
closed. A second review of the first round of fixes found eight of them
incomplete, and they were redone before this release: the Linux X11 password
file, the Windows interpreter check (now done before Python is first run, and
for HD's ffmpeg too), the UltraVNC config (now locked down before the password
is written, verified, and fail-closed), the Windows state and driver folders
(another account's tree is refused, not adopted), the legacy "This Mac"
endpoint (now also cleared for upgraders), preview pages (two leads: Send
always needs your click, on the text shown), and skills-hub Install (one-click only for a source-qualified
result, which today is none; a command to copy instead). The other
seven (the macOS Screen Sharing docs, the Computer pane's remote-cua session
on switch, the Gmail thread on a reply card, `/email-drafts` from a messaging
platform, bot-named SVG images, Slack first-DM approval, texting-style's debug
log) were not reopened. The CHANGELOG entry for v2026.11.19 lists every change.

**Earlier: 2026-11-09**, a quick, partial, source-only pass. It confirmed no
vulnerabilities and closed eight leads in source: tool-approval argument
display, the `C:\usbmmidd_v2` and `C:\ProgramData\hermes-cv` ACLs, the
Windows HD token ACL, `::preview` send confirmation, sign-in link schemes,
click-to-load remote images, and the Slack relay's per-client rate limit.
