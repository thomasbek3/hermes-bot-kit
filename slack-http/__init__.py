"""Profile-local shadow of the bundled Slack platform."""
from plugins.platforms.slack.adapter import register as register_bundled
from .http_adapter import make_http_capable


def register(ctx):
    class Context:
        def __getattr__(self, name):
            return getattr(ctx, name)

        def register_platform(self, **kwargs):
            kwargs['adapter_factory'] = make_http_capable(kwargs['adapter_factory'])
            kwargs['required_env'] = ['SLACK_BOT_TOKEN']
            return ctx.register_platform(**kwargs)

    register_bundled(Context())
