"""
Game template library — pre-baked builders for common 2D game genres.

Each template ships with:
  - C# script set in `templates/<name>/` (game logic + AI scaffold)
  - JSON scene spec (objects, components, default values, anchors)
  - Reference baseline screenshot for `/api/templates/diff`
  - Cost estimate + asset requirements list

Endpoints:
    GET  /api/templates/list                — every available template + metadata
    POST /api/templates/build               — apply template to active game project
    POST /api/templates/diff                — pixel-diff current game view against baseline

First-class templates this session:
    - cat-tac-toe        : 3×3 board, white player vs minimax AI black, learned
                           from session #1's hard-won fixes (Physics2DRaycaster,
                           Center pivot, no-tint win highlight, BottomCenter
                           Restart anchored INSIDE Canvas Overlay).
    - connect-four       : (planned for next session)
    - simple-puzzle      : (planned)
"""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel

from core.config import PROJECT_ROOT, settings

router = APIRouter(prefix="/api/templates", tags=["templates"])

TEMPLATES_DIR = PROJECT_ROOT / "templates" / "games"
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)


# ---- Template registry ------------------------------------------------------


class TemplateRequirement(BaseModel):
    asset_type: str  # sprite | background | ui | sfx
    name: str
    prompt_hint: str
    aspect_ratio: str = "1:1"
    resolution: str = "1K"
    quality: str = "high"


class TemplateMeta(BaseModel):
    id: str
    title: str
    genre: str
    description: str
    requires: list[TemplateRequirement]
    estimated_cost_usd: float
    baseline_screenshot: str | None = None  # path under templates/ to ref image
    scripts: list[str]  # .cs files to deploy under Assets/Scripts/
    scene_spec: dict[str, Any]  # what to wire in the scene


_TEMPLATES: dict[str, TemplateMeta] = {
    "cat-tac-toe": TemplateMeta(
        id="cat-tac-toe",
        title="Cat-Tac-Toe (refined)",
        genre="board",
        description=(
            "3×3 tic-tac-toe with cute cat sprites. Human (white) vs AI "
            "(black, minimax + α-β + 0.15 randomness). Wraps every lesson "
            "from session #1: Physics2DRaycaster on Main Camera, "
            "BoxCollider2D=(1.35, 1.05) per cell, SpriteRenderer.size=0.75 "
            "with Center pivot, win-highlight as scale pulse not colour "
            "tint, RestartButton Screen-Space-Overlay anchored center."
        ),
        requires=[
            TemplateRequirement(
                asset_type="sprite",
                name="player_cat",
                prompt_hint=(
                    "cute chibi cat character, sprite sheet 2 frames horizontal "
                    "(idle + win pose), transparent background, kawaii style, "
                    "centered isolated, no text"
                ),
                aspect_ratio="2:1",
                resolution="1K",
                quality="high",
            ),
            TemplateRequirement(
                asset_type="sprite",
                name="ai_cat",
                prompt_hint=(
                    "cute chibi cat in a contrasting colour to player_cat, "
                    "sprite sheet 2 frames (idle + win), transparent bg, kawaii"
                ),
                aspect_ratio="2:1",
                resolution="1K",
                quality="high",
            ),
            TemplateRequirement(
                asset_type="background",
                name="board_top_down",
                prompt_hint=(
                    "top-down view of a cute cozy 3x3 tic-tac-toe board, warm "
                    "wooden plank with painted black grid lines, soft warm "
                    "lighting, square format, NO characters NO symbols inside "
                    "cells, storybook illustration"
                ),
                aspect_ratio="1:1",
                resolution="2K",
                quality="high",
            ),
        ],
        estimated_cost_usd=0.21 * 2 + 0.32,  # 2 sprites @ 1K high + 1 bg @ 2K high
        baseline_screenshot="cat-tac-toe/baseline.png",
        scripts=["CatTacToeGame.cs", "CatTacToeCell.cs", "CatWinAnimator.cs"],
        scene_spec={
            "scene_name": "CatTacToe",
            "canvas_render_mode": "ScreenSpaceOverlay",
            "main_camera": {
                "orthographic_size": 3.5,
                "components": ["Physics2DRaycaster"],
            },
            "cells": {
                "count": 9,
                "name_pattern": "Cell_{i}",
                "grid": {"cols": 3, "rows": 3, "spacing": 1.45},
                "sprite_renderer": {
                    "drawMode": "Sliced",
                    "size": [0.75, 0.75],
                    "color": [1, 1, 1, 1],
                    "sortingOrder": 5,
                },
                "box_collider2d": {
                    "size": [1.35, 1.05],
                    "offset": [0, 0],
                    "isTrigger": False,
                },
                "script": "CatTacToeCell",
            },
            "game_manager": {
                "name": "GameManager",
                "script": "CatTacToeGame",
                "fields": {
                    "aiRandomness": 0.15,
                    "aiThinkDelay": 0.55,
                },
            },
            "restart_button": {
                "parent": "Canvas",
                "anchor": "center",
                "anchored_position": [0, -240],
                "size": [280, 80],
                "image_color": [0.961, 0.902, 0.827, 0.97],
                "label_text": "Zagraj ponownie",
                "label_font_size": 28,
                "label_color": [0.290, 0.227, 0.165, 1.0],
                "hide_until_game_over": True,
            },
            "status_text": {
                "anchor": "top",
                "panel_color": [0.290, 0.227, 0.165, 0.85],
                "text_color": [0.976, 0.961, 0.929, 1.0],
                "font_size": 32,
                "outline": True,
            },
        },
    ),
}


# ---- Endpoints --------------------------------------------------------------


@router.get("/list")
async def list_templates() -> dict[str, Any]:
    """List every available game template + per-template cost estimate."""
    return {
        "templates": [t.model_dump() for t in _TEMPLATES.values()],
        "count": len(_TEMPLATES),
    }


class BuildRequest(BaseModel):
    template_id: str
    project: str = "default"
    dry_run: bool = False
    skip_asset_check: bool = False
    accept: bool = False  # explicit ACCEPT before money spent


@router.post("/build")
async def build_template(req: BuildRequest) -> dict[str, Any]:
    """Apply a template to the active game project.

    Workflow (per Listening + Honest verification rules):
      1. Pre-flight: scan <game_project>/Assets/Generated/Sprites + Backgrounds for
         existing assets that match template.requires[].name. Reuse if found.
      2. Plan missing assets + emit cost preview.
      3. If not `accept`: return plan + ask user to call with accept=true.
      4. If accept: enqueue missing gens, deploy scripts, wire scene per
         scene_spec.

    Returns:
        {plan, missing_assets, estimated_cost, ready_to_run}
    """
    tpl = _TEMPLATES.get(req.template_id)
    if tpl is None:
        raise HTTPException(status_code=404, detail=f"unknown template '{req.template_id}'")

    # Pre-flight asset check
    unity_assets = settings.unity_project_path / "Assets" / "Generated"
    have, missing = [], []
    for r in tpl.requires:
        # Match by name slug — sprite_pipeline writes <slug>_atlas.png
        slug = r.name.lower().replace(" ", "_")
        candidates: list[Path] = []
        if r.asset_type == "sprite":
            search = unity_assets / "Sprites"
            if search.is_dir():
                candidates = list(search.rglob(f"*{slug}*_atlas.png"))
        elif r.asset_type == "background":
            search = unity_assets / "Backgrounds"
            if search.is_dir():
                candidates = list(search.rglob(f"*{slug}*.png"))
        if candidates and not req.skip_asset_check:
            have.append({"name": r.name, "path": str(candidates[0]), "type": r.asset_type})
        else:
            missing.append(r.model_dump())

    estimated_cost = sum(
        # Mirror the gpt-image-2 pricing in chat.py prompt rules
        {
            ("1K", "low"): 0.10, ("1K", "medium"): 0.14, ("1K", "high"): 0.21,
            ("2K", "low"): 0.15, ("2K", "medium"): 0.21, ("2K", "high"): 0.32,
            ("4K", "low"): 0.40, ("4K", "medium"): 0.56, ("4K", "high"): 0.84,
        }.get((r["resolution"], r["quality"]), 0.21)
        for r in missing
    )

    plan = {
        "template": tpl.id,
        "project": req.project,
        "scripts_to_deploy": tpl.scripts,
        "scene_spec": tpl.scene_spec,
        "assets_reused": have,
        "assets_to_generate": missing,
        "estimated_cost_usd": round(estimated_cost, 2),
        "ready_to_run": req.accept,
    }

    if req.dry_run or not req.accept:
        plan["message"] = (
            f"DRY-RUN — call again with `accept=true` to actually build. "
            f"{len(have)} assets reused, {len(missing)} need generation "
            f"(~${estimated_cost:.2f})."
        )
        return plan

    # ACCEPT path: enqueue generations + deploy + wire
    # NOTE: full wire is the next milestone — for now stage the plan in the
    # gen-queue and return so the user can ACCEPT in the existing flow.
    from backend.services.gen_queue import _state, add_planned

    project_name = req.project or settings.unity_project_path.name
    enqueued = []
    for r in missing:
        task_id = add_planned(
            project=project_name,
            name=r["name"],
            asset_type=r["asset_type"],
            prompt=r["prompt_hint"],
            workflow_id="gpt-image-2",
            quality=r["quality"],
            resolution=r["resolution"],
            aspect_ratio=r["aspect_ratio"],
        )
        enqueued.append(task_id)

    plan["enqueued_task_ids"] = enqueued
    plan["next_step"] = (
        f"Visit Generation Queue + click ACCEPT — {len(enqueued)} tasks "
        f"queued. After completion, POST /api/templates/build again with "
        f"the same body to deploy scripts + wire scene."
    )
    return plan


class DiffRequest(BaseModel):
    template_id: str
    current_screenshot_path: str


@router.post("/diff")
async def diff_against_baseline(req: DiffRequest) -> dict[str, Any]:
    """Pixel-diff a fresh Game-view screenshot vs the template's baseline.

    Returns rough %-similarity + per-quadrant diff so Claude can target the
    region that's off (e.g. "top-right quadrant 12% diff = restart button
    drifted").
    """
    tpl = _TEMPLATES.get(req.template_id)
    if tpl is None or not tpl.baseline_screenshot:
        raise HTTPException(status_code=404, detail="template or baseline missing")
    baseline = TEMPLATES_DIR / tpl.baseline_screenshot
    current = Path(req.current_screenshot_path)
    if not baseline.is_file() or not current.is_file():
        raise HTTPException(status_code=404, detail="screenshot file missing")

    try:
        from PIL import Image
        import numpy as np

        a = np.array(Image.open(baseline).convert("RGB").resize((480, 270)))
        b = np.array(Image.open(current).convert("RGB").resize((480, 270)))
        diff = np.abs(a.astype(int) - b.astype(int))
        overall = float(diff.mean()) / 255.0
        # 4-quadrant breakdown
        h, w = 270, 480
        quadrants = {
            "top_left":     float(diff[:h // 2, :w // 2].mean()) / 255.0,
            "top_right":    float(diff[:h // 2, w // 2:].mean()) / 255.0,
            "bottom_left":  float(diff[h // 2:, :w // 2].mean()) / 255.0,
            "bottom_right": float(diff[h // 2:, w // 2:].mean()) / 255.0,
        }
        return {
            "similarity": round(1.0 - overall, 4),
            "diff_pct": round(overall * 100, 2),
            "quadrants_diff_pct": {k: round(v * 100, 2) for k, v in quadrants.items()},
            "baseline": str(baseline),
            "current": str(current),
        }
    except ImportError:
        raise HTTPException(status_code=500, detail="PIL or numpy missing") from None
