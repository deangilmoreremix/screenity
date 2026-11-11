import { installChromeShim } from "./chromeShim";
installChromeShim({ log: new URLSearchParams(location.search).has("debug") });
