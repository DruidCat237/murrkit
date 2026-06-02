"""
Usage router — surface GPT-Image-2 call counts + cost to the UI.

Endpoints:
    GET  /api/usage/gpt-image-2?project=X&since_ts=Y   — aggregate + recent calls
    WS   /api/usage/gpt-image-2/live                   — push every new event
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel

from backend.usage_tracker import tracker

router = APIRouter(prefix="/api/usage", tags=["usage"])


class UsageCall(BaseModel):
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


class UsageReport(BaseModel):
    total_calls: int
    total_cost_usd: float
    by_resolution: dict[str, dict[str, Any]]
    by_day: dict[str, dict[str, Any]]
    calls: list[UsageCall]


@router.get("/gpt-image-2", response_model=UsageReport)
async def get_gpt_image_2_usage(
    project: str | None = None,
    since_ts: str | None = None,
    limit: int = 200,
) -> UsageReport:
    """Return aggregated GPT-Image-2 usage + recent calls."""
    agg = tracker.aggregate(project=project, since_ts=since_ts)
    calls = tracker.list_calls(project=project, since_ts=since_ts, limit=limit)
    return UsageReport(
        total_calls=agg["total_calls"],
        total_cost_usd=agg["total_cost_usd"],
        by_resolution=agg["by_resolution"],
        by_day=agg["by_day"],
        calls=[UsageCall(**c.__dict__) for c in calls],
    )


@router.websocket("/gpt-image-2/live")
async def gpt_image_2_live(ws: WebSocket) -> None:
    """Stream new usage events to the client as they happen."""
    await tracker.attach(ws)
    try:
        while True:
            # Drain any pings from the client (keepalive)
            await ws.receive_text()
    except WebSocketDisconnect:
        tracker.detach(ws)
    except Exception as e:  # noqa: BLE001
        logger.warning("Usage WS error: {e}", e=str(e)[:200])
        tracker.detach(ws)
