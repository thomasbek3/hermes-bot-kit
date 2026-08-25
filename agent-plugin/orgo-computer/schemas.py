"""Tool schemas -- what the LLM sees."""

ORGO_AGENT_MODELS = [
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-opus-4.8",
    "claude-sonnet-4.6",
    "claude-opus-4.6",
]

ORGO_COMPUTER_BASH = {
    "name": "orgo_computer_bash",
    "description": (
        "Execute one shell command on this bot's pinned Orgo cloud VM and "
        "return combined output and exit code. Preferred for anything that "
        "is a command: open a URL, install a package, write a file, start "
        "or stop a process. Changes real machine state. Do not use for "
        "visual UI work -- take a screenshot and click instead."
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

ORGO_COMPUTER_SCREENSHOT = {
    "name": "orgo_computer_screenshot",
    "description": (
        "Take a screenshot of the pinned Orgo desktop and return the image. "
        "Included in the monthly plan (no AI credits). Coordinates for "
        "orgo_computer_click are pixels in this image. After click/type/key, "
        "call this again to see what changed."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}

ORGO_COMPUTER_CLICK = {
    "name": "orgo_computer_click",
    "description": (
        "Click the pinned Orgo desktop at pixel (x, y). Included in the "
        "monthly plan (no AI credits). Use coordinates from the latest "
        "orgo_computer_screenshot. Then screenshot again."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "x": {
                "type": "integer",
                "description": "Horizontal pixel from the left edge.",
                "minimum": 0,
            },
            "y": {
                "type": "integer",
                "description": "Vertical pixel from the top edge.",
                "minimum": 0,
            },
            "button": {
                "type": "string",
                "description": "Mouse button. Defaults to left.",
                "enum": ["left", "right"],
            },
            "double": {
                "type": "boolean",
                "description": "If true, double-click. Defaults to false.",
            },
        },
        "required": ["x", "y"],
    },
}

ORGO_COMPUTER_TYPE = {
    "name": "orgo_computer_type",
    "description": (
        "Type text into the focused field on the pinned Orgo desktop. "
        "Included in the monthly plan (no AI credits). Screenshot first "
        "so you know what is focused."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "Literal text to type.",
                "minLength": 1,
                "maxLength": 4000,
            },
        },
        "required": ["text"],
    },
}

ORGO_COMPUTER_KEY = {
    "name": "orgo_computer_key",
    "description": (
        "Press one key on the pinned Orgo desktop (Return, Escape, Tab, "
        "Page_Down, Down). Included in the monthly plan (no AI credits). "
        "Use for dialogs and scrolling. Then screenshot again."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "Key name, e.g. Return, Escape, Tab, Page_Down.",
                "minLength": 1,
                "maxLength": 40,
            },
        },
        "required": ["key"],
    },
}

ORGO_COMPUTER_RUN = {
    "name": "orgo_computer_run",
    "description": (
        "LAST RESORT. Delegate a multi-step GUI task to Orgo's hosted "
        "computer-use agent. Spends plan AI credits and holds the mouse "
        "until it finishes. Do not use if orgo_computer_bash or "
        "screenshot/click/type/key can do the job. A second call on the "
        "same computer fails after about 5 seconds while a run is active "
        "-- do not retry a lock-busy error. Write a self-contained task "
        "with an explicit end condition."
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
