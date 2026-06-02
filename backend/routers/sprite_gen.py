"""
Sprite Generation router — POST /api/sprite-gen/*

Handles character sprite sheet generation via GPT-Image-2 + rembg + atlas.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from backend.ws import broadcast_manager

router = APIRouter(prefix="/api/sprite-gen", tags=["sprite-gen"])


# ---- Request/Response models -----------------------------------------------

class SpriteGenRequest(BaseModel):
    description: str
    animations: list[str] | None = None   # default: idle/walk/attack/hurt/death
    # Grid generation (v2 default): 3x3 = 9 frames, up to 4x3/3x4 (~12).
    rows: int = 3
    cols: int = 3
    # Legacy 1xN override — if set, frames are a single row of this many frames.
    frames_per_anim: int | None = None
    style: str = "pixel_art"              # pixel_art | vector | hand_painted | cartoon
    sprite_size: list[int] = [64, 64]     # [width, height] cell-size hint
    output_dir: str | None = None


class SpriteGenResponse(BaseModel):
    character_name: str
    output_dir: str
    atlas_path: str
    frames_json_path: str
    seed_path: str | None = None
    style_anchor: str = ""
    strips: list[dict[str, Any]]
    cost_usd: float


class AssetGenStatus(BaseModel):
    task_id: str
    status: str  # pending | running | done | error
    result: dict[str, Any] | None = None
    error: str | None = None


# ---- In-memory task store (MVP — replace with Redis/DB for prod) -----------
_tasks: dict[str, AssetGenStatus] = {}


# ---- Endpoints -------------------------------------------------------------

@router.post("/character", response_model=SpriteGenResponse)
async def generate_character_sprite(req: SpriteGenRequest) -> SpriteGenResponse:
    """
    Generate a character sprite sheet set.

    Blocks until complete (typically 30-120s depending on animation count).
    For async progress, connect to WS /ws/progress before calling this.
    """
    from agents.sprite_pipeline import generate_character_spritesheet

    await broadcast_manager.push("sprite_gen_start", {
        "description": req.description,
        "animations": req.animations,
        "style": req.style,
    })

    try:
        result = await generate_character_spritesheet(
            req.description,
            animations=req.animations,
            frames_per_anim=req.frames_per_anim,
            rows=req.rows,
            cols=req.cols,
            style=req.style,
            sprite_size=tuple(req.sprite_size),  # type: ignore[arg-type]
            output_dir=Path(req.output_dir) if req.output_dir else None,
        )
    except Exception as e:
        await broadcast_manager.push("sprite_gen_error", {"error": str(e)[:300]})
        raise HTTPException(status_code=500, detail=f"Sprite generation failed: {e}") from None

    await broadcast_manager.push("sprite_gen_done", {
        "atlas": str(result.atlas_path),
        "cost_usd": result.cost_usd,
    })

    return SpriteGenResponse(
        character_name=result.character_name,
        output_dir=str(result.output_dir),
        atlas_path=str(result.atlas_path),
        frames_json_path=str(result.frames_json_path),
        seed_path=str(result.seed_path) if result.seed_path else None,
        style_anchor=result.style_anchor,
        strips=[
            {
                "name": s.name,
                "path": str(s.path),
                "frame_count": s.frame_count,
                "frame_width": s.frame_width,
                "frame_height": s.frame_height,
                "rows": s.rows,
                "cols": s.cols,
                "frames": s.frames,
            }
            for s in result.strips
        ],
        cost_usd=result.cost_usd,
    )
