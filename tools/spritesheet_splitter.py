"""
Spritesheet Splitter — true 2D grid slicing with Phaser-ready frames.json.

Where `tools/sprite_slicer.py` only handles 1×N horizontal strips, this module
slices an arbitrary rows×cols grid (e.g. GPT-Image-2's coherent 3×3 / 3×4 sheets)
into individual frame PNGs AND emits a correct `frames.json` whose rects use the
proper 2D column/row math (`x = col * frame_w`, `y = row * frame_h`).

Frame ordering is row-major (left→right, top→bottom) — index 0 is top-left,
index `cols-1` is top-right, index `cols` starts the second row. This matches
how Phaser's `this.load.spritesheet(...)` enumerates frames, so the emitted
`frames.json` lines up 1:1 with `anims.generateFrameNumbers()`.

Public API:
    split_grid(image_path, rows, cols, *, frame_w=None, frame_h=None,
               out_dir, base_name) -> dict
    split_strip(image_path, cols, *, out_dir, base_name, **kw) -> dict   # 1×N convenience

Returned dict (both functions):
    {
        "frames": [<abs path>, ...],   # row-major order
        "frames_json": <abs path>,
        "cols": int,
        "rows": int,
        "frame_w": int,
        "frame_h": int,
    }
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger


def split_grid(
    image_path: Path | str,
    rows: int,
    cols: int,
    *,
    frame_w: int | None = None,
    frame_h: int | None = None,
    out_dir: Path | str,
    base_name: str,
) -> dict[str, Any]:
    """Slice a 2D rows×cols grid PNG into individual frame PNGs + frames.json.

    Args:
        image_path: Source spritesheet PNG (a rows×cols grid of equal cells).
        rows:       Number of rows in the grid (>= 1).
        cols:       Number of columns in the grid (>= 1).
        frame_w:    Explicit frame width in px. Defaults to `image_width // cols`.
        frame_h:    Explicit frame height in px. Defaults to `image_height // rows`.
        out_dir:    Directory to write the frame PNGs + frames.json into.
        base_name:  Stem for output files, e.g. "knight_walk" →
                    knight_walk_00.png ... and knight_walk_frames.json.

    Returns:
        Dict with frame paths (row-major), frames.json path, and grid geometry.

    Raises:
        ValueError:        rows/cols < 1, or the image is too small for the grid.
        FileNotFoundError: image_path does not exist.
        ImportError:       Pillow not installed.
    """
    from PIL import Image

    if rows < 1 or cols < 1:
        raise ValueError(f"rows and cols must be >= 1 (got rows={rows}, cols={cols})")

    image_path = Path(image_path)
    if not image_path.is_file():
        raise FileNotFoundError(f"spritesheet not found: {image_path}")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with Image.open(image_path) as img:
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        sheet_w, sheet_h = img.size

        fw = int(frame_w) if frame_w else sheet_w // cols
        fh = int(frame_h) if frame_h else sheet_h // rows
        if fw < 1 or fh < 1:
            raise ValueError(
                f"computed frame size {fw}x{fh}px is invalid for a {sheet_w}x{sheet_h}px "
                f"sheet split into {rows}x{cols}"
            )
        # Loud guard: the grid must actually fit inside the sheet. We allow the
        # sheet to be larger than rows*cols*frame (trailing margin) but never
        # smaller — that would silently crop frames.
        if cols * fw > sheet_w or rows * fh > sheet_h:
            raise ValueError(
                f"{rows}x{cols} grid of {fw}x{fh}px frames "
                f"({cols * fw}x{rows * fh}px) does not fit in {sheet_w}x{sheet_h}px sheet"
            )

        frame_paths: list[Path] = []
        rects: list[dict[str, Any]] = []
        for row in range(rows):
            for col in range(cols):
                idx = row * cols + col
                x = col * fw
                y = row * fh
                box = (x, y, x + fw, y + fh)
                frame = img.crop(box).copy()
                frame_path = out_dir / f"{base_name}_{idx:02d}.png"
                frame.save(str(frame_path), "PNG")
                frame_paths.append(frame_path)
                rects.append({
                    "name": f"{base_name}_{idx:02d}",
                    "index": idx,
                    "col": col,
                    "row": row,
                    "rect": {"x": x, "y": y, "width": fw, "height": fh},
                })

    frames_json_path = out_dir / f"{base_name}_frames.json"
    _write_grid_frames_json(
        frames_json_path,
        source=image_path,
        base_name=base_name,
        rows=rows,
        cols=cols,
        frame_w=fw,
        frame_h=fh,
        rects=rects,
    )

    logger.info(
        "split_grid: {src} → {n} frames ({rows}x{cols} @ {fw}x{fh}px) in {out}",
        src=image_path.name, n=len(frame_paths), rows=rows, cols=cols,
        fw=fw, fh=fh, out=out_dir,
    )
    return {
        "frames": [str(p) for p in frame_paths],
        "frames_json": str(frames_json_path),
        "cols": cols,
        "rows": rows,
        "frame_w": fw,
        "frame_h": fh,
    }


def split_strip(
    image_path: Path | str,
    cols: int,
    *,
    out_dir: Path | str,
    base_name: str,
    frame_w: int | None = None,
    frame_h: int | None = None,
) -> dict[str, Any]:
    """1×N horizontal-strip convenience — thin wrapper over `split_grid` with rows=1."""
    return split_grid(
        image_path,
        rows=1,
        cols=cols,
        frame_w=frame_w,
        frame_h=frame_h,
        out_dir=out_dir,
        base_name=base_name,
    )


def _write_grid_frames_json(
    path: Path,
    *,
    source: Path,
    base_name: str,
    rows: int,
    cols: int,
    frame_w: int,
    frame_h: int,
    rects: list[dict[str, Any]],
) -> None:
    """Write a Phaser-consumable frames.json for a 2D grid.

    The schema carries enough geometry for Phaser's `load.spritesheet` path
    (frameWidth/frameHeight + frame count) AND explicit per-frame rects so a
    texture-atlas style loader can use it directly. Frames are row-major,
    matching `anims.generateFrameNumbers(key, { start, end })`.
    """
    data = {
        "source": str(source),
        "base_name": base_name,
        "intent": "character",
        "grid": {"rows": rows, "cols": cols},
        "frame_w": frame_w,
        "frame_h": frame_h,
        "frame_count": len(rects),
        # Phaser `this.load.spritesheet(key, url, frameConfig)` config — the
        # generated sheet plugs straight into BootScene/GameScene loaders.
        "phaser_frame_config": {
            "frameWidth": frame_w,
            "frameHeight": frame_h,
        },
        "frames": rects,
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
