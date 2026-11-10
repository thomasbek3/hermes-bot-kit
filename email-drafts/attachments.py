"""Attachment path checks.

A draft may attach only files inside the bot's own workspace (its working
directory for the chat) or a folder the user listed in ``attachment_dirs``.
Paths are resolved with symlinks followed before the check, so a link inside
the workspace that points outside it is refused. Hidden files and folders
(``.ssh``, ``.env``, ``.hermes`` ...) are refused even inside an allowed root.
The check runs when the draft is written and again just before it is sent.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable

from .store import DraftError

MAX_ATTACHMENTS = 10
MAX_TOTAL_BYTES = 24 * 1024 * 1024  # Gmail's 25 MB limit, less MIME overhead headroom


def allowed_roots(workspace: Any, extra: Iterable[Any]) -> list[str]:
    """Resolved absolute roots: the workspace first, then the configured folders.

    The filesystem root and the user's home folder are never roots on their
    own: a workspace that is one of them allows nothing until a real folder is
    configured (the home folder is the Desktop's fallback cwd)."""
    roots: list[str] = []
    home = os.path.realpath(os.path.expanduser("~"))
    for raw in [workspace, *list(extra or [])]:
        text = str(raw or "").strip()
        if not text or not os.path.isabs(os.path.expanduser(text)):
            continue
        real = os.path.realpath(os.path.expanduser(text))
        if real in (os.path.sep, home) or os.path.dirname(real) == real:
            continue
        if os.path.isdir(real) and real not in roots:
            roots.append(real)
    return roots


def _inside(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:  # different drives on Windows
        return False


def resolve_one(raw: Any, roots: list[str], workspace: Any) -> dict:
    text = str(raw or "").strip()
    if not text:
        raise DraftError("attachment path is empty")
    if "\x00" in text:
        raise DraftError("attachment path is not valid")
    candidate = os.path.expanduser(text)
    if not os.path.isabs(candidate):
        base = str(workspace or "").strip()
        if not base:
            raise DraftError(f"attachment {text!r}: relative paths need a workspace")
        candidate = os.path.join(base, candidate)
    real = os.path.realpath(candidate)
    root = next((r for r in roots if _inside(real, r)), None)
    if root is None:
        raise DraftError(f"attachment {text!r} is outside this bot's workspace and allowed folders")
    rel_parts = Path(os.path.relpath(real, root)).parts
    if any(part.startswith(".") for part in rel_parts):
        raise DraftError(f"attachment {text!r}: hidden files and folders cannot be attached")
    if not os.path.isfile(real):
        raise DraftError(f"attachment {text!r} is not a file")
    return {"path": real, "name": os.path.basename(real), "size": os.path.getsize(real)}


def resolve_attachments(paths: Any, roots: list[str], workspace: Any) -> list[dict]:
    if paths in (None, "", []):
        return []
    if not isinstance(paths, list):
        paths = [paths]
    if len(paths) > MAX_ATTACHMENTS:
        raise DraftError(f"at most {MAX_ATTACHMENTS} attachments")
    out: list[dict] = []
    for raw in paths:
        item = resolve_one(raw.get("path") if isinstance(raw, dict) else raw, roots, workspace)
        if all(o["path"] != item["path"] for o in out):
            out.append(item)
    if sum(item["size"] for item in out) > MAX_TOTAL_BYTES:
        raise DraftError("attachments are larger than 24 MB in total")
    return out


def recheck(attachments: list[dict], roots: list[str]) -> list[dict]:
    """Just before sending: each stored path must still resolve inside a root."""
    return resolve_attachments([a["path"] for a in attachments or []], roots, None) if attachments else []
