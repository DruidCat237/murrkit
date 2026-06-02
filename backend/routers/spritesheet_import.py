"""
Spritesheet Import router — POST /api/spritesheet/import

Accepts a user-uploaded spritesheet PNG plus a rows×cols grid spec, slices it
into individual frames via tools.spritesheet_splitter.split_grid, and returns
served URLs for every frame plus the generated frames.json.

Outputs land under `public_files/spritesheet_imports/<id>/` so they're served
by the existing `/files` StaticFiles mount in backend.main (public_files → /files).

Interface contract (frontend builds its UI against this):
    POST /api/spritesheet/import   multipart fields:
        file       : PNG spritesheet (required)
        rows       : int   (required)
        cols       : int   (required)
        frame_w    : int   (optional — defaults to image_width // cols)
        frame_h    : int   (optional — defaults to image_height // rows)
    →
    {
        "ok": true,
        "frames": ["/files/spritesheet_imports/<id>/sheet_00.png", ...],
        "frames_json_url": "/files/spritesheet_imports/<id>/sheet_frames.json",
        "rows": int, "cols": int, "frame_w": int, "frame_h": int
    }
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from loguru import logger

from core.config import PROJECT_ROOT
from tools.spritesheet_splitter import split_grid
from tools.spritesheet_normalizer import measure_grid, normalize_grid

router = APIRouter(prefix="/api/spritesheet", tags=["spritesheet"])


def _has_usable_alpha(path: Path) -> bool:
    """True if the PNG carries a real (non-constant) alpha channel.

    Normalization detects each frame's silhouette from alpha — it is meaningless
    on a fully-opaque sheet (every pixel would count as content). We use this to
    skip/await background removal instead of silently mangling an opaque upload.
    """
    from PIL import Image

    with Image.open(path) as im:
        if "A" not in im.getbands():
            return False
        alpha = im.convert("RGBA").getchannel("A")
        lo, hi = alpha.getextrema()
        return lo < hi  # has at least some transparent AND some opaque pixels

# Served via the /files StaticFiles mount (public_files → /files).
_IMPORT_ROOT = PROJECT_ROOT / "public_files" / "spritesheet_imports"
_SERVE_PREFIX = "/files/spritesheet_imports"

# Reject oversized uploads — a spritesheet grid is at most ~2048px square.
_MAX_FILE_BYTES = 25 * 1024 * 1024
# Mirror the generation cap: 5x5+ grids drift, so refuse absurd splits.
_MAX_FRAMES = 64


@router.post("/import")
async def import_spritesheet(
    file: UploadFile = File(...),
    rows: int = Form(...),
    cols: int = Form(...),
    frame_w: int | None = Form(default=None),
    frame_h: int | None = Form(default=None),
    normalize: bool = Form(default=True),
    align: str = Form(default="bottom-center"),
    pad: int = Form(default=6),
) -> dict[str, Any]:
    """Slice an uploaded spritesheet PNG into frames + frames.json.

    Fails loudly on bad input (non-PNG, bad grid, oversized file, grid that
    does not fit the image) — no silent fallbacks.
    """
    if rows < 1 or cols < 1:
        raise HTTPException(status_code=400, detail="rows and cols must be >= 1")
    if rows * cols > _MAX_FRAMES:
        raise HTTPException(
            status_code=400,
            detail=f"{rows}x{cols}={rows * cols} frames exceeds max {_MAX_FRAMES}",
        )

    fname = (file.filename or "spritesheet.png").lower()
    if not fname.endswith(".png"):
        raise HTTPException(status_code=400, detail="file must be a PNG")

    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail="empty file")
    if len(body) > _MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large (>{_MAX_FILE_BYTES // (1024 * 1024)} MB)",
        )

    import_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"
    out_dir = _IMPORT_ROOT / import_id
    out_dir.mkdir(parents=True, exist_ok=True)

    base_name = "sheet"
    src_path = out_dir / f"{base_name}_source.png"
    src_path.write_bytes(body)

    # Validate it is a real PNG with sane dimensions before slicing.
    try:
        from PIL import Image
        with Image.open(src_path) as img:
            img.verify()
    except Exception as e:  # noqa: BLE001 — bad upload, surface as 400
        src_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"invalid PNG: {e}") from None

    # Pixel-perfect alignment (systemic default): re-anchor every frame so the
    # animation does not jitter. Skipped only when the sheet has no usable alpha
    # (an opaque upload — nothing to detect a silhouette from).
    norm_meta: dict[str, Any] | None = None
    if normalize:
        if _has_usable_alpha(src_path):
            try:
                norm_meta = normalize_grid(
                    src_path, rows=rows, cols=cols, align=align, pad=pad,
                    frame_w=frame_w, frame_h=frame_h,
                )
            except (ValueError, RuntimeError) as e:
                raise HTTPException(status_code=400, detail=str(e)) from None
        else:
            logger.info("spritesheet import: opaque sheet (no alpha) — skipping normalize")

    # split_grid raises ValueError if the grid does not fit — surface as 400.
    try:
        result = split_grid(
            src_path,
            rows=rows,
            cols=cols,
            frame_w=frame_w,
            frame_h=frame_h,
            out_dir=out_dir,
            base_name=base_name,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None

    def _served(abs_path: str) -> str:
        return f"{_SERVE_PREFIX}/{import_id}/{Path(abs_path).name}"

    frame_urls = [_served(p) for p in result["frames"]]
    frames_json_url = _served(result["frames_json"])

    logger.info(
        "spritesheet import: {f} → {n} frames ({r}x{c}) id={id}",
        f=file.filename, n=len(frame_urls), r=result["rows"], c=result["cols"],
        id=import_id,
    )

    return {
        "ok": True,
        "frames": frame_urls,
        "frames_json_url": frames_json_url,
        "rows": result["rows"],
        "cols": result["cols"],
        "frame_w": result["frame_w"],
        "frame_h": result["frame_h"],
        "normalized": norm_meta is not None,
        "alignment": None if norm_meta is None else {
            "align": norm_meta["align"],
            "jitter_before": [norm_meta["jitter_x_before"], norm_meta["jitter_y_before"]],
            "scale": norm_meta["scale"],
            "overflow_frames": norm_meta["n_overflow"],
        },
    }


@router.post("/normalize")
async def normalize_spritesheet(
    file: UploadFile = File(...),
    rows: int = Form(...),
    cols: int = Form(...),
    align: str = Form(default="bottom-center"),
    pad: int = Form(default=6),
    frame_w: int | None = Form(default=None),
    frame_h: int | None = Form(default=None),
) -> dict[str, Any]:
    """Pixel-perfect-align an uploaded spritesheet, then slice it.

    Same input shape as /import but normalization is MANDATORY here: it re-anchors
    every frame to one consistent anchor (feet-align by default) so the animation
    stops jittering. Requires a real alpha channel — a fully opaque sheet is
    rejected with guidance to remove its background first.

    Returns served frame URLs, the normalized sheet URL, the frames.json URL, and
    `alignment` metrics (jitter removed, applied scale, overflow frame count).
    """
    if rows < 1 or cols < 1:
        raise HTTPException(status_code=400, detail="rows and cols must be >= 1")
    if rows * cols > _MAX_FRAMES:
        raise HTTPException(
            status_code=400,
            detail=f"{rows}x{cols}={rows * cols} frames exceeds max {_MAX_FRAMES}",
        )
    if align not in ("bottom-center", "center", "top-center"):
        raise HTTPException(status_code=400, detail=f"bad align {align!r}")

    fname = (file.filename or "spritesheet.png").lower()
    if not fname.endswith(".png"):
        raise HTTPException(status_code=400, detail="file must be a PNG")
    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail="empty file")
    if len(body) > _MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large (>{_MAX_FILE_BYTES // (1024 * 1024)} MB)",
        )

    import_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"
    out_dir = _IMPORT_ROOT / import_id
    out_dir.mkdir(parents=True, exist_ok=True)
    base_name = "sheet"
    src_path = out_dir / f"{base_name}_source.png"
    src_path.write_bytes(body)

    try:
        from PIL import Image
        with Image.open(src_path) as img:
            img.verify()
    except Exception as e:  # noqa: BLE001 — bad upload → 400
        src_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"invalid PNG: {e}") from None

    if not _has_usable_alpha(src_path):
        raise HTTPException(
            status_code=400,
            detail=(
                "sheet has no usable transparency — alignment needs each frame's "
                "silhouette from the alpha channel. Remove the background first "
                "(POST /api/library/{project}/remove-bg), then normalize."
            ),
        )

    normalized_path = out_dir / f"{base_name}_normalized.png"
    try:
        norm = normalize_grid(
            src_path, rows=rows, cols=cols, out_path=normalized_path,
            align=align, pad=pad, frame_w=frame_w, frame_h=frame_h,
        )
        result = split_grid(
            normalized_path, rows=rows, cols=cols,
            frame_w=frame_w, frame_h=frame_h,
            out_dir=out_dir, base_name=base_name,
        )
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from None

    def _served(p: str) -> str:
        return f"{_SERVE_PREFIX}/{import_id}/{Path(p).name}"

    logger.info(
        "spritesheet normalize: {f} {r}x{c} jitter ({jx},{jy})->0 scale={s} id={id}",
        f=file.filename, r=rows, c=cols,
        jx=norm["jitter_x_before"], jy=norm["jitter_y_before"], s=norm["scale"],
        id=import_id,
    )
    return {
        "ok": True,
        "frames": [_served(p) for p in result["frames"]],
        "frames_json_url": _served(result["frames_json"]),
        "normalized_sheet_url": _served(str(normalized_path)),
        "rows": result["rows"],
        "cols": result["cols"],
        "frame_w": result["frame_w"],
        "frame_h": result["frame_h"],
        "alignment": {
            "align": norm["align"],
            "jitter_before": [norm["jitter_x_before"], norm["jitter_y_before"]],
            "jitter_after": norm["jitter_after"],
            "scale": norm["scale"],
            "overflow_frames": norm["n_overflow"],
            "live_frames": norm["n_live"],
        },
    }
