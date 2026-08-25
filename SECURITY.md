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

- The VNC bridges (`connect-*` scripts) bind to **loopback only**; exposing
  them to a network is outside supported configuration.
- HD mode tokens and Orgo API keys are stored locally by design
  (`.env` / plugin storage, `0600`). They are never transmitted anywhere
  except to the endpoint you configure.
- Social-engineering reports ("the AI told me to run...") are out of scope
  here — file them with Hermes Agent core.
