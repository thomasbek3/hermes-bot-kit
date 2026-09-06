# Security Policy

## Supported versions

Only the latest commit on `master` is supported. This project moves fast;
please run from a fresh clone.

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
