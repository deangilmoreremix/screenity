// Starts the background Worker and simulates the extension lifecycle for the host page.
const hub = window.__chromeHub;

// Pages the extension would open in a browser tab (permissions, first steps, editor...)
// appear as a full-window overlay instead.
window.__smartvidShowFrame = (frame, ctl) => {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-smartvid-overlay", String(ctl.id));
  wrap.style.cssText = "position:fixed;inset:0;z-index:2147483600;background:rgba(15,15,20,.55);display:flex;align-items:center;justify-content:center";
  frame.style.cssText = "width:min(1200px,96vw);height:min(820px,94vh);border:0;border-radius:14px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.35)";
  const x = document.createElement("button");
  x.textContent = "×";
  x.setAttribute("aria-label", "Close");
  x.style.cssText = "position:absolute;top:14px;right:18px;width:36px;height:36px;border-radius:50%;border:0;background:#fff;font-size:22px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  x.onclick = () => ctl.close();
  const tell = (open) => { if (window.parent !== window) window.parent.postMessage({ source: "smartvid-recorder", type: "overlay", open }, location.origin); };
  frame.__smartvidClose = () => { wrap.remove(); tell(false); };
  tell(true);
  wrap.append(frame, x);
  document.body.appendChild(wrap);
};

hub.startBackground();

const first = !localStorage.getItem("smartvid-web:installed");
setTimeout(() => {
  if (first) { localStorage.setItem("smartvid-web:installed", "1"); hub.fireInstalled("install"); }
  else hub.broadcast("startup", {});
}, 300);

// Host pages can open the recorder popup like clicking the extension icon.
window.smartvidRecorder = {
  open: () => hub.fireActionClicked(),
  hub,
};
if (!new URLSearchParams(location.search).has("manual")) {
  window.addEventListener("load", () => setTimeout(() => hub.fireActionClicked(), 1500));
}

// Keyboard shortcuts: the manifest's suggested keys (e.g. Alt+Shift+G) fire chrome.commands.onCommand.
import manifest from "../../manifest.json";
const combos = Object.entries(manifest.commands || {}).filter(([, c]) => c.suggested_key?.default).map(([name, c]) => {
  const parts = c.suggested_key.default.split("+");
  const key = parts[parts.length - 1].toUpperCase();
  return { name, alt: parts.includes("Alt"), shift: parts.includes("Shift"), ctrl: parts.includes("Ctrl"), meta: parts.includes("Command"), code: /^[A-Z]$/.test(key) ? `Key${key}` : key };
});
window.addEventListener("keydown", (e) => {
  const hit = combos.find((c) => c.alt === e.altKey && c.shift === e.shiftKey && c.ctrl === e.ctrlKey && c.meta === e.metaKey && c.code === e.code);
  if (hit) { e.preventDefault(); hub.broadcast("command", { command: hit.name, tab: hub.tabInfo(1) }); }
});

// Tell an embedding page (the SmartVid editor) when a recording starts/stops.
if (window.parent !== window) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.recording) window.parent.postMessage({ source: "smartvid-recorder", type: "recording-state", recording: !!changes.recording.newValue }, location.origin);
  });
}
