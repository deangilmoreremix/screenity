// Web-build only. Screenity addresses its bundled assets as chrome-extension://<id>/assets/...,
// which a normal web page can't load. Rewrite those to the web base URL at build time so the
// upstream sources stay untouched.
module.exports = function (source) {
  return source
    // JS: "chrome-extension://" + chrome.i18n.getMessage("@@extension_id") + "/assets/..."
    .replace(
      /["']chrome-extension:\/\/["']\s*\+\s*chrome\.i18n\.getMessage\(\s*["']@@extension_id["']\s*\)\s*\+\s*/g,
      'chrome.runtime.getURL("").replace(/\\/$/, "") + '
    )
    // CSS/SCSS: url(chrome-extension://__MSG_@@extension_id__/assets/...) -> relative url(assets/...)
    .replace(/chrome-extension:\/\/__MSG_@@extension_id__\//g, "");
};
