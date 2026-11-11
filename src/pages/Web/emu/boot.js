// Defines how the host window creates the hub. Must be imported before ./install.
import { Hub } from "./hub";

window.__chromeHubInit = () => {
  const base = new URL("./", location.href).href;
  const hub = new Hub({
    base,
    workerUrl: `${base}webbackground.bundle.js`,
    onVisibleFrame: (frame, ctl) => window.__smartvidShowFrame?.(frame, ctl),
  });
  // Upstream checks managed storage for "skipSetup" before opening its first-run tab.
  hub.storage.managed.skipSetup = true;
  window.__chromeHub = hub;
  return hub;
};
