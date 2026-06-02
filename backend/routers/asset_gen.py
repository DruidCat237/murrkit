"""
Asset Generation router — POST /api/asset-gen/*

Handles backgrounds, tilesets, UI elements, particle FX generation.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.ws import broadcast_manager

router = APIRouter(prefix="/api/asset-gen", tags=["asset-gen"])


class BackgroundRequest(BaseModel):
    description: str
    layers: list[str] | None = None  # default: sky/far/mid/near
    output_dir: str | None = None


class TilesetRequest(BaseModel):
    description: str
    tile_type: str = "ground"  # ground | wall | platform | decoration
    output_dir: str | None = None


class UIElementRequest(BaseModel):
    description: str
    element_type: str = "button"  # button | panel | health_bar | icon | frame
    output_dir: str | None = None


class ParticleFXRequest(BaseModel):
    description: str
    fx_type: str = "dust"  # dust | spark | impact | magic | smoke
    output_dir: str | None = None


class AssetGenResponse(BaseModel):
    asset_type: str
    name: str
    output_dir: str
    files: list[str]
    metadata: dict
    cost_usd: float


async def _result_to_response(result: object) -> AssetGenResponse:
    d = result.as_dict()  # type: ignore[attr-defined]
    return AssetGenResponse(
        asset_type=d["asset_type"],
        name=d["name"],
        output_dir=d["output_dir"],
        files=d["files"],
        metadata=d["metadata"],
        cost_usd=d["cost_usd"],
    )


@router.post("/background", response_model=AssetGenResponse)
async def generate_background(req: BackgroundRequest) -> AssetGenResponse:
    """Generate parallax background layers."""
    from agents.asset_pipeline import generate_background as _gen

    await broadcast_manager.push("asset_gen_start", {"type": "background", "description": req.description})
    try:
        result = await _gen(
            req.description,
            layers=req.layers,
            output_dir=Path(req.output_dir) if req.output_dir else None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from None

    await broadcast_manager.push("asset_gen_done", {"type": "background", "files": [str(f) for f in result.files]})
    return await _result_to_response(result)


@router.post("/tileset", response_model=AssetGenResponse)
async def generate_tileset(req: TilesetRequest) -> AssetGenResponse:
    """Generate a tileset sheet."""
    from agents.asset_pipeline import generate_tileset as _gen

    await broadcast_manager.push("asset_gen_start", {"type": "tileset", "description": req.description})
    try:
        result = await _gen(
            req.description,
            tile_type=req.tile_type,
            output_dir=Path(req.output_dir) if req.output_dir else None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from None

    await broadcast_manager.push("asset_gen_done", {"type": "tileset"})
    return await _result_to_response(result)


@router.post("/ui-element", response_model=AssetGenResponse)
async def generate_ui_element(req: UIElementRequest) -> AssetGenResponse:
    """Generate a UI element PNG."""
    from agents.asset_pipeline import generate_ui_element as _gen

    await broadcast_manager.push("asset_gen_start", {"type": "ui_element", "description": req.description})
    try:
        result = await _gen(
            req.description,
            element_type=req.element_type,
            output_dir=Path(req.output_dir) if req.output_dir else None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from None

    await broadcast_manager.push("asset_gen_done", {"type": "ui_element"})
    return await _result_to_response(result)


@router.post("/particle-fx", response_model=AssetGenResponse)
async def generate_particle_fx(req: ParticleFXRequest) -> AssetGenResponse:
    """Generate a particle effect sprite sheet."""
    from agents.asset_pipeline import generate_particle_fx as _gen

    await broadcast_manager.push("asset_gen_start", {"type": "particle_fx", "description": req.description})
    try:
        result = await _gen(
            req.description,
            fx_type=req.fx_type,
            output_dir=Path(req.output_dir) if req.output_dir else None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from None

    await broadcast_manager.push("asset_gen_done", {"type": "particle_fx"})
    return await _result_to_response(result)
