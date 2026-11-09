"""Install and remove only this profile's Slack platform shadow."""
import os
import shutil
import tempfile
from pathlib import Path

FILES = ('plugin.yaml', '__init__.py', 'http_adapter.py')
MARKER = '.slack-connect-owned'


class GatewayReloadError(RuntimeError):
    pass


class PlatformLifecycle:
    def __init__(self, home, source, set_enabled, reload_gateway):
        self.home, self.source = Path(home), Path(source)
        self.target = self.home / 'plugins' / 'platforms' / 'slack'
        self.pending = self.home / '.slack-connect-platform-removal-pending'
        self.set_enabled, self.reload_gateway = set_enabled, reload_gateway

    def _owned(self):
        marker = self.target / MARKER
        return (self.target.is_dir() and not self.target.is_symlink() and marker.is_file()
                and not marker.is_symlink() and marker.read_text() == 'slack-connect\n')

    def _reload(self, installed):
        answer = self.reload_gateway()
        if not isinstance(answer, dict) or not answer.get('reloaded'):
            if isinstance(answer, dict) and answer.get('error') == 'home is not served by this gateway':
                raise GatewayReloadError('Gateway refused plugin reload: home is not served by this gateway')
            raise GatewayReloadError('Gateway refused or did not answer the plugin reload')
        if installed and 'platforms/slack' not in answer.get('plugins', []):
            raise GatewayReloadError('Gateway did not load the Slack platform plugin')
        if installed:
            matches = [a for a in answer.get('activations', []) if isinstance(a, dict)
                       and a.get('key') == 'platforms/slack' and a.get('name') == 'slack-platform']
            if len(matches) != 1 or matches[0].get('missing_dependencies'):
                raise GatewayReloadError('Gateway could not load the Slack platform plugin')

    def install(self):
        if not self.target.parent.resolve().is_relative_to(self.home.resolve()):
            raise GatewayReloadError('Slack platform path is outside the target profile')
        if self.target.exists():
            if not self._owned() or any((self.target / f).is_symlink() or not (self.target / f).is_file() or
                                        (self.target / f).read_bytes() != (self.source / f).read_bytes() for f in FILES):
                raise GatewayReloadError('An existing Slack platform shadow requires manual review')
        else:
            self.target.parent.mkdir(parents=True, exist_ok=True)
            stage = Path(tempfile.mkdtemp(prefix='.slack-connect-', dir=self.target.parent))
            try:
                for name in FILES:
                    shutil.copyfile(self.source / name, stage / name)
                (stage / MARKER).write_text('slack-connect\n')
                os.rename(stage, self.target)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        self.set_enabled(True)
        self._reload(True)
        if self.pending.is_file() and not self.pending.is_symlink():
            self.pending.unlink()

    def remove(self):
        if not self.target.parent.resolve().is_relative_to(self.home.resolve()):
            raise GatewayReloadError('Slack platform path is outside the target profile')
        if not self.target.exists() and not self.pending.exists():
            return
        if self.pending.exists() and (self.pending.is_symlink() or self.pending.read_text() != 'slack-connect\n'):
            raise GatewayReloadError('Slack platform removal marker requires manual review')
        if self.target.exists() and not self._owned():
            raise GatewayReloadError('An existing Slack platform shadow requires manual review')
        if self.target.exists():
            # A gateway may have compiled the owned plugin. Refuse unknown files.
            for entry in self.target.iterdir():
                if entry.name in FILES + (MARKER,) and entry.is_file() and not entry.is_symlink():
                    continue
                if entry.name == '__pycache__' and entry.is_dir() and not entry.is_symlink() and all(
                    p.is_file() and not p.is_symlink() and p.suffix == '.pyc' for p in entry.iterdir()
                ):
                    continue
                raise GatewayReloadError('Slack platform shadow contains unrecognized files')
        self.set_enabled(False)
        self.pending.write_text('slack-connect\n')
        if self.target.exists():
            shutil.rmtree(self.target)
        self._reload(False)
        self.pending.unlink()
