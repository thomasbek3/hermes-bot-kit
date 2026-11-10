"""Tool schemas the model reads."""

_ADDRESSES = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Email addresses (plain `name@example.com`; `Name <name@example.com>` keeps the address).",
}

_REPLY = {
    "type": "object",
    "description": (
        "When this email answers another one: the original's Message-ID header, its subject and sender "
        "(shown on the card as \"In reply to\"), optional References and the Gmail thread id when you know them."
    ),
    "properties": {
        "message_id": {"type": "string"},
        "subject": {"type": "string"},
        "from": {"type": "string"},
        "references": {"type": "array", "items": {"type": "string"}},
        "thread_id": {"type": "string"},
    },
}

_ATTACHMENTS = {
    "type": "array",
    "items": {"type": "string"},
    "description": (
        "Files to attach: paths inside your working directory for this chat (relative or absolute), "
        "or inside a folder the user allowed. Anything else is refused."
    ),
}

EMAIL_DRAFT_CREATE = {
    "name": "email_draft_create",
    "description": (
        "Write an email as a DRAFT for the user to review. This is the only way to email anyone: never send "
        "email with a script, SMTP, an API, a browser or another tool. The draft appears as a card in the "
        "user's Hermes Desktop chat with you; the user edits it and clicks Send (or it sends on its own only "
        "when the user has allowed every recipient). After calling this, reply with one short line (for "
        "example: \"Draft to Sam is ready on the card above.\"); do not paste the email text again. Returns "
        "the draft id and status (pending, sent, failed, or disabled with a message to relay)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "to": _ADDRESSES,
            "cc": _ADDRESSES,
            "bcc": _ADDRESSES,
            "subject": {"type": "string"},
            "body": {
                "type": "string",
                "description": "Plain text. Do not add a signature: the user's signature is added under it.",
            },
            "attachments": _ATTACHMENTS,
            "in_reply_to": _REPLY,
        },
        "required": ["to", "subject", "body"],
    },
}

EMAIL_DRAFT_UPDATE = {
    "name": "email_draft_update",
    "description": (
        "Change a pending email draft you created (fields you pass replace the old ones; leave out what stays). "
        "Use it when the user asks for changes before sending, instead of creating a second draft. A draft that "
        "was sent or discarded cannot change."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "The draft id from email_draft_create."},
            "to": _ADDRESSES,
            "cc": _ADDRESSES,
            "bcc": _ADDRESSES,
            "subject": {"type": "string"},
            "body": {"type": "string"},
            "attachments": _ATTACHMENTS,
            "in_reply_to": _REPLY,
        },
        "required": ["id"],
    },
}

EMAIL_DRAFT_STATUS = {
    "name": "email_draft_status",
    "description": "Read an email draft's status: pending, sending, sent (with when and by whom), discarded or failed (with the error).",
    "parameters": {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "The draft id."}},
        "required": ["id"],
    },
}
