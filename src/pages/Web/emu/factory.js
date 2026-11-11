// Builds a `chrome` object for one context (page, frame or worker) on top of a transport.
// transport = { rpc(method, args) -> Promise, ctxInfo: {tabId, kind}, setHandler(fn) }
// The hub (hub.js) sits on the other end and routes between contexts.
import enMessages from "../../../_locales/en/messages.json";

const isFn = (f) => typeof f === "function";

export function makeEvent() {
  const ls = new Set();
  return {
    addListener: (f) => { if (isFn(f)) ls.add(f); },
    removeListener: (f) => ls.delete(f),
    hasListener: (f) => ls.has(f),
    hasListeners: () => ls.size > 0,
    addRules() {}, removeRules() {}, getRules() {},
    _emit(...a) { ls.forEach((f) => { try { f(...a); } catch (e) { console.error("[emu] listener error", e); } }); },
    _set: ls,
  };
}

// Run runtime.onMessage listeners; resolve {responded, value}.
function runMessageListeners(ev, msg, sender) {
  return new Promise((resolve) => {
    let done = false, pending = false;
    const respond = (value) => { if (!done) { done = true; resolve({ responded: true, value }); } };
    ev._set.forEach((fn) => {
      try {
        const ret = fn(msg, sender, respond);
        if (ret === true) pending = true;
        else if (ret && isFn(ret.then)) { pending = true; ret.then(respond, (e) => respond({ error: String(e?.message || e) })); }
      } catch (e) { console.error("[emu] onMessage listener threw", e); }
    });
    if (!pending && !done) resolve({ responded: false });
  });
}

export function createChrome(transport) {
  const ev = {
    onMessage: makeEvent(), onMessageExternal: makeEvent(), onConnect: makeEvent(), onInstalled: makeEvent(),
    onStartup: makeEvent(), onSuspend: makeEvent(), onUpdateAvailable: makeEvent(),
    tabsUpdated: makeEvent(), tabsRemoved: makeEvent(), tabsActivated: makeEvent(), tabsCreated: makeEvent(),
    storageChanged: makeEvent(), alarm: makeEvent(), actionClicked: makeEvent(), command: makeEvent(),
    winFocus: makeEvent(), winRemoved: makeEvent(), dlChanged: makeEvent(), dlCreated: makeEvent(),
    permAdded: makeEvent(), permRemoved: makeEvent(),
  };
  const areaEvents = { local: makeEvent(), sync: makeEvent(), session: makeEvent(), managed: makeEvent() };
  const ports = new Map();

  const runtime = { lastError: undefined };
  const withLastError = (cb, err, result) => {
    runtime.lastError = err ? { message: String(err.message || err) } : undefined;
    try { cb(result); } finally { runtime.lastError = undefined; }
  };
  // chrome-style: optional trailing callback, otherwise a Promise.
  const call = (method, args) => {
    args = [...args];
    const cb = isFn(args[args.length - 1]) ? args.pop() : null;
    const p = transport.rpc(method, args);
    if (!cb) return p;
    p.then((r) => withLastError(cb, null, r), (e) => withLastError(cb, e, undefined));
    return undefined;
  };
  const api = (method) => (...args) => call(method, args);

  // events coming from the hub
  transport.setHandler(async (evt, data) => {
    switch (evt) {
      case "message": return runMessageListeners(ev.onMessage, data.msg, data.sender);
      case "storageChanged": ev.storageChanged._emit(data.changes, data.area); areaEvents[data.area]?._emit(data.changes); return;
      case "alarm": ev.alarm._emit(data); return;
      case "tabsUpdated": ev.tabsUpdated._emit(data.tabId, data.changeInfo, data.tab); return;
      case "tabsRemoved": ev.tabsRemoved._emit(data.tabId, data.info || { isWindowClosing: false }); return;
      case "tabsCreated": ev.tabsCreated._emit(data.tab); return;
      case "tabsActivated": ev.tabsActivated._emit(data); return;
      case "actionClicked": ev.actionClicked._emit(data.tab); return;
      case "command": ev.command._emit(data.command, data.tab); return;
      case "installed": ev.onInstalled._emit(data); return;
      case "startup": ev.onStartup._emit(); return;
      case "downloadsChanged": ev.dlChanged._emit(data); return;
      case "portConnect": {
        const port = makePort(data.portId, data.name, data.sender, true);
        ev.onConnect._emit(port); return;
      }
      case "portMessage": ports.get(data.portId)?._recv(data.msg); return;
      case "portDisconnect": ports.get(data.portId)?._remoteClose(); return;
      default: return;
    }
  });

  function makePort(portId, name, sender, incoming) {
    const onMessage = makeEvent(), onDisconnect = makeEvent();
    let closed = false;
    const port = {
      name, sender,
      onMessage, onDisconnect,
      postMessage: (msg) => { if (!closed) transport.rpc("port.post", [portId, msg]).catch(() => {}); },
      disconnect: () => { if (closed) return; closed = true; ports.delete(portId); transport.rpc("port.close", [portId]).catch(() => {}); },
      _recv: (msg) => onMessage._emit(msg, port),
      _remoteClose: () => { if (closed) return; closed = true; ports.delete(portId); onDisconnect._emit(port); },
    };
    ports.set(portId, port);
    return port;
  }
  const connectPort = (target, args) => {
    const info = args.find((a) => a && typeof a === "object" && !isFn(a)) || {};
    const portId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const port = makePort(portId, info.name || "", undefined, false);
    transport.rpc("port.connect", [portId, info.name || "", target]).catch(() => port._remoteClose());
    return port;
  };

  Object.assign(runtime, {
    id: "smartvid-web-recorder",
    getURL: (p = "") => transport.base + String(p).replace(/^\//, ""),
    getManifest: () => transport.manifest,
    getPlatformInfo: api("runtime.getPlatformInfo"),
    getContexts: api("runtime.getContexts"),
    sendMessage: (...args) => {
      const cb = isFn(args[args.length - 1]) ? args.pop() : null;
      const msg = args.length > 1 && typeof args[0] === "string" ? args[1] : args[0];
      const p = transport.rpc("sendMessage", [msg, null]).then((r) => (r && r.error && r.__emuError ? Promise.reject(new Error(r.error)) : r));
      if (!cb) return p;
      p.then((r) => withLastError(cb, null, r), (e) => withLastError(cb, e, undefined));
    },
    connect: (...a) => connectPort(null, a),
    openOptionsPage: api("noop"), setUninstallURL: api("noop"), requestUpdateCheck: () => Promise.resolve({ status: "no_update" }),
    reload: () => location.reload(),
    onMessage: ev.onMessage, onMessageExternal: ev.onMessageExternal, onConnect: ev.onConnect, onInstalled: ev.onInstalled,
    onStartup: ev.onStartup, onSuspend: ev.onSuspend, onUpdateAvailable: ev.onUpdateAvailable,
  });

  const storageArea = (name) => ({
    get: api(`storage.${name}.get`), set: api(`storage.${name}.set`), remove: api(`storage.${name}.remove`),
    clear: api(`storage.${name}.clear`), getBytesInUse: api(`storage.${name}.getBytesInUse`), setAccessLevel: api("noop"),
    onChanged: areaEvents[name],
  });

  const getMessage = (key, subs) => {
    const m = enMessages[key];
    if (!m) return "";
    const arr = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
    let s = m.message;
    if (m.placeholders) {
      Object.entries(m.placeholders).forEach(([n, p]) => {
        const idx = parseInt(String(p.content).replace("$", ""), 10) - 1;
        s = s.replace(new RegExp(`\\$${n}\\$`, "gi"), arr[idx] ?? (/^\$\d$/.test(p.content) ? "" : p.content));
      });
    }
    arr.forEach((v, i) => { s = s.replace(new RegExp(`\\$${i + 1}`, "g"), v); });
    return s;
  };

  const stub = (extra = {}) => new Proxy(extra, {
    get: (t, p) => (p in t ? t[p] : String(p).startsWith("on") ? makeEvent() : () => Promise.resolve()),
  });

  const chrome = {
    runtime,
    storage: { local: storageArea("local"), sync: storageArea("sync"), session: storageArea("session"), managed: storageArea("managed"), onChanged: ev.storageChanged },
    tabs: {
      get: api("tabs.get"), getCurrent: api("tabs.getCurrent"), query: api("tabs.query"), create: api("tabs.create"),
      update: api("tabs.update"), remove: api("tabs.remove"), reload: api("tabs.reload"), duplicate: api("noop"),
      sendMessage: (tabId, msg, ...rest) => {
        const cb = isFn(rest[rest.length - 1]) ? rest.pop() : null;
        const p = transport.rpc("sendMessage", [msg, tabId]);
        if (!cb) return p;
        p.then((r) => withLastError(cb, null, r), (e) => withLastError(cb, e, undefined));
      },
      connect: (tabId, ...a) => connectPort(tabId, a),
      captureVisibleTab: () => Promise.reject(new Error("captureVisibleTab is unavailable on the web")),
      group: api("noop"), ungroup: api("noop"), TAB_ID_NONE: -1,
      onUpdated: ev.tabsUpdated, onRemoved: ev.tabsRemoved, onActivated: ev.tabsActivated, onCreated: ev.tabsCreated,
      onReplaced: makeEvent(), onMoved: makeEvent(), onAttached: makeEvent(), onDetached: makeEvent(), onHighlighted: makeEvent(),
    },
    windows: {
      get: api("windows.get"), getCurrent: api("windows.getCurrent"), getLastFocused: api("windows.getCurrent"), getAll: api("windows.getAll"),
      create: api("windows.create"), update: api("windows.update"), remove: api("windows.remove"),
      WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onFocusChanged: ev.winFocus, onRemoved: ev.winRemoved, onCreated: makeEvent(),
    },
    scripting: {
      executeScript: (inj) => {
        const copy = { ...inj };
        if (isFn(copy.func)) { copy.funcSrc = copy.func.toString(); delete copy.func; }
        return transport.rpc("scripting.executeScript", [copy]);
      },
      insertCSS: api("noop"), removeCSS: api("noop"), registerContentScripts: api("noop"), unregisterContentScripts: api("noop"),
    },
    alarms: { create: api("alarms.create"), get: api("alarms.get"), getAll: api("alarms.getAll"), clear: api("alarms.clear"), clearAll: api("alarms.clearAll"), onAlarm: ev.alarm },
    action: stub({
      onClicked: ev.actionClicked, getUserSettings: () => Promise.resolve({ isOnToolbar: true }),
      setIcon: api("noop"), setBadgeText: api("noop"), setBadgeBackgroundColor: api("noop"), setTitle: api("noop"), setPopup: api("noop"),
    }),
    commands: {
      getAll: (cb) => {
        const list = Object.entries(transport.manifest.commands || {}).map(([name, c]) => ({ name, description: c.description || "", shortcut: c.suggested_key?.default || "" }));
        return cb ? (cb(list), undefined) : Promise.resolve(list);
      },
      onCommand: ev.command,
    },
    downloads: { download: api("downloads.download"), show: api("noop"), showDefaultFolder: api("noop"), search: () => Promise.resolve([]), cancel: api("noop"), erase: api("noop"), onChanged: ev.dlChanged, onCreated: ev.dlCreated },
    permissions: { contains: api("permissions.contains"), request: api("permissions.request"), remove: api("permissions.remove"), getAll: api("permissions.getAll"), onAdded: ev.permAdded, onRemoved: ev.permRemoved },
    offscreen: { createDocument: api("offscreen.createDocument"), closeDocument: api("offscreen.closeDocument"), hasDocument: api("offscreen.hasDocument"), Reason: new Proxy({}, { get: (_t, p) => String(p) }) },
    system: {
      display: { getInfo: api("system.display.getInfo") },
      memory: { getInfo: api("system.memory.getInfo") },
      cpu: { getInfo: api("system.cpu.getInfo") },
    },
    power: { requestKeepAwake: api("power.requestKeepAwake"), releaseKeepAwake: api("power.releaseKeepAwake") },
    identity: {
      getAuthToken: () => Promise.reject(new Error("Sign-in is not available in the web recorder")),
      launchWebAuthFlow: () => Promise.reject(new Error("Sign-in is not available in the web recorder")),
      removeCachedAuthToken: () => Promise.resolve(), clearAllCachedAuthTokens: () => Promise.resolve(),
      getRedirectURL: (p = "") => `${transport.base}${p}`, getProfileUserInfo: () => Promise.resolve({ email: "", id: "" }),
    },
    tabCapture: { getMediaStreamId: () => Promise.reject(new Error("tabCapture is unavailable on the web; use the screen picker")), capture: () => {}, getCapturedTabs: () => Promise.resolve([]) },
    desktopCapture: { chooseDesktopMedia: (_s, _t, cb) => { const f = isFn(_t) ? _t : cb; f && f(""); return 0; }, cancelChooseDesktopMedia() {} },
    i18n: {
      getMessage, getUILanguage: () => navigator.language || "en", getAcceptLanguages: (cb) => { const r = [...(navigator.languages || ["en"])]; return cb ? cb(r) : Promise.resolve(r); },
      detectLanguage: () => Promise.resolve({ isReliable: false, languages: [] }),
    },
    contextMenus: stub(), webNavigation: stub(), webRequest: stub(), declarativeNetRequest: stub(), notifications: stub(), idle: stub(), sidePanel: stub(), management: stub(), cookies: stub(), history: stub(), bookmarks: stub(),
  };
  return new Proxy(chrome, { get: (t, p) => (p in t ? t[p] : p === "then" ? undefined : stub()) });
}
