"""
State router — ProjectState API endpoints.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/state", tags=["state"])


@router.get("/snapshot")
async def get_snapshot() -> dict:
    """Return current ProjectState snapshot."""
    from core.project_state import get_state
    return get_state().snapshot()


@router.get("/stats")
async def get_stats() -> dict:
    """Return counts: components, protected, tasks_active, decisions."""
    from core.project_state import get_state
    return get_state().stats()
