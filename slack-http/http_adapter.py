"""Use the bundled Slack adapter with a signed HTTP transport."""
import ipaddress
import logging
import sys

logger = logging.getLogger(__name__)
_REQUIRED = (
    '_new_web_client', '_authenticate_workspace', '_register_bolt_handlers',
    '_acquire_platform_lock', '_release_platform_lock', '_fatal_missing_env',
    '_set_fatal_error', '_cancel_socket_watchdog', '_stop_socket_mode_handler',
    '_close_workspace_clients', '_hint_allow_bots', '_team_clients',
    '_team_bot_user_ids', '_team_bot_names', '_app', '_app_token', '_proxy_url',
    '_bot_user_id', '_bot_display_name', '_running', '_shared_listener_profile',
)
_MODULE_REQUIRED = ('_get_scoped_secret', '_resolve_slack_proxy_url', '_load_slack_bot_tokens',
                    '_slack_per_request_proxy_middleware', '_apply_slack_proxy', 'AsyncApp')


def listen_host_allowed(host, allow_nonloopback):
    """Whether the HTTP Events listener may bind `host`. Loopback only (the
    relay in front of it is the public ingress), unless the operator set
    SLACK_HTTP_ALLOW_NONLOOPBACK=1."""
    if str(allow_nonloopback or '').strip() == '1':
        return True
    value = str(host or '').strip()
    if value.lower() == 'localhost':
        return True
    try:
        return ipaddress.ip_address(value.strip('[]').split('%', 1)[0]).is_loopback
    except ValueError:
        return False


def make_http_capable(base):
    module = sys.modules[base.__module__]

    class HttpCapableSlackAdapter(base):
        async def connect(self, *, is_reconnect=False):
            # Socket Mode keeps the bundled connection path, including its validation.
            scoped_secret = getattr(module, '_get_scoped_secret', None)
            if scoped_secret is None:
                from gateway.platforms._shared import get_scoped_secret
                if get_scoped_secret('SLACK_CONNECTION_MODE') != 'http':
                    return await super().connect(is_reconnect=is_reconnect)
                self._set_fatal_error('slack_http_incompatible', 'slack-http plugin incompatible with this Hermes version', retryable=False)
                return False
            if scoped_secret('SLACK_CONNECTION_MODE') != 'http':
                return await super().connect(is_reconnect=is_reconnect)
            if any(not hasattr(self, name) for name in _REQUIRED) or any(not hasattr(module, name) for name in _MODULE_REQUIRED):
                self._set_fatal_error('slack_http_incompatible', 'slack-http plugin incompatible with this Hermes version', retryable=False)
                return False
            token = self.config.token
            secret = scoped_secret('SLACK_SIGNING_SECRET')
            for name, value in (('SLACK_BOT_TOKEN', token), ('SLACK_SIGNING_SECRET', secret)):
                if not value:
                    self._fatal_missing_env(name)
                    return False
            host = scoped_secret('SLACK_HTTP_HOST') or '127.0.0.1'
            if not listen_host_allowed(host, scoped_secret('SLACK_HTTP_ALLOW_NONLOOPBACK')):
                logger.error('[Slack] SLACK_HTTP_HOST %r is not a loopback address; refusing to listen on it. '
                             'Use 127.0.0.1 behind the relay, or set SLACK_HTTP_ALLOW_NONLOOPBACK=1 to allow it.', host)
                self._set_fatal_error('slack_http_nonloopback', 'SLACK_HTTP_HOST is not a loopback address '
                                      '(set SLACK_HTTP_ALLOW_NONLOOPBACK=1 to allow it)', retryable=False)
                return False
            from aiohttp import web
            from gateway.platforms.shared_ingress import bind_listener
            from slack_bolt.adapter.aiohttp import to_bolt_request, to_aiohttp_response
            from slack_sdk.signature import SignatureVerifier
            lock = False
            self._http_runner = None
            try:
                if not self._acquire_platform_lock('slack-http', token, 'Slack bot token'):
                    return False
                lock = True
                self._running = False
                await self._cancel_socket_watchdog('[Slack] Prior watchdog task failed while stopping')
                await self._stop_socket_mode_handler()
                await self._close_workspace_clients()
                self._app = None
                self._app_token = None
                self._proxy_url = module._resolve_slack_proxy_url()
                self._bot_user_id = self._bot_display_name = None
                self._team_clients, self._team_bot_user_ids, self._team_bot_names = {}, {}, {}
                tokens = module._load_slack_bot_tokens(token, quiet=False)
                self._app = module.AsyncApp(token=tokens[0], client=self._new_web_client(tokens[0], self._proxy_url),
                    signing_secret=secret, before_authorize=module._slack_per_request_proxy_middleware(self._proxy_url))
                module._apply_slack_proxy(self._app.client, self._proxy_url)
                for bot_token in tokens:
                    await self._authenticate_workspace(bot_token, self._proxy_url)
                self._register_bolt_handlers()
                verifier = SignatureVerifier(signing_secret=secret)

                async def handle(request):
                    # Bolt logs the raw body at INFO on an invalid signature.
                    # Reject first so that a hostile body cannot reach that log.
                    raw = await request.read()
                    try:
                        valid = verifier.is_valid_request(raw, request.headers)
                    except (ValueError, UnicodeError):
                        valid = False
                    if not valid:
                        raise web.HTTPUnauthorized()
                    bolt_request = await to_bolt_request(request)
                    return await to_aiohttp_response(await self._app.async_dispatch(bolt_request))

                app = web.Application(client_max_size=1024 * 1024)
                app.router.add_post('/slack/events', handle)
                profile = getattr(self, '_hermes_profile_name', None)
                runner = getattr(self, 'gateway_runner', None)
                if profile and profile != 'default' and runner and runner._multiplex_on():
                    self._shared_listener_profile = profile
                port = int(scoped_secret('SLACK_HTTP_PORT') or '8656')
                self._http_runner = await bind_listener(self, app, host, port, '/slack/events', access_log=None)
                self._running = True
                self._hint_allow_bots()
                logger.info('[Slack] HTTP Events mode ready (%d workspace(s))', len(self._team_clients))
                return True
            except Exception:
                # Errors from SDKs can include credentials; do not log exception text.
                logger.error('[Slack] HTTP Events mode failed to start')
                return False
            finally:
                if lock and not self._running:
                    await self._close_workspace_clients()
                    self._release_platform_lock()

        async def disconnect(self):
            try:
                await super().disconnect()
            finally:
                runner = getattr(self, '_http_runner', None)
                if runner is not None:
                    await runner.cleanup()
                self._http_runner = None
                self._shared_ingress_app = None

    return HttpCapableSlackAdapter
