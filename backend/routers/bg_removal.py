"""
Background-removal router — local rembg + alpha-matting via onnxruntime.

Endpoints
    GET   /api/bg-removal/models                — list available rembg models
    POST  /api/bg-removal/strip                 — strip background on ONE file
    POST  /api/bg-removal/strip-unity-atlas     — strip + overwrite a sprite atlas
                                                  in the active game project
                                                  (with AssetDatabase.Refresh)

The agent uses these instead of regenerating an asset when the visible bug
is "white halo around the character" or "background partially cut".
"""

from __future__ import annotations

import asyncio
import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel

from core.config import settings
from tools.rembg_wrapper import (
    default_model_for,
    list_models,
    remove_background,
)

router = APIRouter(prefix="/api/bg-removal", tags=["bg-removal"])


class StripRequest(BaseModel):
    """Strip bg on a file. Either pass `abs_path` (local file) or
    `unity_rel_path` (resolved relative to `<unity_project>/Assets/`)."""
    abs_path: str | None = None
    unity_rel_path: str | None = None
    output_path: str | None = None  # if None: <input>_nobg.png next to source
    model: str | None = None  # default: birefnet-general for sprites/anything
    asset_type: str = "sprite"  # picks default model when `model` is None
    alpha_matting: bool = True
    in_place: bool = False  # overwrite the input — used by the atlas helper


class StripResponse(BaseModel):
    ok: bool
    output_path: str
    model: str
    elapsed_ms: int


@router.get("/models")
async def get_models() -> dict[str, Any]:
    """List available rembg models + the default mapping per asset type."""
    return {
        "models": list_models(),
        "defaults": {
            "sprite": default_model_for("sprite"),
            "background": default_model_for("background"),
            "tileset": default_model_for("tileset"),
            "ui_element": default_model_for("ui_element"),
            "sprite_silhouette": default_model_for("sprite_silhouette"),
        },
        "guidance": {
            "birefnet-general": "DEFAULT. Preserves stars/hearts/sparkles around "
                                "characters. ~5 s warmed, ~50 s first-run "
                                "(973 MB download).",
            "isnet-anime": "Tighter silhouette — strips decorations. Use for "
                           "icons or when you want JUST the character.",
            "u2net": "Old default. Confuses white characters with white "
                     "background. Avoid for white-fur cats.",
            "bria-rmbg": "Strong general alternative.",
        },
    }


def _resolve_input(req: StripRequest) -> Path:
    if req.abs_path:
        p = Path(req.abs_path).resolve()
    elif req.unity_rel_path:
        if ".." in req.unity_rel_path.split("/"):
            raise HTTPException(status_code=400, detail="invalid path")
        base = (settings.unity_project_path / "Assets").resolve()
        p = (base / req.unity_rel_path).resolve()
        try:
            p.relative_to(base)
        except ValueError:
            raise HTTPException(status_code=400, detail="path escapes Assets/") from None
    else:
        raise HTTPException(
            status_code=400, detail="abs_path or unity_rel_path required"
        )
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"input not found: {p}")
    return p


@router.post("/strip", response_model=StripResponse)
async def strip(req: StripRequest) -> StripResponse:
    """Strip background on ONE file. Returns where the output landed."""
    src = _resolve_input(req)
    model = req.model or default_model_for(req.asset_type)

    if req.in_place:
        out = src
    elif req.output_path:
        out = Path(req.output_path).resolve()
    else:
        out = src.with_name(f"{src.stem}_nobg.png")

    started = time.time()
    # rembg is CPU-bound — run in thread to keep the event loop free.
    await asyncio.to_thread(
        remove_background,
        src,
        out,
        model=model,
        alpha_matting=req.alpha_matting,
    )
    elapsed_ms = int((time.time() - started) * 1000)
    logger.info(
        "bg-removal: {src} -> {out} model={m} alpha={a} took {ms} ms",
        src=src.name, out=out.name, m=model, a=req.alpha_matting, ms=elapsed_ms,
    )
    return StripResponse(
        ok=True, output_path=str(out), model=model, elapsed_ms=elapsed_ms,
    )


@router.post("/strip-unity-atlas")
async def strip_unity_atlas(req: StripRequest) -> dict[str, Any]:
    """Strip background on a sprite atlas IN-PLACE + trigger an
    AssetDatabase.Refresh so the new alpha shows up in the engine immediately.

    Path is relative to `<unity_project>/Assets/`. A backup of the original
    is saved next to it as `<name>.original.png` on the first call.
    """
    if not req.unity_rel_path:
        raise HTTPException(status_code=400, detail="unity_rel_path required")
    src = _resolve_input(req)
    # Back up original on first call so we can rewind.
    backup = src.with_suffix(".original.png")
    if not backup.exists():
        shutil.copyfile(src, backup)
        logger.info("bg-removal: backed up {p} -> {b}", p=src.name, b=backup.name)

    model = req.model or default_model_for(req.asset_type)
    started = time.time()
    await asyncio.to_thread(
        remove_background,
        src,
        src,  # in-place
        model=model,
        alpha_matting=req.alpha_matting,
    )
    elapsed_ms = int((time.time() - started) * 1000)

    return {
        "ok": True,
        "output_path": str(src),
        "backup_path": str(backup),
        "model": model,
        "elapsed_ms": elapsed_ms,
    }
