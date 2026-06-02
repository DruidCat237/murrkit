"""
Phaser game runtime integration — drives the dev server, runs headless
playtest via Playwright, dumps Canvas/DOM state, persists screenshots.

This is the Phaser-flavored replacement for what `unity.py` did in
the retired predecessor. Where the legacy engine exposed `/api/unity/*` over MCP,
here we expose `/api/phaser/*` over direct subprocess + Playwright calls.

Endpoints:
    GET  /api/phaser/health              — Vite dev server reachable?
    POST /api/phaser/dev-server/start    — `npm run dev` in phaser_game/
    POST /api/phaser/dev-server/stop     — kill running Vite
    GET  /api/phaser/dev-server/status   — running? port? PID?
    POST /api/phaser/screenshot          — Playwright capture, returns persisted path
    POST /api/phaser/composition-check   — read scene-graph via page.evaluate, eval assertions
    POST /api/phaser/playtest            — load level, screenshot at intervals, return verdict
    GET  /api/phaser/levels              — list levels/*.yaml
    POST /api/phaser/levels              — write a level YAML
"""

from __future__ import annotations

import asyncio
import base64
import functools
import inspect
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

import httpx
from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel, Field

from core.config import PROJECT_ROOT

router = APIRouter(prefix="/api/phaser", tags=["phaser"])


# ---------------------------------------------------------------------------
# ProactorEventLoop workaround
# ---------------------------------------------------------------------------
# uvicorn on Windows hardcodes WindowsSelectorEventLoopPolicy() in
# uvicorn/loops/asyncio.py:asyncio_setup() — done historically because
# httptools had issues with ProactorEventLoop. The side effect: Python
# Playwright's `loop.subprocess_exec` raises NotImplementedError on the
# SelectorEventLoop (subprocess transport is Proactor-only on Windows).
#
# We dodge it by running Playwright-using endpoints in a separate thread that
# owns its OWN ProactorEventLoop. Cheap: the playtest endpoint is rare
# (manual + Claude-triggered, not high-RPS). Linux/macOS path is the default
# `new_event_loop()` which supports subprocess everywhere.

def _proactor_endpoint(
    async_impl: Callable[..., Awaitable[Any]],
) -> Callable[..., Awaitable[Any]]:
    """Run the wrapped async endpoint in a thread with its own event loop.

    On Windows the thread loop is forced to ProactorEventLoop so Playwright's
    subprocess_exec works regardless of uvicorn's policy. Result + exceptions
    propagate normally back to FastAPI.
    """
    @functools.wraps(async_impl)
    async def wrapped(*args: Any, **kwargs: Any) -> Any:
        def _runner() -> Any:
            if sys.platform == "win32":
                loop = asyncio.ProactorEventLoop()
            else:
                loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                return loop.run_until_complete(async_impl(*args, **kwargs))
            finally:
                loop.close()
        return await asyncio.to_thread(_runner)
    # CRITICAL pair of tweaks so FastAPI uses OUR wrapped function (with the
    # thread+ProactorEventLoop dance) AND can still parse the typed request body.
    # (1) Copy the typed signature from `async_impl` onto `wrapped` so
    #     FastAPI's DI sees `req: PlaytestRequest` etc instead of (*args, **kwargs)
    #     — without this it treats every param as a missing query string.
    # (2) Drop __wrapped__ so FastAPI's `inspect.unwrap()` doesn't peel back
    #     to the original async function and bypass the thread.
    wrapped.__signature__ = inspect.signature(async_impl)  # type: ignore[attr-defined]
    try:
        delattr(wrapped, "__wrapped__")
    except AttributeError:
        pass
    return wrapped


PHASER_DIR = PROJECT_ROOT / "phaser_game"
PHASER_LEVELS_DIR = PHASER_DIR / "levels"
PHASER_DEFAULT_PORT = 5173
SCREENSHOTS_DIR = PROJECT_ROOT / "public_files" / "screenshots"


# ---------------------------------------------------------------------------
# Dev server management — single global process
# ---------------------------------------------------------------------------

_dev_server_proc: subprocess.Popen[bytes] | None = None
_dev_server_port: int = PHASER_DEFAULT_PORT
_dev_server_started_at: float = 0.0

# Single-flight guard: only ONE playtest at a time. Without this, two
# concurrent /api/phaser/playtest calls each launch their own Chromium and
# eat ~500MB+ RAM each. This is a backend-wide lock (lazy-init because
# asyncio.Lock needs a running loop).
_playtest_lock: asyncio.Lock | None = None

def _get_playtest_lock() -> asyncio.Lock:
    """Returns the singleton playtest lock, recreating it if it's bound to a
    dead event loop (e.g. after uvicorn --reload regenerated the loop). The
    stale Lock raises `RuntimeError: bound to a different event loop` on
    acquire, which traps the entire endpoint. Detect by trying to use it and
    recreating on mismatch."""
    global _playtest_lock
    if _playtest_lock is None:
        _playtest_lock = asyncio.Lock()
        return _playtest_lock
    # Probe: is the lock's loop the currently running loop?
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        return _playtest_lock  # No loop yet; first acquire will bind it
    lock_loop = getattr(_playtest_lock, "_loop", None)
    if lock_loop is not None and lock_loop is not current_loop:
        _playtest_lock = asyncio.Lock()
    return _playtest_lock


# ---------------------------------------------------------------------------
# Shared Playwright machinery (used by BOTH /playtest and /drive)
# ---------------------------------------------------------------------------

async def _close_browser_safely(browser: Any) -> None:
    """Timeout-protected browser teardown shared by every Playwright endpoint.

    If browser.close() hangs (Chromium subprocess unresponsive), force a
    second bounded close so Windows Task Manager doesn't fill with zombie
    headless_shell/chrome.exe renderers from crashed runs. Factored out of the
    original /playtest finally-block so /drive gets the identical guarantee.
    """
    try:
        await asyncio.wait_for(browser.close(), timeout=5.0)
    except (asyncio.TimeoutError, Exception) as e:  # noqa: BLE001
        logger.warning(
            "browser.close() hung or failed ({e}) — force-killing",
            e=type(e).__name__,
        )
        try:
            proc = getattr(getattr(browser, "_impl_obj", None), "_channel", None)
            if proc is not None:
                await asyncio.wait_for(browser.close(), timeout=2.0)
        except Exception:  # noqa: BLE001
            pass


async def _canvas_to_game_mapper(page: Any) -> Callable[[float, float], tuple[float, float]]:
    """Return a `game_to_screen(gx, gy)` mapper from Phaser game-space coords to
    on-page pixel coords, by reading the live canvas bounding box + game config.

    Shared by /playtest's slingshot bot and /drive's click/drag inputs so mouse
    events land on the right pixel regardless of Phaser.Scale.FIT letterboxing.
    """
    canvas_box = await page.evaluate(
        "() => { const c = document.querySelector('canvas');"
        " const r = c.getBoundingClientRect();"
        " return { left: r.left, top: r.top, width: r.width, height: r.height,"
        " gameWidth: window.game.config.width, gameHeight: window.game.config.height }; }"
    )

    def game_to_screen(gx: float, gy: float) -> tuple[float, float]:
        return (
            canvas_box["left"] + gx * canvas_box["width"] / canvas_box["gameWidth"],
            canvas_box["top"] + gy * canvas_box["height"] / canvas_box["gameHeight"],
        )

    return game_to_screen


@router.get("/health")
async def phaser_health() -> dict[str, Any]:
    """Is the Vite dev server reachable?"""
    url = f"http://127.0.0.1:{_dev_server_port}/"
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(url)
            ok = r.status_code < 500
    except (httpx.RequestError, OSError):
        ok = False
    return {
        "healthy": ok,
        "url": url,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "pid": _dev_server_proc.pid if _dev_server_proc and _dev_server_proc.poll() is None else None,
    }


class DevServerStartRequest(BaseModel):
    port: int = PHASER_DEFAULT_PORT


class DevServerStopRequest(BaseModel):
    # True ONLY when the human clicks the Stop button in the dashboard. A user
    # stop is RESPECTED (game stays down, persists across restarts). A programmatic
    # stop (inner Claude, a playtest cleanup, an internal restart) leaves this
    # False, so the watchdog brings the game back — an internal action must never
    # make the game vanish from the Phaser Game tab.
    user_initiated: bool = False


# ---------------------------------------------------------------------------
# Dev-server lifecycle: log-to-file spawn (no PIPE deadlock), adopt-or-respawn,
# and a watchdog that keeps Vite alive. Root causes this fixes:
#   1. PIPE DEADLOCK — the old spawn used stdout=PIPE that nobody drained, so
#      Vite froze once it had printed ~64KB (HMR/request logs filled the OS pipe
#      buffer and the next write blocked). That was Vite "randomly dying". A log
#      FILE never blocks and gives a crash trail.
#   2. ORPHAN ON BACKEND RESTART — Vite is a child of the backend; a backend
#      restart orphans it (it keeps running) but resets `_dev_server_proc=None`,
#      so the old start endpoint would spawn a DUPLICATE that can't bind :5173.
#      _ensure_vite ADOPTS a reachable server instead.
# "Desired" state is persisted so a backend restart never silently drops the game.
# ---------------------------------------------------------------------------

_dev_server_desired: bool = False
_VITE_DESIRED_FILE = PROJECT_ROOT / ".omc" / "state" / "vite_desired.json"


def _load_vite_desired() -> bool | None:
    """Persisted desired-state; None if never set (→ default-on for a game tool)."""
    import json
    try:
        return bool(json.loads(_VITE_DESIRED_FILE.read_text()).get("desired"))
    except (OSError, ValueError):
        return None


def _save_vite_desired(desired: bool) -> None:
    import json
    try:
        _VITE_DESIRED_FILE.parent.mkdir(parents=True, exist_ok=True)
        _VITE_DESIRED_FILE.write_text(json.dumps({"desired": desired}))
    except OSError as e:
        logger.warning("could not persist vite desired-state: {e}", e=e)


async def _vite_reachable(port: int) -> bool:
    """True if SOMETHING answers HTTP on the port (ours, an orphan, or a
    user-started `npm run dev`)."""
    try:
        async with httpx.AsyncClient(timeout=1.5) as c:
            r = await c.get(f"http://127.0.0.1:{port}/")
            return r.status_code < 500
    except (httpx.RequestError, OSError):
        return False


def _spawn_vite(port: int) -> subprocess.Popen[bytes]:
    """Spawn `npm run dev`, logging to a FILE (never a PIPE — see header)."""
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        raise RuntimeError("npm not found on PATH")
    env = os.environ.copy()
    env["VITE_PORT"] = str(port)
    log_path = PROJECT_ROOT / "logs" / f"vite-{port}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logf = log_path.open("ab")  # noqa: SIM115 — handle owned by the child process
    return subprocess.Popen(
        [npm, "run", "dev", "--", "--port", str(port), "--host", "127.0.0.1"],
        cwd=str(PHASER_DIR),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        shell=False,
    )


def _kill_port_holder(port: int) -> None:
    """Kill a wedged/orphaned node process holding `port` but not answering, so a
    clean rebind can happen. Best-effort, node/npm-only to avoid collateral."""
    if os.name != "nt":
        return
    def _ps(cmd: str) -> str:
        return subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", cmd],
            capture_output=True, text=True, timeout=10,
        ).stdout
    try:
        for tok in _ps(
            f"Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction "
            "SilentlyContinue | Select-Object -ExpandProperty OwningProcess"
        ).split():
            if not tok.strip().isdigit():
                continue
            pid = int(tok)
            name = _ps(
                f"(Get-Process -Id {pid} -ErrorAction SilentlyContinue).ProcessName"
            ).strip().lower()
            if name in ("node", "npm"):
                _ps(f"Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue")
                logger.warning("reaped wedged Vite holder pid={p} on :{port}", p=pid, port=port)
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning("kill_port_holder({port}) failed: {e}", port=port, e=e)


async def _ensure_vite(port: int) -> dict[str, Any]:
    """Make Vite reachable on `port`: ADOPT if already up, else (re)spawn.
    Returns the dev-server response shape."""
    global _dev_server_proc, _dev_server_port, _dev_server_started_at
    _dev_server_port = port
    if not (PHASER_DIR / "package.json").is_file():
        return {"ok": False, "port": port,
                "error": "phaser_game/package.json missing — run npm install"}
    if await _vite_reachable(port):
        managed = bool(_dev_server_proc and _dev_server_proc.poll() is None)
        return {"ok": True, "already_running": True,
                "pid": _dev_server_proc.pid if managed else None,
                "port": port, "url": f"http://127.0.0.1:{port}/"}
    # Not reachable → reap our own dead/hung handle, then any orphan on the port.
    if _dev_server_proc and _dev_server_proc.poll() is None:
        try:
            _dev_server_proc.kill()
        except OSError:
            pass
    _dev_server_proc = None
    await asyncio.to_thread(_kill_port_holder, port)
    try:
        proc = _spawn_vite(port)
    except RuntimeError as e:
        return {"ok": False, "port": port, "error": str(e)}
    _dev_server_proc = proc
    _dev_server_started_at = time.time()
    url = f"http://127.0.0.1:{port}/"
    for _ in range(30):
        await asyncio.sleep(0.4)
        if await _vite_reachable(port):
            return {"ok": True, "pid": proc.pid, "port": port, "url": url}
    return {"ok": False, "pid": proc.pid, "port": port, "url": url,
            "note": f"Started but not reachable within 12s — see logs/vite-{port}.log"}


async def vite_watchdog() -> None:
    """Background loop (started in the app lifespan): while Vite is DESIRED, keep
    it alive — revive a crashed / pipe-wedged dev server within ~10s instead of
    leaving the game dead until a manual click. Auto-starts on boot unless an
    explicit /stop opted out persistently."""
    global _dev_server_desired
    # `desired` = the USER's intent (game on / off), persisted across restarts.
    # Fresh project (never stopped) defaults ON, so the game is there in the tab.
    # The watchdog only REVIVES a crash (desired=True but unreachable) — it does
    # NOT fight a deliberate user Stop (desired=False). A transient/programmatic
    # stop (inner Claude, a playtest cleanup) does NOT clear `desired`, so the game
    # still auto-recovers from those; ONLY a user-initiated Stop sets desired=False.
    # That's what keeps the game present without overriding an explicit Stop click.
    persisted = _load_vite_desired()
    _dev_server_desired = True if persisted is None else persisted
    if persisted is None:
        _save_vite_desired(True)
    logger.info("vite watchdog started (desired={d}, port={p})",
                d=_dev_server_desired, p=_dev_server_port)
    while True:
        try:
            if _dev_server_desired and not await _vite_reachable(_dev_server_port):
                logger.warning("watchdog: Vite :{p} down — (re)starting", p=_dev_server_port)
                res = await _ensure_vite(_dev_server_port)
                if not res.get("ok"):
                    logger.error("watchdog restart failed: {r}", r=res)
        except Exception as e:  # noqa: BLE001 — the watchdog must never die
            logger.error("vite watchdog iteration error: {e!r}", e=e)
        await asyncio.sleep(10)


@router.post("/dev-server/start")
async def dev_server_start(req: DevServerStartRequest) -> dict[str, Any]:
    """Start (or ADOPT) Vite and mark it DESIRED so the watchdog keeps it alive.
    Idempotent: a reachable server is adopted, never duplicated."""
    global _dev_server_desired
    if not (PHASER_DIR / "package.json").is_file():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "phaser_game/package.json missing",
                "hint": "Run `cd phaser_game && npm install` first.",
            },
        )
    _dev_server_desired = True
    _save_vite_desired(True)
    return await _ensure_vite(req.port)


@router.post("/dev-server/stop")
async def dev_server_stop(req: DevServerStopRequest | None = None) -> dict[str, Any]:
    global _dev_server_proc, _dev_server_desired
    # A USER Stop is respected: clear `desired` so the watchdog leaves it down and
    # the choice survives a restart. A programmatic/transient stop (no body, or
    # user_initiated=False — the inner Claude, a playtest cleanup) does NOT touch
    # `desired`, so the watchdog brings the game back: an internal action must
    # never make the game vanish from the Phaser Game tab.
    if req and req.user_initiated:
        _dev_server_desired = False
        _save_vite_desired(False)
    if not _dev_server_proc or _dev_server_proc.poll() is not None:
        # We don't hold the handle, but an orphan from a previous backend may
        # still be serving — reap it so "stop" actually stops the game.
        await asyncio.to_thread(_kill_port_holder, _dev_server_port)
        return {"ok": True, "was_running": False}
    pid = _dev_server_proc.pid
    try:
        if os.name == "nt":
            _dev_server_proc.send_signal(signal.CTRL_BREAK_EVENT)
            try:
                _dev_server_proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                _dev_server_proc.kill()
        else:
            _dev_server_proc.terminate()
            try:
                _dev_server_proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                _dev_server_proc.kill()
    finally:
        _dev_server_proc = None
    return {"ok": True, "killed_pid": pid}


@router.get("/dev-server/status")
async def dev_server_status() -> dict[str, Any]:
    # Backend-managed dev-server (we spawned it via POST /dev-server/start)
    if _dev_server_proc and _dev_server_proc.poll() is None:
        uptime = time.time() - _dev_server_started_at
        return {
            "running": True,
            "pid": _dev_server_proc.pid,
            "port": _dev_server_port,
            "uptime_s": round(uptime, 1),
            "managed_by_backend": True,
        }
    # Fall back to HTTP probe — user may have started Vite externally
    # (`cd phaser_game && npm run dev`) so `_dev_server_proc` is None but
    # Vite is alive. Without this fallback the frontend shows "Phaser offline"
    # even though playtest works fine.
    url = f"http://127.0.0.1:{_dev_server_port}/"
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(url)
            if r.status_code < 500:
                return {
                    "running": True,
                    "pid": None,
                    "port": _dev_server_port,
                    "uptime_s": None,
                    "managed_by_backend": False,
                    "detected_via": "http_probe",
                }
    except (httpx.RequestError, OSError):
        pass
    return {"running": False}


# ---------------------------------------------------------------------------
# Playwright-driven screenshot + composition-check
# ---------------------------------------------------------------------------


class ScreenshotRequest(BaseModel):
    level_id: str | None = None  # if None, captures current page
    width: int = 1280
    height: int = 720
    wait_selector: str | None = "canvas"
    wait_timeout_ms: int = 5000
    extra_wait_ms: int = 500  # let the scene settle (animations, physics)


@router.post("/screenshot")
@_proactor_endpoint
async def phaser_screenshot(req: ScreenshotRequest) -> dict[str, Any]:
    """Drive headless Chromium via Playwright, screenshot the Phaser canvas,
    persist to `public_files/screenshots/` and return absolute path +
    `claude_next_step` directive (HARDEN-1 pattern).
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "playwright_not_installed",
                "hint": "uv add playwright && uv run playwright install chromium",
                "msg": str(e),
            },
        ) from None

    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    url = f"http://127.0.0.1:{_dev_server_port}/"
    if req.level_id:
        url += f"?level={req.level_id}"

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%f")
    out_path = SCREENSHOTS_DIR / f"phaser_{stamp}.png"

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            ctx = await browser.new_context(viewport={"width": req.width, "height": req.height})
            page = await ctx.new_page()
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=10000)
                if req.wait_selector:
                    await page.wait_for_selector(
                        req.wait_selector, timeout=req.wait_timeout_ms
                    )
                if req.extra_wait_ms > 0:
                    await page.wait_for_timeout(req.extra_wait_ms)
                await page.screenshot(path=str(out_path), full_page=False)
            finally:
                await ctx.close()
        finally:
            await browser.close()

    if not out_path.is_file():
        raise HTTPException(status_code=500, detail="screenshot save failed")

    return {
        "ok": True,
        "persisted_path": str(out_path.resolve()),
        "served_url": f"/files/screenshots/{out_path.name}",
        "url_captured": url,
        "size_bytes": out_path.stat().st_size,
        "claude_next_step": (
            "MANDATORY: before drawing any conclusion about what is or isn't "
            "in this screenshot, call Read on the persisted_path. That loads "
            "the PNG as multimodal vision input. Text descriptions from the "
            "game's JS state are NOT sufficient — you are a vision-capable "
            "model. If Read returns successfully, restate in 1-2 sentences "
            "what you ACTUALLY see vs what you expected (HARDEN-7 reflective "
            "check). If the image shows a defect inconsistent with what you "
            "just claimed to build, STOP and fix it before declaring "
            "anything 'done'."
        ),
    }


class CompositionAssertion(BaseModel):
    """Deterministic relationship check against the live Phaser scene-graph.

    kind:
      - "exists"          : object with given name exists in scene
      - "child_of"        : a.parentContainer === b
      - "near"            : distance(a, b) <= tolerance
      - "above"           : a.y < b.y  (with optional gap)
      - "below"           : a.y > b.y
      - "left_of"         : a.x < b.x
      - "right_of"        : a.x > b.x
      - "within_camera"   : object is inside camera viewport bounds
      - "alpha_eq"        : abs(a.alpha - expected) <= tolerance
      - "scale_eq"        : abs(a.scaleX - expected) <= tolerance
    """
    kind: Literal[
        "exists", "child_of", "near", "above", "below",
        "left_of", "right_of", "within_camera", "alpha_eq", "scale_eq",
    ]
    a: str
    b: str = ""
    tolerance: float = 0.5
    expected: float = 1.0
    label: str = ""


class CompositionCheckRequest(BaseModel):
    assertions: list[CompositionAssertion]
    level_id: str | None = None


@router.post("/composition-check")
@_proactor_endpoint
async def composition_check(req: CompositionCheckRequest) -> dict[str, Any]:
    """Run deterministic scene-graph assertions against the live Phaser game.

    Uses Playwright `page.evaluate` to read object positions/parents from
    the Phaser scene. NO LLM in loop. Either the cat's parent is the
    slingshot or it isn't.

    Game-side contract: every named object MUST have `obj.name` set OR be
    findable via `scene.children.getByName(name)`. The Phaser builder
    enforces this when generating scenes from YAML.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail={"error": "playwright_not_installed"},
        ) from None

    url = f"http://127.0.0.1:{_dev_server_port}/"
    if req.level_id:
        url += f"?level={req.level_id}"

    assertions_payload = [a.model_dump() for a in req.assertions]

    js = """
    (assertionsJSON) => {
      const assertions = JSON.parse(assertionsJSON);
      const game = window.game;
      if (!game) return { error: "window.game not exposed" };
      const scenes = game.scene.scenes.filter(s => s.scene.isActive());
      if (!scenes.length) return { error: "no active scene" };
      const scene = scenes[0];

      const findObj = (name) => {
        // First try scene.children registry by name
        let obj = scene.children.getByName(name);
        if (obj) return obj;
        // Then registered alias via scene.data
        if (scene.data && scene.data.get && scene.data.get(name)) {
          return scene.data.get(name);
        }
        // Then search recursively into containers
        const stack = scene.children.list.slice();
        while (stack.length) {
          const o = stack.pop();
          if (o && o.name === name) return o;
          if (o && o.list) stack.push(...o.list);
        }
        return null;
      };

      const worldBox = (o) => {
        if (!o) return null;
        const w = o.displayWidth || o.width || 1;
        const h = o.displayHeight || o.height || 1;
        const ox = o.originX !== undefined ? o.originX : 0.5;
        const oy = o.originY !== undefined ? o.originY : 0.5;
        const x = (o.x !== undefined ? o.x : 0) - w * ox;
        const y = (o.y !== undefined ? o.y : 0) - h * oy;
        return { minX: x, minY: y, maxX: x + w, maxY: y + h, cx: x + w / 2, cy: y + h / 2 };
      };

      const cam = scene.cameras.main;
      const camView = cam ? { x: cam.worldView.x, y: cam.worldView.y, w: cam.worldView.width, h: cam.worldView.height } : null;

      const details = [];
      for (const ass of assertions) {
        const a = findObj(ass.a);
        const b = ass.b ? findObj(ass.b) : null;
        const ba = worldBox(a);
        const bb = worldBox(b);
        const detail = {
          kind: ass.kind, a: ass.a, b: ass.b, label: ass.label,
          found_a: !!a, found_b: ass.b ? !!b : true,
          bounds_a: ba, bounds_b: bb,
        };
        if (!a || (ass.b && !b)) {
          detail.pass = false;
          detail.reason = `GameObject not found: ${!a ? "a=" + ass.a : "b=" + ass.b}`;
          details.push(detail);
          continue;
        }
        let ok = false; let reason = "";
        const tol = ass.tolerance ?? 0.5;
        const expected = ass.expected ?? 1.0;
        switch (ass.kind) {
          case "exists":
            ok = !!a; reason = ok ? "found" : "not found";
            break;
          case "child_of":
            ok = a.parentContainer === b || a.parent === b;
            reason = `a.parent=${a.parentContainer ? a.parentContainer.name : "(none)"} expected=${ass.b}`;
            break;
          case "near": {
            const dx = ba.cx - bb.cx, dy = ba.cy - bb.cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            ok = d <= tol; reason = `distance ${d.toFixed(1)}px, tol ${tol}`;
            break;
          }
          case "above":
            ok = ba.maxY <= bb.minY + tol;
            reason = `a.maxY=${ba.maxY.toFixed(1)} vs b.minY=${bb.minY.toFixed(1)} tol=${tol}`;
            break;
          case "below":
            ok = ba.minY >= bb.maxY - tol;
            reason = `a.minY=${ba.minY.toFixed(1)} vs b.maxY=${bb.maxY.toFixed(1)} tol=${tol}`;
            break;
          case "left_of":
            ok = ba.maxX <= bb.minX + tol;
            reason = `a.maxX=${ba.maxX.toFixed(1)} vs b.minX=${bb.minX.toFixed(1)}`;
            break;
          case "right_of":
            ok = ba.minX >= bb.maxX - tol;
            reason = `a.minX=${ba.minX.toFixed(1)} vs b.maxX=${bb.maxX.toFixed(1)}`;
            break;
          case "within_camera":
            if (!camView) { ok = false; reason = "no main camera"; break; }
            ok = ba.cx >= camView.x && ba.cx <= camView.x + camView.w &&
                 ba.cy >= camView.y && ba.cy <= camView.y + camView.h;
            reason = `a center (${ba.cx.toFixed(1)},${ba.cy.toFixed(1)}) vs cam [${camView.x},${camView.y},${camView.w}x${camView.h}]`;
            break;
          case "alpha_eq":
            ok = Math.abs((a.alpha ?? 1) - expected) <= tol;
            reason = `a.alpha=${(a.alpha ?? 1).toFixed(2)} expected=${expected} tol=${tol}`;
            break;
          case "scale_eq":
            ok = Math.abs((a.scaleX ?? 1) - expected) <= tol;
            reason = `a.scaleX=${(a.scaleX ?? 1).toFixed(2)} expected=${expected} tol=${tol}`;
            break;
          default:
            ok = false; reason = `unknown kind ${ass.kind}`;
        }
        detail.pass = ok;
        detail.reason = reason;
        details.push(detail);
      }
      return { details, sceneKey: scene.scene.key };
    }
    """

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            ctx = await browser.new_context()
            page = await ctx.new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_selector("canvas", timeout=5000)
            await page.wait_for_timeout(600)
            result = await page.evaluate(js, json.dumps(assertions_payload))
        finally:
            await browser.close()

    if "error" in result:
        return {
            "pass": False,
            "error": result["error"],
            "blockers": [result["error"]],
            "details": [],
        }
    details = result.get("details", [])
    fails = [d for d in details if not d.get("pass")]
    return {
        "pass": len(fails) == 0,
        "total": len(details),
        "passed": len(details) - len(fails),
        "failed": len(fails),
        "scene_key": result.get("sceneKey"),
        "blockers": [
            f"[{d['kind']}] {d.get('label') or d['a']}"
            f"{(' vs ' + d['b']) if d.get('b') else ''}: {d.get('reason', 'fail')}"
            for d in fails
        ],
        "details": details,
    }


class UICheckRequest(BaseModel):
    level_id: str | None = None
    overlap_frac: float = 0.18  # min overlap (fraction of smaller text) to flag


@router.post("/ui-check")
@_proactor_endpoint
async def ui_check(req: UICheckRequest) -> dict[str, Any]:
    """Deterministic UI-QA — detect Text that OVERLAPS other text or runs
    OFF-SCREEN, via window.__uiCheck() in the live game. NO vision model, no cost.

    Chat-history analysis showed the #1 recurring small failure was overlapping /
    clipped UI text the user had to catch by eye. This catches it programmatically
    so the agent self-iterates BEFORE showing the user. For deep menu states
    (an open Options panel, a pause overlay), the inner Claude runs the SAME
    check via the Playwright-MCP after clicking into that state:
    `browser_evaluate("() => window.__uiCheck()")`.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise HTTPException(status_code=503, detail={"error": "playwright_not_installed"}) from None

    url = f"http://127.0.0.1:{_dev_server_port}/"
    if req.level_id:
        url += f"?level={req.level_id}"

    js = (
        "(frac) => (window.__uiCheck "
        "? window.__uiCheck({ overlapFrac: frac }) "
        ": { error: '__uiCheck not installed - rebuild phaser_game (main.ts installUiCheck)' })"
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            ctx = await browser.new_context()
            page = await ctx.new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_selector("canvas", timeout=5000)
            await page.wait_for_timeout(800)  # let the scene + UI settle
            result = await page.evaluate(js, req.overlap_frac)
        finally:
            await browser.close()

    if isinstance(result, dict) and "error" in result:
        return {"pass": False, "error": result["error"], "blockers": [result["error"]]}

    offscreen = result.get("offscreen", [])
    overlaps = result.get("overlaps", [])
    screen = result.get("screen", {})
    blockers = [
        f"OFF-SCREEN text '{o['text']}' at ({o['x']},{o['y']}) {o['w']}x{o['h']} "
        f"(canvas {screen.get('w')}x{screen.get('h')})"
        for o in offscreen
    ] + [
        f"OVERLAP: '{o['a']}' overlaps '{o['b']}' ({int(o['frac'] * 100)}% of the smaller)"
        for o in overlaps
    ]
    ok = result.get("ok", len(blockers) == 0)
    return {
        "pass": ok,
        "text_count": result.get("textCount", 0),
        "screen": screen,
        "offscreen": offscreen,
        "overlaps": overlaps,
        "blockers": blockers,
        "claude_next_step": (
            "UI is clean — no overlapping or off-screen text."
            if ok else
            "FIX every overlap/off-screen item above (reposition or resize the "
            "text or its panel), then re-run /api/phaser/ui-check BEFORE telling "
            "the user the UI is done."
        ),
    }


# ---------------------------------------------------------------------------
# Playtest — load level, screenshot at intervals, return verdict
# ---------------------------------------------------------------------------


class PlaytestRequest(BaseModel):
    level_id: str = "level_01"
    duration_s: float = 8.0  # raised from 5 — more time to capture full launch + settle
    # NEW (2026-05-27): 200ms cadence by default = 40 frames per 8s playtest.
    # Lets the agent see motion, animation, trajectory — static screenshots
    # missed all dynamic bugs (rotation 360, drift left, comet trail).
    frame_interval_ms: int = 200
    # Capture WebM video of the whole session via Playwright recordVideo.
    # Gemini accepts video/webm natively — much cheaper than 40 PNG calls.
    capture_video: bool = True
    # Capture state trace (positions, velocities, rotation per frame) from
    # window.__phaserTrace exposed by AngryCatLevel. Algorithmic anomaly
    # detection runs on this to catch dynamic bugs BEFORE any vision LLM
    # call (Voyager-pattern state introspection).
    capture_state_trace: bool = True
    capture_console: bool = True
    # NEW: actually play the game. For N > 0 the playtest simulates that
    # many slingshot drag-release cycles via Playwright mouse events,
    # aiming each shot at a still-alive enemy. verdict_pass then requires
    # at least 1 enemy destroyed, not just "page rendered cleanly".
    simulate_shots: int = 0
    shot_pull_distance: float = 150.0  # pixels of pull-back from anchor
    # Legacy override — if set, frame_interval_ms is computed from this.
    screenshot_interval_s: float | None = None
    # Trim head/tail of state trace by N frames each side in returned JSON
    # to keep response compact (full trace stays on disk).
    trace_downsample_factor: int = 3  # keep every Nth frame in response


# ---------------------------------------------------------------------------
# Dynamic-anomaly detection (Voyager-pattern — runs BEFORE vision LLM)
# ---------------------------------------------------------------------------

def _detect_dynamic_anomalies(
    trace: list[dict[str, Any]],
    collisions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Algorithmic pass over `window.__phaserTrace` to catch physics/animation
    bugs that single-frame vision can't see. Returns:
      { pass: bool, anomalies: [{type, severity, t_ms, description}], stats: {...} }

    Detected patterns (each maps directly to a user-visible complaint):
      - rotation_overflow → "koty obracają się 360 mid-flight"
      - lateral_drift     → "koty lewitują w lewo po upadku"
      - hover_after_settle→ "kot zawiesza się w powietrzu" (false-settle bug)
      - physics_spike     → "fizyka leży" (teleport / jump)
      - no_launch         → cat never gained velocity (slingshot broken)
      - never_grounded    → cat never touched ground in trace
    """
    if not trace or len(trace) < 5:
        return {"pass": False, "anomalies": [{"type": "empty_trace",
                "severity": "critical", "t_ms": 0,
                "description": "No trace frames captured — game probably crashed at load."}],
                "stats": {}}

    anomalies: list[dict[str, Any]] = []

    # 1. Did the cat ever actually launch? (vmag > 200 at some point post-launched=true)
    launched_frames = [f for f in trace if f.get("launched")]
    max_vmag_post_launch = max(
        ((f["vx"] ** 2 + f["vy"] ** 2) ** 0.5 for f in launched_frames),
        default=0.0,
    )
    if launched_frames and max_vmag_post_launch < 100:
        anomalies.append({
            "type": "no_launch", "severity": "critical",
            "t_ms": launched_frames[0]["t"],
            "description": f"Cat 'launched=true' but max velocity only {max_vmag_post_launch:.0f}px/s "
                           f"(expected ≥500). Slingshot release impulse broken.",
        })

    # 2. Rotation overflow — angular velocity spinning indefinitely.
    # Phaser's body.angularVelocity is DEG/sec (not rad/s) — thresholds are
    # in deg/s. 458 deg/s ≈ 8 rad/s (>1.3 rotations/s); 286 deg/s ≈ 5 rad/s.
    # Cat launches at 280-380 deg/s and SHOULD decay via angularDrag within ~1s.
    for i in range(1, len(trace)):
        if not trace[i].get("launched"):
            continue
        if abs(trace[i]["av"]) > 458.0:  # deg/s sustained = real spin overflow
            # Check if it stayed high for > 600ms across same cat instance
            window = trace[max(0, i-3):i+1]
            same_cat = all(w.get("cat") == trace[i].get("cat") for w in window)
            if same_cat and all(abs(w["av"]) > 286.0 for w in window):
                anomalies.append({
                    "type": "rotation_overflow", "severity": "major",
                    "t_ms": trace[i]["t"],
                    "description": f"Cat angular velocity sustained at {trace[i]['av']:.1f} deg/s for >600ms "
                                   "(spinning never decays). Missing angularDrag.",
                })
                break  # one report per playtest

    # 3. Lateral drift — |vx| stays > 30 long after launch (no collision)
    # Look at last 25% of trace (presumably post-settle phase)
    tail = trace[int(len(trace) * 0.75):]
    if tail:
        avg_abs_vx = sum(abs(f["vx"]) for f in tail) / len(tail)
        if avg_abs_vx > 30 and all(not f.get("launched", False) is False for f in tail):
            anomalies.append({
                "type": "lateral_drift", "severity": "major",
                "t_ms": tail[0]["t"],
                "description": f"After settle, cat |vx| averages {avg_abs_vx:.0f}px/s (expected <10). "
                               "Force-settle timer probably leaves residual velocity ('lewituje w lewo').",
            })

    # 4. Hover after settle — cat OFF ground but velocity ~0
    GROUND_Y_THRESHOLD = 600  # below this y = off-ground (level dependent)
    for i in range(len(trace) - 5, len(trace)):
        if i < 0: continue
        f = trace[i]
        vmag = (f["vx"] ** 2 + f["vy"] ** 2) ** 0.5
        if f["y"] < GROUND_Y_THRESHOLD and vmag < 5 and f.get("launched"):
            anomalies.append({
                "type": "hover_after_settle", "severity": "major",
                "t_ms": f["t"],
                "description": f"Cat at y={f['y']:.0f} (off-ground) but |v|={vmag:.1f}px/s near zero. "
                               "Cat is FLOATING (gravityScale wrong or sleep applied prematurely).",
            })
            break

    # 5. Physics spikes — sudden velocity jumps without collision logged.
    # Skip frames where the tracked cat INSTANCE changed (shot N → shot N+1):
    # the recorder follows currentProjectile which switches between cats, so
    # the "teleport" is just the next cat spawning at the slingshot anchor.
    coll_times = {c["t"] for c in collisions}
    for i in range(1, len(trace)):
        if trace[i].get("cat") != trace[i-1].get("cat"):
            continue  # different cat instance — not a teleport
        dvy = trace[i]["vy"] - trace[i-1]["vy"]
        dvx = trace[i]["vx"] - trace[i-1]["vx"]
        if abs(dvy) > 400 or abs(dvx) > 400:
            t = trace[i]["t"]
            # Was there a collision within 100ms?
            nearby_coll = any(abs(ct - t) < 100 for ct in coll_times)
            if not nearby_coll:
                anomalies.append({
                    "type": "physics_spike", "severity": "minor",
                    "t_ms": t,
                    "description": f"Velocity jump dv=({dvx:.0f},{dvy:.0f}) at t={t}ms without collision. "
                                   "Possible teleport or physics step glitch.",
                })
                break

    # Stats summary
    stats = {
        "trace_length": len(trace),
        "collision_count": len(collisions),
        "damaging_hits": sum(1 for c in collisions if c.get("damaged")),
        "max_velocity_pixels_per_sec": round(max_vmag_post_launch, 1),
        "trace_duration_ms": trace[-1]["t"] - trace[0]["t"] if trace else 0,
    }

    return {
        "pass": len([a for a in anomalies if a["severity"] in ("critical", "major")]) == 0,
        "anomalies": anomalies,
        "stats": stats,
    }


def _compose_frame_grid(
    frame_paths: list[Path],
    output_path: Path,
    cols: int = 4,
    rows: int = 4,
    frame_interval_ms: int = 200,
) -> Path | None:
    """PIL composite: arrange up to cols*rows frames into a single image
    with timestamp burned-in on each cell. Drastically cheaper for vision
    LLM than sending N separate frames (16× fewer tokens).

    Returns saved path on success, None if PIL missing or no frames.
    """
    if not frame_paths:
        return None
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        logger.warning("PIL not available — skipping frame grid composite")
        return None
    n = min(len(frame_paths), cols * rows)
    if n == 0:
        return None
    # Open first frame to compute cell size
    first = Image.open(str(frame_paths[0]))
    W, H = first.size
    cw, ch = W // cols, H // rows
    grid = Image.new("RGB", (W, H), color=(20, 20, 28))
    try:
        font = ImageFont.truetype("arial.ttf", 18)
    except (OSError, IOError):
        font = ImageFont.load_default()
    for i in range(n):
        try:
            im = Image.open(str(frame_paths[i])).convert("RGB").resize((cw, ch))
        except (OSError, IOError, Image.UnidentifiedImageError):
            continue
        cx = (i % cols) * cw
        cy = (i // cols) * ch
        grid.paste(im, (cx, cy))
        # Burn timestamp + frame index
        d = ImageDraw.Draw(grid)
        label = f"#{i+1:02d}  t={i*frame_interval_ms}ms"
        # Black outline for legibility on any bg
        for ox, oy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            d.text((cx + 6 + ox, cy + 4 + oy), label, fill=(0, 0, 0), font=font)
        d.text((cx + 6, cy + 4), label, fill=(80, 255, 80), font=font)
    grid.save(str(output_path), quality=85)
    return output_path


def _plot_trajectory_overlay(
    base_frame: Path,
    trace: list[dict[str, Any]],
    output_path: Path,
) -> Path | None:
    """Draw cat-flight polyline + numbered waypoints over the final frame.
    Set-of-Mark style: lets the vision LLM see WHERE the cat went, not just
    where it ENDED. One image, but encodes the whole flight path.
    """
    if not trace:
        return None
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None
    try:
        im = Image.open(str(base_frame)).convert("RGB")
    except (OSError, IOError, Image.UnidentifiedImageError):
        return None
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except (OSError, IOError):
        font = ImageFont.load_default()
    # Only plot frames where cat was launched and moving
    moving = [f for f in trace if f.get("launched") and (f["vx"] ** 2 + f["vy"] ** 2) > 100]
    if len(moving) < 2:
        return None
    pts = [(int(f["x"]), int(f["y"])) for f in moving]
    # Red polyline showing path
    if len(pts) >= 2:
        d.line(pts, fill=(255, 50, 50), width=3)
    # Numbered yellow dots every 5 points
    for i in range(0, len(pts), 5):
        x, y = pts[i]
        d.ellipse((x - 6, y - 6, x + 6, y + 6), fill=(255, 220, 0), outline=(0, 0, 0))
        d.text((x + 8, y - 8), str(i // 5), fill=(255, 255, 255), font=font)
    im.save(str(output_path), quality=85)
    return output_path


@router.post("/playtest")
@_proactor_endpoint
async def phaser_playtest(req: PlaytestRequest) -> dict[str, Any]:
    """Run a headless playtest of the given level. Returns a structured
    verdict the reward-hack guard can consume.

    With simulate_shots > 0 the bot actually drag-pulls-releases the cat
    toward each alive enemy in turn (Playwright mouse.down/move/up). The
    final verdict_pass then includes "enemies_killed > 0" — a real proof
    that gameplay works, not just "page rendered".
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise HTTPException(status_code=503, detail="playwright not installed") from None

    # Single-flight: refuse to run concurrent playtest (each spawns Chromium
    # = 500MB+ RAM). If a second call comes in while first is mid-flight,
    # wait or reject. Here we WAIT (lock acquires when prior finishes).
    lock = _get_playtest_lock()
    if lock.locked():
        logger.info("playtest already running — queueing this call")
    await lock.acquire()
    try:
        return await _phaser_playtest_impl(req)
    finally:
        lock.release()


async def _phaser_playtest_impl(req: PlaytestRequest) -> dict[str, Any]:
    """Inner playtest implementation (gated by single-flight lock above)."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise HTTPException(status_code=503, detail="playwright not installed") from None

    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    VIDEOS_DIR = SCREENSHOTS_DIR.parent / "playtest_videos"
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%f")
    url = f"http://127.0.0.1:{_dev_server_port}/?level={req.level_id}"

    # Honour legacy `screenshot_interval_s` if caller still uses it.
    frame_interval_ms = req.frame_interval_ms
    if req.screenshot_interval_s is not None and req.screenshot_interval_s > 0:
        frame_interval_ms = int(req.screenshot_interval_s * 1000)

    frames: list[str] = []
    console_log: list[dict[str, str]] = []
    js_errors: list[str] = []
    shot_log: list[dict[str, Any]] = []
    initial_enemies = 0
    state_trace: list[dict[str, Any]] = []
    collision_log: list[dict[str, Any]] = []
    video_path: str | None = None

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            ctx_kwargs: dict[str, Any] = {"viewport": {"width": 1280, "height": 720}}
            if req.capture_video:
                ctx_kwargs["record_video_dir"] = str(VIDEOS_DIR)
                ctx_kwargs["record_video_size"] = {"width": 1280, "height": 720}
            ctx = await browser.new_context(**ctx_kwargs)
            page = await ctx.new_page()
            if req.capture_console:
                page.on("console", lambda m: console_log.append({"type": m.type, "text": m.text}))
                page.on("pageerror", lambda e: js_errors.append(str(e)))
            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_selector("canvas", timeout=5000)
            # Settle: let Phaser BootScene → AngryCatLevel transition complete
            await asyncio.sleep(1.5)

            # Capture initial enemy count for "did the player actually kill anything"
            try:
                initial_enemies = await page.evaluate(
                    "() => { const g = window.game; if (!g) return 0;"
                    " const s = g.scene.scenes.find(s => s.scene.isActive());"
                    " return s?.enemiesAlive ?? 0; }"
                )
            except Exception:  # noqa: BLE001
                initial_enemies = 0

            # --- Optional: simulate gameplay --------------------------------
            if req.simulate_shots > 0:
                # Find canvas bounding box so mouse coords map to game coords.
                game_to_screen = await _canvas_to_game_mapper(page)
                for shot_i in range(req.simulate_shots):
                    # Read current Cat + alive enemy positions
                    snap = await page.evaluate(
                        "() => { const g = window.game; const s = g.scene.scenes.find(s => s.scene.isActive());"
                        " if (!s || !s.currentProjectile) return null;"
                        " const cat = s.currentProjectile;"
                        " const enemies = [];"
                        " s.objectsByName.forEach((o, name) => {"
                        "   if (o.active && o.getData && o.getData('spec')?.destroyOnHit)"
                        "     enemies.push({ name, x: o.x, y: o.y });"
                        " });"
                        " return { cat: { x: cat.x, y: cat.y }, shots: s.shotsRemaining,"
                        " score: s.score, enemiesAlive: s.enemiesAlive, enemies, launched: s.launched }; }"
                    )
                    if not snap or not snap.get("cat") or snap.get("launched"):
                        await asyncio.sleep(1.0)
                        continue
                    if not snap["enemies"]:
                        shot_log.append({"shot": shot_i + 1, "skip": "no_enemies"})
                        break
                    cat = snap["cat"]
                    # Pick closest enemy to slingshot in straight-line distance
                    target = min(snap["enemies"], key=lambda e: (e["x"] - cat["x"]) ** 2 + (e["y"] - cat["y"]) ** 2)
                    # Pull-back direction = opposite of target direction
                    dx = target["x"] - cat["x"]
                    dy = target["y"] - cat["y"]
                    norm = (dx * dx + dy * dy) ** 0.5 or 1.0
                    pull = req.shot_pull_distance
                    drag_dx = -dx * pull / norm
                    drag_dy = -dy * pull / norm
                    # Convert game coords to screen coords for mouse events
                    sx1, sy1 = game_to_screen(cat["x"], cat["y"])
                    sx2, sy2 = game_to_screen(cat["x"] + drag_dx, cat["y"] + drag_dy)
                    # Phaser's input.setDraggable consumes pointerdown/move/up on the sprite
                    await page.mouse.move(sx1, sy1)
                    await page.mouse.down()
                    # Smooth drag in 8 steps so Phaser's drag handler fires
                    steps = 8
                    for k in range(1, steps + 1):
                        ix = sx1 + (sx2 - sx1) * k / steps
                        iy = sy1 + (sy2 - sy1) * k / steps
                        await page.mouse.move(ix, iy, steps=2)
                        await asyncio.sleep(0.03)
                    await page.mouse.up()
                    shot_log.append({
                        "shot": shot_i + 1, "target": target["name"],
                        "pull_game": [round(drag_dx, 1), round(drag_dy, 1)],
                    })
                    # Capture mid-flight screenshot + wait for reload (~3s)
                    await asyncio.sleep(0.6)
                    mid_fp = SCREENSHOTS_DIR / f"playtest_{stamp}_shot{shot_i+1:02d}_mid.png"
                    await page.screenshot(path=str(mid_fp), full_page=False)
                    frames.append(str(mid_fp.resolve()))
                    await asyncio.sleep(2.6)  # let physics settle + reload next projectile

            # --- High-cadence capture: 200ms frame interval --------------------
            # 40 frames per 8s playtest. Each iteration:
            #   (a) screenshot to PNG
            #   (b) optional state snapshot via window.__phaserScene
            # Loop is deadline-based so frame_interval_ms is reliable even
            # under WS-roundtrip overhead.
            interval_s = frame_interval_ms / 1000.0
            t0 = time.time()
            next_shot_ts = t0
            n = 0
            while time.time() - t0 < req.duration_s:
                if time.time() >= next_shot_ts:
                    n += 1
                    fp = SCREENSHOTS_DIR / f"playtest_{stamp}_f{n:03d}.png"
                    await page.screenshot(path=str(fp), full_page=False)
                    frames.append(str(fp.resolve()))
                    next_shot_ts += interval_s
                await asyncio.sleep(0.02)  # 50Hz wake — much finer than interval

            # --- Pull state trace + collision log from page memory -------------
            if req.capture_state_trace:
                try:
                    state_trace = await page.evaluate(
                        "() => (window.__phaserTrace || []).slice()"
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("trace dump failed: {e}", e=e)
                    state_trace = []
                try:
                    collision_log = await page.evaluate(
                        "() => (window.__phaserCollisions || []).slice()"
                    )
                except Exception:  # noqa: BLE001
                    collision_log = []

            try:
                state = await page.evaluate(
                    "() => { const g = window.game; if (!g) return null;"
                    " const s = g.scene.scenes.find(s => s.scene.isActive());"
                    " if (!s) return null; return { score: s.score ?? null,"
                    " shotsRemaining: s.shotsRemaining ?? null,"
                    " enemiesAlive: s.enemiesAlive ?? null,"
                    " win: s.win ?? null, lose: s.lose ?? null,"
                    " sceneKey: s.scene.key }; }"
                )
            except Exception:  # noqa: BLE001
                state = None

            # --- Finalize video BEFORE closing browser -----------------------
            # Playwright requires page.close() (or ctx.close()) before the
            # WebM file is flushed; we grab a handle now and resolve path()
            # after ctx.close(). browser.close() will be called in finally.
            video_handle = page.video if req.capture_video else None
            if video_handle is not None:
                try:
                    await page.close()
                    await ctx.close()
                    raw_video_path = await video_handle.path()
                    # Rename to a deterministic name so callers can predict it
                    if raw_video_path:
                        target = VIDEOS_DIR / f"playtest_{stamp}.webm"
                        try:
                            Path(raw_video_path).rename(target)
                            video_path = str(target.resolve())
                        except OSError:
                            # Rename across drives or permission issue — keep raw path
                            video_path = str(Path(raw_video_path).resolve())
                except Exception as e:  # noqa: BLE001
                    logger.warning("video finalize failed: {e}", e=e)
                    video_path = None
        finally:
            await _close_browser_safely(browser)

    error_count = sum(1 for c in console_log if c["type"] == "error") + len(js_errors)
    # Scenes without an "enemies" concept (e.g. volleyball) report enemiesAlive=None;
    # treat that as "unchanged" so the playtest doesn't crash on int - None.
    alive = state.get("enemiesAlive") if state else None
    if alive is None:
        alive = initial_enemies
    enemies_killed = max(0, initial_enemies - alive)

    # --- Post-capture: algorithmic anomaly detection + visual composites ----
    dynamic_verdict = _detect_dynamic_anomalies(state_trace, collision_log)

    # 4×4 grid of first 16 frames (one image vs 16) — sent to vision LLM instead of N PNGs
    grid_path_str: str | None = None
    if frames:
        grid_out = SCREENSHOTS_DIR / f"playtest_{stamp}_grid.jpg"
        grid_result = _compose_frame_grid(
            [Path(f) for f in frames[:16]], grid_out, frame_interval_ms=frame_interval_ms,
        )
        if grid_result:
            grid_path_str = str(grid_result.resolve())

    # Trajectory overlay on final frame — shows whole cat-flight as polyline
    trajectory_path_str: str | None = None
    if frames and state_trace:
        traj_out = SCREENSHOTS_DIR / f"playtest_{stamp}_trajectory.jpg"
        traj_result = _plot_trajectory_overlay(Path(frames[-1]), state_trace, traj_out)
        if traj_result:
            trajectory_path_str = str(traj_result.resolve())

    # Down-sample trace for response payload (full trace stays on disk in video)
    trace_sample = state_trace[::max(1, req.trace_downsample_factor)] if state_trace else []

    # Verdict: now ALSO requires dynamic_verdict.pass (no rotation overflow, no drift, no spike)
    if req.simulate_shots > 0:
        verdict_pass = error_count == 0 and enemies_killed >= 1 and dynamic_verdict["pass"]
    else:
        verdict_pass = error_count == 0 and len(frames) > 0 and dynamic_verdict["pass"]
    return {
        "verdict_pass": verdict_pass,
        "level_id": req.level_id,
        "duration_s": req.duration_s,
        "frame_interval_ms": frame_interval_ms,
        "frames": frames,
        "frame_count": len(frames),
        "video_path": video_path,
        "grid_path": grid_path_str,
        "trajectory_path": trajectory_path_str,
        "console_error_count": error_count,
        "console_errors": [c for c in console_log if c["type"] == "error"][:20],
        "js_errors": js_errors[:10],
        "final_state": state,
        "initial_enemies": initial_enemies,
        "enemies_killed": enemies_killed,
        "simulate_shots": req.simulate_shots,
        "shot_log": shot_log,
        "state_trace": trace_sample,
        "state_trace_full_count": len(state_trace),
        "collision_log": collision_log[-30:],  # last 30 collisions
        "dynamic_verdict": dynamic_verdict,
        "ts": time.time(),
    }


# ---------------------------------------------------------------------------
# /drive — genre-agnostic active-play harness (Pillar 2)
# ---------------------------------------------------------------------------
# Executes a TIMED INPUT SCRIPT (keyboard + mouse) against the live game via
# Playwright, samples window.__gameState() every frame, and (optionally)
# evaluates control-responsiveness assertions over the resulting state
# timeline. This is the genre-neutral analogue of /playtest's slingshot bot +
# _detect_dynamic_anomalies: it works for platformer / RPG / any genre that
# implements the generic gameState.ts contract.


class DriveInput(BaseModel):
    """One timed input event in a drive script. `at_ms` is the offset from
    drive start at which to fire it; events execute in `at_ms` order.

    type:
      - "keydown" : press `key` and hold (release later via "keyup")
      - "keyup"   : release `key`
      - "hold"    : press `key`, wait `hold_ms`, release (one-shot directional)
      - "tap"     : press+release `key` quickly (hold_ms defaults to ~40ms)
      - "click"   : mouse down+up at game-space (`x`,`y`)
      - "drag"    : mouse down at `from`, move to `to`, release (slingshot/RTS)

    `key` uses Playwright key names (e.g. "ArrowRight", "Space", "a", "Enter").
    `x`,`y` / `from` / `to` are GAME-SPACE coords (mapped through the canvas box).
    """
    at_ms: int = 0
    type: Literal["keydown", "keyup", "hold", "tap", "click", "drag"]
    key: str | None = None
    x: float | None = None
    y: float | None = None
    from_: tuple[float, float] | None = Field(default=None, alias="from")
    to: tuple[float, float] | None = None
    hold_ms: int = 0

    model_config = {"populate_by_name": True}


# Built-in assertion vocabulary computed over the state_timeline (a list of
# window.__gameState() snapshots). Keys are matched exactly against
# DriveAssert.expect; `predicate_js` is the escape hatch (evaluated in-browser).
_DRIVE_ASSERT_VOCAB = (
    "player.x_increased",
    "player.x_decreased",
    "player.y_increased",
    "player.y_decreased",
    "player.y_rose_then_fell",
    "player.moved",
    "score_increased",
    "score_decreased",
    "hp_increased",
    "hp_decreased",
    "scene.win",
    "scene.lose",
    "no_js_errors",
    "predicate_js",
)


class DriveAssert(BaseModel):
    """A control-responsiveness assertion. `expect` is one of the built-in
    vocabulary strings (see _DRIVE_ASSERT_VOCAB) OR the literal "predicate_js",
    in which case `predicate_js` holds a JS expression evaluated in the browser
    over the `samples` array (the full state timeline)."""
    name: str
    expect: str
    predicate_js: str | None = None
    # margin for numeric "increased"/"decreased"/"moved" comparisons (px or pts)
    margin: float = 1.0


class DriveRequest(BaseModel):
    level_id: str = "level_01"
    duration_s: float = 6.0
    inputs: list[DriveInput] = Field(default_factory=list)
    asserts: list[DriveAssert] = Field(default_factory=list)
    # Frame cadence: sample __gameState() + screenshot every N ms.
    frame_interval_ms: int = 200
    # Settle time after canvas appears before the input script starts.
    settle_ms: int = 1200
    capture_console: bool = True
    # Compose first 16 frames into one grid JPEG (cheap vision input).
    compose_grid: bool = True


def _player_series(timeline: list[dict[str, Any]], axis: str) -> list[float]:
    """Extract a numeric series for player.<axis> from non-null player frames."""
    out: list[float] = []
    for s in timeline:
        p = s.get("player")
        if isinstance(p, dict) and isinstance(p.get(axis), (int, float)):
            out.append(float(p[axis]))
    return out


def _scalar_series(timeline: list[dict[str, Any]], key: str) -> list[float]:
    """Extract a top-level numeric series (e.g. score, hp) from the timeline."""
    out: list[float] = []
    for s in timeline:
        v = s.get(key)
        if isinstance(v, (int, float)):
            out.append(float(v))
    return out


def _eval_builtin_assert(
    expect: str,
    margin: float,
    timeline: list[dict[str, Any]],
    js_error_count: int,
) -> dict[str, Any]:
    """Compute a single built-in assertion over the state timeline. Returns
    {pass, evidence}. Note: in Phaser, screen-Y grows DOWNWARD, so a JUMP is
    y DECREASING then INCREASING — `player.y_rose_then_fell` models exactly
    that (rose visually = y went down, fell = y came back up)."""
    if expect in ("player.x_increased", "player.x_decreased", "player.moved"):
        xs = _player_series(timeline, "x")
        ys = _player_series(timeline, "y")
        if not xs:
            return {"pass": False, "evidence": "no player.x samples in timeline"}
        if expect == "player.moved":
            dx = xs[-1] - xs[0]
            dy = (ys[-1] - ys[0]) if ys else 0.0
            dist = (dx * dx + dy * dy) ** 0.5
            return {"pass": dist > margin,
                    "evidence": f"net displacement {dist:.1f}px (margin {margin})"}
        delta = xs[-1] - xs[0]
        if expect == "player.x_increased":
            return {"pass": delta > margin,
                    "evidence": f"player.x {xs[0]:.1f}→{xs[-1]:.1f} (Δ{delta:+.1f}, margin {margin})"}
        return {"pass": delta < -margin,
                "evidence": f"player.x {xs[0]:.1f}→{xs[-1]:.1f} (Δ{delta:+.1f}, margin {margin})"}

    if expect in ("player.y_increased", "player.y_decreased"):
        ys = _player_series(timeline, "y")
        if not ys:
            return {"pass": False, "evidence": "no player.y samples in timeline"}
        delta = ys[-1] - ys[0]
        if expect == "player.y_increased":
            return {"pass": delta > margin,
                    "evidence": f"player.y {ys[0]:.1f}→{ys[-1]:.1f} (Δ{delta:+.1f}, margin {margin})"}
        return {"pass": delta < -margin,
                "evidence": f"player.y {ys[0]:.1f}→{ys[-1]:.1f} (Δ{delta:+.1f}, margin {margin})"}

    if expect == "player.y_rose_then_fell":
        ys = _player_series(timeline, "y")
        if len(ys) < 3:
            return {"pass": False, "evidence": f"need >=3 player.y samples, got {len(ys)}"}
        start = ys[0]
        min_y = min(ys)              # apex (smallest y = highest on screen)
        min_i = ys.index(min_y)
        rose = (start - min_y) > margin                 # went up from start
        fell_back = min_i < len(ys) - 1 and (ys[-1] - min_y) > margin  # came back down after apex
        ok = rose and fell_back
        return {"pass": ok,
                "evidence": f"start y={start:.1f}, apex y={min_y:.1f}@i{min_i}, end y={ys[-1]:.1f} "
                            f"(rose={rose}, fell_back={fell_back}, margin {margin})"}

    if expect in ("score_increased", "score_decreased"):
        sc = _scalar_series(timeline, "score")
        if not sc:
            return {"pass": False, "evidence": "no score samples in timeline"}
        delta = sc[-1] - sc[0]
        if expect == "score_increased":
            return {"pass": delta > margin,
                    "evidence": f"score {sc[0]:.0f}→{sc[-1]:.0f} (Δ{delta:+.0f})"}
        return {"pass": delta < -margin,
                "evidence": f"score {sc[0]:.0f}→{sc[-1]:.0f} (Δ{delta:+.0f})"}

    if expect in ("hp_increased", "hp_decreased"):
        hp = _scalar_series(timeline, "hp")
        if not hp:
            return {"pass": False, "evidence": "no hp samples in timeline"}
        delta = hp[-1] - hp[0]
        if expect == "hp_increased":
            return {"pass": delta > margin,
                    "evidence": f"hp {hp[0]:.0f}→{hp[-1]:.0f} (Δ{delta:+.0f})"}
        return {"pass": delta < -margin,
                "evidence": f"hp {hp[0]:.0f}→{hp[-1]:.0f} (Δ{delta:+.0f})"}

    if expect in ("scene.win", "scene.lose"):
        flag = expect.split(".", 1)[1]
        hit = next((s for s in timeline if isinstance(s.get("scene"), dict) and s["scene"].get(flag)), None)
        if hit is not None:
            return {"pass": True, "evidence": f"scene.{flag} became true at t={hit.get('t')}ms"}
        return {"pass": False,
                "evidence": f"scene.{flag} never became true across {len(timeline)} frames"}

    if expect == "no_js_errors":
        return {"pass": js_error_count == 0,
                "evidence": f"{js_error_count} js/console error(s)"}

    return {"pass": False, "evidence": f"unknown assert expect '{expect}' "
                                       f"(valid: {', '.join(_DRIVE_ASSERT_VOCAB)})"}


@router.post("/drive")
@_proactor_endpoint
async def phaser_drive(req: DriveRequest) -> dict[str, Any]:
    """Genre-agnostic active-play harness. Executes a timed keyboard+mouse
    script against the live game, samples window.__gameState() per frame, and
    evaluates optional control-responsiveness assertions. Single-flight gated
    (shares the playtest Chromium lock — only one browser session at a time)."""
    try:
        from playwright.async_api import async_playwright  # noqa: F401
    except ImportError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "playwright_not_installed",
                "hint": "uv add playwright && uv run playwright install chromium",
                "msg": str(e),
            },
        ) from None

    lock = _get_playtest_lock()
    if lock.locked():
        logger.info("drive: playtest/drive already running — queueing this call")
    await lock.acquire()
    try:
        return await _phaser_drive_impl(req)
    finally:
        lock.release()


async def _phaser_drive_impl(req: DriveRequest) -> dict[str, Any]:
    """Inner /drive implementation (gated by the single-flight lock above)."""
    from playwright.async_api import async_playwright

    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%f")
    url = f"http://127.0.0.1:{_dev_server_port}/?level={req.level_id}"

    interval_s = req.frame_interval_ms / 1000.0
    frames: list[str] = []
    state_timeline: list[dict[str, Any]] = []
    console_log: list[dict[str, str]] = []
    js_errors: list[str] = []
    input_log: list[dict[str, Any]] = []

    # Inputs execute in at_ms order; sort defensively so out-of-order scripts work.
    inputs = sorted(req.inputs, key=lambda i: i.at_ms)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            ctx = await browser.new_context(viewport={"width": 1280, "height": 720})
            page = await ctx.new_page()
            if req.capture_console:
                page.on("console", lambda m: console_log.append({"type": m.type, "text": m.text}))
                page.on("pageerror", lambda e: js_errors.append(str(e)))
            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_selector("canvas", timeout=5000)
            # Settle: let BootScene → GameScene transition + register __gameState.
            await asyncio.sleep(req.settle_ms / 1000.0)

            # Verify the generic contract is present — fail LOUDLY if not, so a
            # scene that forgot to call registerGameState() is obvious instead
            # of silently returning an empty timeline.
            has_contract = await page.evaluate("() => typeof window.__gameState === 'function'")
            if not has_contract:
                # Raise inside the try — the finally below closes the browser.
                raise HTTPException(
                    status_code=422,
                    detail={
                        "error": "missing_gameState_contract",
                        "hint": "Scene must call registerGameState(scene, provider) "
                                "from src/systems/gameState.ts so window.__gameState() exists.",
                        "level_id": req.level_id,
                    },
                )

            game_to_screen = await _canvas_to_game_mapper(page)

            async def sample_state() -> None:
                snap = await page.evaluate(
                    "() => { try { return window.__gameState ? window.__gameState() : null; }"
                    " catch (e) { return { t: -1, custom: { error: String(e) } }; } }"
                )
                if snap is not None:
                    state_timeline.append(snap)

            async def capture_frame(idx: int) -> None:
                fp = SCREENSHOTS_DIR / f"drive_{stamp}_f{idx:03d}.png"
                await page.screenshot(path=str(fp), full_page=False)
                frames.append(str(fp.resolve()))

            # Track key state so a "hold"/"tap" that overlaps an explicit
            # keydown/keyup doesn't desync; Playwright is fine with redundant
            # up, but we log intent for the evidence trail.
            async def fire_input(ev: DriveInput) -> None:
                if ev.type == "keydown":
                    if not ev.key:
                        raise HTTPException(status_code=422, detail="keydown requires 'key'")
                    await page.keyboard.down(ev.key)
                elif ev.type == "keyup":
                    if not ev.key:
                        raise HTTPException(status_code=422, detail="keyup requires 'key'")
                    await page.keyboard.up(ev.key)
                elif ev.type in ("hold", "tap"):
                    if not ev.key:
                        raise HTTPException(status_code=422, detail=f"{ev.type} requires 'key'")
                    await page.keyboard.down(ev.key)
                    hold = ev.hold_ms if ev.hold_ms > 0 else (40 if ev.type == "tap" else 200)
                    await asyncio.sleep(hold / 1000.0)
                    await page.keyboard.up(ev.key)
                elif ev.type == "click":
                    if ev.x is None or ev.y is None:
                        raise HTTPException(status_code=422, detail="click requires 'x' and 'y'")
                    sx, sy = game_to_screen(ev.x, ev.y)
                    await page.mouse.move(sx, sy)
                    await page.mouse.down()
                    await asyncio.sleep(0.04)
                    await page.mouse.up()
                elif ev.type == "drag":
                    if not ev.from_ or not ev.to:
                        raise HTTPException(status_code=422, detail="drag requires 'from' and 'to'")
                    sx1, sy1 = game_to_screen(ev.from_[0], ev.from_[1])
                    sx2, sy2 = game_to_screen(ev.to[0], ev.to[1])
                    await page.mouse.move(sx1, sy1)
                    await page.mouse.down()
                    steps = 8
                    for k in range(1, steps + 1):
                        ix = sx1 + (sx2 - sx1) * k / steps
                        iy = sy1 + (sy2 - sy1) * k / steps
                        await page.mouse.move(ix, iy, steps=2)
                        await asyncio.sleep(0.02)
                    await page.mouse.up()
                input_log.append({"at_ms": ev.at_ms, "type": ev.type, "key": ev.key,
                                  "x": ev.x, "y": ev.y, "hold_ms": ev.hold_ms})

            # --- Deadline-driven loop: interleave frame-sampling with input ----
            # firing. Each input fires once the wall-clock passes its at_ms;
            # frames+state sample every frame_interval_ms. Mirrors /playtest's
            # 50Hz-wake deadline loop so cadence is reliable under overhead.
            t0 = time.time()
            next_frame_ts = t0
            input_i = 0
            frame_n = 0
            while True:
                elapsed_ms = (time.time() - t0) * 1000.0
                # Fire any inputs whose at_ms has arrived (in order).
                while input_i < len(inputs) and inputs[input_i].at_ms <= elapsed_ms:
                    await fire_input(inputs[input_i])
                    input_i += 1
                # Frame sample on cadence.
                if time.time() >= next_frame_ts:
                    await sample_state()
                    await capture_frame(frame_n)
                    frame_n += 1
                    next_frame_ts += interval_s
                # Stop once duration elapsed AND all inputs fired.
                if (time.time() - t0) >= req.duration_s and input_i >= len(inputs):
                    break
                await asyncio.sleep(0.02)  # 50Hz wake — finer than frame interval

            # One final state sample so assertions see the settled end-state.
            await sample_state()

            # --- predicate_js asserts: evaluate in-browser over the timeline ---
            # Done BEFORE closing the browser. The expression receives `samples`
            # (the full state_timeline array) and must evaluate truthy/falsy.
            predicate_results: dict[int, dict[str, Any]] = {}
            for idx, a in enumerate(req.asserts):
                if a.expect == "predicate_js":
                    if not a.predicate_js:
                        predicate_results[idx] = {
                            "pass": False,
                            "evidence": "expect=predicate_js but predicate_js expression missing",
                        }
                        continue
                    try:
                        val = await page.evaluate(
                            f"(samples) => {{ return ({a.predicate_js}); }}",
                            state_timeline,
                        )
                        predicate_results[idx] = {
                            "pass": bool(val),
                            "evidence": f"predicate_js → {json.dumps(val)[:200]}",
                        }
                    except Exception as e:  # noqa: BLE001
                        # Surface the JS error — do NOT swallow (fail loudly).
                        predicate_results[idx] = {
                            "pass": False,
                            "evidence": f"predicate_js threw: {type(e).__name__}: {str(e)[:200]}",
                        }
        finally:
            await _close_browser_safely(browser)

    error_count = sum(1 for c in console_log if c["type"] == "error") + len(js_errors)

    # --- Compute assertions over the captured timeline ----------------------
    assert_results: list[dict[str, Any]] = []
    for idx, a in enumerate(req.asserts):
        if a.expect == "predicate_js":
            res = predicate_results.get(idx, {"pass": False, "evidence": "predicate not evaluated"})
        else:
            res = _eval_builtin_assert(a.expect, a.margin, state_timeline, error_count)
        assert_results.append({
            "name": a.name,
            "expect": a.expect,
            "pass": res["pass"],
            "evidence": res["evidence"],
        })

    # --- Compose 4×4 grid of first 16 frames (cheap vision input) -----------
    grid_path_str: str | None = None
    if req.compose_grid and frames:
        grid_out = SCREENSHOTS_DIR / f"drive_{stamp}_grid.jpg"
        grid_result = _compose_frame_grid(
            [Path(f) for f in frames[:16]], grid_out, frame_interval_ms=req.frame_interval_ms,
        )
        if grid_result:
            grid_path_str = str(grid_result.resolve())

    asserts_passed = sum(1 for r in assert_results if r["pass"])
    return {
        "ok": True,
        "verdict_pass": (error_count == 0)
        and (len(assert_results) == 0 or asserts_passed == len(assert_results)),
        "level_id": req.level_id,
        "duration_s": req.duration_s,
        "frame_interval_ms": req.frame_interval_ms,
        "frames": frames,
        "frame_count": len(frames),
        "grid_path": grid_path_str,
        "state_timeline": state_timeline,
        "state_sample_count": len(state_timeline),
        "input_log": input_log,
        "asserts": assert_results,
        "asserts_passed": asserts_passed,
        "asserts_total": len(assert_results),
        "console_errors": [c for c in console_log if c["type"] == "error"][:20],
        "console_error_count": error_count,
        "js_errors": js_errors[:10],
        "ts": time.time(),
    }


# ---------------------------------------------------------------------------
# Level YAML CRUD
# ---------------------------------------------------------------------------


@router.get("/levels")
async def list_levels() -> dict[str, Any]:
    PHASER_LEVELS_DIR.mkdir(parents=True, exist_ok=True)
    levels = sorted(p.name for p in PHASER_LEVELS_DIR.glob("*.yaml"))
    return {"levels": levels, "dir": str(PHASER_LEVELS_DIR)}


class WriteLevelRequest(BaseModel):
    level_id: str = Field(..., pattern=r"^[a-zA-Z0-9_\-]+$")
    yaml_content: str


@router.post("/levels")
async def write_level(req: WriteLevelRequest) -> dict[str, Any]:
    PHASER_LEVELS_DIR.mkdir(parents=True, exist_ok=True)
    out = PHASER_LEVELS_DIR / f"{req.level_id}.yaml"
    out.write_text(req.yaml_content, encoding="utf-8")
    return {"ok": True, "path": str(out.resolve()), "size_bytes": out.stat().st_size}


@router.get("/levels/{level_id}")
async def read_level(level_id: str) -> dict[str, Any]:
    p = PHASER_LEVELS_DIR / f"{level_id}.yaml"
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"level {level_id} not found")
    return {"level_id": level_id, "yaml_content": p.read_text(encoding="utf-8"), "path": str(p)}
