# Notices

This project is an independent, community plugin for
[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research).
It is not built by, endorsed by, or affiliated with Nous Research,
Tailscale, or xAI.

## Derivative work attribution

The desktop viewer (`plugin.js`) studied the public source of
[Korgo Bot](https://github.com/nickvasilescu/korgo-bot) by Nick Vasilescu
(MIT License, Copyright (c) 2025 Nous Research) for UI patterns (thumbnail
panel-crop, reconnect backoff, expand-without-reconnect) but contains no
copied code. An earlier agent plugin adapted from Korgo Bot was retired and
is no longer shipped; its history (with this notice) stays in git. The
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
