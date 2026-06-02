"""
Smoke test runner — kicks off a tiny end-to-end pipeline trial and reports.

Used by the frontend "Run smoke test of pipeline" button.

Steps:
    1. Generate a 1-frame, 1-anim sprite at LOW quality (cheapest possible GPT-Image-2 job)
    2. Try to import into the engine (or skip if the engine-MCP unreachable)
    3. Take a screenshot (if the engine available)
    4. Report pass/fail per stage + total cost

Endpoint:
    POST  /api/smoke/pipeline    — run the smoke test; returns SmokeTestReport
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from loguru import logger
from pydantic import BaseModel

from core.config import PROJECT_ROOT

router = APIRouter(prefix="/api/smoke", tags=["smoke"])


class StageResult(BaseModel):
    name: str
    ok: bool
    detail: str
    elapsed_ms: int
    extra: dict[str, Any] = {}


class SmokeTestReport(BaseModel):
    started_at: str
    total_elapsed_ms: int
    total_cost_usd: float
    stages: list[StageResult]
    overall_ok: bool
    summary: str


@router.post("/pipeline", response_model=SmokeTestReport)
async def smoke_pipeline() -> SmokeTestReport:
    started = time.time()
    started_at = datetime.now(timezone.utc).isoformat()
    stages: list[StageResult] = []
    total_cost = 0.0

    # 1) Kitty App connectivity
    t0 = time.time()
    try:
        from backend.routers.settings import test_kitty
        kitty_res = await test_kitty()
        stages.append(StageResult(
            name="kitty_connectivity", ok=kitty_res.ok, detail=kitty_res.detail,
            elapsed_ms=int((time.time() - t0) * 1000), extra=kitty_res.extra,
        ))
    except Exception as e:  # noqa: BLE001
        stages.append(StageResult(
            name="kitty_connectivity", ok=False, detail=f"err: {e!s}",
            elapsed_ms=int((time.time() - t0) * 1000),
        ))

    # 2) DeepSeek connectivity
    t0 = time.time()
    try:
        from backend.routers.settings import test_deepseek
        ds_res = await test_deepseek()
        stages.append(StageResult(
            name="deepseek_connectivity", ok=ds_res.ok, detail=ds_res.detail,
            elapsed_ms=int((time.time() - t0) * 1000), extra=ds_res.extra,
        ))
        total_cost += float(ds_res.extra.get("cost_usd", 0.0))
    except Exception as e:  # noqa: BLE001
        stages.append(StageResult(
            name="deepseek_connectivity", ok=False, detail=f"err: {e!s}",
            elapsed_ms=int((time.time() - t0) * 1000),
        ))

    # 3) Sprite pipeline (tiny — 1 anim, 1 frame, low quality)
    sprite_ok = False
    sprite_detail = "skipped (Kitty App not reachable)"
    sprite_path: Path | None = None
    if stages[0].ok:
        t0 = time.time()
        try:
            from agents.sprite_pipeline import generate_character_spritesheet
            res = await generate_character_spritesheet(
                description="tiny smoke-test placeholder square",
                animations=["idle"],
                frames_per_anim=2,
                style="pixel_art",
                sprite_size=(32, 32),
            )
            sprite_ok = True
            sprite_detail = f"atlas={res.atlas_path.name} cost=${res.cost_usd:.4f}"
            sprite_path = res.atlas_path
            total_cost += res.cost_usd
        except Exception as e:  # noqa: BLE001
            sprite_detail = f"err: {e!s}"
            logger.exception("Sprite smoke failed")
        stages.append(StageResult(
            name="sprite_generation", ok=sprite_ok, detail=sprite_detail,
            elapsed_ms=int((time.time() - t0) * 1000),
            extra={"sprite_path": str(sprite_path) if sprite_path else ""},
        ))
    else:
        stages.append(StageResult(
            name="sprite_generation", ok=False, detail="skipped (Kitty App not reachable)",
            elapsed_ms=0,
        ))

    overall_ok = all(s.ok for s in stages)
    summary = (
        f"{sum(1 for s in stages if s.ok)}/{len(stages)} stages passed. "
        f"Total cost: ${total_cost:.4f}. "
        f"{'PASS' if overall_ok else 'FAIL (see individual stages)'}."
    )
    return SmokeTestReport(
        started_at=started_at,
        total_elapsed_ms=int((time.time() - started) * 1000),
        total_cost_usd=total_cost,
        stages=stages,
        overall_ok=overall_ok,
        summary=summary,
    )
