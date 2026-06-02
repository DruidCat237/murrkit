import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: ".",
  // RELATIVE asset URLs in the build → the dist/ folder is fully relocatable:
  // it works at druidcat.com/ OR druidcat.com/<any-slug>/ with no rebuild.
  base: "./",
  publicDir: resolve(__dirname, "../public"),  // murrkit/public/ — shared assets (angrycat atlases etc.)
  server: {
    port: 5173,
    host: "127.0.0.1",
    strictPort: false,
    fs: {
      allow: [
        resolve(__dirname),
        resolve(__dirname, "../public"),
        resolve(__dirname, "../public/assets"),
      ],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@levels": resolve(__dirname, "levels"),
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false, // shipped web bundle — no 11MB .map for players to download
  },
});
