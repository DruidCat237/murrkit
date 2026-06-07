// murrkit-desktop — Electron main process.
//
// A desktop shell around the murrkit dashboard that also STARTS the three local
// servers for you (backend, frontend, phaser) so you do not have to open three
// terminals. It paints a loading screen instantly, spawns the servers in the
// background, and swaps to the dashboard the moment it is reachable.
//
// The murrkit repo location is resolved from MURRKIT_HOME; since this app lives
// in the repo under desktop/, the default is the parent folder. A sibling
// "murrkit" folder is also tried. If none is found, auto-start is skipped and
// the loading screen shows the manual commands instead.
//
// Build output (installer, node_modules, release/) is git-ignored; only the
// source here is versioned. Override the dashboard URL with MURRKIT_URL.

const { app, BrowserWindow, shell, net } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const DASHBOARD_URL = process.env.MURRKIT_URL || "http://localhost:3001";
const ICON = path.join(__dirname, "icon.png");

// --- Locate the murrkit repo ------------------------------------------------
function resolveMurrkitHome() {
  const candidates = [
    process.env.MURRKIT_HOME,
    path.join(__dirname, ".."),             // desktop/ lives inside the murrkit repo → parent is the repo
    path.join(__dirname, "..", "murrkit"),  // fallback: sibling layout
    path.join(path.dirname(__dirname), "murrkit"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "backend", "main.py"))) return path.resolve(c);
    } catch {
      /* ignore */
    }
  }
  return null;
}

const MURRKIT_HOME = resolveMurrkitHome();

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

async function maybeStartServers() {
  if (!MURRKIT_HOME) {
    console.warn("murrkit repo not found (set MURRKIT_HOME) — skipping auto-start.");
    return;
  }
  // Already running? Don't double-spawn (the user may have started them by hand).
  if (await dashboardReachable()) return;
  spawnServer("backend", "uv run uvicorn backend.main:app --port 8001", MURRKIT_HOME);
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
app.whenReady().then(() => {
  createWindow(); // loading screen up instantly
  maybeStartServers(); // spawn servers in the background; pollDashboard swaps in when ready
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", killServers);

app.on("window-all-closed", () => {
  killServers();
  if (process.platform !== "darwin") app.quit();
});
