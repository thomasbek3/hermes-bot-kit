(function () {
  "use strict";
  // remote-cua is backend-only (/api/plugins/remote-cua/lease|take|release|status). Its tab is hidden;
  // this stub registers an empty component so the dashboard does not flag the bundle as broken.
  var reg = window.__HERMES_PLUGINS__;
  if (!reg || typeof reg.register !== "function") return;
  reg.register("remote-cua", function RemoteCuaHidden() { return null; });
})();
