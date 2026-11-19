"""Slack configuration calls; no credentials in URLs, argv, or error text."""
import io
import json
import logging
import re
import secrets
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

from common.access import SlackReadError
from common.token_store import request_rotation

LOG = logging.getLogger(__name__)


class SlackAPI:
    class IconUnavailable(Exception):
        pass

    def __init__(self, opener=urllib.request.urlopen):
        self.opener = opener

    def rotate(self, refresh):
        return request_rotation(refresh, opener=self.opener)

    def post(self, method, token, values):
        request = urllib.request.Request('https://slack.com/api/' + method,
            data=urlencode(values).encode(), headers={'Authorization':'Bearer ' + token}, method='POST')
        with self.opener(request, timeout=15) as response:
            return json.load(response)

    def create(self, token, data):
        return self.post('apps.manifest.create', token, {'manifest':json.dumps(data, separators=(',', ':'))})

    def update(self, token, app_id, data):
        return self.post('apps.manifest.update', token,
                         {'app_id': app_id, 'manifest': json.dumps(data, separators=(',', ':'))})

    def users_list(self, token, pages=100):
        """Every user of the bot's workspace (users.list, paginated). All
        pages or nothing: any failed page raises SlackReadError (with Slack's
        error code, and Retry-After when Slack rate-limits)."""
        users, cursor = [], ''
        for _ in range(pages):
            values = {'limit': '200'}
            if cursor:
                values['cursor'] = cursor
            try:
                result = self.post('users.list', token, values)
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    raise SlackReadError('ratelimited', exc.headers.get('Retry-After')) from None
                raise SlackReadError() from None
            except Exception:
                raise SlackReadError() from None
            if not isinstance(result, dict) or not result.get('ok'):
                raise SlackReadError(result.get('error') if isinstance(result, dict) else None)
            users.extend(result.get('members') or [])
            cursor = ((result.get('response_metadata') or {}).get('next_cursor') or '').strip()
            if not cursor:
                return users
        raise SlackReadError('workspace_too_large')

    def delete(self, token, app_id):
        return self.post('apps.manifest.delete', token, {'app_id':app_id})

    def set_icon(self, token, app_id, png):
        boundary = 'hermes-' + secrets.token_hex(16)
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="app_id"\r\n\r\n{app_id}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\n'
                'Content-Type: image/png\r\n\r\n').encode() + png + f'\r\n--{boundary}--\r\n'.encode()
        request = urllib.request.Request('https://slack.com/api/apps.icon.set', data=body,
            headers={'Authorization':'Bearer ' + token, 'Content-Type':'multipart/form-data; boundary=' + boundary}, method='POST')
        try:
            with self.opener(request, timeout=15) as response:
                result = json.load(response)
        except Exception:
            LOG.warning('Slack app icon request failed')
            raise
        error = result.get('error')
        safe_error = error if isinstance(error, str) and re.fullmatch(r'[a-z_]{1,80}', error) else 'unknown_error'
        if result.get('ok'):
            LOG.info('Slack app icon set successfully')
        else:
            LOG.warning('Slack app icon error: %s', safe_error)
            if safe_error in ('missing_scope', 'invalid_auth', 'not_allowed_token_type', 'not_authed', 'access_denied', 'not_allowed'):
                raise self.IconUnavailable(safe_error)
            raise RuntimeError('Slack could not set the app icon')


def profile_icon(home):
    from PIL import Image, ImageDraw, ImageOps
    image = None
    for extension in ('png', 'jpg', 'jpeg', 'webp'):
        path = Path(home) / 'assets' / ('avatar.' + extension)
        if path.is_file():
            with Image.open(path) as source:
                image = ImageOps.fit(source.convert('RGBA'), (512, 512))
            break
    if image is None:
        image = Image.new('RGB', (512, 512), '#292c42')
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((85, 106, 427, 405), radius=85, fill='#e4e7ff')
        draw.ellipse((160, 211, 206, 257), fill='#292c42')
        draw.ellipse((306, 211, 352, 257), fill='#292c42')
        draw.rounded_rectangle((186, 306, 326, 327), radius=10, fill='#292c42')
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()
