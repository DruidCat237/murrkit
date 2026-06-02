"""
Persistent project memory for the murrkit orchestrator.

Three responsibilities, all backed by `.omc/state/`:

1. **Session map** — the per-project Claude CLI `session_id` used for
   `--resume`. `chat.py` previously held this only in RAM
   (`_session_by_project`), so a backend restart silently orphaned every
   conversation: the next turn started a brand-new Claude session with no
   memory of the design, the assets, or the open bugs. We now mirror that
   dict to `.omc/state/sessions.json` (load-on-import, save-on-update) so
   continuity survives restarts.

2. **Progress doc** — `.omc/state/<project>/progress.md`: a human- and
   model-readable log of design decisions, what's done, and open bugs.
   Auto-injected into the system prompt every turn so the inner Claude
   resumes with real context instead of re-deriving it.

3. **Failure-log tail** — the last N entries of the project-wide
   `.omc/state/failure_log.json` (written by chat.py's guard machinery),
   formatted for prompt injection so prior-session lessons actually reach
   the model.

Disk IO follows the same convention as the rest of the codebase: atomic
`tmp.replace(target)` writes; reads tolerate a missing/corrupt file by
returning empty rather than crashing the chat stream (a corrupt cache must
never take down a live conversation). Real *logic* errors are NOT swallowed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger

from core.config import PROJECT_ROOT

# ---- Paths -----------------------------------------------------------------

_STATE_ROOT = PROJECT_ROOT / ".omc" / "state"
_SESSIONS_PATH = _STATE_ROOT / "sessions.json"
_FAILURE_LOG_PATH = _STATE_ROOT / "failure_log.json"


def _project_state_dir(project: str) -> Path:
    """`.omc/state/<project>/` — created on demand."""
    d = _STATE_ROOT / (project or "default")
    d.mkdir(parents=True, exist_ok=True)
    return d


def progress_path(project: str) -> Path:
    """Absolute path to a project's `progress.md` (not created here)."""
    return _project_state_dir(project) / "progress.md"


def design_path(project: str) -> Path:
    """Absolute path to a project's approved `design.md` GDD (not created here).

    The GDD gate in the system prompt instructs the inner Claude to persist
    the user-APPROVED Game Design Doc here before writing any game code.
    """
    return _project_state_dir(project) / "design.md"


# ---- 1. Persisted session map ----------------------------------------------


def load_sessions() -> dict[str, str]:
    """Load the persisted {project: claude_session_id} map.

    Returns an empty dict when the file is absent or unreadable — a missing
    cache is simply "no prior sessions", which is correct on first run.
    """
    if not _SESSIONS_PATH.is_file():
        return {}
    try:
        data = json.loads(_SESSIONS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("project_memory: sessions.json unreadable ({e}); starting empty", e=e)
        return {}
    if not isinstance(data, dict):
        logger.warning("project_memory: sessions.json not an object; starting empty")
        return {}
    # Coerce to the expected shape: str -> str.
    return {str(k): str(v) for k, v in data.items() if v}


def save_sessions(sessions: dict[str, str]) -> None:
    """Persist the whole {project: session_id} map atomically.

    Disk failures are logged but never raised — losing the persisted cache
    must not crash a live chat stream. The in-RAM dict remains authoritative
    for the current process either way.
    """
    try:
        _STATE_ROOT.mkdir(parents=True, exist_ok=True)
        tmp = _SESSIONS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(sessions, indent=2), encoding="utf-8")
        tmp.replace(_SESSIONS_PATH)
    except OSError as e:
        logger.warning("project_memory: failed to persist sessions.json ({e})", e=e)


def update_session(project: str, session_id: str) -> None:
    """Record one project's session id, merging with whatever is on disk.

    Re-reads the file first so a save from another worker/process isn't
    clobbered. No-op when project or session_id is empty.
    """
    if not project or not session_id:
        return
    sessions = load_sessions()
    if sessions.get(project) == session_id:
        return  # already current — skip the write
    sessions[project] = session_id
    save_sessions(sessions)


# ---- 2. Progress doc -------------------------------------------------------


def read_progress(project: str) -> str:
    """Return the raw text of `<project>/progress.md`, or "" if none exists."""
    p = progress_path(project)
    if not p.is_file():
        return ""
    try:
        return p.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning("project_memory: progress.md unreadable for {p} ({e})", p=project, e=e)
        return ""


def write_progress(project: str, content: str) -> Path:
    """Overwrite `<project>/progress.md` atomically; return its path."""
    p = progress_path(project)
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(p)
    return p


# ---- 3. Failure-log tail ---------------------------------------------------


def failure_log_tail(project: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    """Return the last `limit` entries of the project-wide failure log.

    When `project` is given, only that project's entries are considered (the
    log is shared across projects). Tolerates a missing/corrupt file by
    returning an empty list.
    """
    if not _FAILURE_LOG_PATH.is_file():
        return []
    try:
        store = json.loads(_FAILURE_LOG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("project_memory: failure_log.json unreadable ({e})", e=e)
        return []
    entries = store.get("entries", []) if isinstance(store, dict) else []
    if project:
        entries = [e for e in entries if e.get("project") == project]
    return entries[-limit:]
