// Web-build only. Screenity addresses its bundled assets as chrome-extension://<id>/assets/...,
// which a normal web page can't load. Rewrite those to the web base URL at build time so the
// upstream sources stay untouched.
module.exports = function (source) {
  return source
    // JS: "chrome-extension://" + chrome.i18n.getMessage("@@extension_id") + "/assets/x"  ->  chrome.runtime.getURL("assets/x")
    .replace(
      /["']chrome-extension:\/\/["']\s*\+\s*chrome\.i18n\.getMessage\(\s*["']@@extension_id["']\s*\)\s*\+\s*(["'])\/([^"'\n]*)\1/g,
      'chrome.runtime.getURL("$2")'
    )
    // any remaining form of the same prefix
    .replace(
      /["']chrome-extension:\/\/["']\s*\+\s*chrome\.i18n\.getMessage\(\s*["']@@extension_id["']\s*\)\s*\+\s*/g,
      'chrome.runtime.getURL("").replace(/\\/$/, "") + '
    )
    // Root-absolute asset paths only work at an extension's root; make them relative to the recorder's base.
    // JSX attribute:  src="/assets/x.svg"  ->  src={chrome.runtime.getURL("assets/x.svg")}
    .replace(/([A-Za-z-])=(["'])\/assets\/([^"'\n]*)\2/g, '$1={chrome.runtime.getURL("assets/$3")}')
    // plain string literal: "/assets/x" -> chrome.runtime.getURL("assets/x")
    .replace(/(["'])\/assets\/([^"'\n]*)\1/g, 'chrome.runtime.getURL("assets/$2")')
    // CSS/SCSS/HTML: url(chrome-extension://__MSG_@@extension_id__/assets/...) -> relative url(assets/...)
    .replace(/chrome-extension:\/\/__MSG_@@extension_id__\//g, "");
};
