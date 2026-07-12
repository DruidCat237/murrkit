"""
Generation queue router — exposes the gen_queue service over HTTP + WS.

The queue itself lives in `backend/services/gen_queue.py`. Sprite/asset
routers call `gen_queue.enqueue(...)` instead of running synchronously
when the client wants live progress.

Endpoints:
    GET   /api/gen-queue/list                — all known tasks (rolling buffer)
    GET   /api/gen-queue/task/{task_id}     — single task status
    POST  /api/gen-queue/cancel/{task_id}    — cancel a queued or running task
    POST  /api/gen-queue/enqueue-sprite      — enqueue a sprite gen with progress
    POST  /api/gen-queue/enqueue-asset       — enqueue an asset gen with progress
    WS    /ws/gen-queue                      — stream events {queued|started|progress|completed|failed}
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel

from backend.services import gen_queue as gq
from core.config import settings


# Target pixel dimensions per asset_type for post-download normalization
# (EXP-4 PHASE C). Width × height. With project-wide PPU=200 (set on the
# engine side via SpriteImportNormalizer), these map to predictable
# world-unit sizes (256/200 = 1.28u for blocks, 512/200 = 2.56u for chars).
_NORMALIZE_TARGETS: dict[str, tuple[int, int]] = {
    "sprite":          (512, 512),  # default character — 2.56 × 2.56 world units
    "sprite_block":    (256, 256),  # blocks — 1.28 × 1.28
    "sprite_character":(512, 512),
    "sprite_slingshot":(256, 512),
    "background":      (1920, 1080),
    "tileset":         (1024, 1024),
    "ui-element":      (256, 256),
    "particle-fx":     (256, 256),
}


def _normalize_atlas_post_download(png_path: Path, asset_type: str) -> None:
    """EXP-4 PHASE C — crop to opaque bounds + scale to target px in place.

    Fixes the EXP-3 root cause where GPT-Image-2 returned wildly varying
    content sizes (a "wooden plank" prompt sometimes filled 30% of canvas,
    sometimes 90%), producing oversized walls and tiny characters.

    Behavior:
      1. Open the PNG with RGBA.
      2. getbbox() → tight opaque rectangle (drops transparent padding).
      3. Crop to that bbox.
      4. thumbnail() to fit inside target_w × target_h (preserves aspect).
      5. Paste centered on a new transparent canvas of exactly target size.
      6. Save in place, overwriting original.

    The engine-side `SpriteImportNormalizer.cs` then applies PPU=200, pivot,
    meshType=Tight on top of this clean atlas.

    Fail-loudly per swe-agent-rigor: a missing PIL or unreadable PNG
    raises — the gen_queue worker catches it and logs but does not
    silently leave a malformed atlas.
    """
    from PIL import Image  # local import (Pillow optional dep)

    target = _NORMALIZE_TARGETS.get(asset_type, _NORMALIZE_TARGETS["sprite"])
    target_w, target_h = target

    with Image.open(png_path) as src:
        img = src.convert("RGBA")
        bbox = img.getbbox()
        if bbox is None:
            # Fully transparent input — leave as-is, just resize to target.
            cropped = img.resize(target, Image.LANCZOS)
        else:
            cropped = img.crop(bbox)
        # Preserve aspect when scaling content into target frame
        cropped.thumbnail(target, Image.LANCZOS)
        out = Image.new("RGBA", target, (0, 0, 0, 0))
        # Center horizontally; align to BOTTOM vertically so characters
        # whose pivot will be set to bottom-center sit naturally on
        # whatever ground we place them on.
        px = (target_w - cropped.width) // 2
        py = target_h - cropped.height
        out.paste(cropped, (px, py))
        out.save(png_path, "PNG", optimize=True)

    logger.info(
        "normalized atlas {p} to {w}×{h} (asset_type={t})",
        p=png_path.name, w=target_w, h=target_h, t=asset_type,
    )


def _thumb_url(abs_path: Path | str) -> str | None:
    """Turn a generated-file absolute path into a URL the frontend can fetch.

    Assets now land under `projects/<project>/Generated/...` (per-project
    isolation). We expose them via the Asset Library's `/raw` endpoint, which
    streams the bytes inline (works as an <img src>). Falls back to a `/raw`
    `unity:` id for any pre-migration file still under the old Assets tree, and
    finally to `/files/{name}`.
    """
    from urllib.parse import quote

    from core.config import PROJECTS_DIR

    p = Path(abs_path)
    if not p.is_absolute():
        return f"/files/{p.name}"
    resolved = p.resolve()
    # Primary: file lives under projects/<project>/...
    try:
        rel = resolved.relative_to(PROJECTS_DIR.resolve()).as_posix()
        project = rel.split("/", 1)[0]
        asset_id = f"legacy:{rel}"
        return f"/api/library/{quote(project)}/raw?asset_id={quote(asset_id, safe='')}"
    except (ValueError, OSError):
        pass
    # Legacy fallback: still under the old <game_project>/Assets tree.
    try:
        arel = resolved.relative_to((settings.unity_project_path / "Assets").resolve()).as_posix()
        return f"/api/library/default/raw?asset_id={quote('unity:' + arel, safe='')}"
    except (ValueError, OSError):
        return f"/files/{p.name}"


async def _autoWire_animator(result: Any) -> dict[str, Any]:
    # murrkit NO-OP: this used to create an engine AnimatorController + .anim
    # files via MCP. In Phaser, animations are defined in TypeScript scene
    # code (anims.create(...)) — no controller files. Short-circuit so
    # gen-queue worker doesn't try to import the dropped mcp_client_unity.
    return {"skipped": "phaser2d_no_unity_animator", "result_summary": str(result)[:200]}


router = APIRouter(prefix="/api/gen-queue", tags=["gen-queue"])


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------


@router.get("/list")
async def list_tasks() -> dict[str, Any]:
    return {
        "max_parallel": gq.MAX_PARALLEL,
        "tasks": [asdict(t) for t in gq.list_tasks()],
        "ts": time.time(),
    }


@router.get("/task/{task_id}")
async def get_task(task_id: str) -> dict[str, Any]:
    t = gq.get_task(task_id)
    if t is None:
        raise HTTPException(status_code=404, detail="task not found")
    return asdict(t)


@router.post("/cancel/{task_id}")
async def cancel(task_id: str) -> dict[str, Any]:
    # planned rows can be discarded outright
    t = gq.get_task(task_id)
    if t is not None and t.status == "planned":
        ok = await gq.discard_planned(task_id)
        if not ok:
            raise HTTPException(status_code=404, detail="task not found")
        return {"ok": True, "task_id": task_id, "discarded": True}
    ok = gq.cancel_task(task_id)
    if not ok:
        raise HTTPException(status_code=404, detail="task not found")
    return {"ok": True, "task_id": task_id}


class ClearRequest(BaseModel):
    project: str | None = None  # None = all projects
    # Statuses to remove. Defaults to terminal failure/cancellation states so
    # the user can sweep history without nuking running rows. The service
    # refuses queued/started/progress anyway as a safety net.
    statuses: list[str] = ["failed", "cancelled"]


@router.post("/clear")
async def clear_finished(req: ClearRequest) -> dict[str, Any]:
    """Bulk-remove terminal-state tasks from the queue (failed / cancelled /
    completed). Used by the UI "Clear failed" / "Clear completed" buttons.

    Running tasks (queued/started/progress) are NEVER touched — cancel them
    first via /cancel/{task_id} if you want them gone.
    """
    statuses = set(req.statuses) - {"queued", "started", "progress"}
    if not statuses:
        return {"ok": True, "removed": 0, "note": "no terminal statuses requested"}
    removed = await gq.clear_tasks_by_status(statuses, req.project)
    return {
        "ok": True,
        "removed": removed,
        "statuses": sorted(statuses),
        "project": req.project,
    }


# ---------------------------------------------------------------------------
# Planning surface: Claude posts an asset-plan as planned rows; user accepts
# (per-row or all) and the queue then dispatches the real workers.
# ---------------------------------------------------------------------------


class PlanRow(BaseModel):
    name: str                           # short identifier shown in UI
    asset_type: str                     # "sprite" | "prop" | "background" | "tileset" | "biome_tileset" | "ui-element" | "particle-fx"
    prompt: str                         # one-line prompt that will be sent to Kitty
    workflow_id: str = "gpt-image-2"    # backendId; "gpt-image-2" (fresh) | "gpt-image-2-edit" (with base_image_path)
    quality: str = "medium"             # "low" | "medium" | "high"
    resolution: str = "1K"              # "1K" | "2K" | "4K"
    aspect_ratio: str = "1:1"           # 1:1, 16:9, 9:16, …
    # Absolute path to a local image to use as the edit-reference. Required
    # when `workflow_id == "gpt-image-2-edit"`. The worker hosts this file
    # via Kitty's /media streaming endpoint to get a public URL, then calls
    # gpt-image-2-edit. Keeps the generated sprite visually consistent
    # with an existing character atlas — see task #105 base-character rule.
    base_image_path: str | None = None


class PlanRequest(BaseModel):
    project: str = "default"
    rows: list[PlanRow]


@router.post("/plan")
async def post_plan(req: PlanRequest) -> dict[str, Any]:
    """Stage one or more PLANNED rows in the queue.

    The rows show up immediately in the queue UI as gray "planned" entries
    with their cost. No upstream call happens until the user clicks
    Accept (or POSTs /accept-all). Mirrors the Kitty AI Studio app pattern
    where planned generations are visible before submission.
    """
    from tools import kitty_api as _k

    task_ids: list[str] = []
    total_cents = 0
    for row in req.rows:
        # Validate base_image_path when edit workflow requested — fail
        # loudly so the caller doesn't accept a plan that can't possibly
        # run (e.g. Claude staged edit without providing the reference).
        if row.workflow_id == "gpt-image-2-edit":
            if not row.base_image_path:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"row '{row.name}': workflow_id='gpt-image-2-edit' requires "
                        f"base_image_path (absolute path to the local reference image)"
                    ),
                )
            if not Path(row.base_image_path).is_file():
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"row '{row.name}': base_image_path not found on disk: "
                        f"{row.base_image_path}"
                    ),
                )
        cents = _k.estimate_cost_cents(
            workflow_id=row.workflow_id,
            quality=row.quality,
            resolution=row.resolution,
            aspect_ratio=row.aspect_ratio,
        )
        total_cents += cents
        tid = await gq.add_planned(
            name=row.name,
            asset_type=row.asset_type,
            prompt=row.prompt,
            project=req.project,
            workflow_id=row.workflow_id,
            quality=row.quality,
            resolution=row.resolution,
            aspect_ratio=row.aspect_ratio,
            cost_cents=cents,
            base_image_path=row.base_image_path,
        )
        task_ids.append(tid)
    return {
        "task_ids": task_ids,
        "count": len(task_ids),
        "total_cost_cents": total_cents,
        "total_cost_usd": total_cents / 100.0,
    }


@router.get("/planned")
async def get_planned(project: str | None = None) -> dict[str, Any]:
    """List all PLANNED rows (waiting for user accept), optionally per project."""
    return {
        "tasks": [asdict(t) for t in gq.list_planned(project)],
        "ts": time.time(),
    }


class EditPlannedRequest(BaseModel):
    prompt: str | None = None
    quality: str | None = None         # "low" | "medium" | "high"
    resolution: str | None = None      # "1K" | "2K" | "4K"
    aspect_ratio: str | None = None    # "1:1" | "16:9" | …
    base_image_path: str | None = None # absolute disk path to edit-reference


@router.post("/edit/{task_id}")
async def edit_planned(task_id: str, req: EditPlannedRequest) -> dict[str, Any]:
    """Edit a PLANNED task before the user accepts it.

    Lets the user tweak prompts/quality/resolution Claude proposed without
    discarding and restarting from scratch. Recomputes cost when quality or
    resolution change so the displayed total stays accurate.

    Only works for `status="planned"` rows — once accepted the worker is
    running and the prompt is locked.
    """
    t = gq.get_task(task_id)
    if t is None:
        raise HTTPException(status_code=404, detail="task not found")
    if t.status != "planned":
        raise HTTPException(
            status_code=409,
            detail=f"task is {t.status!r}, only planned rows are editable",
        )

    # Recompute cost if quality / resolution / aspect_ratio changed.
    cost_cents: int | None = None
    if req.quality or req.resolution or req.aspect_ratio:
        from tools import kitty_api as _k
        cost_cents = _k.estimate_cost_cents(
            workflow_id=t.planned_workflow or "gpt-image-2",
            quality=req.quality or t.planned_quality or "medium",
            resolution=req.resolution or t.planned_resolution or "1K",
            aspect_ratio=req.aspect_ratio or t.planned_aspect_ratio or "1:1",
        )

    # Validate base_image_path if provided (allow empty string to clear it,
    # but if non-empty it must exist on disk — same loud-fail policy as
    # /plan).
    if req.base_image_path:
        if not Path(req.base_image_path).is_file():
            raise HTTPException(
                status_code=404,
                detail=f"base_image_path not found on disk: {req.base_image_path}",
            )

    updated = await gq.update_planned(
        task_id,
        prompt=req.prompt,
        quality=req.quality,
        resolution=req.resolution,
        aspect_ratio=req.aspect_ratio,
        cost_cents=cost_cents,
        base_image_path=req.base_image_path,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="task not found or not planned")
    return asdict(updated)


@router.get("/base-preview/{task_id}")
async def serve_base_preview(task_id: str) -> Any:
    """Stream the base_image_path file for a planned task. Lets the frontend
    show a thumbnail of the edit-reference next to the inline prompt editor
    without leaking arbitrary filesystem paths via the URL.
    """
    from fastapi.responses import FileResponse
    t = gq.get_task(task_id)
    if t is None:
        raise HTTPException(status_code=404, detail="task not found")
    if not t.base_image_path:
        raise HTTPException(status_code=404, detail="task has no base_image_path")
    p = Path(t.base_image_path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"base file missing: {p}")
    return FileResponse(path=p, media_type="image/png")


class AcceptRequest(BaseModel):
    task_ids: list[str] | None = None     # None = accept all planned in `project`
    project: str | None = None


@router.post("/accept")
async def accept_plan(req: AcceptRequest) -> dict[str, Any]:
    """Promote planned rows to queued + dispatch their workers.

    If `task_ids` is omitted, accepts every planned row in `project` (or all
    projects when `project` is None too).
    """
    targets: list[gq.QueueTask] = []
    if req.task_ids:
        for tid in req.task_ids:
            t = gq.get_task(tid)
            if t is not None and t.status == "planned":
                targets.append(t)
    else:
        targets = gq.list_planned(req.project)
    if not targets:
        return {"accepted": 0, "task_ids": []}

    dispatched: list[str] = []
    for t in targets:
        # Dispatch FIRST, then drop the planned row only once a real worker
        # exists. The old order discarded the row before dispatch, so any row
        # whose asset_type _dispatch_from_plan doesn't recognise (returns None)
        # was silently deleted — the user clicked Accept and the task vanished.
        new_id = await _dispatch_from_plan(t)
        if new_id:
            await gq.discard_planned(t.id)
            dispatched.append(new_id)
        else:
            logger.warning(
                "accept_plan: no worker for asset_type={at!r} (task {tid}) — "
                "keeping the planned row instead of dropping it",
                at=t.asset_type, tid=t.id,
            )
    return {"accepted": len(dispatched), "task_ids": dispatched}


async def _dispatch_from_plan(t: "gq.QueueTask") -> str | None:
    """Fire the actual sprite/asset worker for a previously-planned row.

    Reuses the existing enqueue-sprite / enqueue-asset handlers' worker
    bodies so behaviour stays identical to the "submit straight away" path.
    """
    name = (t.extra or {}).get("name") or t.id
    if t.asset_type == "sprite":
        # Loud failure if a plan-row asked for edit-mode but lacks the
        # reference. Better to refuse the dispatch than silently fall
        # through to fresh-gen and burn $ on a character that drifts.
        if t.planned_workflow == "gpt-image-2-edit" and not t.base_image_path:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"task {t.id} ('{name}'): planned_workflow='gpt-image-2-edit' "
                    f"but base_image_path is missing. Re-stage with the reference path."
                ),
            )
        # ---- EDIT-MODE branch: workflow_id="gpt-image-2-edit" + base_image_path ----
        # When Claude planned a sprite with a reference image (e.g. new
        # pose for an existing character), bypass the multi-frame
        # sprite_pipeline and call gpt-image-2-edit directly. Produces a
        # SINGLE PNG that visually matches the base atlas's character,
        # not a fresh text-to-image that drifts in style.
        if t.planned_workflow == "gpt-image-2-edit" and t.base_image_path:
            async def edit_worker(task: gq.QueueTask, handle: gq.QueueTaskHandle) -> None:
                import asyncio as _asyncio
                from tools import gpt_image_2 as _g
                from tools import kitty_api as _k

                base_path = Path(task.base_image_path or "")
                if not base_path.is_file():
                    raise RuntimeError(
                        f"base_image_path missing on disk at worker time: {base_path}"
                    )

                await handle.progress(3, f"uploading reference {base_path.name} to Kitty media")
                # Upload to Kitty /media → public URL (no S3-presigned; edit
                # endpoint rejects those). upload_file_sync expects
                # (file_bytes, filename, content_type) — NOT a path. Read
                # the file in this thread, then ship bytes off-thread so the
                # main loop stays responsive.
                file_bytes = base_path.read_bytes()
                public_url = await _asyncio.to_thread(
                    _k.upload_file_sync,
                    file_bytes,
                    base_path.name,
                    "image/png",
                )
                if not public_url:
                    raise RuntimeError(f"Kitty upload returned empty URL for {base_path}")

                await handle.progress(10, f"submit_edit ({name}) reference={base_path.name}")
                await handle.start_heartbeat(
                    eta_seconds=1200.0,
                    interval_s=4.0,
                    text_prefix=f"Kitty edit-mode {name}",
                )

                # Map quality → tier expected by submit_edit (low/medium/high)
                quality = task.planned_quality or "medium"
                resolution = task.planned_resolution or "1K"
                aspect = task.planned_aspect_ratio or "1:1"

                job_id = await _asyncio.to_thread(
                    _g.submit_edit,
                    task.prompt,
                    public_url,
                    aspect,
                    quality,
                    resolution,
                    180,             # timeout_s for submit
                    task.project,
                )

                await handle.progress(35, f"waiting for Kitty job {job_id}")
                # Poll for completion off-thread (sync poll loop).
                # Signature: wait_for_completion(task_id, on_poll, poll_interval_s,
                #                                max_wait_min, should_cancel)
                # should_cancel lets the poll THREAD stop when the user cancels —
                # asyncio-task cancellation can't kill the thread, so without it
                # a cancelled edit would keep hitting Kitty for up to 25 min.
                data = await _asyncio.to_thread(
                    _g.wait_for_completion,
                    job_id,
                    None,   # on_poll callback — not needed here
                    8,      # poll_interval_s
                    25,     # max_wait_min
                    lambda: handle.cancelled,
                )
                result_url = _g.extract_result_url(data)
                if not result_url:
                    raise RuntimeError(
                        f"submit_edit returned job {job_id} but no output URL — payload={data!r}"
                    )

                # Download to the per-project Generated folder, routed
                # DETERMINISTICALLY by the row's declared asset_type (a sprite
                # edit → projects/<project>/Generated/Sprites/<name>/). The old
                # code wrote to <game_project>/Assets/Generated/Sprites which both
                # ignored the active project (regressing per-project isolation)
                # and mixed every project's edits into one shared tree.
                from agents.sprite_pipeline import (
                    _default_output_dir as _gen_dir,
                    subfolder_for_role as _role_sub,
                )
                out_dir = (
                    _gen_dir(_role_sub(task.asset_type or "sprite"), task.project)
                    / name
                )
                out_dir.mkdir(parents=True, exist_ok=True)
                out_file = out_dir / f"{name}.png"

                await handle.progress(82, f"downloading {result_url[:60]}")
                # download_result expects Path, not str
                await _asyncio.to_thread(_g.download_result, result_url, out_file)

                # EXP-4 PHASE C — post-download normalization (Layer 3).
                # Crop to tight opaque bounds + scale to target px per
                # asset_type so the engine-side AssetPostprocessor doesn't have
                # to fight wildly varying source sizes. Catch failures
                # loudly per swe-agent-rigor: a normalization crash should
                # surface, not silently degrade to raw output.
                await handle.progress(88, "normalizing atlas (crop+scale)")
                try:
                    await _asyncio.to_thread(
                        _normalize_atlas_post_download,
                        out_file,
                        task.asset_type or "sprite",
                    )
                except Exception as e:  # noqa: BLE001 — log + continue
                    logger.warning(
                        "post-download normalize failed for {f}: {e} "
                        "(continuing with raw output)",
                        f=out_file, e=e,
                    )

                await handle.stop_heartbeat()
                await handle.progress(95, "engine will auto-refresh on file watcher tick")

                # Cost: 1 image at the quality/res tier. Reuse estimator.
                cost = _k.estimate_cost_cents(
                    workflow_id="gpt-image-2-edit",
                    quality=quality,
                    resolution=resolution,
                    aspect_ratio=aspect,
                ) / 100.0

                thumb = _thumb_url(str(out_file))
                await handle.complete(
                    thumbnail_url=thumb,
                    cost_usd=cost,
                    extra={
                        "character_name": name,
                        "atlas_path": str(out_file),  # single frame, no atlas
                        "base_image_path": str(base_path),
                        "workflow_id": "gpt-image-2-edit",
                        "kitty_job_id": job_id,
                        "result_url": result_url,
                    },
                )

            return await gq.enqueue(
                asset_type="sprite",
                prompt=t.prompt,
                project=t.project,
                eta_seconds=180.0,
                worker=edit_worker,
                base_image_path=t.base_image_path,  # propagate the edit reference
            )

        # ---- FRESH-GEN branch (default — multi-frame sprite_pipeline) ----
        async def worker(task: gq.QueueTask, handle: gq.QueueTaskHandle) -> None:
            from agents.sprite_pipeline import generate_character_spritesheet

            await handle.progress(5, f"calling Kitty App via sprite_pipeline ({name})")
            await handle.start_heartbeat(
                eta_seconds=1200.0,  # 20 min — Kitty queue can sit 15-25 min before workers pick up
                interval_s=4.0,
                text_prefix=f"Kitty generating {name}",
            )
            # DEFAULT character sheet = a 3x3 grid (9 DISTINCT animation poses),
            # NOT a 1xN strip / single frame. The old `frames_per_anim=1` forced
            # a 1x1 grid → one static frame; planning several of those produced
            # the "row of identical cats" the user complained about. Leave
            # rows/cols at the pipeline default (DEFAULT_GRID_ROWS x
            # DEFAULT_GRID_COLS = 3x3) and request a single "walk" cycle so the
            # 9 cells enumerate a real contact→passing→recoil walk.
            result = await generate_character_spritesheet(
                t.prompt,
                animations=["walk"],
                style="cartoon",
                sprite_size=(256, 256),
                project=task.project,
            )
            await handle.stop_heartbeat()
            await handle.progress(92, "writing atlas + frames.json")
            await handle.progress(96, "wiring animations")
            wire = await _autoWire_animator(result)
            thumb = _thumb_url(result.atlas_path)
            await handle.complete(
                thumbnail_url=thumb,
                cost_usd=result.cost_usd,
                extra={
                    "character_name": result.character_name,
                    "atlas_path": str(result.atlas_path),
                    "frames_json": str(result.frames_json_path),
                    "unity_wire": wire,
                },
            )

        return await gq.enqueue(
            asset_type="sprite",
            prompt=t.prompt,
            project=t.project,
            eta_seconds=90.0,
            worker=worker,
        )

    if t.asset_type in ("prop", "object", "static"):
        # STATIC single-image asset (net post, ball, rock, crate, sign, goal,
        # platform, fence, pickup...). ONE clean object — NO animation, NO grid,
        # NO legs. This is the fix for "asked for a static post, got a walking
        # post-with-legs spritesheet": props must NEVER route to the animated
        # character pipeline.
        async def prop_worker(task: gq.QueueTask, handle: gq.QueueTaskHandle) -> None:
            from agents.sprite_pipeline import generate_static_sprite

            await handle.progress(5, f"generating static prop ({name})")
            await handle.start_heartbeat(
                eta_seconds=600.0, interval_s=4.0,
                text_prefix=f"Kitty generating {name}",
            )
            result = await generate_static_sprite(t.prompt, project=task.project)
            await handle.stop_heartbeat()
            await handle.progress(95, "writing static asset")
            await handle.complete(
                thumbnail_url=_thumb_url(result.atlas_path),
                cost_usd=result.cost_usd,
                extra={
                    "character_name": result.character_name,
                    "atlas_path": str(result.atlas_path),
                    "frames_json": str(result.frames_json_path),
                    "static": True,
                },
            )

        return await gq.enqueue(
            asset_type="prop",
            prompt=t.prompt,
            project=t.project,
            eta_seconds=60.0,
            worker=prop_worker,
        )

    if t.asset_type in ("biome_tileset", "biome-tileset"):
        # Map Studio: 16-tile 4×4 autotile sheet for ONE biome. The row's
        # `name` doubles as the biome id (matches map.yaml `tilesets[].biome`);
        # base_image_path (optional) anchors the art style to an earlier
        # biome's sheet via edit-mode so a map's tilesets don't drift apart.
        biome = str((t.extra or {}).get("biome") or name)

        async def biome_worker(task: gq.QueueTask, handle: gq.QueueTaskHandle) -> None:
            from agents.asset_pipeline import generate_biome_tileset

            await handle.progress(5, f"generating biome tileset ({biome})")
            await handle.start_heartbeat(
                eta_seconds=1200.0,  # Kitty queue can sit 15-25 min
                interval_s=4.0,
                text_prefix=f"Kitty generating {biome} tiles",
            )
            result = await generate_biome_tileset(
                task.prompt,
                biome,
                base_image_path=task.base_image_path,
                project=task.project,
            )
            await handle.stop_heartbeat()
            await handle.progress(95, "slicing + publishing tileset")
            await handle.complete(
                thumbnail_url=_thumb_url(result.files[0]) if result.files else None,
                cost_usd=result.cost_usd,
                extra={
                    "asset_type": result.asset_type,
                    "files": [str(f) for f in result.files],
                    "biome": biome,
                    # The one-liner the captain adds to map.yaml as `image:`.
                    "map_yaml_image": result.metadata.get("map_yaml_image"),
                },
            )

        return await gq.enqueue(
            asset_type="biome_tileset",
            prompt=t.prompt,
            project=t.project,
            eta_seconds=90.0,
            worker=biome_worker,
            extra={"name": name, "biome": biome},
            base_image_path=t.base_image_path,
        )

    if t.asset_type in ("background", "tileset", "ui-element", "particle-fx"):
        async def worker(task: gq.QueueTask, handle: gq.QueueTaskHandle) -> None:
            from agents.asset_pipeline import (
                generate_background, generate_tileset,
                generate_ui_element, generate_particle_fx,
            )

            await handle.progress(10, f"generating {t.asset_type} ({name})")
            await handle.start_heartbeat(
                eta_seconds=1200.0,  # 20 min — Kitty queue can sit 15-25 min before workers pick up
                interval_s=4.0,
                text_prefix=f"Kitty generating {name}",
            )
            kind = t.asset_type
            if kind == "background":
                result = await generate_background(t.prompt, project=task.project)
            elif kind == "tileset":
                result = await generate_tileset(t.prompt, project=task.project)
            elif kind == "ui-element":
                result = await generate_ui_element(t.prompt, project=task.project)
            else:
                result = await generate_particle_fx(t.prompt, project=task.project)
            await handle.stop_heartbeat()
            await handle.progress(95, "finalising")
            thumb = _thumb_url(result.files[0]) if result.files else None
            await handle.complete(
                thumbnail_url=thumb,
                cost_usd=result.cost_usd,
                extra={
                    "asset_type": result.asset_type,
                    "files": [str(f) for f in result.files],
                },
            )

        return await gq.enqueue(
            asset_type=t.asset_type,
            prompt=t.prompt,
            project=t.project,
            eta_seconds=60.0,
            worker=worker,
        )

    return None


# ---------------------------------------------------------------------------
# Queued runners — wrap existing sync sprite/asset gen in workers
# ---------------------------------------------------------------------------


class EnqueueSpriteRequest(BaseModel):
    description: str
    project: str = "default"
    animations: list[str] | None = None
    # Grid generation (v2 default): 3x3 = 9 frames, up to 4x3/3x4 (~12).
    rows: int = 3
    cols: int = 3
    # Legacy 1xN override — if set, frames are a single row of this many frames.
    frames_per_anim: int | None = None
    style: str = "pixel_art"
    sprite_size: list[int] = [64, 64]


@router.post("/enqueue-sprite")
async def enqueue_sprite(req: EnqueueSpriteRequest) -> dict[str, Any]:
    """Enqueue a sprite generation and return the task_id immediately.

    The actual work happens in a background worker; subscribe to
    `/ws/gen-queue` to follow progress.
    """

    async def worker(task: gq.QueueTask, handle: gq.QueueTaskHandle) -> None:
        from agents.sprite_pipeline import generate_character_spritesheet

        await handle.progress(5, "calling Kitty App via sprite_pipeline")
        # Kitty image gen typically takes 60-180s per image. Without a heartbeat
        # the UI bar would freeze at 5% for the full duration, looking hung.
        anim_count = len(req.animations or ["idle", "walk", "attack", "hurt", "death"])
        await handle.start_heartbeat(
            eta_seconds=1200.0 * max(1, anim_count),
            interval_s=4.0,
            text_prefix=f"Kitty generating ({anim_count} anim{'s' if anim_count != 1 else ''})",
        )

        result = await generate_character_spritesheet(
            req.description,
            animations=req.animations,
            frames_per_anim=req.frames_per_anim,
            rows=req.rows,
            cols=req.cols,
            style=req.style,
            sprite_size=tuple(req.sprite_size),  # type: ignore[arg-type]
            project=req.project,
        )

        await handle.stop_heartbeat()
        await handle.progress(95, "writing atlas + frames.json")

        thumb = _thumb_url(result.atlas_path)
        await handle.complete(
            thumbnail_url=thumb,
            cost_usd=result.cost_usd,
            extra={
                "character_name": result.character_name,
                "atlas_path": str(result.atlas_path),
                "frames_json": str(result.frames_json_path),
                "strips": [
                    {
                        "name": s.name,
                        "path": str(s.path),
                        "frame_count": s.frame_count,
                    }
                    for s in result.strips
                ],
            },
        )

    task_id = await gq.enqueue(
        asset_type="sprite",
        prompt=req.description,
        project=req.project,
        eta_seconds=60.0,
        worker=worker,
    )
    return {"task_id": task_id, "status": "queued"}


class EnqueuePropRequest(BaseModel):
    description: str
    project: str = "default"
    style: str = "cartoon"
    sprite_size: list[int] = [512, 512]


@router.post("/enqueue-prop")
async def enqueue_prop(req: EnqueuePropRequest) -> dict[str, Any]:
    """Enqueue a STATIC single-image prop (net post, ball, rock, crate, sign,
    goal, platform, fence, pickup...). ONE clean object — NO animation, NO grid,
    NO legs. Use this for ANYTHING that does not move on its own; use
    /enqueue-sprite ONLY for living, self-animating characters."""

    async def worker(task: gq.QueueTask, handle: gq.QueueTaskHandle) -> None:
        from agents.sprite_pipeline import generate_static_sprite

        await handle.progress(5, "calling Kitty App (static prop)")
        await handle.start_heartbeat(
            eta_seconds=600.0, interval_s=4.0, text_prefix="Kitty generating prop",
        )
        result = await generate_static_sprite(
            req.description, style=req.style,
            sprite_size=tuple(req.sprite_size),  # type: ignore[arg-type]
            project=req.project,
        )
        await handle.stop_heartbeat()
        await handle.progress(95, "writing static asset")
        await handle.complete(
            thumbnail_url=_thumb_url(result.atlas_path),
            cost_usd=result.cost_usd,
            extra={
                "character_name": result.character_name,
                "atlas_path": str(result.atlas_path),
                "frames_json": str(result.frames_json_path),
                "static": True,
            },
        )

    task_id = await gq.enqueue(
        asset_type="prop",
        prompt=req.description,
        project=req.project,
        eta_seconds=60.0,
        worker=worker,
    )
    return {"task_id": task_id, "status": "queued"}


class EnqueueAssetRequest(BaseModel):
    asset_type: str   # "background" | "tileset" | "ui-element" | "particle-fx"
    description: str
    project: str = "default"
    extra: dict[str, Any] = {}


@router.post("/enqueue-asset")
async def enqueue_asset(req: EnqueueAssetRequest) -> dict[str, Any]:
    async def worker(task: gq.QueueTask, handle: gq.QueueTaskHandle) -> None:
        from agents.asset_pipeline import (
            generate_background,
            generate_tileset,
            generate_ui_element,
            generate_particle_fx,
        )

        kind = req.asset_type
        await handle.progress(10, f"generating {kind}")
        await handle.start_heartbeat(
            eta_seconds=1200.0,
            interval_s=4.0,
            text_prefix=f"Kitty generating {kind}",
        )

        if kind == "background":
            result = await generate_background(req.description, project=req.project, **{
                k: v for k, v in req.extra.items() if k in {"layers"}
            })
        elif kind == "tileset":
            result = await generate_tileset(req.description, project=req.project, **{
                k: v for k, v in req.extra.items() if k in {"tile_type"}
            })
        elif kind == "ui-element":
            result = await generate_ui_element(req.description, project=req.project, **{
                k: v for k, v in req.extra.items() if k in {"element_type"}
            })
        elif kind == "particle-fx":
            result = await generate_particle_fx(req.description, project=req.project, **{
                k: v for k, v in req.extra.items() if k in {"fx_type"}
            })
        else:
            await handle.stop_heartbeat()
            await handle.fail(f"unknown asset_type {kind}")
            return

        await handle.stop_heartbeat()
        await handle.progress(95, "finalising")
        thumb = _thumb_url(result.files[0]) if result.files else None
        await handle.complete(
            thumbnail_url=thumb,
            cost_usd=result.cost_usd,
            extra={
                "asset_type": result.asset_type,
                "files": [str(f) for f in result.files],
                "metadata": result.metadata,
            },
        )

    task_id = await gq.enqueue(
        asset_type=req.asset_type,
        prompt=req.description,
        project=req.project,
        eta_seconds=30.0,
        worker=worker,
    )
    return {"task_id": task_id, "status": "queued"}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


@router.websocket("/ws-events")
async def ws_events(ws: WebSocket) -> None:
    """Alias-style endpoint mounted on `/api/gen-queue/ws-events`.

    The main app also mounts `/ws/gen-queue` at the root for a cleaner URL —
    both work. Both honour `?project=<name>` so the initial snapshot is
    scoped to the client's active project; without the param the client
    sees every project's history.
    """
    project = ws.query_params.get("project") or None
    await gq.register_ws(ws, project=project)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"event": "pong", "ts": time.time()}))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        gq.unregister_ws(ws)
