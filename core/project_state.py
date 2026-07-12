"""
ProjectState — single source of truth for what exists in the 2D game project,
who owns it, and what's been done.

Schema:
    components — every file/asset the agent ever touched or that exists in scope
        file_path (PK)         relative to project root
        owner                  user_handcrafted | agent_generated | asset_imported | sprite_generated
        status                 completed | in_progress | planned | deprecated
        category               script_runtime | sprite | tileset | audio | animator | scene | other
        last_user_touch_ms     unix ms when user last edited (file watcher mtime)
        last_agent_touch_ms    unix ms when agent last wrote
        notes                  free-form description
        protected              1 = NEVER overwrite without explicit user request
        created_at             timestamp

    tasks / decisions — same schema as GameTestMVP (copy-as-is)

Usage:
    from core.project_state import get_state
    state = get_state()
    snapshot = state.snapshot()
    task_id = state.start_task(intent="generate knight spritesheet")
    state.complete_task(task_id, summary="done")
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

from core.config import PROJECT_ROOT, PROJECTS_DIR


DB_PATH = PROJECTS_DIR / "_shared" / "project_state.db"

# File globs we auto-scan on startup to populate components table
def _scan_globs() -> list[tuple[str, str, str]]:
    """Glob patterns relative to PROJECT_ROOT — 2D game project layout."""
    from core.config import settings as _s
    p = _s.unity_project_name
    return [
        (f"{p}/Assets/Scripts/**/*.cs",     "user_handcrafted", "script_runtime"),
        (f"{p}/Assets/Sprites/**/*.png",    "sprite_generated", "sprite"),
        (f"{p}/Assets/Tilemaps/**/*.png",   "sprite_generated", "tileset"),
        (f"{p}/Assets/Audio/**/*.wav",      "agent_generated",  "audio"),
        (f"{p}/Assets/Audio/**/*.mp3",      "agent_generated",  "audio"),
        (f"{p}/Assets/Scenes/**/*.unity",   "user_handcrafted", "scene"),
        (f"{p}/Assets/Animations/**/*.controller", "agent_generated", "animator"),
        ("templates/**/*.cs.tmpl",          "user_handcrafted", "script_runtime"),
    ]


# Files we KNOW are user-handcrafted core (override auto-scan ownership for these)
# Anyone with persistent ownership across sessions belongs here. The list is
# minimal — most files inherit ownership from auto-scan.
_KNOWN_USER_CORE: dict[str, dict[str, Any]] = {
    # Empty by default — Agent deploys PlayerController/CameraFollow/AgentTestRunner
    # from the template library on first build_game run. After deploy, these files
    # become PROTECTED via the post-creation flag pass below (agent_generated +
    # protected=1 once they exist on disk and are referenced by setup_quest_scene).
}

# After agent deploys 2D scripts, mark them protected.
def _agent_deployed_protected() -> set[str]:
    """Dynamic — uses current unity_project_name."""
    from core.config import settings as _s
    proj = _s.unity_project_name
    return {
        f"{proj}/Assets/Scripts/PlayerController2D.cs",
        f"{proj}/Assets/Scripts/CameraFollow2D.cs",
        f"{proj}/Assets/Scripts/Health.cs",
    }


@dataclass(slots=True)
class ComponentRecord:
    file_path: str
    owner: str
    status: str
    category: str
    last_user_touch_ms: int = 0
    last_agent_touch_ms: int = 0
    notes: str = ""
    protected: int = 0


@dataclass(slots=True)
class TaskRecord:
    id: int
    parent_id: int | None
    intent: str
    status: str
    started_at: str
    finished_at: str | None = None
    owner_agent: str = ""
    cost_usd: float = 0.0
    events: list[dict] = field(default_factory=list)


class ProjectState:
    """Persistent shared state. Singleton-ish — call ProjectState() anywhere."""

    def __init__(self) -> None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._scan_filesystem()

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        # sqlite3's own `with conn:` commits/rolls back but NEVER closes the
        # connection — leaking a handle per call until GC finalizes it (a real
        # problem on Windows, where the open handle can also block file ops).
        # Wrap it so every `with self._conn() as c:` commits on success, rolls
        # back on error, and always closes.
        c = sqlite3.connect(DB_PATH)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()

    def _init_db(self) -> None:
        with self._conn() as c:
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS components (
                    file_path           TEXT PRIMARY KEY,
                    owner               TEXT NOT NULL DEFAULT 'unknown',
                    status              TEXT NOT NULL DEFAULT 'completed',
                    category            TEXT NOT NULL DEFAULT 'other',
                    last_user_touch_ms  INTEGER DEFAULT 0,
                    last_agent_touch_ms INTEGER DEFAULT 0,
                    notes               TEXT DEFAULT '',
                    protected           INTEGER DEFAULT 0,
                    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE IF NOT EXISTS tasks (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    parent_id    INTEGER,
                    intent       TEXT NOT NULL,
                    status       TEXT NOT NULL DEFAULT 'in_progress',
                    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
                    finished_at  TEXT,
                    owner_agent  TEXT DEFAULT '',
                    cost_usd     REAL DEFAULT 0,
                    events_json  TEXT NOT NULL DEFAULT '[]',
                    summary      TEXT DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS decisions (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp    TEXT NOT NULL DEFAULT (datetime('now')),
                    agent_name   TEXT,
                    action       TEXT NOT NULL,
                    rationale    TEXT NOT NULL DEFAULT '',
                    files_touched TEXT NOT NULL DEFAULT '[]',
                    task_id      INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_comp_owner ON components(owner);
                CREATE INDEX IF NOT EXISTS idx_comp_status ON components(status);
                CREATE INDEX IF NOT EXISTS idx_task_parent ON tasks(parent_id);
                CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);
                """
            )

    def _scan_filesystem(self) -> None:
        """Auto-discover files and merge into components table.
        Existing rows preserved (don't overwrite owner if user changed it manually).
        New files get default ownership from _SCAN_GLOBS.
        Files in _KNOWN_USER_CORE always upgrade to protected=1."""
        with self._conn() as c:
            # First pass: glob scan
            seen: set[str] = set()
            for pattern, default_owner, category in _scan_globs():
                for p in PROJECT_ROOT.glob(pattern):
                    if not p.is_file():
                        continue
                    if p.suffix == ".meta":
                        continue
                    rel = str(p.relative_to(PROJECT_ROOT)).replace("\\", "/")
                    seen.add(rel)
                    mtime_ms = int(p.stat().st_mtime * 1000)
                    existing = c.execute(
                        "SELECT 1 FROM components WHERE file_path = ?", (rel,)
                    ).fetchone()
                    if existing:
                        # Update mtime only — don't overwrite owner (user might have changed it)
                        c.execute(
                            "UPDATE components SET last_user_touch_ms = MAX(last_user_touch_ms, ?) WHERE file_path = ?",
                            (mtime_ms, rel),
                        )
                    else:
                        c.execute(
                            """INSERT INTO components
                               (file_path, owner, status, category, last_user_touch_ms)
                               VALUES (?, ?, 'completed', ?, ?)""",
                            (rel, default_owner, category, mtime_ms),
                        )
            # Second pass: enforce known-user-core entries
            for rel, meta in _KNOWN_USER_CORE.items():
                p = PROJECT_ROOT / rel
                if p.exists():
                    c.execute(
                        """INSERT OR REPLACE INTO components
                           (file_path, owner, status, category, last_user_touch_ms,
                            last_agent_touch_ms, notes, protected)
                           VALUES (
                             ?, ?, ?,
                             COALESCE((SELECT category FROM components WHERE file_path = ?), 'script_runtime'),
                             COALESCE((SELECT last_user_touch_ms FROM components WHERE file_path = ?),
                                      ?),
                             COALESCE((SELECT last_agent_touch_ms FROM components WHERE file_path = ?), 0),
                             ?, ?
                           )""",
                        (
                            rel, meta["owner"], meta["status"],
                            rel,
                            rel, int(p.stat().st_mtime * 1000),
                            rel,
                            meta.get("notes", ""), meta.get("protected", 0),
                        ),
                    )
            # Third pass: mark agent-deployed core scripts as protected once they exist.
            # User opted to let Agent generate PlayerController/CameraFollow/AgentTestRunner
            # from templates — after deploy they're agent_generated, but we DON'T want
            # subsequent runs to accidentally overwrite them. So flip protected=1 on
            # presence + tag owner=agent_generated_protected.
            for rel in _agent_deployed_protected():
                p = PROJECT_ROOT / rel
                if not p.exists():
                    continue
                # Only flip protected on existing rows (don't insert)
                c.execute(
                    """UPDATE components
                       SET protected = 1,
                           owner = CASE
                             WHEN owner IN ('auto', 'agent_generated', 'agent_generated_protected')
                             THEN 'agent_generated_protected'
                             ELSE owner END,
                           notes = COALESCE(NULLIF(notes, ''),
                             'Agent-deployed core script. Don''t regenerate. Use Custom<Name> if you must extend.')
                       WHERE file_path = ?""",
                    (rel,),
                )

    # -------------------------------------------------------------------------
    # Snapshot — for LLM prompt injection
    # -------------------------------------------------------------------------
    def snapshot(self, max_components: int = 60) -> dict[str, Any]:
        """Return a compact summary that fits in an LLM prompt as JSON.
        Top-level: counts, key files, active tasks."""
        with self._conn() as c:
            comp_rows = c.execute(
                "SELECT file_path, owner, status, category, notes, protected "
                "FROM components ORDER BY protected DESC, file_path"
            ).fetchall()
            tasks = c.execute(
                "SELECT id, parent_id, intent, status, summary FROM tasks "
                "WHERE status IN ('in_progress', 'planned') ORDER BY id DESC LIMIT 20"
            ).fetchall()

        protected = [
            {"path": r["file_path"], "owner": r["owner"], "notes": (r["notes"] or "")[:120]}
            for r in comp_rows if r["protected"]
        ]
        agent_owned = [
            r["file_path"] for r in comp_rows if r["owner"] == "agent_generated"
        ][:30]
        by_category: dict[str, int] = {}
        for r in comp_rows:
            by_category[r["category"]] = by_category.get(r["category"], 0) + 1

        return {
            "components_total": len(comp_rows),
            "protected_files": protected[:30],
            "agent_owned_files": agent_owned,
            "by_category": by_category,
            "active_tasks": [
                {"id": t["id"], "intent": t["intent"][:120], "status": t["status"]}
                for t in tasks
            ],
        }

    def render_for_prompt(self) -> str:
        """Markdown-style summary for injection into LLM system prompt."""
        s = self.snapshot()
        lines: list[str] = ["## Current project state (read this BEFORE deciding actions)"]
        lines.append(f"- Total tracked components: {s['components_total']}")
        if s["by_category"]:
            cats = ", ".join(f"{k}={v}" for k, v in sorted(s["by_category"].items()))
            lines.append(f"- By category: {cats}")
        if s["protected_files"]:
            lines.append("")
            lines.append("### PROTECTED files (do NOT overwrite — read first if needed)")
            for f in s["protected_files"][:15]:
                lines.append(f"- `{f['path']}` (owner={f['owner']}) — {f['notes'][:80]}")
        if s["agent_owned_files"]:
            lines.append("")
            lines.append("### Agent-generated files (safe to modify or replace)")
            for path in s["agent_owned_files"][:15]:
                lines.append(f"- `{path}`")
        if s["active_tasks"]:
            lines.append("")
            lines.append("### Active / pending tasks")
            for t in s["active_tasks"]:
                lines.append(f"- #{t['id']} [{t['status']}] {t['intent']}")
        lines.append("")
        lines.append(
            "RULES: Before creating/modifying a file, check if it's PROTECTED. "
            "If yes, READ it first (execute_python / filesystem), then ASK user "
            "before overwriting. If user explicitly asked to modify/improve it, proceed."
        )
        return "\n".join(lines)

    # -------------------------------------------------------------------------
    # Component ops
    # -------------------------------------------------------------------------
    def is_protected(self, file_path: str) -> bool:
        rel = self._normalize(file_path)
        with self._conn() as c:
            row = c.execute(
                "SELECT protected FROM components WHERE file_path = ?", (rel,)
            ).fetchone()
            return bool(row and row["protected"])

    def can_overwrite(
        self, file_path: str, *, user_explicitly_requested: bool = False
    ) -> tuple[bool, str]:
        """Returns (allowed, reason). Use in tools to gate destructive writes."""
        rel = self._normalize(file_path)
        with self._conn() as c:
            row = c.execute(
                "SELECT owner, status, protected, notes FROM components WHERE file_path = ?",
                (rel,),
            ).fetchone()
        if row is None:
            return True, "new_file"
        if row["protected"] and not user_explicitly_requested:
            return False, (
                f"Protected: owner={row['owner']}, status={row['status']}. "
                f"Notes: {row['notes'][:120]}. To overwrite, user must explicitly request."
            )
        if row["owner"] == "user_handcrafted" and not user_explicitly_requested:
            return False, (
                f"User-handcrafted file. Last touched by user. "
                f"To modify, user must explicitly request OR call read_component first."
            )
        return True, f"agent-owned ({row['owner']})"

    def record_component(
        self,
        file_path: str,
        *,
        owner: str = "agent_generated",
        status: str = "completed",
        category: str = "other",
        notes: str = "",
        protected: bool = False,
    ) -> None:
        rel = self._normalize(file_path)
        now_ms = int(time.time() * 1000)
        with self._conn() as c:
            c.execute(
                """INSERT INTO components
                   (file_path, owner, status, category, last_agent_touch_ms, notes, protected)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(file_path) DO UPDATE SET
                     owner = excluded.owner,
                     status = excluded.status,
                     category = excluded.category,
                     last_agent_touch_ms = excluded.last_agent_touch_ms,
                     notes = excluded.notes,
                     protected = MAX(components.protected, excluded.protected)""",
                (rel, owner, status, category, now_ms, notes, 1 if protected else 0),
            )

    def mark_user_modified(self, file_path: str) -> None:
        """Called when file watcher detects user edited file (mtime > last_agent_touch).
        Bumps owner to user_modified and protects."""
        rel = self._normalize(file_path)
        now_ms = int(time.time() * 1000)
        with self._conn() as c:
            c.execute(
                """UPDATE components SET
                     owner = CASE WHEN owner = 'user_handcrafted' THEN owner ELSE 'user_modified' END,
                     last_user_touch_ms = ?,
                     protected = 1
                   WHERE file_path = ?""",
                (now_ms, rel),
            )

    # -------------------------------------------------------------------------
    # Task ops (hierarchical)
    # -------------------------------------------------------------------------
    def start_task(
        self, intent: str, *, parent_id: int | None = None, owner_agent: str = ""
    ) -> int:
        with self._conn() as c:
            cur = c.execute(
                """INSERT INTO tasks (parent_id, intent, status, owner_agent)
                   VALUES (?, ?, 'in_progress', ?)""",
                (parent_id, intent[:1000], owner_agent),
            )
            return int(cur.lastrowid or 0)

    def emit(self, task_id: int, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Append an event to task's event log. Returns the event dict for WS broadcast."""
        event = {
            "kind": kind,
            "ts": int(time.time() * 1000),
            "task_id": task_id,
            **payload,
        }
        with self._conn() as c:
            row = c.execute(
                "SELECT events_json FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if row is None:
                return event
            try:
                events = json.loads(row["events_json"]) or []
            except json.JSONDecodeError:
                events = []
            events.append(event)
            c.execute(
                "UPDATE tasks SET events_json = ? WHERE id = ?",
                (json.dumps(events[-200:], ensure_ascii=False), task_id),
            )
        return event

    def complete_task(
        self, task_id: int, *, status: str = "completed", summary: str = "",
        cost_usd: float = 0.0,
    ) -> None:
        with self._conn() as c:
            c.execute(
                """UPDATE tasks SET status = ?, finished_at = datetime('now'),
                                    summary = ?, cost_usd = ?
                   WHERE id = ?""",
                (status, summary[:1000], cost_usd, task_id),
            )

    def task_tree(self, root_id: int) -> dict[str, Any]:
        """Return a task with all descendants nested."""
        with self._conn() as c:
            row = c.execute("SELECT * FROM tasks WHERE id = ?", (root_id,)).fetchone()
            if row is None:
                return {}
            children = c.execute(
                "SELECT id FROM tasks WHERE parent_id = ? ORDER BY id", (root_id,)
            ).fetchall()
        node = dict(row)
        try:
            node["events"] = json.loads(node.get("events_json", "[]"))
        except Exception:
            node["events"] = []
        node.pop("events_json", None)
        node["children"] = [self.task_tree(int(r["id"])) for r in children]
        return node

    # -------------------------------------------------------------------------
    # Decision log
    # -------------------------------------------------------------------------
    def log_decision(
        self,
        agent_name: str,
        action: str,
        rationale: str,
        files_touched: list[str] | None = None,
        task_id: int | None = None,
    ) -> None:
        with self._conn() as c:
            c.execute(
                """INSERT INTO decisions
                   (agent_name, action, rationale, files_touched, task_id)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    agent_name,
                    action[:200],
                    rationale[:1000],
                    json.dumps(files_touched or []),
                    task_id,
                ),
            )

    # -------------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------------
    @staticmethod
    def _normalize(file_path: str) -> str:
        # Accept absolute or relative; normalize to project-relative posix
        p = Path(file_path)
        if p.is_absolute():
            try:
                p = p.relative_to(PROJECT_ROOT)
            except ValueError:
                pass
        return str(p).replace("\\", "/")

    def stats(self) -> dict[str, Any]:
        with self._conn() as c:
            return {
                "components": c.execute("SELECT COUNT(*) FROM components").fetchone()[0],
                "protected": c.execute(
                    "SELECT COUNT(*) FROM components WHERE protected=1"
                ).fetchone()[0],
                "tasks_active": c.execute(
                    "SELECT COUNT(*) FROM tasks WHERE status='in_progress'"
                ).fetchone()[0],
                "tasks_total": c.execute("SELECT COUNT(*) FROM tasks").fetchone()[0],
                "decisions": c.execute("SELECT COUNT(*) FROM decisions").fetchone()[0],
            }


# Module-level singleton
_state: ProjectState | None = None


def get_state() -> ProjectState:
    global _state
    if _state is None:
        _state = ProjectState()
    return _state
