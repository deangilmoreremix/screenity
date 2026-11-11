// Send a finished recording from the extension's editor page to the SmartVid
// editor tab (opening one if needed). Resolves once the editor confirms it
// added the clip to the timeline.
import {
  BRIDGE_PORT_NAME,
  CHUNK_BYTES,
  SMARTVID_EDITOR_URL,
  SMARTVID_TAB_PATTERNS,
} from "./config";

const bytesToB64 = (bytes) => {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
};

const ping = (tabId) =>
  new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "smartvid-ping" }, (res) => {
      resolve(!chrome.runtime.lastError && !!res?.ready);
    });
  });

const waitForBridge = async (tabId, timeoutMs = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping(tabId)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const findOrOpenEditorTab = async () => {
  const tabs = await chrome.tabs.query({ url: SMARTVID_TAB_PATTERNS });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return tabs[0].id;
  }
  const tab = await chrome.tabs.create({ url: SMARTVID_EDITOR_URL });
  return tab.id;
};

export async function sendToSmartVid(blob, { name, duration, mode } = {}) {
  const tabId = await findOrOpenEditorTab();
  if (!(await waitForBridge(tabId))) {
    throw new Error("Could not reach the SmartVid editor tab");
  }
  const port = chrome.tabs.connect(tabId, { name: BRIDGE_PORT_NAME });
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const acked = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("SmartVid editor did not confirm the recording")),
      60000
    );
    port.onMessage.addListener((m) => {
      if (m.type === "ack") {
        clearTimeout(timer);
        resolve();
      }
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      reject(new Error("Connection to the SmartVid editor closed"));
    });
  });

  port.postMessage({
    type: "start",
    id,
    name: name || "Screen Recording",
    duration,
    mode: mode || "screen",
    mime: blob.type || "video/webm",
    size: blob.size,
  });
  for (let off = 0; off < blob.size; off += CHUNK_BYTES) {
    const buf = await blob.slice(off, off + CHUNK_BYTES).arrayBuffer();
    port.postMessage({ type: "chunk", data: bytesToB64(new Uint8Array(buf)) });
  }
  port.postMessage({ type: "end" });
  await acked;
  port.disconnect();
}
