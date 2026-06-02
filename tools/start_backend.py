"""
start_backend.py — atomic zombie killer + clean uvicorn launch.

Why this exists
---------------
Windows TCP zombie sockets: when uvicorn dies (Ctrl+C, killed parent, crashed
reload), the LISTENING socket on the port often stays bound for 2-4 minutes
even though the owning PID is gone. taskkill says "process not found" but
netstat still shows the port held. New uvicorn instances either fail to
bind or — worse — bind alongside, and the kernel routes incoming requests
randomly between the new clean process and the stale zombie that's serving
old code. That broke 4 ports for us in the previous session (8001->8002->
8003->8004->8005).

This script makes restart atomic:
  1. Find every python.exe whose command line contains "backend.main:app"
     and PowerShell-Stop-Process them all (taskkill -F doesn't always work
     on managed Python processes, Stop-Process does).
  2. Wait until netstat shows zero LISTENING entries on the target port.
     If sockets are stuck, wait up to 60 s — Windows TIME_WAIT default is
     ~4 min but mostly drains in 30-60 s if no live FDs hold them.
  3. Start ONE fresh uvicorn on the configured port (default 8001 from
     `BACKEND_PORT` env / settings).

Usage
-----
    uv run python -m tools.start_backend            # use BACKEND_PORT from .env
    uv run python -m tools.start_backend --port 8001
    uv run python -m tools.start_backend --no-reload    # production-ish
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

# Force stdout to UTF-8 so ASCII-only output works on cp1250 Polish Windows
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        pass

REPO_ROOT = Path(__file__).resolve().parents[1]


def _ps(cmd: str) -> str:
    """Run a PowerShell command, return stdout (trimmed)."""
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", cmd],
        capture_output=True,
        text=True,
        timeout=20,
    )
    return result.stdout.strip()


def kill_backend_processes() -> list[int]:
    """Return list of PIDs killed."""
    # NOTE: match '*backend.main*' (NOT '*backend.main:app*'). start_uvicorn()
    # launches the server as `python -m backend.main`, whose command line has NO
    # ':app' suffix — so the old ':app' filter never matched our own children and
    # zombies accumulated (two stale backends both bound to :8002, kernel routing
    # requests randomly between old and new code). 'tools.start_backend' (the
    # launcher) does not contain 'backend.main' as a substring, so it's safe.
    pids_raw = _ps(
        "Get-CimInstance Win32_Process -Filter \"name='python.exe'\" "
        "| Where-Object { $_.CommandLine -like '*backend.main*' } "
        "| Select-Object -ExpandProperty ProcessId"
    )
    pids = [int(p) for p in pids_raw.split() if p.strip().isdigit()]
    if not pids:
        return []
    print(f"  killing {len(pids)} backend processes: {pids}")
    for pid in pids:
        _ps(f"Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue")
    return pids


def listeners_on_port(port: int) -> list[int]:
    """Return list of PIDs still LISTENING on the given port."""
    out = _ps(
        f"Get-NetTCPConnection -State Listen -LocalPort {port} "
        "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"
    )
    return [int(p) for p in out.split() if p.strip().isdigit()]


def wait_for_port_free(port: int, timeout_s: int = 60) -> bool:
    """Poll until nothing is LISTENING on the port (or timeout).

    BUG #171 FIX: detect kernel-zombie sockets (PIDs that no longer exist
    in tasklist) and break out early so the caller can fall back to a
    different port instead of waiting the full 60s.
    """
    deadline = time.time() + timeout_s
    zombie_seen_for: float | None = None
    while time.time() < deadline:
        live = listeners_on_port(port)
        if not live:
            return True
        # Detect phantom sockets — PIDs that no longer exist as real processes.
        # On Windows, dead-PID LISTENING entries can linger indefinitely after
        # certain uvicorn crashes / Ctrl-C combinations; netstat keeps showing
        # them but Stop-Process returns "not found". Waiting longer doesn't help.
        all_phantom = all(not _is_real_pid(pid) for pid in live)
        if all_phantom:
            if zombie_seen_for is None:
                zombie_seen_for = time.time()
            elif time.time() - zombie_seen_for >= 5.0:
                print(
                    f"  port {port} has {len(live)} phantom LISTENING socket(s) "
                    f"on dead PIDs {live} — kernel cleanup may take minutes. "
                    "Caller should fall back to a different port."
                )
                return False
        else:
            zombie_seen_for = None
        time.sleep(1)
    return False


def _is_real_pid(pid: int) -> bool:
    """Return True iff `pid` is a currently-running Windows process."""
    out = _ps(
        f"if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) "
        "{ 'alive' } else { 'dead' }"
    )
    return out.strip() == "alive"


def start_uvicorn(port: int, reload: bool) -> int:
    """Start one fresh uvicorn. Returns child PID.

    Uses `python -m backend.main` (not `python -m uvicorn`) so that
    `backend/main.py`'s top-level `set_event_loop_policy(WindowsProactorEventLoopPolicy)`
    runs BEFORE `uvicorn.run()` creates the event loop. With `python -m uvicorn`,
    uvicorn instantiates its loop first and only then imports `backend.main`,
    making our policy line a no-op — which breaks Python Playwright on Windows
    (NotImplementedError from `loop.subprocess_exec`).

    Reload mode is intentionally disabled with this entry point; the reload
    worker subprocess would re-introduce the same loop-creation-before-import
    race. Code changes require a full restart via `start_backend.py`.
    """
    venv_python = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    if not venv_python.is_file():
        # Fall back to system python; uv-managed deps may still be importable.
        venv_python = Path(sys.executable)
    cmd = [
        str(venv_python),
        "-m", "backend.main",
    ]
    if reload:
        # Print a warning but don't enable — reload mode races our policy fix.
        print("  WARN: --reload requested but disabled to keep ProactorEventLoop on Windows.")
    log = REPO_ROOT / "logs" / f"backend-{port}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    f = log.open("ab")
    env = os.environ.copy()
    env["BACKEND_PORT"] = str(port)  # backend.main:run() reads this via core.config.settings
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        stdout=f,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        env=env,
    )
    print(f"  launched backend pid={proc.pid} -> logs at {log}")
    return proc.pid


def wait_for_health(port: int, timeout_s: int = 30) -> bool:
    """Poll /health until 200 or timeout."""
    import urllib.error
    import urllib.request

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(1)
    return False


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=int(os.environ.get("BACKEND_PORT", "8001")))
    p.add_argument("--no-reload", action="store_true")
    p.add_argument("--skip-kill", action="store_true", help="don't kill existing processes")
    args = p.parse_args()

    port = args.port
    print(f"start_backend -> port {port}")

    if not args.skip_kill:
        print("step 1/3: killing existing backend processes")
        kill_backend_processes()
        print("step 2/3: waiting for port to free")
        if not wait_for_port_free(port, timeout_s=60):
            stuck = listeners_on_port(port)
            print(f"  WARN: port still held by {stuck} after 60s — proceeding anyway")
        else:
            print(f"  port {port} clean")
    else:
        print("step 1/3: skip-kill — leaving existing processes alone")
        print("step 2/3: skip wait")

    print("step 3/3: launching uvicorn")
    pid = start_uvicorn(port, reload=not args.no_reload)
    if wait_for_health(port, timeout_s=30):
        print(f"[OK] backend up on port {port} (pid {pid})")
        return 0
    print(f"[FAIL] backend did NOT respond on /health within 30s -- check logs/backend-{port}.log")
    return 1


if __name__ == "__main__":
    sys.exit(main())
