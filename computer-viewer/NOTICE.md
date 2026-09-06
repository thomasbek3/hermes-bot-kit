# Notices

This project is an independent, community plugin for
[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research).
It is not built by, endorsed by, or affiliated with Nous Research, Orgo,
Tailscale, or xAI.

## Derivative work attribution

The `agent-plugin/orgo-computer` component is derived in part from
[Korgo Bot](https://github.com/nickvasilescu/korgo-bot) by Nick Vasilescu
(MIT License, Copyright (c) 2025 Nous Research): the agent-endpoint handling,
Orgo request/response helpers, error-status mapping, and run-locking pattern
are adapted from its `orgo_agent_mcp.py`. The desktop viewer (`plugin.js`)
studied Korgo Bot's public source for UI patterns (thumbnail panel-crop,
reconnect backoff, expand-without-reconnect) but contains no copied code.

Korgo Bot's permissive MIT license requires that its copyright and permission
notice accompany derivative portions; this file serves as that notice. The
MIT License text is in [`LICENSE`](LICENSE).

## noVNC (MPL-2.0)

WebSocket mode vendors a bundled copy of [noVNC](https://github.com/novnc/noVNC)
1.7.0 (`core/rfb.js`) at [`vendor/novnc-rfb.mjs`](vendor/novnc-rfb.mjs).
noVNC is Copyright (C) 2022 The noVNC authors and is licensed under the
Mozilla Public License, version 2.0. The MPL-2.0 text is at
https://www.mozilla.org/MPL/2.0/ and in the upstream source. The bundle also
includes pako (MIT). Provenance and the rebuild command are in
[`vendor/README.md`](vendor/README.md).

## Trademarks

Product and company names mentioned here are trademarks of their respective
owners. The MIT License covers the software; it does not grant trademark
rights.
