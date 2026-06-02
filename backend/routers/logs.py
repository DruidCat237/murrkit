"""
Live log viewer router — WebSocket tail of backend log files.

Architecture:
    loguru writes to logs/murrkit_*.log (configured in core/config.py).
    This router does a lightweight tail-f over the newest matching log file.

Endpoints:
    WS    /api/logs/tail       — stream new lines as they arrive
    GET   /api/logs/recent     — last N lines (one-shot fetch)
    GET   /api/logs/files      — list available log files
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections import deque
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel

from core.config import PROJECT_ROOT

router = APIRouter(prefix="/api/logs", tags=["logs"])
LOG_DIR = PROJECT_ROOT / "logs"


# Loguru default file format: "{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {module}:{function}:{line} - {message}"
_LOG_LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\|\s+"
    r"(?P<level>\w+)\s*\|\s+(?P<location>[^-]+?)\s+-\s+(?P<msg>.*)$"
)


def _parse_line(raw: str) -> dict:
    m = _LOG_LINE_RE.match(raw)
    if not m:
        return {"raw": raw.rstrip(), "level": "INFO", "module": ""}
    d = m.groupdict()
    # Derive component from module path (e.g. "chat" from "chat:send:99")
    module = d.get("location") or ""
    component = module.split(":", 1)[0].split(".")[-1] if module else ""
    return {
        "ts": d["ts"], "level": d["level"], "module": module.strip(),
        "component": component.strip(), "msg": d["msg"].rstrip(),
        "raw": raw.rstrip(),
    }


def _newest_log() -> Path | None:
    if not LOG_DIR.exists():
        return None
    candidates = sorted(LOG_DIR.glob("murrkit_*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


class RecentLogsResponse(BaseModel):
    file: str
    lines: list[dict]
    total_lines: int


@router.get("/files")
async def list_log_files() -> list[dict]:
    if not LOG_DIR.exists():
        return []
    out: list[dict] = []
    for p in sorted(LOG_DIR.iterdir(), reverse=True):
        if p.is_file() and p.suffix == ".log":
            st = p.stat()
            out.append({
                "name": p.name, "path": str(p), "size_bytes": st.st_size,
                "modified": st.st_mtime,
            })
    return out


@router.get("/recent", response_model=RecentLogsResponse)
async def recent_logs(limit: int = 200, component: str | None = None) -> RecentLogsResponse:
    f = _newest_log()
    if f is None or not f.exists():
        return RecentLogsResponse(file="(none)", lines=[], total_lines=0)
    # Tail efficiently: read whole file (logs rotate at 10MB so this is OK)
    text = f.read_text(encoding="utf-8", errors="replace")
    raw_lines = text.splitlines()
    parsed = [_parse_line(ln) for ln in raw_lines]
    if component:
        parsed = [p for p in parsed if p.get("component") == component]
    return RecentLogsResponse(
        file=f.name, lines=parsed[-limit:], total_lines=len(parsed),
    )


@router.websocket("/tail")
async def tail_logs(ws: WebSocket) -> None:
    """Tail the newest log file. Pushes {kind:'line', ...} every new line."""
    await ws.accept()
    f = _newest_log()
    if f is None:
        await ws.send_text(json.dumps({"kind": "error", "error": "No log files yet."}))
        await ws.close()
        return

    pos = f.stat().st_size  # start from end
    try:
        while True:
            await asyncio.sleep(0.4)
            try:
                cur_size = f.stat().st_size
            except FileNotFoundError:
                # Log rotated; find new
                f = _newest_log()
                if f is None:
                    continue
                pos = 0
                continue
            if cur_size < pos:
                # log truncated/rotated
                pos = 0
            if cur_size > pos:
                with f.open("rb") as fp:
                    fp.seek(pos)
                    new = fp.read(cur_size - pos).decode("utf-8", errors="replace")
                pos = cur_size
                for ln in new.splitlines():
                    parsed = _parse_line(ln)
                    parsed["kind"] = "line"
                    await ws.send_text(json.dumps(parsed))
    except WebSocketDisconnect:
        logger.debug("Log tail WS disconnected.")
    except Exception as e:  # noqa: BLE001
        logger.warning("Log tail error: {e}", e=str(e)[:200])
        try:
            await ws.send_text(json.dumps({"kind": "error", "error": str(e)[:300]}))
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
