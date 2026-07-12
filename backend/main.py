"""
FastAPI backend for murrkit — port 8001.

Phaser-based game-dev orchestrator. Drops the legacy engine-MCP / engine-files /
engine-hub / game-build routers; keeps everything Kitty / Gemini / DeepSeek /
gen-queue / vision / references / chat / etc. that's engine-agnostic.

Endpoints:
    GET  /health                   — liveness
    GET  /api/status               — config snapshot (model, budget)
    POST /api/chat                 — non-streaming chat
    WS   /ws/progress              — generic progress broadcast
    WS   /ws/gen-queue             — generation queue events

    /api/sprite-gen/*              — sprite sheet generation (Kitty / GPT-Image-2)
    /api/asset-gen/*               — generic 2D asset generation
    /api/bg-removal/*              — BiRefNet/U2Net bg removal
    /api/vision/*                  — Gemini compare / DeepSeek triage
    /api/gen-queue/*               — bounded-concurrency generation queue
    /api/projects/*                — project management
    /api/state/*                   — ProjectState API
    /api/references/*              — user reference materials

    GET  /files/{filename}         — static file serving

Security:
    - CORS: localhost:3001 only
    - Bearer token (auto-generated, in .env BACKEND_AUTH_TOKEN)
"""

from __future__ import annotations

import asyncio
import json
import sys
from contextlib import asynccontextmanager
from typing import AsyncIterator

# Force ProactorEventLoop on Windows (SelectorEventLoop has no subprocess support)
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pydantic import BaseModel

from core.config import PROJECT_ROOT, budget, settings
from backend.ws import broadcast_manager


# ---- Lifespan ---------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    logger.info(
        "murrkit backend starting on {h}:{p} (budget=${b:.2f})",
        h=settings.backend_host,
        p=settings.backend_port,
        b=settings.budget_limit_usd,
    )
    # Ensure public_files dir exists (for image staging)
    (PROJECT_ROOT / "public_files").mkdir(parents=True, exist_ok=True)
    (PROJECT_ROOT / "public_files" / "screenshots").mkdir(parents=True, exist_ok=True)

    # Pre-warm rembg's 175MB U2Net model in a background thread so the FIRST
    # sprite generation isn't blocked by a one-off model download.
    async def _prewarm_rembg() -> None:
        def _download() -> None:
            try:
                from rembg import new_session  # type: ignore[import]
                new_session()
                logger.info("rembg U2Net model ready")
            except BaseException as e:  # noqa: BLE001
                logger.debug("rembg prewarm skipped: {t}: {e}", t=type(e).__name__, e=e)
        await asyncio.to_thread(_download)
    asyncio.create_task(_prewarm_rembg())

    # Keep the Vite game dev-server alive: auto-start on boot + revive within
    # ~10s if it crashes or pipe-wedges. Fixes "the game keeps disappearing".
    asyncio.create_task(phaser_router.vite_watchdog())

    yield

    logger.info("Backend stopping. Total spent: ${s:.4f}", s=budget.spent_usd)


app = FastAPI(title="murrkit Backend", version="0.1.0", lifespan=lifespan)

# CORS — Next.js dev on :3001
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3001", "http://127.0.0.1:3001"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS", "PUT", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=600,
)

# Static files for image staging + screenshots
_public_dir = PROJECT_ROOT / "public_files"
_public_dir.mkdir(parents=True, exist_ok=True)
app.mount("/files", StaticFiles(directory=str(_public_dir)), name="public_files")

# Also expose phaser_game/public for asset preview from dashboard UI
_phaser_assets = PROJECT_ROOT / "public" / "assets"
if _phaser_assets.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_phaser_assets)), name="phaser_assets")

# Routers — legacy engine-specific routers intentionally dropped during the
# migration (see CLAUDE.md "Migration" section).
from backend.routers import (
    sprite_gen,
    asset_gen,
    projects,
    state as state_router,
    chat as chat_router,
    settings as settings_router,
    library as library_router,
    logs as logs_router,
    smoke as smoke_router,
    usage as usage_router,
    context as context_router,
    animation as animation_router,
    gen_queue as gen_queue_router,
    kitty as kitty_router,
    bg_removal as bg_removal_router,
    admin as admin_router,
    templates as templates_router,
    template_lib as template_lib_router,
    qwen as qwen_router,
    vision as vision_router,
    references as references_router,
    phaser as phaser_router,
    spritesheet_import as spritesheet_import_router,
    fs as fs_router,
    maps as maps_router,
)
from backend.services import gen_queue as gen_queue_svc

app.include_router(sprite_gen.router)
app.include_router(asset_gen.router)
app.include_router(projects.router)
app.include_router(state_router.router)
app.include_router(chat_router.router)
app.include_router(settings_router.router)
app.include_router(library_router.router)
app.include_router(logs_router.router)
app.include_router(smoke_router.router)
app.include_router(usage_router.router)
app.include_router(context_router.router)
app.include_router(animation_router.router)
app.include_router(gen_queue_router.router)
app.include_router(kitty_router.router)
app.include_router(bg_removal_router.router)
app.include_router(admin_router.router)
app.include_router(templates_router.router)
app.include_router(template_lib_router.router)
app.include_router(qwen_router.router)
app.include_router(vision_router.router)
app.include_router(references_router.router)
app.include_router(phaser_router.router)
app.include_router(spritesheet_import_router.router)
app.include_router(fs_router.router)
app.include_router(maps_router.router)


# ---- Auth helper ------------------------------------------------------------
def _check_auth(authorization: str | None) -> None:
    if not settings.backend_auth_token:
        return
    expected = f"Bearer {settings.backend_auth_token}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ---- Models -----------------------------------------------------------------
class ChatRequest(BaseModel):
    message: str
    system: str | None = None


class ChatResponse(BaseModel):
    text: str
    cost_usd: float
    input_tokens: int
    output_tokens: int


class StatusResponse(BaseModel):
    model: str
    budget_limit_usd: float
    budget_spent_usd: float
    budget_remaining_usd: float
    phaser_game_path: str
    backend_port: int
    feature_flags: dict[str, bool]


# ---- Core endpoints ---------------------------------------------------------
@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status", response_model=StatusResponse)
async def status() -> StatusResponse:
    return StatusResponse(
        model=settings.deepseek_model,
        budget_limit_usd=settings.budget_limit_usd,
        budget_spent_usd=budget.spent_usd,
        budget_remaining_usd=budget.remaining_usd,
        phaser_game_path=str(PROJECT_ROOT / "phaser_game"),
        backend_port=settings.backend_port,
        feature_flags={
            "tester": settings.enable_tester_agent,
            "audio": settings.enable_audio_agent,
        },
    )


@app.post("/api/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    authorization: str | None = Header(default=None),
) -> ChatResponse:
    _check_auth(authorization)
    from core.llm import complete

    system = req.system or (
        "You are murrkit — orchestrator for autonomous Phaser 3 + TypeScript "
        "2D game development. Be concise and propose concrete next actions."
    )
    result = await complete(system=system, user=req.message, max_tokens=2048)
    return ChatResponse(
        text=result.text,
        cost_usd=result.cost_usd,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
    )


# ---- WebSocket progress broadcast ------------------------------------------
@app.websocket("/ws/progress")
async def ws_progress(ws: WebSocket) -> None:
    await broadcast_manager.connect(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        broadcast_manager.disconnect(ws)
        logger.debug("WebSocket client disconnected.")


@app.websocket("/ws/gen-queue")
async def ws_gen_queue_root(ws: WebSocket) -> None:
    """Generation queue events — pushes {event, task} payloads.

    Honours `?project=<name>` for the initial snapshot so the client only
    receives its active project's history.
    """
    project = ws.query_params.get("project") or None
    await gen_queue_svc.register_ws(ws, project=project)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"event": "pong"}))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        gen_queue_svc.unregister_ws(ws)


# ---- Entry point ------------------------------------------------------------
def _force_proactor_loop_on_windows() -> None:
    """Stop uvicorn from clobbering our ProactorEventLoop on Windows.

    uvicorn/loops/asyncio.py:asyncio_setup() hardcodes
    `asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())`
    on Windows — uvicorn does this because httptools/h11 historically had
    issues with ProactorEventLoop, but it breaks Python Playwright which
    REQUIRES Proactor for subprocess support (selector raises NotImplementedError
    in _make_subprocess_transport).

    We replace uvicorn's setup function with a no-op so our top-level policy
    (set above before any FastAPI import) survives into the request loop.
    """
    if sys.platform != "win32":
        return
    try:
        import uvicorn.loops.asyncio as _ual
    except ImportError:
        return
    def _noop_asyncio_setup(*_a, **_kw) -> None:
        # Re-apply Proactor policy at uvicorn's setup time to be safe.
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    _ual.asyncio_setup = _noop_asyncio_setup  # type: ignore[attr-defined]


def run() -> None:
    import uvicorn

    _force_proactor_loop_on_windows()
    uvicorn.run(
        "backend.main:app",
        host=settings.backend_host,
        port=settings.backend_port,
        reload=False,
        log_level=settings.log_level.lower(),
        loop="asyncio",  # route through our patched asyncio_setup
    )


if __name__ == "__main__":
    run()
