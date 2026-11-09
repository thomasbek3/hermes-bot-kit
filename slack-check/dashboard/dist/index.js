(function () {
  "use strict";
  // slack-check is a backend-only plugin (GET /api/plugins/slack-check/test). Its tab is hidden;
  // this stub registers an empty component so the dashboard does not flag the bundle as broken.
  var reg = window.__HERMES_PLUGINS__;
  if (!reg || typeof reg.register !== "function") return;
  reg.register("slack-check", function SlackCheckHidden() { return null; });
})();
