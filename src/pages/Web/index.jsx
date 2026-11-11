// Web build: boots the real Screenity Content UI on a normal web page. The chrome.* APIs it
// expects are emulated by ./emu; the unmodified background service worker runs in a Worker.
import "./emu/boot";     // must be first: defines how the hub is created
import "./emu/install";  // defines window.chrome before any upstream module loads
import "../Content/index.jsx";
import "./start";
