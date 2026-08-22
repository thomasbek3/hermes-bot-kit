"""Tool schemas -- what the LLM sees."""

ORGO_AGENT_MODELS = [
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-opus-4.8",
    "claude-sonnet-4.6",
    "claude-opus-4.6",
]

ORGO_COMPUTER_RUN = {
    "name": "orgo_computer_run",
    "description": (
        "Delegate a bounded multi-step GUI or browser task to the hosted "
        "computer-use agent on this bot's provisioned cloud computer. It can "
        "click, type, browse, and change external state, uses Orgo plan "
        "credits, and is not idempotent. The run holds the computer's input "
        "for the whole duration; a second call on the same computer fails "
        "after about 5 seconds until the first finishes -- do not retry a "
        "lock-busy error. Prefer orgo_computer_bash or other direct tools for "
        "deterministic non-visual work. Write tasks self-contained with an "
        "explicit end condition."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "task": {
                "type": "string",
                "description": (
                    "A complete, self-contained description of the visual "
                    "computer task, including an explicit end condition."
                ),
                "minLength": 1,
                "maxLength": 20000,
            },
            "model": {
                "type": "string",
                "description": "The Orgo-hosted computer-use model.",
                "enum": list(ORGO_AGENT_MODELS),
            },
            "max_steps": {
                "type": "integer",
                "description": "Maximum screenshot/action loop steps (1-100). Defaults to 30.",
                "minimum": 1,
                "maximum": 100,
            },
        },
        "required": ["task"],
    },
}

ORGO_COMPUTER_BASH = {
    "name": "orgo_computer_bash",
    "description": (
        "Execute one arbitrary shell command on this bot's pinned Orgo cloud "
        "VM and return its combined output and exit code. This changes "
        "external state on a real machine -- treat with the same care as any "
        "shell. Deterministic and cheap; preferred over orgo_computer_run for "
        "anything not requiring vision or a GUI. Runs concurrently with "
        "delegated GUI work; avoid commands that manipulate the GUI while a "
        "delegated run is active."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to run on the pinned Orgo VM.",
                "minLength": 1,
            },
        },
        "required": ["command"],
    },
}
