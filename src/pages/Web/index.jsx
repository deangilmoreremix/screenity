// Web build: boots the real Screenity Content UI on a normal web page, backed by the
// chrome.* shim and an in-page replacement for the background service worker.
import "./installShim"; // must be first: defines window.chrome before anything else loads
import "./webBackground";
import "../Content/index.jsx";
