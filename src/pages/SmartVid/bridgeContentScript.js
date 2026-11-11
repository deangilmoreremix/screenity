// Runs on the SmartVid editor origin. Receives a recording from the extension
// in chunks over a port, rebuilds the Blob and hands it to the editor page,
// which adds it to the timeline (see the 'smartvid-extension' listener there).
import { BRIDGE_PORT_NAME } from "./config";

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.type === "smartvid-ping") sendResponse({ ready: true });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BRIDGE_PORT_NAME) return;
  let meta = null;
  let parts = [];

  const onEditorAck = (event) => {
    const d = event.data;
    if (
      event.source === window &&
      d &&
      d.source === "smartvid-editor" &&
      d.type === "recording-received" &&
      meta &&
      d.id === meta.id
    ) {
      window.removeEventListener("message", onEditorAck);
      port.postMessage({ type: "ack" });
    }
  };

  port.onMessage.addListener((msg) => {
    if (msg.type === "start") {
      meta = msg;
      parts = [];
    } else if (msg.type === "chunk") {
      parts.push(b64ToBytes(msg.data));
    } else if (msg.type === "end" && meta) {
      const blob = new Blob(parts, { type: meta.mime || "video/webm" });
      parts = [];
      window.addEventListener("message", onEditorAck);
      window.postMessage(
        {
          source: "smartvid-extension",
          type: "recording",
          id: meta.id,
          blob,
          name: meta.name,
          duration: meta.duration,
          mode: meta.mode,
        },
        window.location.origin
      );
    }
  });
  port.onDisconnect.addListener(() => {
    window.removeEventListener("message", onEditorAck);
  });
});
