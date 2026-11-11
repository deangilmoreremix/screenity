// Entry for the background Web Worker: the emulated chrome.* first, then the unmodified
// upstream background service worker, then tell the host we're ready.
import "./emu/install";
import "../Background/index.js";
self.postMessage({ t: "ready" });
