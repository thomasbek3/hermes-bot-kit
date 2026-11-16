"""The ComputerUseProvider Hermes loads when a profile sets ``computer_use.backend: remote-cua``."""
from __future__ import annotations

from typing import Any, Optional

from . import settings


def make_provider() -> Any:
    """The provider instance. ``ComputerUseProvider`` is Hermes's documented provider contract
    (``tools/computer_use/backend.py``); the private pieces load later, version-gated, in backend.py."""
    from tools.computer_use.backend import ComputerUseProvider

    class RemoteCuaProvider(ComputerUseProvider):
        name = settings.BACKEND_NAME
        display_name = "cua-driver on a remote Mac over SSH (remote-cua)"

        def create_backend(self, *, permission_mode: str) -> Any:
            from . import backend
            # Read in the active profile's scope: each bot's own remote_cua block.
            return backend.create_backend(settings.from_profile(), permission_mode)

        def is_available(self) -> bool:
            """Cheap (no network): the profile has a remote_cua block. A Windows block is 'available' so the
            tool explains the refusal instead of silently disappearing."""
            try:
                settings.from_profile()
            except Exception:
                return False
            return True

        def doctor(self) -> Optional[int]:
            from . import cli
            return cli.print_check(None)

    return RemoteCuaProvider()
