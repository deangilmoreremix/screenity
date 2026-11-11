// SmartVid editor location. UPDATE these for your deployment, and keep the
// manifest.json "SmartVid bridge" content_scripts matches in sync.
export const SMARTVID_EDITOR_URL = "http://localhost:5173/timeline";
export const SMARTVID_TAB_PATTERNS = [
  "http://localhost/*",
  "https://smartvid.example/*", // TODO: replace with the real editor origin
];
export const BRIDGE_PORT_NAME = "smartvid-recording";
// Raw bytes per chunk (base64 grows this by ~33%, well under the 64MB message cap).
export const CHUNK_BYTES = 4 * 1024 * 1024;
