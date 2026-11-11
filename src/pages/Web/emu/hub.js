// Routes everything chrome.* would normally route between extension contexts:
//   - runtime / tabs messaging between the page UI, extension "tab" frames and the background Worker
//   - storage (+ change events), alarms, tabs (as iframes), offscreen docs (hidden iframes), downloads, ports
// Lives in the host window (web.html).

// Always use the browser's screen picker (getDisplayMedia); chrome.desktopCapture is extension-only.
const WEB_DEFAULTS = { forceDisplayMediaScreen: true };
const PERSIST = { local: true, sync: true, session: false, managed: false };
const VISIBLE_PAGES = /(permissions|editor|setup|download|playground|editorapp)\.html/;
const clone = (v) => { if (v === undefined) return v; try { return structuredClone(v); } catch { try { return JSON.parse(JSON.stringify(v)); } catch { return v; } } };
const globToRe = (g) => new RegExp("^" + String(g).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

export class Hub {
  constructor({ base, workerUrl, onVisibleFrame }) {
    this.base = base;
    this.workerUrl = workerUrl;
    this.onVisibleFrame = onVisibleFrame || null;
    this.ctxs = new Map();
    this.nextCtx = 1;
    this.nextTab = 2;
    this.nextWin = 2;
    this.tabs = new Map([[1, { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false, incognito: false, status: "complete", url: location.href, title: document.title, discarded: false, autoDiscardable: true, _frame: null }]]);
    this.frames = new Map();     // tabId -> iframe
    this.offscreen = null;       // iframe
    this.storage = { local: {}, sync: {}, session: {}, managed: {} };
    this.alarms = new Map();
    this.ports = new Map();
    this.worker = null;
    this.workerCtx = null;
    this.readyResolve = null;
    this.ready = new Promise((r) => { this.readyResolve = r; });
    this.history = [];
    this._loadStorage();
    Object.assign(this.storage.local, WEB_DEFAULTS);
  }

  // ---------- storage ----------
  _loadStorage() {
    for (const area of Object.keys(PERSIST)) {
      if (!PERSIST[area]) continue;
      try { this.storage[area] = JSON.parse(localStorage.getItem(`smartvid-web:${area}`) || "{}"); } catch { this.storage[area] = {}; }
    }
  }
  _saveStorage(area) {
    if (!PERSIST[area]) return;
    clearTimeout(this._saveT?.[area]);
    (this._saveT ||= {})[area] = setTimeout(() => {
      try { localStorage.setItem(`smartvid-web:${area}`, JSON.stringify(this.storage[area])); } catch (e) { console.warn("[hub] storage quota", e); }
    }, 50);
  }
  _storage(area, op, args) {
    const S = this.storage[area];
    const norm = (q) => (q == null ? null : typeof q === "string" ? [q] : Array.isArray(q) ? q : q);
    if (op === "get") {
      const q = args[0];
      if (q == null) return clone(S);
      if (typeof q === "string" || Array.isArray(q)) { const out = {}; [].concat(q).forEach((k) => { if (k in S) out[k] = clone(S[k]); }); return out; }
      const out = {}; Object.keys(q).forEach((k) => { out[k] = k in S ? clone(S[k]) : q[k]; }); return out;
    }
    if (op === "set") {
      const changes = {};
      Object.entries(args[0] || {}).forEach(([k, v]) => { if (v === undefined) return; changes[k] = { oldValue: clone(S[k]), newValue: clone(v) }; S[k] = clone(v); });
      this._storageChanged(area, changes); return undefined;
    }
    if (op === "remove") {
      const changes = {};
      [].concat(args[0]).forEach((k) => { if (k in S) { changes[k] = { oldValue: clone(S[k]) }; delete S[k]; } });
      this._storageChanged(area, changes); return undefined;
    }
    if (op === "clear") {
      const changes = {}; Object.keys(S).forEach((k) => { changes[k] = { oldValue: S[k] }; delete S[k]; });
      // Web build settings that must survive upstream's install-time storage wipe.
      if (area === "local") Object.entries(WEB_DEFAULTS).forEach(([k, v]) => { S[k] = v; changes[k] = { oldValue: changes[k]?.oldValue, newValue: v }; });
      this._storageChanged(area, changes); return undefined;
    }
    if (op === "getBytesInUse") return JSON.stringify(S).length;
    return undefined;
  }
  _storageChanged(area, changes) {
    if (!Object.keys(changes).length) return;
    this._saveStorage(area);
    this.broadcast("storageChanged", { area, changes });
  }

  // ---------- contexts ----------
  register({ tabId, kind, url, frameId, deliver }) {
    const id = this.nextCtx++;
    this.ctxs.set(id, { id, tabId, kind, url, frameId, deliver });
    return id;
  }
  unregister(id) { this.ctxs.delete(id); }

  broadcast(evt, data, except) {
    this.ctxs.forEach((c) => { if (c.id !== except) c.deliver(evt, clone(data)).catch(() => {}); });
  }

  tabInfo(tabId) {
    const t = this.tabs.get(tabId);
    if (!t) return undefined;
    const { _frame, ...pub } = t;
    return { ...pub };
  }

  senderFor(ctx) {
    return {
      id: "smartvid-web-recorder", url: ctx.url, origin: location.origin, frameId: ctx.frameId || 0,
      tab: ctx.tabId != null ? this.tabInfo(ctx.tabId) : undefined,
    };
  }

  async dispatchMessage(ctx, msg, tabId) {
    await this.ready;
    this.history.push(msg?.type);
    const sender = this.senderFor(ctx);
    const targets = [...this.ctxs.values()].filter((c) => c.id !== ctx.id && (tabId == null || c.tabId === tabId));
    if (!targets.length) return undefined;
    const m = clone(msg);
    return new Promise((resolve) => {
      let left = targets.length, settled = false;
      targets.forEach((t) => {
        t.deliver("message", { msg: m, sender }).then((r) => {
          if (settled) return;
          if (r && r.responded) { settled = true; resolve(r.value); } else if (--left === 0) { settled = true; resolve(undefined); }
        }, () => { if (!settled && --left === 0) { settled = true; resolve(undefined); } });
      });
    });
  }

  // ---------- rpc entry (from any context) ----------
  async handle(ctxId, method, args) {
    const ctx = this.ctxs.get(ctxId) || this.workerCtx;
    const [ns, ...rest] = method.split(".");
    const op = rest.join(".");
    switch (method) {
      case "noop": return undefined;
      case "sendMessage": return this.dispatchMessage(ctx, args[0], args[1] == null ? null : args[1]);
      case "runtime.getPlatformInfo": return { os: /Mac/i.test(navigator.platform) ? "mac" : /Win/i.test(navigator.platform) ? "win" : /CrOS/.test(navigator.userAgent) ? "cros" : "linux", arch: "x86-64", nacl_arch: "x86-64" };
      case "runtime.getContexts": return this._getContexts(args[0] || {});
      case "tabs.get": { const t = this.tabInfo(args[0]); if (!t) throw new Error(`No tab with id: ${args[0]}.`); return t; }
      case "tabs.getCurrent": return ctx.tabId != null ? this.tabInfo(ctx.tabId) : undefined;
      case "tabs.query": return this._tabsQuery(args[0] || {});
      case "tabs.create": return this._tabsCreate(args[0] || {});
      case "tabs.update": return this._tabsUpdate(args.length > 1 ? args[0] : ctx.tabId, args.length > 1 ? args[1] : args[0]);
      case "tabs.remove": [].concat(args[0]).forEach((id) => this._tabRemove(id)); return undefined;
      case "tabs.reload": { const f = this.frames.get(args[0] ?? ctx.tabId); if (f) f.contentWindow.location.reload(); else if ((args[0] ?? ctx.tabId) === 1) location.reload(); return undefined; }
      case "windows.getCurrent": case "windows.get": return this._win();
      case "windows.getAll": return [this._win()];
      case "windows.create": { const o = args[0] || {}; const url = [].concat(o.url || [])[0]; const tab = url ? await this._tabsCreate({ url, active: true }) : undefined; return { ...this._win(), id: this.nextWin++, tabs: tab ? [tab] : [] }; }
      case "windows.update": return this._win();
      case "windows.remove": return undefined;
      case "scripting.executeScript": return this._executeScript(args[0] || {});
      case "alarms.create": return this._alarmCreate(args);
      case "alarms.get": { const a = this.alarms.get(args[0] ?? ""); return a ? a.info : undefined; }
      case "alarms.getAll": return [...this.alarms.values()].map((a) => a.info);
      case "alarms.clear": return this._alarmClear(args[0] ?? "");
      case "alarms.clearAll": { [...this.alarms.keys()].forEach((k) => this._alarmClear(k)); return true; }
      case "permissions.contains": return this._perm(args[0]);
      case "permissions.request": return this._perm(args[0]);
      case "permissions.remove": return true;
      case "permissions.getAll": return { permissions: ["storage", "unlimitedStorage", "tabs", "scripting", "downloads"], origins: [] };
      case "offscreen.createDocument": return this._offscreenCreate(args[0] || {});
      case "offscreen.closeDocument": return this._offscreenClose();
      case "offscreen.hasDocument": return !!this.offscreen;
      case "system.display.getInfo": return [{ id: "0", name: "Display", isPrimary: true, isInternal: true, bounds: { left: 0, top: 0, width: screen.width, height: screen.height }, workArea: { left: 0, top: 0, width: screen.availWidth, height: screen.availHeight }, dpiX: 96, dpiY: 96 }];
      case "system.memory.getInfo": { const gb = navigator.deviceMemory || 4; return { capacity: gb * 1073741824, availableCapacity: Math.round(gb * 1073741824 * 0.6) }; }
      case "system.cpu.getInfo": return { numOfProcessors: navigator.hardwareConcurrency || 4, archName: "x86_64", modelName: "", features: [], processors: [] };
      case "power.requestKeepAwake": this._keepAwake(true); return undefined;
      case "power.releaseKeepAwake": this._keepAwake(false); return undefined;
      case "downloads.download": return this._download(args[0] || {});
      case "port.connect": return this._portConnect(ctx, args[0], args[1], args[2]);
      case "port.post": return this._portPost(ctx, args[0], args[1]);
      case "port.close": return this._portClose(ctx, args[0]);
      default: break;
    }
    if (ns === "storage") {
      const [area, o] = [rest[0], rest[1]];
      return this._storage(area, o, args);
    }
    console.warn("[hub] unhandled rpc", method);
    return undefined;
  }

  _win() { return { id: 1, focused: true, alwaysOnTop: false, incognito: false, state: "normal", type: "normal", left: 0, top: 0, width: innerWidth, height: innerHeight }; }
  _perm() { return true; } // nothing to grant at the extension level; the browser prompts at capture time
  _getContexts(filter) {
    const types = filter.contextTypes;
    const out = [];
    this.ctxs.forEach((c) => {
      if (c.kind === "worker") { if (!types || types.includes("BACKGROUND")) out.push({ contextType: "BACKGROUND", contextId: String(c.id), tabId: -1, frameId: -1, documentUrl: this.workerUrl }); return; }
      const isOff = c.tabId == null;
      const type = isOff ? "OFFSCREEN_DOCUMENT" : "TAB";
      if (!types || types.includes(type)) {
        if (filter.documentUrls && !filter.documentUrls.includes(c.url)) return;
        out.push({ contextType: type, contextId: String(c.id), tabId: c.tabId ?? -1, frameId: c.frameId || 0, documentUrl: c.url, windowId: 1, incognito: false });
      }
    });
    return out;
  }

  // ---------- tabs as iframes ----------
  _tabsQuery(q) {
    let list = [...this.tabs.keys()].map((id) => this.tabInfo(id));
    if (q.active != null) list = list.filter((t) => t.active === q.active);
    if (q.currentWindow || q.lastFocusedWindow) list = list.filter((t) => t.windowId === 1);
    if (q.windowId != null && q.windowId >= 0) list = list.filter((t) => t.windowId === q.windowId);
    if (q.url) { const res = [].concat(q.url).map(globToRe); list = list.filter((t) => res.some((r) => r.test(t.url || ""))); }
    if (q.title) { const r = globToRe(q.title); list = list.filter((t) => r.test(t.title || "")); }
    if (q.status) list = list.filter((t) => t.status === q.status);
    if (q.pinned != null) list = list.filter((t) => !!t.pinned === q.pinned);
    return list;
  }

  // Extension URLs are relative to the extension root ("editor.html?x=1"); make them absolute.
  _abs(url) { return typeof url === "string" && url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? new URL(url.replace(/^\//, ""), this.base).href : url; }
  _isOurs(url) { return typeof url === "string" && url.startsWith(this.base); }

  async _tabsCreate(o) {
    const url = this._abs(o.url || "about:blank");
    if (!this._isOurs(url)) {
      // An ordinary external page: open it in a real browser tab.
      try { window.open(url, "_blank", "noopener"); } catch {}
      return { id: this.nextTab++, windowId: 1, index: 0, active: false, pinned: false, highlighted: false, incognito: false, url, status: "complete", title: "" };
    }
    const id = this.nextTab++;
    const page = url.slice(this.base.length).split(/[?#]/)[0];
    const visible = VISIBLE_PAGES.test(page) && o.active !== false;
    const f = document.createElement("iframe");
    f.name = `smartvid-tab:${id}`;
    f.allow = "display-capture *; camera *; microphone *; autoplay *; clipboard-write *; fullscreen *; picture-in-picture *";
    f.setAttribute("data-smartvid-tab", String(id));
    const tab = { id, index: this.tabs.size, windowId: 1, active: visible, highlighted: visible, pinned: !!o.pinned, incognito: false, status: "loading", url, title: "", discarded: false, autoDiscardable: true, _frame: f };
    this.tabs.set(id, tab);
    this.frames.set(id, f);
    f.addEventListener("load", () => {
      tab.status = "complete";
      try { tab.title = f.contentDocument?.title || ""; } catch {}
      this.broadcast("tabsUpdated", { tabId: id, changeInfo: { status: "complete", url: tab.url }, tab: this.tabInfo(id) });
    });
    if (visible && this.onVisibleFrame) this.onVisibleFrame(f, { id, page, close: () => this._tabRemove(id) });
    else {
      f.style.cssText = "position:fixed;left:-20px;top:-20px;width:2px;height:2px;border:0;opacity:0.01;pointer-events:none";
      document.body.appendChild(f);
    }
    f.src = url;
    this.broadcast("tabsCreated", { tab: this.tabInfo(id) });
    this.broadcast("tabsUpdated", { tabId: id, changeInfo: { status: "loading", url }, tab: this.tabInfo(id) });
    return this.tabInfo(id);
  }

  _tabsUpdate(tabId, props) {
    const t = this.tabs.get(tabId);
    if (!t) throw new Error(`No tab with id: ${tabId}.`);
    if (props.url && this.frames.get(tabId)) { const u = this._abs(props.url); t.url = u; t.status = "loading"; this.frames.get(tabId).src = u; }
    if (props.active != null) {
      this.tabs.forEach((x) => { x.active = false; });
      t.active = !!props.active || t.active;
      if (props.active) { try { window.focus(); } catch {} this.broadcast("tabsActivated", { tabId, windowId: 1 }); }
    }
    return this.tabInfo(tabId);
  }

  _tabRemove(id) {
    const t = this.tabs.get(id);
    if (!t || id === 1) return;
    const f = this.frames.get(id);
    this.tabs.delete(id); this.frames.delete(id);
    if (f) { try { f.remove(); } catch {} f.__smartvidClose?.(); }
    [...this.ctxs.values()].filter((c) => c.tabId === id).forEach((c) => this.ctxs.delete(c.id));
    this.broadcast("tabsRemoved", { tabId: id, info: { isWindowClosing: false } });
  }

  _executeScript({ target, funcSrc, args, files }) {
    const tabId = target?.tabId ?? 1;
    const win = tabId === 1 ? window : this.frames.get(tabId)?.contentWindow;
    if (!win) throw new Error(`No tab with id: ${tabId}.`);
    if (funcSrc) {
      try {
        const fn = win.eval(`(${funcSrc})`);
        return Promise.resolve(fn(...(args || []))).then((result) => [{ frameId: 0, result }], () => [{ frameId: 0, result: undefined }]);
      } catch (e) { return [{ frameId: 0, result: undefined }]; }
    }
    // File injection: the content UI is already running in this page; nothing to inject.
    return [{ frameId: 0, result: undefined }];
  }

  // ---------- offscreen ----------
  _offscreenCreate({ url }) {
    if (this.offscreen) throw new Error("Only a single offscreen document may be created.");
    const f = document.createElement("iframe");
    f.name = "smartvid-offscreen";
    f.allow = "display-capture *; camera *; microphone *; autoplay *; clipboard-write *";
    f.style.cssText = "position:fixed;left:-20px;top:-20px;width:2px;height:2px;border:0;opacity:0.01;pointer-events:none";
    document.body.appendChild(f);
    f.src = this._abs(url);
    this.offscreen = f;
    return undefined;
  }
  _offscreenClose() {
    if (!this.offscreen) throw new Error("No current offscreen document.");
    const f = this.offscreen; this.offscreen = null;
    [...this.ctxs.values()].filter((c) => c.kind === "offscreen").forEach((c) => this.ctxs.delete(c.id));
    f.remove();
    return undefined;
  }

  // ---------- alarms ----------
  _alarmCreate(args) {
    const name = typeof args[0] === "string" ? args[0] : "";
    const info = typeof args[0] === "string" ? args[1] || {} : args[0] || {};
    this._alarmClear(name);
    const delay = info.when != null ? Math.max(0, info.when - Date.now()) : (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000;
    const period = info.periodInMinutes ? info.periodInMinutes * 60000 : 0;
    const rec = { info: { name, scheduledTime: Date.now() + delay, periodInMinutes: info.periodInMinutes } };
    const fire = () => {
      this.broadcast("alarm", { name, scheduledTime: Date.now(), periodInMinutes: info.periodInMinutes });
      if (period) { rec.info.scheduledTime = Date.now() + period; rec.timer = setTimeout(fire, period); } else this.alarms.delete(name);
    };
    rec.timer = setTimeout(fire, delay);
    this.alarms.set(name, rec);
    return undefined;
  }
  _alarmClear(name) { const a = this.alarms.get(name); if (!a) return false; clearTimeout(a.timer); this.alarms.delete(name); return true; }

  // ---------- misc ----------
  async _keepAwake(on) {
    try {
      if (on && navigator.wakeLock && !this._lock) this._lock = await navigator.wakeLock.request("screen");
      else if (!on && this._lock) { await this._lock.release(); this._lock = null; }
    } catch {}
  }
  _download({ url, filename }) {
    const id = Date.now() % 1e9;
    const a = document.createElement("a");
    a.href = url; a.download = (filename || "recording").split(/[\\/]/).pop();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => this.broadcast("downloadsChanged", { id, state: { previous: "in_progress", current: "complete" } }), 100);
    return id;
  }

  // ---------- ports ----------
  _portConnect(ctx, portId, name, targetTab) {
    const sender = this.senderFor(ctx);
    const targets = [...this.ctxs.values()].filter((c) => c.id !== ctx.id && (targetTab == null || c.tabId === targetTab));
    this.ports.set(portId, { a: ctx.id, bs: targets.map((t) => t.id) });
    targets.forEach((t) => t.deliver("portConnect", { portId, name, sender }).catch(() => {}));
  }
  _portPost(ctx, portId, msg) {
    const p = this.ports.get(portId); if (!p) return;
    const dest = ctx.id === p.a ? p.bs : [p.a];
    dest.forEach((id) => this.ctxs.get(id)?.deliver("portMessage", { portId, msg: clone(msg) }).catch(() => {}));
  }
  _portClose(ctx, portId) {
    const p = this.ports.get(portId); if (!p) return;
    const dest = ctx.id === p.a ? p.bs : [p.a];
    this.ports.delete(portId);
    dest.forEach((id) => this.ctxs.get(id)?.deliver("portDisconnect", { portId }).catch(() => {}));
  }

  // ---------- background worker ----------
  startBackground() {
    const w = new Worker(this.workerUrl, { name: "smartvid-background" });
    this.worker = w;
    const pending = new Map();
    let seq = 1;
    const ctx = this.workerCtx = {
      id: this.register({ tabId: null, kind: "worker", url: this.workerUrl, frameId: 0, deliver: (evt, data) => new Promise((resolve) => {
        const id = seq++;
        pending.set(id, resolve);
        w.postMessage({ t: "deliver", id, evt, data });
        if (evt !== "message") { pending.delete(id); resolve(undefined); }
      }) }),
      kind: "worker",
    };
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.t === "ready") { this.readyResolve(); return; }
      if (m.t === "deliverResult") { const r = pending.get(m.id); pending.delete(m.id); r && r(m.result); return; }
      if (m.t === "rpc") {
        try { const result = await this.handle(ctx.id, m.method, m.args); w.postMessage({ t: "rpcResult", id: m.id, result }); }
        catch (err) { w.postMessage({ t: "rpcResult", id: m.id, error: String(err?.message || err) }); }
      }
    };
    w.onerror = (e) => { console.error("[hub] background worker error:", e.message || e); this.readyResolve(); };
    // Don't block page messages forever if the worker is slow to boot.
    setTimeout(() => this.readyResolve(), 8000);
    return w;
  }

  // Simulates clicking the toolbar icon (the extension's action) on the host tab.
  fireActionClicked() { this.broadcast("actionClicked", { tab: this.tabInfo(1) }); }
  fireInstalled(reason = "install") { this.broadcast("installed", { reason }); }
}
