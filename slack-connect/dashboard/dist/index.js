(function () {
  'use strict';
  var registry = window.__HERMES_PLUGINS__;
  if (registry && typeof registry.register === 'function') registry.register('slack-connect', function SlackConnectHidden() { return null; });
})();
