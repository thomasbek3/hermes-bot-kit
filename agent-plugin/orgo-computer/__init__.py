"""orgo-computer plugin -- registration."""

from __future__ import annotations

from pathlib import Path

from . import schemas, tools


def register(ctx) -> None:
    """Wire tools, slash command, CLI, hook, and bundled skill."""
    tools.bind_context(ctx)

    ctx.register_tool(
        name="orgo_computer_run",
        toolset="orgo_computer",
        schema=schemas.ORGO_COMPUTER_RUN,
        handler=tools.orgo_computer_run,
        is_async=True,
        requires_env=["ORGO_API_KEY"],
        check_fn=tools.orgo_ready,
    )
    ctx.register_tool(
        name="orgo_computer_bash",
        toolset="orgo_computer",
        schema=schemas.ORGO_COMPUTER_BASH,
        handler=tools.orgo_computer_bash,
        is_async=True,
        requires_env=["ORGO_API_KEY"],
        check_fn=tools.orgo_ready,
    )

    ctx.register_hook("pre_tool_call", tools.pre_tool_call)

    ctx.register_command(
        "computer",
        handler=tools.handle_computer_command_async,
        description="List or pin this bot's Orgo cloud computer",
        args_hint="[uuid|name]",
    )
    ctx.register_command(
        "orgo-computer",
        handler=tools.handle_computer_command_async,
        description="List or pin this bot's Orgo cloud computer",
        args_hint="[uuid|name]",
    )

    ctx.register_cli_command(
        name="orgo-computer",
        help="List Orgo computers and pin one on a Hermes profile",
        setup_fn=tools.setup_cli,
        handler_fn=tools.handle_cli,
        description=(
            "orgo-computer list  -- list desktops for ORGO_API_KEY; "
            "orgo-computer set <profile> <id>  -- write that profile's pin"
        ),
    )

    skill_md = Path(__file__).parent / "skills" / "computer-basics" / "SKILL.md"
    if skill_md.is_file():
        ctx.register_skill("computer-basics", skill_md)
