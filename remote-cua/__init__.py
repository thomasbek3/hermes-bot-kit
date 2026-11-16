"""remote-cua: Hermes's own computer_use tool, driving a remote Mac over SSH.

One directory, two ways Hermes loads it:

* as the computer-use provider named by ``computer_use.backend: remote-cua`` (Hermes's
  ``plugins/computer_use`` discovery calls ``register(ctx)`` with a collector that only keeps
  ``ctx.register_computer_use_provider``), and
* as an ordinary plugin (``kind: standalone`` in plugin.yaml, enabled in ``plugins.enabled``) that
  adds the ``pre_tool_call`` lease hook and the ``hermes remote-cua check`` command.

The desktop pane changes the lease through this directory's dashboard routes
(``dashboard/plugin_api.py``, mounted by Hermes at ``/api/plugins/remote-cua/``).
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def register(ctx):
    # Provider: present only on Hermes's computer-use collector context (register_computer_use_provider).
    register_provider = getattr(ctx, "register_computer_use_provider", None)
    if callable(register_provider):
        from .provider import make_provider
        register_provider(make_provider())

    from . import cli, lease
    ctx.register_hook("pre_tool_call", lease.pre_tool_call)
    register_cli = getattr(ctx, "register_cli_command", None)
    if callable(register_cli):
        try:
            register_cli("remote-cua", "Check a bot's remote Mac for computer_use (remote-cua)",
                         cli.setup_parser, cli.handle,
                         description="Reachability, cua-driver, macOS permissions and screen state of the "
                                     "machine a profile's remote_cua block points at.")
        except Exception as exc:  # a name clash must not cost the lease hook
            logger.warning("remote-cua: could not register the CLI command: %s", exc)
