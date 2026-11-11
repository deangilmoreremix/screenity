// Minimal in-page implementation of the chrome.* extension APIs Screenity uses, so its real
// UI and recorder code can run on an ordinary web page. Every "extension context" lives in
// the same window, so runtime messaging is an in-page bus.
import enMessages from "../../_locales/en/messages.json";

const BASE = (window.__SMARTVID_RECORDER_BASE__ || new URL("./", document.currentScript?.src || location.href).href);
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function makeEvent() {
  const ls = new Set();
  return {
    addListener: (f) => ls.add(f),
    removeListener: (f) => ls.delete(f),
    hasListener: (f) => ls.has(f),
    _emit: (...a) => ls.forEach((f) => { try { f(...a); } catch (e) { console.error(e); } }),
    _listeners: ls,
  };
}

function makeStorageArea(name, onChanged) {
  const KEY = `smartvid-web:${name}:`;
  const mem = name === "session";
  const store = {};
  const read = (k) => {
    if (mem) return store[k];
    try { const v = localStorage.getItem(KEY + k); return v === null ? undefined : JSON.parse(v); } catch { return undefined; }
  };
  const write = (k, v) => { if (mem) store[k] = v; else try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { console.warn("storage quota", e); } };
  const del = (k) => { if (mem) delete store[k]; else localStorage.removeItem(KEY + k); };
  const keys = () => (mem ? Object.keys(store) : Object.keys(localStorage).filter((k) => k.startsWith(KEY)).map((k) => k.slice(KEY.length)));
  const done = (res, cb) => (cb ? (cb(res), undefined) : Promise.resolve(res));
  return {
    get(q, cb) {
      let out = {};
      if (q == null) keys().forEach((k) => { out[k] = read(k); });
      else if (typeof q === "string" || Array.isArray(q)) asArray(q).forEach((k) => { const v = read(k); if (v !== undefined) out[k] = v; });
      else Object.keys(q).forEach((k) => { const v = read(k); out[k] = v === undefined ? q[k] : v; });
      return done(out, cb);
    },
    set(items, cb) {
      const changes = {};
      Object.entries(items || {}).forEach(([k, v]) => { const old = read(k); write(k, v); changes[k] = { oldValue: old, newValue: v }; });
      Promise.resolve().then(() => onChanged._emit(changes, name));
      return done(undefined, cb);
    },
    remove(k, cb) {
      const changes = {};
      asArray(k).forEach((key) => { changes[key] = { oldValue: read(key) }; del(key); });
      Promise.resolve().then(() => onChanged._emit(changes, name));
      return done(undefined, cb);
    },
    clear(cb) { keys().forEach(del); return done(undefined, cb); },
    getBytesInUse(_k, cb) { return done(0, cb); },
    setAccessLevel() { return Promise.resolve(); },
  };
}

export function installChromeShim({ log = false } = {}) {
  if (window.chrome?.runtime?.id) return window.chrome;

  const onStorageChanged = makeEvent();
  const onMessage = makeEvent();
  const unhandled = [];

  const messageBus = {
    // Deliver to every listener; resolve with the first sendResponse value (like Chrome).
    dispatch(msg, sender) {
      return new Promise((resolve) => {
        let responded = false, async = false;
        const sendResponse = (r) => { if (!responded) { responded = true; resolve(r); } };
        let handled = false;
        onMessage._listeners.forEach((fn) => {
          try {
            const ret = fn(msg, sender, sendResponse);
            if (ret === true) { async = true; handled = true; }
            else if (ret && typeof ret.then === "function") { async = true; handled = true; ret.then(sendResponse); }
          } catch (e) { console.error("[shim] onMessage listener threw", e); }
        });
        if (!handled) unhandled.push(msg);
        if (!async) Promise.resolve().then(() => sendResponse(undefined));
      });
    },
  };

  const runtime = {
    id: "smartvid-web-recorder",
    lastError: undefined,
    getURL: (p = "") => BASE + String(p).replace(/^\//, ""),
    getManifest: () => ({ version: "4.7.2", manifest_version: 3, name: "SmartVid Recorder (web)" }),
    getPlatformInfo: (cb) => { const r = { os: /Mac/.test(navigator.platform) ? "mac" : /Win/.test(navigator.platform) ? "win" : "linux", arch: "x86-64" }; return cb ? cb(r) : Promise.resolve(r); },
    sendMessage(...args) {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      const msg = args.length > 1 ? args[1] : args[0];
      if (log) console.debug("[bus] →", msg?.type, msg);
      const p = messageBus.dispatch(msg, { id: runtime.id, url: location.href, tab: { id: 1, url: location.href, active: true } });
      return cb ? (p.then(cb), undefined) : p;
    },
    onMessage,
    onMessageExternal: makeEvent(),
    onConnect: makeEvent(),
    onInstalled: makeEvent(),
    onStartup: makeEvent(),
    onSuspend: makeEvent(),
    connect: () => ({ postMessage() {}, disconnect() {}, onMessage: makeEvent(), onDisconnect: makeEvent() }),
    openOptionsPage: () => {},
    setUninstallURL: () => {},
    reload: () => location.reload(),
  };

  const tabEvent = () => makeEvent();
  const tabs = {
    query: (_q, cb) => { const r = [{ id: 1, url: location.href, active: true, windowId: 1, title: document.title }]; return cb ? cb(r) : Promise.resolve(r); },
    get: (id, cb) => { const r = { id, url: location.href, active: true, windowId: 1 }; return cb ? cb(r) : Promise.resolve(r); },
    getCurrent: (cb) => { const r = { id: 1, url: location.href, active: true, windowId: 1 }; return cb ? cb(r) : Promise.resolve(r); },
    sendMessage: (_id, msg, ...rest) => runtime.sendMessage(msg, ...rest.filter((x) => typeof x === "function")),
    create: (o, cb) => { if (o?.url) window.open(o.url, "_blank", "noopener"); const r = { id: Date.now(), url: o?.url }; return cb ? cb(r) : Promise.resolve(r); },
    update: (_id, _o, cb) => (cb ? cb({}) : Promise.resolve({})),
    remove: (_id, cb) => (cb ? cb() : Promise.resolve()),
    reload: () => {},
    captureVisibleTab: () => Promise.reject(new Error("captureVisibleTab unavailable on the web")),
    onUpdated: tabEvent(), onRemoved: tabEvent(), onActivated: tabEvent(), onCreated: tabEvent(),
  };

  const i18n = {
    getMessage(key, subs) {
      const m = enMessages[key];
      if (!m) return "";
      let s = m.message;
      asArray(subs).forEach((v, i) => { s = s.replace(new RegExp(`\\$${i + 1}`, "g"), v); });
      if (m.placeholders) Object.entries(m.placeholders).forEach(([n, p]) => { const idx = parseInt(String(p.content).replace("$", ""), 10) - 1; s = s.replace(new RegExp(`\\$${n}\\$`, "gi"), asArray(subs)[idx] ?? ""); });
      return s;
    },
    getUILanguage: () => navigator.language || "en",
    getAcceptLanguages: (cb) => { const r = navigator.languages || ["en"]; return cb ? cb(r) : Promise.resolve(r); },
  };

  const downloads = {
    download(opts, cb) {
      const a = document.createElement("a");
      a.href = opts.url; a.download = opts.filename || "recording";
      document.body.appendChild(a); a.click(); a.remove();
      const id = Date.now();
      cb && cb(id);
      return Promise.resolve(id);
    },
    onChanged: makeEvent(), onCreated: makeEvent(),
    show() {}, showDefaultFolder() {}, search: (_q, cb) => (cb ? cb([]) : Promise.resolve([])),
  };

  const stubEvents = () => new Proxy({}, { get: (_t, p) => (String(p).startsWith("on") ? makeEvent() : () => Promise.resolve()) });

  const chromeShim = {
    runtime,
    tabs,
    i18n,
    downloads,
    storage: { local: makeStorageArea("local", onStorageChanged), sync: makeStorageArea("sync", onStorageChanged), session: makeStorageArea("session", onStorageChanged), managed: makeStorageArea("managed", onStorageChanged), onChanged: onStorageChanged },
    action: stubEvents(),
    commands: { onCommand: makeEvent(), getAll: (cb) => (cb ? cb([]) : Promise.resolve([])) },
    windows: { getCurrent: (cb) => { const r = { id: 1, focused: true, width: innerWidth, height: innerHeight }; return cb ? cb(r) : Promise.resolve(r); }, update: () => Promise.resolve({}), create: () => Promise.resolve({}), remove: () => Promise.resolve(), getAll: (cb) => (cb ? cb([]) : Promise.resolve([])), WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onFocusChanged: makeEvent(), onRemoved: makeEvent() },
    scripting: { executeScript: () => Promise.resolve([]), insertCSS: () => Promise.resolve() },
    alarms: { create() {}, clear: () => Promise.resolve(true), get: () => Promise.resolve(null), onAlarm: makeEvent() },
    system: { display: { getInfo: (cb) => { const r = [{ id: "1", bounds: { left: 0, top: 0, width: screen.width, height: screen.height }, isPrimary: true }]; return cb ? cb(r) : Promise.resolve(r); } } },
    identity: stubEvents(),
    offscreen: stubEvents(),
    power: { requestKeepAwake() {}, releaseKeepAwake() {} },
    tabCapture: stubEvents(),
    desktopCapture: stubEvents(),
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true), getAll: () => Promise.resolve({ permissions: [], origins: [] }), onAdded: makeEvent(), onRemoved: makeEvent() },
    contextMenus: stubEvents(),
    webNavigation: stubEvents(),
  };

  window.chrome = chromeShim;
  window.__chromeShim = { messageBus, unhandled };
  return chromeShim;
}
