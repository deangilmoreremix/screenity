// Installs window.chrome in whatever context this is: the host page (creates the hub),
// an extension "tab"/offscreen frame (talks to the hub in an ancestor window), or the
// background Web Worker (talks to the hub over postMessage).
import { createChrome } from "./factory";
import manifest from "../../../manifest.json";

const base = () => new URL("./", (typeof location !== "undefined" ? location.href : self.location.href)).href;
const parseTab = (name) => { const m = /^smartvid-tab:(\d+)$/.exec(name || ""); return m ? +m[1] : null; };

function install() {
  const isWorker = typeof window === "undefined" && typeof importScripts === "function";
  if (isWorker) return installInWorker();
  if (window.chrome?.runtime?.id) return window.chrome;
  return installInPage();
}

function installInWorker() {
  const pendingRpc = new Map();
  let seq = 1, handler = null;
  const transport = {
    base: base(), manifest,
    rpc: (method, args) => new Promise((resolve, reject) => { const id = seq++; pendingRpc.set(id, { resolve, reject }); self.postMessage({ t: "rpc", id, method, args }); }),
    setHandler: (fn) => { handler = fn; },
  };
  self.addEventListener("message", async (e) => {
    const m = e.data;
    if (m.t === "rpcResult") { const p = pendingRpc.get(m.id); pendingRpc.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
    else if (m.t === "deliver" && handler) { const result = await handler(m.evt, m.data); self.postMessage({ t: "deliverResult", id: m.id, result }); }
  });
  self.chrome = createChrome(transport);
  return self.chrome;
}

function findHub() {
  let w = window;
  for (let i = 0; i < 8; i++) {
    try { if (w.__chromeHub) return w.__chromeHub; } catch {}
    if (w.parent === w) break;
    w = w.parent;
  }
  return null;
}

function installInPage() {
  let hub = findHub();
  const isHost = !hub;
  if (isHost) {
    // The host page boots the hub itself (see Web/index.jsx); create a placeholder until then.
    hub = window.__chromeHubInit?.() || null;
    if (!hub) throw new Error("[emu] hub missing in host window");
  }
  const kind = window.name === "smartvid-offscreen" ? "offscreen" : "page";
  let tabId = kind === "offscreen" ? null : (isHost ? 1 : parseTab(window.name));
  if (tabId == null && kind !== "offscreen") { try { tabId = window.parent.__smartvidTabId ?? 1; } catch { tabId = 1; } }
  window.__smartvidTabId = tabId;
  let handler = null;
  const ctxId = hub.register({
    tabId, kind, url: location.href, frameId: isHost ? 0 : 1,
    deliver: async (evt, data) => (handler ? handler(evt, data) : { responded: false }),
  });
  const transport = {
    base: base(), manifest,
    rpc: (method, args) => hub.handle(ctxId, method, args),
    setHandler: (fn) => { handler = fn; },
  };
  window.chrome = createChrome(transport);
  window.addEventListener("pagehide", () => hub.unregister(ctxId));
  return window.chrome;
}

install();
