// murrkit-desktop — Electron main process.
//
// A desktop shell around the murrkit dashboard that also STARTS the three local
// servers for you (backend, frontend, phaser) so you do not have to open three
// terminals. It paints a loading screen instantly, spawns the servers in the
// background, and swaps to the dashboard the moment it is reachable.
//
// Finding the murrkit repo:
//   1. MURRKIT_HOME env var
//   2. a folder you picked before (remembered in the app's user-data config)
//   3. the parent folder (when run from source: desktop/ inside the repo)
//   4. a sibling "murrkit/" folder
// An INSTALLED build (in Program Files) doesn't sit next to the repo, so on
// first run it asks you to point at the murrkit folder once and remembers it.
//
// Build output (installer, node_modules, release/) is git-ignored; only the
// source here is versioned. Override the dashboard URL with MURRKIT_URL.

const { app, BrowserWindow, shell, net, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const DASHBOARD_URL = process.env.MURRKIT_URL || "http://localhost:3001";
const ICON = path.join(__dirname, "icon.png");

// --- Remembered repo location (user-data config) ----------------------------
function configPath() {
  return path.join(app.getPath("userData"), "murrkit-desktop.json");
}

function isMurrkitRepo(dir) {
  try {
    return !!dir && fs.existsSync(path.join(dir, "backend", "main.py"));
  } catch {
    return false;
  }
}

function readSavedHome() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (isMurrkitRepo(cfg.murrkitHome)) return path.resolve(cfg.murrkitHome);
  } catch {
    /* no/invalid config yet */
  }
  return null;
}

function saveHome(dir) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ murrkitHome: dir }, null, 2));
  } catch (e) {
    console.error("could not save murrkit home:", e.message);
  }
}

// --- Locate the murrkit repo ------------------------------------------------
function resolveMurrkitHome() {
  const candidates = [
    process.env.MURRKIT_HOME,
    readSavedHome(),                        // a folder the user picked before
    path.join(__dirname, ".."),             // from source: desktop/ inside the repo
    path.join(__dirname, "..", "murrkit"),  // sibling layout
    path.join(path.dirname(__dirname), "murrkit"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (isMurrkitRepo(c)) return path.resolve(c);
  }
  return null;
}

// First-run: ask the user where the murrkit repo is, validate, and remember it.
async function promptForHome() {
  const res = await dialog.showOpenDialog(win, {
    title: "Locate your murrkit folder",
    message: "Select your murrkit repository folder (it contains backend/, frontend/ and phaser_game/).",
    buttonLabel: "Use this folder",
    properties: ["openDirectory"],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  const picked = res.filePaths[0];
  if (isMurrkitRepo(picked)) {
    saveHome(picked);
    return path.resolve(picked);
  }
  await dialog.showMessageBox(win, {
    type: "error",
    title: "Not the murrkit folder",
    message: "That folder doesn't look like the murrkit repo (no backend/main.py inside).",
    detail: "Pick the folder that contains backend/, frontend/ and phaser_game/.",
  });
  return null;
}

let MURRKIT_HOME = resolveMurrkitHome();

let win = null;
let pollTimer = null;
let connected = false;
const children = [];

// --- Server lifecycle -------------------------------------------------------
function spawnServer(label, command, cwd) {
  let stdio = "ignore";
  try {
    const logPath = path.join(app.getPath("userData"), `server-${label}.log`);
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  } catch {
    stdio = "ignore";
  }
  try {
    const child = spawn(command, {
      cwd,
      shell: true, // needed so `uv` / `npm` resolve via the shell (.cmd shims on Windows)
      windowsHide: true,
      stdio,
      env: { ...process.env },
    });
    child.on("error", (e) => console.error(`[${label}] spawn error:`, e.message));
    children.push({ label, child });
    console.log(`[${label}] started in ${cwd}`);
  } catch (e) {
    console.error(`[${label}] failed to start:`, e.message);
  }
}

// Prefer the project venv's Python for the backend — avoids the `uv` trampoline,
// which fails to canonicalize its script path when spawned from a GUI app on
// Windows ("uv trampoline failed to canonicalize script path"). Falls back to
// `uv run` only if no .venv is present (run `uv sync` once to create it).
function backendCmd(home) {
  const py =
    process.platform === "win32"
      ? path.join(home, ".venv", "Scripts", "python.exe")
      : path.join(home, ".venv", "bin", "python");
  if (fs.existsSync(py)) return `"${py}" -m uvicorn backend.main:app --port 8001`;
  // `python -m uvicorn` (not bare `uvicorn`) so even this fallback dodges the
  // broken uvicorn.exe console-script shim that the trampoline can't canonicalize.
  return "uv run python -m uvicorn backend.main:app --port 8001";
}

async function maybeStartServers() {
  if (!MURRKIT_HOME) {
    console.warn("murrkit repo not found — skipping auto-start (manual instructions shown).");
    return;
  }
  // Already running? Don't double-spawn (the user may have started them by hand).
  if (await dashboardReachable()) return;
  spawnServer("backend", backendCmd(MURRKIT_HOME), MURRKIT_HOME);
  spawnServer("frontend", "npm run dev", path.join(MURRKIT_HOME, "frontend"));
  spawnServer("phaser", "npm run dev", path.join(MURRKIT_HOME, "phaser_game"));
}

function killServers() {
  for (const { label, child } of children) {
    try {
      if (process.platform === "win32" && child.pid) {
        // Kill the whole tree (npm/uv spawn child node/python processes).
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch (e) {
      console.error(`[${label}] kill error:`, e.message);
    }
  }
  children.length = 0;
}

// --- Window + dashboard connect ---------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0b0b0f",
    title: "murrkit",
    icon: ICON,
    autoHideMenuBar: true,
    show: false, // wait for first paint (the loading screen) — no black flash
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    if (pollTimer) clearTimeout(pollTimer);
    win = null;
  });

  win.loadFile(path.join(__dirname, "loading.html"));
  pollDashboard();
}

function dashboardReachable() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    let req;
    try {
      req = net.request({ method: "GET", url: DASHBOARD_URL });
    } catch {
      return finish(false);
    }
    req.on("response", () => finish(true));
    req.on("error", () => finish(false));
    setTimeout(() => finish(false), 2000);
    try {
      req.end();
    } catch {
      finish(false);
    }
  });
}

async function pollDashboard() {
  if (!win || connected) return;
  const ok = await dashboardReachable();
  if (!win || connected) return;
  if (ok) {
    connected = true;
    win.loadURL(DASHBOARD_URL);
  } else {
    pollTimer = setTimeout(pollDashboard, 1500);
  }
}

// --- App lifecycle ----------------------------------------------------------
async function startup() {
  createWindow(); // loading screen up instantly
  // If we already know where the repo is, great. Otherwise (typically an
  // installed build) ask once and remember it — unless the dashboard is
  // already running, in which case we just connect.
  if (!MURRKIT_HOME && !(await dashboardReachable())) {
    MURRKIT_HOME = await promptForHome();
  }
  maybeStartServers(); // spawn in the background; pollDashboard swaps in when ready
}

app.whenReady().then(startup);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", killServers);

app.on("window-all-closed", () => {
  killServers();
  if (process.platform !== "darwin") app.quit();
});
