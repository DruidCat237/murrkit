"""
Generation queue — bounded-concurrency queue for asset / sprite gen.

Goals:
    - Frontend can see the queue (queued / running / completed / failed) in real time.
    - Configurable parallelism (default 3) via env MAX_PARALLEL_GEN.
    - Each enqueue returns a task_id; status streams over /ws/gen-queue.

Design:
    - Singleton `gen_queue` with an asyncio.Semaphore for parallelism.
    - Tasks are coroutines accepting a task_id + emit() callback.
    - Internal task table is bounded to last 200 entries (rolling).
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import WebSocket
from loguru import logger


MAX_PARALLEL = int(os.environ.get("MAX_PARALLEL_GEN", "3"))
TABLE_BOUND = 200

# ---- Persistence -----------------------------------------------------------
# Queue state survives backend restart so a Cat-Tac-Toe gen kicked off at
# lunch is still visible (with thumbnails!) when the user comes back.
# Planned rows stay clickable; completed/failed rows stay in history;
# in-flight rows (queued/started/progress) cannot resume — their subprocess
# is gone — so they're marked `failed` with a "backend restarted" reason
# on load.
_DB_PATH = Path(__file__).resolve().parents[2] / "logs" / "gen_queue.db"
_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
_db_lock = threading.Lock()


def _init_db() -> None:
    with _db_lock, sqlite3.connect(_DB_PATH) as conn:
        # WAL + relaxed sync: durability stays best-effort (this is a UI cache,
        # not source of truth), but each commit no longer fsyncs a rollback
        # journal — cutting the per-tick cost _broadcast pays on every progress
        # / heartbeat event. journal_mode is persistent per DB file.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS queue_tasks (
                id TEXT PRIMARY KEY,
                project TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_queue_project ON queue_tasks(project, updated_at DESC)"
        )


_init_db()


def _write_row(task_id: str, project: str, payload: str) -> None:
    """Blocking DB upsert of an already-serialized payload. Safe to run in a
    worker thread (asyncio.to_thread) — it touches no mutable task object, only
    the strings it was handed."""
    try:
        with _db_lock, sqlite3.connect(_DB_PATH) as conn:
            conn.execute(
                "INSERT INTO queue_tasks (id, project, payload, updated_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, "
                "updated_at=excluded.updated_at",
                (task_id, project, payload, time.time()),
            )
    except (sqlite3.Error, OSError) as e:
        logger.warning("queue _write_row failed for task {tid}: {e}", tid=task_id, e=e)


def _serialize_task(task: "QueueTask") -> str | None:
    """asdict + json.dumps. MUST be called on the event-loop thread (or wherever
    the task is otherwise quiescent): asdict iterates task.extra, and running it
    off-thread while a coroutine does task.extra.update() raises 'dictionary
    changed size during iteration'."""
    try:
        return json.dumps(asdict(task), ensure_ascii=False)
    except (TypeError, ValueError) as e:
        logger.warning("queue _serialize_task failed for {tid}: {e}", tid=task.id, e=e)
        return None


def _persist(task: "QueueTask") -> None:
    """Serialize + upsert a task row synchronously. For SYNC callers (on the
    loop thread) — do NOT call from a worker thread; use _serialize_task on the
    loop then _write_row off-thread (see _broadcast)."""
    payload = _serialize_task(task)
    if payload is not None:
        _write_row(task.id, task.project, payload)


def _persist_delete(task_id: str) -> None:
    try:
        with _db_lock, sqlite3.connect(_DB_PATH) as conn:
            conn.execute("DELETE FROM queue_tasks WHERE id = ?", (task_id,))
    except (sqlite3.Error, OSError) as e:
        logger.warning("queue _persist_delete failed for {tid}: {e}", tid=task_id, e=e)


def _load_persisted() -> None:
    """Load saved tasks into _state on startup. In-flight rows are
    transitioned to `failed` with a clear reason — the user can re-plan
    them but they CANNOT silently resume (the subprocess is gone)."""
    try:
        with _db_lock, sqlite3.connect(_DB_PATH) as conn:
            rows = conn.execute(
                "SELECT id, payload FROM queue_tasks ORDER BY updated_at ASC"
            ).fetchall()
    except (sqlite3.Error, OSError) as e:
        logger.warning("queue _load_persisted failed: {e}", e=e)
        return
    n_revived = 0
    n_failed = 0
    for tid, payload in rows:
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            continue
        try:
            task = QueueTask(**data)
        except TypeError:
            # Old/incompatible schema — skip rather than crash the whole load.
            continue
        if task.status in ("queued", "started", "progress"):
            task.status = "failed"
            task.error = task.error or "Backend restarted — task could not resume."
            task.completed_at = task.completed_at or time.time()
            n_failed += 1
            _persist(task)
        _state.tasks[task.id] = task
        if task.id not in _state.order:
            _state.order.append(task.id)
        n_revived += 1
    if n_revived:
        logger.info(
            "queue: revived {n} task(s) from disk ({f} marked failed: backend-restart)",
            n=n_revived, f=n_failed,
        )


@dataclass
class QueueTask:
    id: str
    asset_type: str          # e.g. "sprite", "background", "tileset", "ui", "particle"
    prompt: str
    # 'planned'   — proposed by Claude, awaiting user ACCEPT (no upstream call yet)
    # 'queued'    — accepted, waiting for semaphore slot
    # 'started' / 'progress' — running
    # 'completed' / 'failed' / 'cancelled'
    status: str = "queued"
    project: str = "default"
    eta_seconds: float = 30.0
    cost_usd: float = 0.0
    thumbnail_url: str | None = None
    started_at: float | None = None
    completed_at: float | None = None
    progress_pct: float = 0.0
    progress_text: str = ""
    error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    # Asset-plan metadata used by the queue UI for planned (not-yet-accepted)
    # rows. Mirrors the asset_pipeline / sprite_pipeline call signature so
    # accepting the plan can fire the right worker.
    planned_workflow: str | None = None
    planned_quality: str | None = None
    planned_resolution: str | None = None
    planned_aspect_ratio: str | None = None
    # Base image (absolute path on disk) for the edit / reference workflow.
    # When set + planned_workflow == "gpt-image-2-edit", the worker uploads
    # this file to Kitty as a public URL and calls submit_edit() so the
    # generated sprite stays visually consistent with an existing character
    # atlas instead of producing a fresh-text character that drifts in
    # style. Required for the base-character workflow (task #105).
    base_image_path: str | None = None


@dataclass
class _QueueState:
    tasks: dict[str, QueueTask] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    connections: list[WebSocket] = field(default_factory=list)
    semaphore: asyncio.Semaphore | None = None
    cancel_flags: dict[str, asyncio.Event] = field(default_factory=dict)
    # The asyncio.Task driving each worker. cancel_task() calls .cancel() on
    # this so a running Kitty poll aborts immediately instead of waiting for
    # the next polite check of cancel_flags.
    asyncio_tasks: dict[str, asyncio.Task] = field(default_factory=dict)


_state = _QueueState()

# Restore prior session at import time so the first WS snapshot already
# carries history. Safe because _load_persisted only touches _state.tasks /
# _state.order and doesn't need an event loop.
_load_persisted()


def _semaphore() -> asyncio.Semaphore:
    if _state.semaphore is None:
        _state.semaphore = asyncio.Semaphore(MAX_PARALLEL)
    return _state.semaphore


_ACTIVE_STATES = ("queued", "started", "progress")


def _trim_table() -> None:
    # Evict oldest TERMINAL rows only. Popping by pure insertion order could
    # garbage-collect a still-running task — a burst of enqueues pushes an
    # in-flight row to the front — stranding it uncancellable and leaking its
    # worker. Never evict a queued/started/progress task; if everything is
    # in-flight, let the table grow briefly rather than drop live work.
    while len(_state.order) > TABLE_BOUND:
        victim = next(
            (
                tid
                for tid in _state.order
                if (t := _state.tasks.get(tid)) is None
                or t.status not in _ACTIVE_STATES
            ),
            None,
        )
        if victim is None:
            break
        _state.order.remove(victim)
        _state.tasks.pop(victim, None)
        _state.cancel_flags.pop(victim, None)
        _state.asyncio_tasks.pop(victim, None)
        _persist_delete(victim)


async def _broadcast(event: str, task: QueueTask) -> None:
    # Serialize the task HERE on the event-loop thread (asdict is atomic w.r.t.
    # other coroutines — none can interleave mid-iteration), then push only the
    # blocking sqlite write off the loop. Doing asdict inside the worker thread
    # would race a concurrent task.extra.update() ("dictionary changed size
    # during iteration"); doing the fsync inline would stall the loop on every
    # progress/heartbeat tick. This split gets both right.
    if event == "cancelled" and task.status == "planned":
        # Planned-row discard deletes the row entirely (matches in-memory
        # behaviour in discard_planned).
        await asyncio.to_thread(_persist_delete, task.id)
    else:
        payload = _serialize_task(task)
        if payload is not None:
            await asyncio.to_thread(_write_row, task.id, task.project, payload)
    if not _state.connections:
        return
    msg = json.dumps({"event": event, "task": asdict(task), "ts": time.time()})
    dead: list[WebSocket] = []
    for ws in _state.connections:
        try:
            await ws.send_text(msg)
        except Exception:  # noqa: BLE001
            dead.append(ws)
    for ws in dead:
        unregister_ws(ws)


async def enqueue(
    *,
    asset_type: str,
    prompt: str,
    project: str = "default",
    eta_seconds: float = 30.0,
    worker: Callable[[QueueTask, "QueueTaskHandle"], Awaitable[None]],
    extra: dict[str, Any] | None = None,
    base_image_path: str | None = None,
) -> str:
    """Enqueue a task. Returns task_id immediately.

    `worker` is an async callable that does the real work; it receives the
    task and a handle for emitting progress / completion. The worker is
    responsible for catching its own exceptions and using
    `handle.fail(msg)` — anything that escapes will mark the task failed.

    `base_image_path` is propagated onto the new QueueTask so workers
    spawned via _dispatch_from_plan can still read the edit reference
    that was set on the original planned row. Without this kwarg the
    new task lost the field and edit_worker hit `base_image_path == ""`.
    """
    task_id = uuid.uuid4().hex[:12]
    task = QueueTask(
        id=task_id,
        asset_type=asset_type,
        # Keep the FULL prompt — it is the real upstream generation input the
        # workers pass to Kitty. Truncating here (the old `[:400]`) silently cut
        # rich multi-frame prompts mid-sentence and billed the user for an image
        # made from the fragment. The UI can wrap/scroll the full text.
        prompt=prompt,
        project=project,
        eta_seconds=eta_seconds,
        extra=dict(extra or {}),
        base_image_path=base_image_path,
    )
    _state.tasks[task_id] = task
    _state.order.append(task_id)
    _state.cancel_flags[task_id] = asyncio.Event()
    _trim_table()

    await _broadcast("queued", task)
    _state.asyncio_tasks[task_id] = asyncio.create_task(_run_task(task, worker))
    return task_id


class QueueTaskHandle:
    """Mutator helper passed to workers; centralises broadcasting."""

    def __init__(self, task: QueueTask) -> None:
        self.task = task
        self._cancel_event = _state.cancel_flags.get(task.id)
        self._heartbeat_task: asyncio.Task | None = None

    @property
    def cancelled(self) -> bool:
        return bool(self._cancel_event and self._cancel_event.is_set())

    async def progress(self, pct: float, text: str = "") -> None:
        self.task.progress_pct = max(0.0, min(100.0, pct))
        if text:
            self.task.progress_text = text
        self.task.status = "progress"
        await _broadcast("progress", self.task)

    async def complete(self, *, thumbnail_url: str | None = None, cost_usd: float = 0.0,
                       extra: dict[str, Any] | None = None) -> None:
        self.task.status = "completed"
        self.task.thumbnail_url = thumbnail_url
        self.task.cost_usd = cost_usd
        self.task.completed_at = time.time()
        self.task.progress_pct = 100.0
        if extra:
            self.task.extra.update(extra)
        await _broadcast("completed", self.task)

    async def fail(self, message: str) -> None:
        self.task.status = "failed"
        self.task.error = message[:500]
        self.task.completed_at = time.time()
        await _broadcast("failed", self.task)

    async def start_heartbeat(
        self,
        *,
        eta_seconds: float = 120.0,
        interval_s: float = 5.0,
        text_prefix: str = "Kitty working",
        start_pct: float = 10.0,
        cap_pct: float = 90.0,
    ) -> None:
        """Start a background task that emits progress events every
        `interval_s` while the worker waits on a long upstream call.

        Without this, the UI sees status="started" + progress=5% the moment
        a job submits, then nothing for 60-180s — making it look like the
        worker hung. The heartbeat ticks progress upward toward `cap_pct`
        based on elapsed/eta, so the UI bar moves.

        Stops automatically via `stop_heartbeat()` (called from the worker
        before complete/fail) or when the parent task is cancelled.
        """
        if self._heartbeat_task is not None:
            return
        started_at = time.time()

        async def _tick() -> None:
            try:
                while True:
                    await asyncio.sleep(interval_s)
                    elapsed = time.time() - started_at
                    pct = min(cap_pct, start_pct + (elapsed / max(1.0, eta_seconds)) * (cap_pct - start_pct))
                    self.task.progress_pct = pct
                    self.task.progress_text = f"{text_prefix} ({int(elapsed)}s)"
                    self.task.status = "progress"
                    await _broadcast("progress", self.task)
            except asyncio.CancelledError:
                return

        self._heartbeat_task = asyncio.create_task(_tick())

    async def stop_heartbeat(self) -> None:
        if self._heartbeat_task is None:
            return
        self._heartbeat_task.cancel()
        try:
            await self._heartbeat_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        self._heartbeat_task = None


async def _run_task(task: QueueTask, worker: Callable[[QueueTask, QueueTaskHandle], Awaitable[None]]) -> None:
    sem = _semaphore()
    handle = QueueTaskHandle(task)

    async with sem:
        if handle.cancelled:
            task.status = "cancelled"
            await _broadcast("cancelled", task)
            return

        task.status = "started"
        task.started_at = time.time()
        await _broadcast("started", task)

        try:
            await worker(task, handle)
            # Worker should call complete(); if not, mark complete with defaults.
            if task.status not in ("completed", "failed", "cancelled"):
                await handle.complete()
        except asyncio.CancelledError:
            task.status = "cancelled"
            task.completed_at = time.time()
            await _broadcast("cancelled", task)
            raise
        except Exception as e:  # noqa: BLE001
            if handle.cancelled:
                # The worker raised because the user cancelled (e.g. the poll's
                # cooperative PollCancelled) — it's already marked cancelled by
                # cancel_task(); don't overwrite that with a spurious "failed".
                task.status = "cancelled"
                task.completed_at = time.time()
                await _broadcast("cancelled", task)
            else:
                logger.exception("gen-queue task {id} crashed: {e}", id=task.id, e=e)
                await handle.fail(f"{type(e).__name__}: {e}")
        finally:
            # Always tear down a still-running heartbeat so it doesn't keep
            # broadcasting progress for a completed/failed/cancelled task.
            await handle.stop_heartbeat()


async def add_planned(
    *,
    name: str,
    asset_type: str,
    prompt: str,
    project: str,
    workflow_id: str,
    quality: str,
    resolution: str,
    aspect_ratio: str,
    cost_cents: int,
    base_image_path: str | None = None,
) -> str:
    """Add a 'planned' row to the queue. No upstream call until accepted.

    Pass `base_image_path` (absolute disk path) when the row should run
    through gpt-image-2-edit using that file as the reference image —
    keeps character poses consistent across iterations.
    """
    task_id = uuid.uuid4().hex[:12]
    task = QueueTask(
        id=task_id,
        asset_type=asset_type,
        # Full prompt — accepting this planned row dispatches it verbatim to the
        # generator. The old `[:400]` truncation lost the tail of rich prompts.
        prompt=prompt,
        project=project,
        status="planned",
        cost_usd=cost_cents / 100.0,
        planned_workflow=workflow_id,
        planned_quality=quality,
        planned_resolution=resolution,
        planned_aspect_ratio=aspect_ratio,
        base_image_path=base_image_path,
        extra={"name": name, "planned": True},
    )
    _state.tasks[task_id] = task
    _state.order.append(task_id)
    _state.cancel_flags[task_id] = asyncio.Event()
    _trim_table()
    await _broadcast("planned", task)
    return task_id


def list_planned(project: str | None = None) -> list[QueueTask]:
    out = [t for t in list_tasks() if t.status == "planned"]
    if project:
        out = [t for t in out if t.project == project]
    return out


async def discard_planned(task_id: str) -> bool:
    """Remove a planned-only row from the queue (no upstream cancel needed)."""
    t = _state.tasks.get(task_id)
    if t is None or t.status != "planned":
        return False
    try:
        _state.order.remove(task_id)
    except ValueError:
        pass
    _state.tasks.pop(task_id, None)
    _state.cancel_flags.pop(task_id, None)
    await _broadcast("cancelled", t)
    return True


async def update_planned(
    task_id: str,
    *,
    prompt: str | None = None,
    quality: str | None = None,
    resolution: str | None = None,
    aspect_ratio: str | None = None,
    cost_cents: int | None = None,
    base_image_path: str | None = None,
) -> QueueTask | None:
    """Mutate a planned row before the user accepts it.

    Only `planned` status is editable — once accepted the worker has started
    and the prompt is locked. Returns the updated task, or None if not found
    / not in planned state.

    `base_image_path` lets the user retarget the edit-reference (e.g. swap
    grumpy_black to small_chubby_patched after looking at the v1 atlases).
    The router validates the file exists before passing it through.
    """
    t = _state.tasks.get(task_id)
    if t is None or t.status != "planned":
        return None
    if prompt is not None:
        t.prompt = prompt  # full prompt — this is the real generation input
    if quality is not None:
        t.planned_quality = quality
    if resolution is not None:
        t.planned_resolution = resolution
    if aspect_ratio is not None:
        t.planned_aspect_ratio = aspect_ratio
    if cost_cents is not None:
        t.cost_usd = cost_cents / 100.0
    if base_image_path is not None:
        t.base_image_path = base_image_path or None
    # Persist the edit so a backend restart doesn't lose user tweaks.
    _persist(t)
    # Re-broadcast so any UI re-renders with the new prompt/cost. Reuse the
    # `planned` event since semantically the row is still in the planning
    # bucket and clients already handle this event.
    await _broadcast("planned", t)
    return t


def cancel_task(task_id: str) -> bool:
    """Cancel a queued or running task.

    Two-pronged: set the cancel event (handled before the worker enters its
    semaphore-protected critical section), and cancel the asyncio.Task that
    drives the worker (raises CancelledError into a running Kitty poll so it
    aborts immediately).
    """
    ev = _state.cancel_flags.get(task_id)
    at = _state.asyncio_tasks.get(task_id)
    task = _state.tasks.get(task_id)
    if ev is None and at is None and task is None:
        return False
    if ev is not None:
        ev.set()
    # Mark in task table immediately so the UI flips even if the cancellation
    # propagates a few ms later.
    if task is not None and task.status in ("queued", "started", "progress"):
        task.status = "cancelled"
        task.completed_at = time.time()
        # Fire-and-forget broadcast — we're in a sync function so schedule it.
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(_broadcast("cancelled", task))
        except RuntimeError:
            pass
    if at is not None and not at.done():
        at.cancel()
    return True


def list_tasks() -> list[QueueTask]:
    return [_state.tasks[i] for i in _state.order if i in _state.tasks]


def get_task(task_id: str) -> QueueTask | None:
    return _state.tasks.get(task_id)


async def clear_tasks_by_status(
    statuses: set[str],
    project: str | None = None,
) -> int:
    """Remove every task whose status is in `statuses` (optionally filtered to
    one project). Returns count removed.

    Used by the UI's bulk-clear buttons (e.g. "Clear failed") so old failure
    rows don't clutter the queue forever. Refuses to remove in-flight rows
    (queued/started/progress) — those must be cancelled first via cancel_task.
    """
    safe_statuses = statuses - {"queued", "started", "progress"}
    if not safe_statuses:
        return 0
    removed_ids: list[str] = []
    removed_tasks: list[QueueTask] = []
    for tid, task in list(_state.tasks.items()):
        if task.status not in safe_statuses:
            continue
        if project is not None and task.project != project:
            continue
        removed_ids.append(tid)
        removed_tasks.append(task)
    for tid in removed_ids:
        _state.tasks.pop(tid, None)
        if tid in _state.order:
            _state.order.remove(tid)
        _persist_delete(tid)
    # Broadcast each removal so connected UIs drop the rows without a full refetch.
    for task in removed_tasks:
        try:
            await _broadcast("removed", task)
        except Exception:  # noqa: BLE001 — broadcast best-effort
            pass
    return len(removed_ids)


async def register_ws(ws: WebSocket, project: str | None = None) -> None:
    await ws.accept()
    _state.connections.append(ws)
    # Initial snapshot — filter by project when caller asked. Without a filter
    # the client sees every project's history, which is the legacy behaviour
    # (kept for the global activity-monitor view).
    tasks_list = list_tasks()
    if project:
        tasks_list = [t for t in tasks_list if t.project == project]
    await ws.send_text(json.dumps({
        "event": "snapshot",
        "tasks": [asdict(t) for t in tasks_list],
        "max_parallel": MAX_PARALLEL,
        "project": project,
    }))


def unregister_ws(ws: WebSocket) -> None:
    try:
        _state.connections.remove(ws)
    except ValueError:
        pass
