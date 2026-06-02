"""
Animation router — author animation-clip specs and render server-side GIF
previews from sprite atlases for the Phaser game pipeline.

An "animation spec" is a small engine-neutral JSON document (atlas + fps +
loop-mode + frame rects). The Phaser side consumes it through
`phaser_game/src/systems/anims.ts` → `BootScene` `anims.create(...)`; there is
no proprietary clip/controller asset to generate.

Endpoints:
    POST /api/animation/create-clip  — persist an animation-clip spec (JSON)
    GET  /api/animation/preview-gif  — render a GIF from an atlas + frame grid
    GET  /api/animation/list         — list stored animation specs for a project
    POST /api/animation/save         — persist an animation spec to disk

History note: this router previously also drove a Unity-MCP proxy to emit
`.anim` clips and `.controller` AnimatorControllers (create-clip's engine half,
plus build-controller / edit-clip). All of that was Unity-editor-specific and
imported `core.mcp_client_unity`, which no longer exists after the migration to
Phaser 3 + Vite. Those code paths were removed; spec authoring + GIF preview
(the parts the frontend AnimationEditor actually uses) were kept and are
engine-neutral.
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from core.config import PROJECT_ROOT, PROJECTS_DIR

router = APIRouter(prefix="/api/animation", tags=["animation"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class AnimFrame(BaseModel):
    rect: list[int] = Field(..., description="[x, y, w, h] in atlas pixels", min_length=4, max_length=4)
    duration_ms: int = Field(100, ge=1, le=5000)
    tag: str | None = None


class CreateClipRequest(BaseModel):
    sprite_atlas_path: str
    name: str
    frames: list[AnimFrame]
    loop_mode: Literal["once", "loop", "ping-pong", "reverse"] = "loop"
    fps: int = Field(12, ge=1, le=60)


class SaveSpecRequest(BaseModel):
    project: str
    name: str
    spec: dict[str, Any]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _project_anim_dir(project: str) -> Path:
    return PROJECTS_DIR / project / "animations"


def _serialize_clip_spec(req: CreateClipRequest) -> str:
    """Emit the engine-neutral AnimationClipSpec the Phaser anims loader ingests."""
    return json.dumps({
        "kind": "AnimationClipSpec",
        "version": 1,
        "name": req.name,
        "atlas": req.sprite_atlas_path,
        "fps": req.fps,
        "loop_mode": req.loop_mode,
        "frames": [f.model_dump() for f in req.frames],
    }, indent=2)


def _resolve_atlas_path(atlas: str) -> Path:
    """Resolve an atlas reference to a filesystem path (Phaser-era roots).

    - absolute path                → used as-is
    - "/files/<x>" (served URL)    → public_files/<x>
    - anything else (repo-relative)→ <repo root>/<x>  (e.g. "public/assets/cat.png")
    """
    p = Path(atlas)
    if p.is_absolute():
        return p
    rel = atlas.lstrip("/")
    if rel.startswith("files/"):
        return PROJECT_ROOT / "public_files" / rel[len("files/"):]
    return PROJECT_ROOT / rel


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/create-clip")
async def create_clip(req: CreateClipRequest) -> dict[str, Any]:
    """Persist an animation-clip spec (engine-neutral JSON) for the Phaser loader."""
    if not req.frames:
        raise HTTPException(status_code=400, detail="frames list cannot be empty")

    spec_dir = PROJECT_ROOT / "logs" / "animation_specs"
    spec_dir.mkdir(parents=True, exist_ok=True)
    spec_path = spec_dir / f"{int(time.time() * 1000)}_{req.name}.json"
    spec_path.write_text(_serialize_clip_spec(req), encoding="utf-8")

    return {
        "ok": True,
        "spec_path": str(spec_path),
        "name": req.name,
        "fps": req.fps,
        "loop_mode": req.loop_mode,
        "frame_count": len(req.frames),
    }


@router.get("/preview-gif")
async def preview_gif(
    atlas: str = Query(..., description="Absolute or project-relative path to PNG atlas"),
    fps: int = Query(12, ge=1, le=60),
    rows: int = Query(1, ge=1, le=32, description="Frames per row in the atlas"),
    cols: int | None = Query(None, ge=1, le=64, description="If unset, derived from atlas+frame_size"),
    frame_w: int = Query(0, ge=0, le=2048),
    frame_h: int = Query(0, ge=0, le=2048),
    loop: int = Query(0, ge=0, le=1, description="0=infinite, 1=once"),
) -> Response:
    """Render a server-side GIF preview of the sprite atlas at given fps."""
    try:
        from PIL import Image
    except ImportError as e:
        raise HTTPException(status_code=503, detail=f"Pillow not installed: {e}") from None

    atlas_path = _resolve_atlas_path(atlas)
    if not atlas_path.exists():
        raise HTTPException(status_code=404, detail=f"atlas not found: {atlas_path}")

    img = Image.open(atlas_path).convert("RGBA")
    iw, ih = img.size

    # Auto-derive frame size if not provided
    if frame_w == 0 or frame_h == 0:
        # heuristic: square frame, rows hint
        fh = ih // rows
        fw = fh  # assume square
    else:
        fw, fh = frame_w, frame_h

    if cols is None:
        cols = max(1, iw // fw)

    frames: list[Image.Image] = []
    for r in range(rows):
        for c in range(cols):
            x = c * fw
            y = r * fh
            if x + fw > iw or y + fh > ih:
                break
            sub = img.crop((x, y, x + fw, y + fh))
            frames.append(sub)

    if not frames:
        raise HTTPException(status_code=400, detail="no frames extracted; check frame_w/frame_h")

    duration_ms = int(1000 / max(1, fps))
    buf = io.BytesIO()
    frames[0].save(
        buf,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=duration_ms,
        loop=0 if loop == 0 else 1,
        disposal=2,
        transparency=0,
    )
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="image/gif",
        headers={"Cache-Control": "no-cache", "Content-Disposition": f'inline; filename="{atlas_path.stem}.gif"'},
    )


@router.get("/list")
async def list_specs(project: str = Query("default")) -> dict[str, Any]:
    d = _project_anim_dir(project)
    if not d.exists():
        return {"project": project, "specs": []}
    specs: list[dict[str, Any]] = []
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        specs.append({
            "filename": p.name,
            "name": data.get("name", p.stem),
            "fps": data.get("fps", 12),
            "frame_count": len(data.get("frames", [])),
            "loop_mode": data.get("loop_mode", "loop"),
        })
    return {"project": project, "specs": specs}


@router.post("/save")
async def save_spec(req: SaveSpecRequest) -> dict[str, Any]:
    d = _project_anim_dir(req.project)
    d.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(c for c in req.name if c.isalnum() or c in "-_") or "anim"
    target = d / f"{safe_name}.json"
    target.write_text(json.dumps(req.spec, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(target)}
