"""
Admin router — hot-reload backend routers in-process.

Lets you edit a Python file in `backend/routers/*.py` and re-import it
without restarting uvicorn (which would lose the live chat session
ids, queue state, websocket subscriptions, prewarmed rembg sessions).

Endpoints:
    GET  /api/admin/reloadable  — list routers that can be reloaded
    POST /api/admin/reload      — { router: "<name>" } → importlib.reload

Safety: only routers under `backend.routers.*` can be reloaded; core
modules (config, llm, mcp_client_unity) need a full restart because
they hold state other code captured at import time.
"""

from __future__ import annotations

import importlib
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Routers we know are safe to reload — pure FastAPI surface, no global
# state that other modules captured. Hand-curated to avoid surprises.
_RELOADABLE = {
    "bg_removal",
    "chat",
    "gen_queue",
    "kitty",
    "library",
    "projects",
    "settings",
    "smoke",
    "sprite_gen",
    "asset_gen",
    "templates",
    "unity",
    "unity_files",
    "unity_hub",
    "qwen",
}


class ReloadRequest(BaseModel):
    router: str


@router.get("/reloadable")
async def list_reloadable() -> dict[str, list[str]]:
    return {"routers": sorted(_RELOADABLE)}


@router.post("/reload")
async def reload_router(req: ReloadRequest) -> dict[str, Any]:
    name = req.router.strip()
    if name not in _RELOADABLE:
        raise HTTPException(
            status_code=400,
            detail=f"router '{name}' not in reloadable set: {sorted(_RELOADABLE)}",
        )
    mod_name = f"backend.routers.{name}"
    try:
        import sys
        mod = sys.modules.get(mod_name)
        started = time.time()
        if mod is None:
            mod = importlib.import_module(mod_name)
            kind = "imported"
        else:
            mod = importlib.reload(mod)
            kind = "reloaded"
        elapsed_ms = int((time.time() - started) * 1000)
        logger.info("admin: {k} {m} in {ms} ms", k=kind, m=mod_name, ms=elapsed_ms)
        # NOTE: this does NOT re-register the router into the running FastAPI
        # app. Existing routes still point at the OLD function objects. For
        # most tweaks (response shapes, query logic) the user only needs the
        # new module bound under the same import path for tools that import
        # it directly. Live-route hot-swap requires app.router.routes mutation
        # which is risky — skip for now and document.
        return {
            "ok": True,
            "kind": kind,
            "module": mod_name,
            "elapsed_ms": elapsed_ms,
            "note": "module re-imported; FastAPI route handlers still point at "
                    "the pre-reload functions. Use this to refresh helper "
                    "functions (price tables, prompt rules) that other code "
                    "imports lazily. For route handler changes, full uvicorn "
                    "restart is still needed.",
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("admin reload failed")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from None
