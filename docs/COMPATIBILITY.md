# Hermes compatibility

Checked 2026-11-07 against NousResearch/hermes-agent stable **v0.23.0**, commit
`2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`.
[Official release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0).

The four Desktop plugins use the Desktop plugin SDK and DOM markers. The
optional texting-style and orgo-computer plugins use Agent plugin registration
APIs. These are separate from the language model: this kit does not select,
pin, download, or upgrade a model. Choose a provider/model through Hermes;
texting-style supplies prompt context and orgo-computer supplies tools. Actual
model behavior and tool calling still require a configured provider test.

## Repeat the checks

Against a separate, clean Hermes Agent source checkout:

```sh
python3 scripts/check-hermes-compat.py /path/to/hermes-agent
node --test bubble-mode/plugin.test.mjs bot-sections/plugin.test.mjs task-dock/plugin.test.mjs computer-viewer/plugin.test.mjs
python3 -m unittest discover -s texting-style/tests
python3 -m unittest discover -s computer-viewer/agent-plugin/orgo-computer/tests
```

CI checks the pinned stable baseline and upstream main on pushes, PRs, and a
weekly schedule. Source checks detect removed SDK names, literal DOM slot names,
and agent registration hooks. They do not validate TypeScript signatures,
transitive exports, CSS layout, RPC routing, or model responses. A passing source
check is an early warning check, not a guarantee of full runtime compatibility.

## Live acceptance still required

In a test Desktop setup, install from the checkout and reload plugins. Inspect
Bot Chat bubbles, approvals and group/regular session exclusions; move/collapse
roster sections; switch bots with a saved Task Dock; connect a test computer;
and exercise texting-style and Orgo tools with a configured model. Include two
connections with identically named profiles when checking a multi-gateway fleet.
No live Desktop files, model settings, services, or remote computers were changed
by this source audit. Windows PowerShell parsing remains covered by Windows CI.

Install snippets remain pinned to the existing published kit release. Updating
this source tree does not publish a new release or change what those URLs serve.
Use `bash install.sh` from this checkout to test the updated source. Cut a new
kit release through `scripts/release.sh` before changing the public install pin.
