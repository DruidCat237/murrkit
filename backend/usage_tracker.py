"""
GPT-Image-2 usage tracker — singleton that records every GPT-Image-2
submit call to SQLite (logs/gpt_image_2_usage.db) and broadcasts new events
to subscribed WebSocket clients.

Schema (table `gpt_image_2_usage`):
    id           INTEGER PRIMARY KEY
    project      TEXT     — project name (or "default" / "_global")
    model        TEXT     — "gpt-image-2" | "gpt-image-2-edit"
    resolution   TEXT     — "1K" | "2K" | "4K"
    quality      TEXT     — "low" | "medium" | "high"
    size         TEXT     — "1:1" | "16:9" | ...
    cost_usd     REAL     — estimated cost (Kitty App / DruidCat prices)
    prompt       TEXT     — first 200 chars of the prompt
    task_id      TEXT     — Kitty App job id (post-submit)
    ts           TEXT     — ISO-8601 UTC timestamp
    elapsed_ms   INTEGER  — submit→completion ms (0 if still pending)
    status       TEXT     — "submitted" | "completed" | "failed"
    extra        TEXT     — JSON blob with any extra metadata

Pricing matches the user's DruidCat / Kitty App spec:
    1K → $0.04
    2K → $0.08
    4K → $0.16
(gpt-image-2-edit uses the same per-resolution cost.)

Usage from gpt_image_2.py:
    from backend.usage_tracker import tracker
    tracker.record_submit(model="gpt-image-2", resolution="2K", ...)

Usage from a router subscribing for live updates:
    @router.websocket("/live")
    async def live(ws): await tracker.attach(ws)
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from fastapi import WebSocket
from loguru import logger

from core.config import PROJECT_ROOT


DB_PATH = PROJECT_ROOT / "logs" / "gpt_image_2_usage.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Resolution → cost USD (matches Kitty App / DruidCat pricing)
RESOLUTION_COST_USD: dict[str, float] = {
    "1K": 0.04,
    "2K": 0.08,
    "4K": 0.16,
}


def estimate_cost(resolution: str) -> float:
    return RESOLUTION_COST_USD.get((resolution or "2K").upper(), 0.08)


@dataclass
class UsageRecord:
    id: int
    project: str
    model: str
    resolution: str
    quality: str
    size: str
    cost_usd: float
    prompt: str
    task_id: str
    ts: str
    elapsed_ms: int
    status: str
    extra: dict[str, Any]


class UsageTracker:
    """Singleton tracker. Thread-safe (SQLite locked by a mutex).

    Subscribers receive `{"type": "usage_event", "record": {...}}` on
    every `record_submit` / `record_completion`.
    """

    def __init__(self, db_path: Path = DB_PATH) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        self._subscribers: list[WebSocket] = []
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS gpt_image_2_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project TEXT NOT NULL DEFAULT '_global',
                    model TEXT NOT NULL,
                    resolution TEXT NOT NULL,
                    quality TEXT NOT NULL DEFAULT 'high',
                    size TEXT NOT NULL DEFAULT '1:1',
                    cost_usd REAL NOT NULL DEFAULT 0,
                    prompt TEXT,
                    task_id TEXT,
                    ts TEXT NOT NULL,
                    elapsed_ms INTEGER DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'submitted',
                    extra TEXT
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_usage_project_ts "
                "ON gpt_image_2_usage(project, ts)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_usage_task "
                "ON gpt_image_2_usage(task_id)"
            )

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.db_path)
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()

    # ---- Recording ------------------------------------------------------

    def record_submit(
        self,
        *,
        project: str = "_global",
        model: str = "gpt-image-2",
        resolution: str = "2K",
        quality: str = "high",
        size: str = "1:1",
        prompt: str = "",
        task_id: str = "",
        extra: dict[str, Any] | None = None,
    ) -> UsageRecord:
        """Record a fresh submit. Returns the new UsageRecord."""
        cost = estimate_cost(resolution)
        ts = datetime.now(timezone.utc).isoformat()
        prompt_short = (prompt or "")[:200]
        extra_json = json.dumps(extra or {})

        with self._conn() as conn:
            cur = conn.execute(
                "INSERT INTO gpt_image_2_usage "
                "(project, model, resolution, quality, size, cost_usd, prompt, task_id, ts, "
                " elapsed_ms, status, extra) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'submitted', ?)",
                (project, model, resolution, quality, size, cost, prompt_short,
                 task_id, ts, extra_json),
            )
            new_id = cur.lastrowid or 0

        rec = UsageRecord(
            id=new_id, project=project, model=model, resolution=resolution,
            quality=quality, size=size, cost_usd=cost, prompt=prompt_short,
            task_id=task_id, ts=ts, elapsed_ms=0, status="submitted",
            extra=extra or {},
        )
        logger.info(
            "GPT-Image-2 usage: model={m} res={r} cost=${c:.2f} project={p}",
            m=model, r=resolution, c=cost, p=project,
        )
        # Best-effort async broadcast
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._broadcast(rec))
        except RuntimeError:
            pass  # not in async context — broadcast skipped
        return rec

    def record_completion(
        self,
        task_id: str,
        *,
        elapsed_ms: int,
        status: str = "completed",
        extra: dict[str, Any] | None = None,
    ) -> None:
        """Mark a previously-submitted task as completed or failed."""
        if not task_id:
            return  # Nothing to update — would match too many rows
        with self._conn() as conn:
            row = conn.execute(
                "SELECT id, extra FROM gpt_image_2_usage WHERE task_id = ? "
                "ORDER BY id DESC LIMIT 1",
                (task_id,),
            ).fetchone()
            if not row:
                return
            row_id = row[0]
            current_extra: dict[str, Any] = {}
            try:
                current_extra = json.loads(row[1] or "{}")
            except json.JSONDecodeError:
                current_extra = {}
            if extra:
                current_extra.update(extra)
            conn.execute(
                "UPDATE gpt_image_2_usage SET elapsed_ms = ?, status = ?, extra = ? "
                "WHERE id = ?",
                (elapsed_ms, status, json.dumps(current_extra), row_id),
            )

    # ---- Querying -------------------------------------------------------

    def list_calls(
        self,
        *,
        project: str | None = None,
        since_ts: str | None = None,
        limit: int = 200,
    ) -> list[UsageRecord]:
        clauses: list[str] = []
        args: list[Any] = []
        if project:
            clauses.append("project = ?")
            args.append(project)
        if since_ts:
            clauses.append("ts >= ?")
            args.append(since_ts)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = (
            "SELECT id, project, model, resolution, quality, size, cost_usd, prompt, "
            "task_id, ts, elapsed_ms, status, extra "
            f"FROM gpt_image_2_usage{where} ORDER BY ts DESC LIMIT ?"
        )
        args.append(limit)
        out: list[UsageRecord] = []
        with self._conn() as conn:
            for r in conn.execute(sql, args).fetchall():
                extra: dict[str, Any] = {}
                try:
                    extra = json.loads(r[12] or "{}")
                except json.JSONDecodeError:
                    pass
                out.append(UsageRecord(
                    id=r[0], project=r[1], model=r[2], resolution=r[3], quality=r[4],
                    size=r[5], cost_usd=r[6], prompt=r[7] or "", task_id=r[8] or "",
                    ts=r[9], elapsed_ms=r[10] or 0, status=r[11], extra=extra,
                ))
        return out

    def aggregate(
        self,
        *,
        project: str | None = None,
        since_ts: str | None = None,
    ) -> dict[str, Any]:
        """Return total cost + per-resolution + per-day breakdown."""
        calls = self.list_calls(project=project, since_ts=since_ts, limit=100000)
        total = sum(c.cost_usd for c in calls)
        by_resolution: dict[str, dict[str, Any]] = {}
        by_day: dict[str, dict[str, Any]] = {}
        for c in calls:
            br = by_resolution.setdefault(c.resolution, {"count": 0, "cost_usd": 0.0})
            br["count"] += 1
            br["cost_usd"] += c.cost_usd
            day = c.ts[:10]
            bd = by_day.setdefault(day, {"count": 0, "cost_usd": 0.0})
            bd["count"] += 1
            bd["cost_usd"] += c.cost_usd
        return {
            "total_calls": len(calls),
            "total_cost_usd": round(total, 4),
            "by_resolution": by_resolution,
            "by_day": by_day,
        }

    # ---- Live broadcast --------------------------------------------------

    async def attach(self, ws: WebSocket) -> None:
        await ws.accept()
        self._subscribers.append(ws)
        # Send a hello with current totals
        try:
            agg = self.aggregate()
            await ws.send_text(json.dumps({
                "type": "usage_snapshot",
                "totals": agg,
            }))
        except Exception:  # noqa: BLE001
            pass

    def detach(self, ws: WebSocket) -> None:
        if ws in self._subscribers:
            self._subscribers.remove(ws)

    async def _broadcast(self, rec: UsageRecord) -> None:
        if not self._subscribers:
            return
        msg = json.dumps({
            "type": "usage_event",
            "record": {
                "id": rec.id,
                "project": rec.project,
                "model": rec.model,
                "resolution": rec.resolution,
                "quality": rec.quality,
                "size": rec.size,
                "cost_usd": rec.cost_usd,
                "prompt": rec.prompt,
                "task_id": rec.task_id,
                "ts": rec.ts,
                "status": rec.status,
            },
        })
        dead: list[WebSocket] = []
        for ws in list(self._subscribers):
            try:
                await ws.send_text(msg)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.detach(ws)


# Module-level singleton
tracker = UsageTracker()
