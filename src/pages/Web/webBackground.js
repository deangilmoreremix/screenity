// In-page stand-in for the extension's background service worker. Handlers mirror the
// behaviour of src/pages/Background/messaging/handlers.js for the messages the web build needs.
const handlers = {};
const on = (type, fn) => { handlers[type] = fn; };

// Same logic as upstream "get-tab-id" / "sync-recording-state" (Background/messaging/handlers.js).
on("get-tab-id", () => ({ tabId: 1 }));
on("sync-recording-state", async () => {
  const s = await chrome.storage.local.get(["recording", "paused", "recordingStartTime", "pausedAt", "totalPausedMs", "pendingRecording"]);
  return {
    recording: Boolean(s.recording),
    paused: Boolean(s.paused),
    recordingStartTime: s.recordingStartTime || null,
    pausedAt: s.pausedAt || null,
    totalPausedMs: s.totalPausedMs || 0,
    pendingRecording: Boolean(s.pendingRecording),
  };
});

const seen = new Set();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) {
    if (msg?.type && !seen.has(msg.type)) { seen.add(msg.type); console.debug("[web-bg] unhandled:", msg.type); }
    return false;
  }
  Promise.resolve(h(msg, sender)).then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true;
});

// The toolbar icon opens the popup in the extension; on the web we open it on load.
window.addEventListener("load", () => setTimeout(() => chrome.runtime.sendMessage({ type: "toggle-popup" }), 600));
