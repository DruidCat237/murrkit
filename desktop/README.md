# murrkit desktop

Electron desktop shell for the **murrkit** dashboard. Lives in the repo under
`desktop/`; its source is versioned, but the build output (the installer,
`node_modules/`, `release/`) is **git-ignored** and never committed.

## What it does

A desktop window that **auto-starts the three local servers** (backend,
frontend, phaser) for you, then opens the murrkit dashboard once it is ready —
no need to juggle three terminals. It paints a loading screen instantly, spawns
the servers in the background, and swaps to the dashboard the moment
`http://localhost:3001` responds. Closing the window kills the servers it
started.

- The murrkit repo is found via `MURRKIT_HOME`, else the parent folder (this app
  is `desktop/` inside the repo), else a sibling `murrkit/`.
- If the repo can't be found, auto-start is skipped and the loading screen shows
  the manual commands.
- It does **not** bundle the Python / Node toolchain — you still need `uv` +
  Node installed (full standalone bundling is the roadmap below).

## Build the installer

```bash
cd desktop
npm install
npm run dist     # → release/murrkit Setup <version>.exe   (NSIS installer)
```

- Output lands in `release/` (git-ignored). Upload that `.exe` to your site.
- `npm run pack` makes an unpacked app dir (faster, for testing) without an installer.
- `npm start` runs the shell in dev (no packaging).

> **Node:** use **Node 20 LTS**. Node 22.19.0 on Windows has a libuv `readlink`
> regression that can break file-heavy build tooling.

For trusted installs, code-sign the installer (electron-builder `win.certificateFile`
or Azure Trusted Signing); unsigned builds trigger Windows SmartScreen warnings.

## Roadmap (full standalone, later)

To ship a true one-click app that needs no local toolchain:
1. Bundle the FastAPI backend with PyInstaller → spawn it from `main.js`.
2. Bundle the built Next.js dashboard (static export or a packaged Node server).
3. Bundle the Phaser/Vite build output served locally.
4. Keep the agent CLI (Claude Code or Codex) as a user-side prerequisite.
