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

- The VNC server itself (port 5900) is loopback-only. The websockify
  bridge (6080) and HD agent (6090) are network listeners. Default bind:
  the Tailscale interface when Tailscale is up, otherwise loopback.
  `CV_BIND=0.0.0.0` exposes them on every interface and is supported only
  on a trusted LAN. Transport is plaintext `ws://`: confidentiality and
  peer authentication come from the tailnet (WireGuard) or an SSH tunnel,
  not from the bridge. No TLS/`wss` mode exists. The HD token travels in
  the WebSocket query string because the browser WebSocket API cannot set
  headers; anyone who can read the wire can read it — keep it on the
  tailnet or tunnel. The VNC password is 8 characters by protocol
  (classic DES auth); treat it as a second factor, not the boundary. The
  desktop plugin refuses `ws://` to public hosts.
- HD mode tokens and Orgo API keys are stored locally by design
  (`.env` / plugin storage, `0600`). They are never transmitted anywhere
  except to the endpoint you configure.
- Social-engineering reports ("the AI told me to run...") are out of scope
  here — file them with Hermes Agent core.

## Audit

**Date:** 2026-11-09.

**Method:** a multi-phase source audit of the whole repository (mapping,
focused hunts, an independent check of every candidate, a final review), run
as a quick, partial pass. No code was executed; every check was source review.

**Result:** no confirmed vulnerabilities. Eight leads could not be settled
from source alone (they depend on Hermes, proxy or Windows behaviour). This
change set closes all eight in source anyway:

1. Orgo tool approvals now show the full argument with control characters
   escaped, up to 2000 characters, with an explicit "more characters" marker.
2. `C:\usbmmidd_v2` (run by a SYSTEM startup task) gets a protected
   Administrators/SYSTEM ACL, and an existing folder with any other owner
   stops the install.
3. The HD agent tree and venv under `C:\ProgramData\hermes-cv` get a
   protected ACL, so other local users cannot add files the logon task runs.
4. The Windows HD token file is readable only by the install user,
   Administrators and SYSTEM.
5. A `::preview` page can no longer send a hidden message without the user:
   it shows the text with Send / Dismiss unless the user just clicked into it.
6. A connection's sign-in link opens only for `https:` (or `http:` to this
   machine); anything else is shown as text.
7. Remote images in bot replies load only when the user clicks Load.
8. The Slack relay's rate limit is per client behind the proxy and never
   blocks requests that carry a valid Slack signature or OAuth state.

Also tightened in the same change set: preview frames have no network, card
buttons show what they send, Slack-supplied text is cleaned before it is
saved, the Slack HTTP listener stays on loopback unless allowed, noVNC loads
only from the verified vendored copy, `C:\ffmpeg` is used only when safe, and
the CI workflows have read-only permissions and actions pinned to commits.

**Not covered** (this pass does not claim these are safe): the Bot Sections,
Task Dock and Bubble Mode desktop plugins; the Orgo agent-plugin installer;
the Orgo CLI helpers `orgo-hands` and `orgo-term`; the computer-viewer noVNC
loader; the root-level legacy installer shims and per-plugin install scripts;
the gateway tool-approval cards in the Grokbot Override desktop UI; Grokbot
Override scheduled routines (cron); the relay service installer and Tailscale
Funnel exposure; the texting-style backend plugin hooks.
