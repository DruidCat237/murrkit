// Minimal, safe preload bridge. Renderer (the dashboard) can detect it's
// running inside the desktop shell via `window.murrkit?.isDesktop`.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("murrkit", {
  isDesktop: true,
  platform: process.platform,
});
