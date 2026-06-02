"""
Spritesheet Normalizer — make every frame pixel-perfect aligned to each other.

THE PROBLEM this solves (root cause of "koślawe / trzęsące się" animations):
GPT-Image-2 renders an N×N grid where the character sits at a SLIGHTLY DIFFERENT
position and size inside each cell. `split_grid` then cuts the sheet into EVEN
cells, so the centre-pivot lands on a different part of the body every frame.
Played back, the sprite jitters and bobs — so animations get thrown away.

THE FIX (deterministic, no LLM): for each cell, find the real content bounding
box from the ALPHA channel (the sheet must already be background-removed), then
re-place that content into a fresh uniform cell with ONE consistent anchor —
`bottom-center` (feet-align) by default, so the feet stay glued to the same
ground line and the body grows UP from it. Frames become pixel-perfect even
relative to each other → no jitter, no bob.

Scale is PRESERVED (factor 1.0) unless a frame's content is too big for its cell
(the "cut ears" overflow case): then EVERY frame is uniformly down-scaled by the
same factor so the largest one fits with margin — uniform, so still no jitter and
no relative-size popping between frames.

This is meant to run OBLIGATORILY in the sprite pipeline (right after rembg,
before slicing) and is also exposed via `POST /api/spritesheet/normalize`.

Public API:
    normalize_grid(image_path, rows, cols, *, out_path=None, align="bottom-center",
                   pad=6, alpha_threshold=8, frame_w=None, frame_h=None) -> dict
    measure_grid(image_path, rows, cols, *, alpha_threshold=8,
                 frame_w=None, frame_h=None) -> dict   # metrics only, no write
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from loguru import logger

ALIGN_MODES = ("bottom-center", "center", "top-center")


def _cell_geometry(sheet_w: int, sheet_h: int, rows: int, cols: int,
                   frame_w: int | None, frame_h: int | None) -> tuple[int, int]:
    """Resolve per-cell size, defaulting to an even split of the sheet."""
    fw = int(frame_w) if frame_w else sheet_w // cols
    fh = int(frame_h) if frame_h else sheet_h // rows
    if fw < 1 or fh < 1:
        raise ValueError(
            f"computed frame size {fw}x{fh}px invalid for {sheet_w}x{sheet_h}px "
            f"sheet split {rows}x{cols}"
        )
    if cols * fw > sheet_w or rows * fh > sheet_h:
        raise ValueError(
            f"{rows}x{cols} grid of {fw}x{fh}px frames does not fit in "
            f"{sheet_w}x{sheet_h}px sheet"
        )
    return fw, fh


def _content_bbox(cell: "Any", alpha_threshold: int) -> tuple[int, int, int, int] | None:
    """Bounding box of visible pixels via the ALPHA channel only.

    Using the full-image getbbox() is WRONG for rembg output: transparent pixels
    often keep non-zero RGB, so getbbox() would return the whole cell. We threshold
    the alpha channel and bbox THAT, which is the true silhouette.
    """
    alpha = cell.getchannel("A")
    mask = alpha.point(lambda a: 255 if a > alpha_threshold else 0)
    return mask.getbbox()  # (left, top, right, bottom) or None if fully empty


def _analyze(img: "Any", rows: int, cols: int, fw: int, fh: int,
             alpha_threshold: int) -> dict[str, Any]:
    """Per-cell content metrics: bbox, size, edge-overflow, feet-anchor (local)."""
    cells: list[dict[str, Any]] = []
    max_cw = max_ch = 0
    for row in range(rows):
        for col in range(cols):
            x0, y0 = col * fw, row * fh
            cell = img.crop((x0, y0, x0 + fw, y0 + fh))
            bbox = _content_bbox(cell, alpha_threshold)
            if bbox is None:
                cells.append({"row": row, "col": col, "blank": True})
                continue
            l, t, r, b = bbox
            cw, ch = r - l, b - t
            max_cw, max_ch = max(max_cw, cw), max(max_ch, ch)
            # Touching a cell edge → the model likely drew past the cell and the
            # even slice clipped it (e.g. the cat's ears). Flag for regeneration.
            touches = l <= 0 or t <= 0 or r >= fw or b >= fh
            cells.append({
                "row": row, "col": col, "blank": False, "bbox": (l, t, r, b),
                "cw": cw, "ch": ch,
                # feet anchor in LOCAL cell coords: horizontal centre, bottom edge
                "anchor_x": l + cw / 2.0, "anchor_y": float(b),
                "touches_edge": touches,
            })
    return {"cells": cells, "max_cw": max_cw, "max_ch": max_ch}


def _stdev(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    return math.sqrt(sum((v - mean) ** 2 for v in values) / n)


def measure_grid(
    image_path: Path | str,
    rows: int,
    cols: int,
    *,
    alpha_threshold: int = 8,
    frame_w: int | None = None,
    frame_h: int | None = None,
) -> dict[str, Any]:
    """Compute alignment metrics for a grid sheet WITHOUT modifying it.

    `jitter_x/jitter_y` are the std-dev (px) of the per-frame feet-anchor across
    non-blank frames — i.e. how much the sprite wanders cell-to-cell. ~0 = clean,
    large = the shaky animation the user is seeing.
    """
    from PIL import Image

    image_path = Path(image_path)
    if not image_path.is_file():
        raise FileNotFoundError(f"spritesheet not found: {image_path}")
    if rows < 1 or cols < 1:
        raise ValueError(f"rows/cols must be >= 1 (got {rows}x{cols})")

    with Image.open(image_path) as im:
        img = im.convert("RGBA")
        sheet_w, sheet_h = img.size
        fw, fh = _cell_geometry(sheet_w, sheet_h, rows, cols, frame_w, frame_h)
        info = _analyze(img, rows, cols, fw, fh, alpha_threshold)

    live = [c for c in info["cells"] if not c["blank"]]
    return {
        "rows": rows, "cols": cols, "frame_w": fw, "frame_h": fh,
        "n_frames": len(info["cells"]), "n_live": len(live),
        "n_blank": len(info["cells"]) - len(live),
        "n_overflow": sum(1 for c in live if c["touches_edge"]),
        "max_content_w": info["max_cw"], "max_content_h": info["max_ch"],
        "jitter_x": round(_stdev([c["anchor_x"] for c in live]), 2),
        "jitter_y": round(_stdev([c["anchor_y"] for c in live]), 2),
    }


def normalize_grid(
    image_path: Path | str,
    rows: int,
    cols: int,
    *,
    out_path: Path | str | None = None,
    align: str = "bottom-center",
    pad: int = 6,
    alpha_threshold: int = 8,
    frame_w: int | None = None,
    frame_h: int | None = None,
) -> dict[str, Any]:
    """Re-anchor every frame to a single consistent anchor → pixel-perfect even.

    Args:
        image_path: RGBA grid sheet, background ALREADY removed (needs real alpha).
        rows, cols: Grid geometry.
        out_path:   Where to write the normalized sheet. Defaults to overwriting
                    `image_path` in place (the pipeline wants the clean sheet to
                    BECOME the normalized one).
        align:      "bottom-center" (feet-align, default — best for characters),
                    "center", or "top-center".
        pad:        Transparent margin (px) kept inside each cell on the anchored
                    side(s). Also the safety margin used when down-scaling overflow.
        alpha_threshold: Alpha above this counts as content.

    Returns:
        Metrics dict incl. `jitter_x/before`, applied `scale`, `n_overflow`,
        and the (unchanged) cell geometry — so the caller can `split_grid` after.

    Raises:
        ValueError on bad grid; RuntimeError if the sheet is entirely empty.
    """
    from PIL import Image

    if align not in ALIGN_MODES:
        raise ValueError(f"align must be one of {ALIGN_MODES} (got {align!r})")

    image_path = Path(image_path)
    out_path = Path(out_path) if out_path else image_path
    if not image_path.is_file():
        raise FileNotFoundError(f"spritesheet not found: {image_path}")
    if rows < 1 or cols < 1:
        raise ValueError(f"rows/cols must be >= 1 (got {rows}x{cols})")

    with Image.open(image_path) as im:
        img = im.convert("RGBA")
        sheet_w, sheet_h = img.size
        fw, fh = _cell_geometry(sheet_w, sheet_h, rows, cols, frame_w, frame_h)
        info = _analyze(img, rows, cols, fw, fh, alpha_threshold)
        live = [c for c in info["cells"] if not c["blank"]]
        if not live:
            raise RuntimeError(
                f"{image_path.name}: every cell is empty (alpha<={alpha_threshold}) "
                "— refusing to normalize a blank sheet"
            )

        # Uniform scale: 1.0 unless the biggest content can't fit with `pad` margin.
        safe_w = max(1, fw - 2 * pad)
        safe_h = max(1, fh - 2 * pad)
        scale = min(1.0, safe_w / info["max_cw"], safe_h / info["max_ch"])

        jitter_x_before = round(_stdev([c["anchor_x"] for c in live]), 2)
        jitter_y_before = round(_stdev([c["anchor_y"] for c in live]), 2)

        out = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
        for c in info["cells"]:
            if c["blank"]:
                continue
            l, t, r, b = c["bbox"]
            content = img.crop((c["col"] * fw + l, c["row"] * fh + t,
                                c["col"] * fw + r, c["row"] * fh + b))
            if scale < 1.0:
                content = content.resize(
                    (max(1, round((r - l) * scale)), max(1, round((b - t) * scale))),
                    Image.LANCZOS,
                )
            cw2, ch2 = content.size
            # Anchor inside the cell.
            px = (fw - cw2) // 2
            if align == "bottom-center":
                py = fh - pad - ch2
            elif align == "top-center":
                py = pad
            else:  # center
                py = (fh - ch2) // 2
            px = min(max(px, 0), max(0, fw - cw2))
            py = min(max(py, 0), max(0, fh - ch2))
            out.paste(content, (c["col"] * fw + px, c["row"] * fh + py), content)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out.save(str(out_path), "PNG")

    result = {
        "ok": True,
        "out_path": str(out_path),
        "rows": rows, "cols": cols, "frame_w": fw, "frame_h": fh,
        "n_frames": len(info["cells"]),
        "n_live": len(live),
        "n_blank": len(info["cells"]) - len(live),
        "n_overflow": sum(1 for c in live if c["touches_edge"]),
        "scale": round(scale, 4),
        "align": align, "pad": pad,
        "jitter_x_before": jitter_x_before,
        "jitter_y_before": jitter_y_before,
        # After normalization every live frame shares the exact same anchor.
        "jitter_after": 0.0,
        "max_content_w": info["max_cw"], "max_content_h": info["max_ch"],
    }
    logger.info(
        "normalize_grid: {src} {r}x{c} → jitter ({jx},{jy})px → 0 | "
        "scale={s} overflow={ov}/{n} align={al} → {out}",
        src=image_path.name, r=rows, c=cols,
        jx=jitter_x_before, jy=jitter_y_before, s=result["scale"],
        ov=result["n_overflow"], n=result["n_live"], al=align, out=out_path.name,
    )
    return result
