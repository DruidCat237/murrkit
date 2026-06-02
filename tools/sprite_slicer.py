"""
Sprite Slicer — Pillow-based grid slicing and atlas building.

Cuts horizontal strips into individual frame images.
Packs multiple strips into a master atlas PNG.

Usage:
    from tools.sprite_slicer import slice_strip, build_atlas

    frames = slice_strip("knight_walk.png", frame_count=4)
    # frames: list of PIL Image objects

    build_atlas(["knight_idle.png", "knight_walk.png"], "knight_atlas.png")
"""

from __future__ import annotations

from pathlib import Path

from loguru import logger


def slice_strip(
    strip_path: Path | str,
    frame_count: int,
    *,
    save_frames: bool = False,
    output_dir: Path | None = None,
) -> list[object]:
    """
    Slice a horizontal strip PNG into individual frames.

    Args:
        strip_path:   Path to horizontal strip image.
        frame_count:  Number of frames in the strip.
        save_frames:  If True, save individual frame PNGs to output_dir.
        output_dir:   Where to save frames (defaults to strip's directory).

    Returns:
        List of PIL Image objects (one per frame).
    """
    try:
        from PIL import Image
    except ImportError:
        raise ImportError("Pillow not installed. Run: uv add pillow")

    strip_path = Path(strip_path)
    with Image.open(strip_path) as img:
        total_width, height = img.size
        frame_width = total_width // frame_count
        frames: list[Image.Image] = []

        for i in range(frame_count):
            x = i * frame_width
            box = (x, 0, x + frame_width, height)
            frame = img.crop(box).copy()
            frames.append(frame)

            if save_frames:
                out_dir = output_dir or strip_path.parent
                out_dir.mkdir(parents=True, exist_ok=True)
                stem = strip_path.stem
                frame.save(str(out_dir / f"{stem}_frame_{i:02d}.png"), "PNG")

    logger.debug(
        "slice_strip: {n} frames from {p} ({fw}x{h}px each)",
        n=len(frames),
        p=strip_path.name,
        fw=frame_width,
        h=height,
    )
    return frames


def build_atlas(
    strip_paths: list[Path | str],
    output_path: Path | str,
) -> Path:
    """
    Stack multiple strips vertically into a master atlas PNG.

    Each strip becomes one row in the atlas. Strips are padded/cropped to
    the same width (the widest strip's width).

    Args:
        strip_paths:  List of paths to horizontal strip PNGs.
        output_path:  Where to write the atlas PNG.

    Returns:
        output_path as Path.
    """
    try:
        from PIL import Image
    except ImportError:
        raise ImportError("Pillow not installed. Run: uv add pillow")

    output_path = Path(output_path)
    strips: list[Image.Image] = []

    for p in strip_paths:
        with Image.open(p) as img:
            strips.append(img.copy())

    if not strips:
        raise ValueError("No strips provided to build_atlas()")

    max_width = max(s.width for s in strips)
    total_height = sum(s.height for s in strips)

    atlas = Image.new("RGBA", (max_width, total_height), (0, 0, 0, 0))
    y = 0
    for strip in strips:
        atlas.paste(strip, (0, y))
        y += strip.height

    output_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(str(output_path), "PNG")
    logger.info(
        "build_atlas: {n} strips -> {w}x{h}px atlas at {p}",
        n=len(strips),
        w=max_width,
        h=total_height,
        p=output_path.name,
    )
    return output_path


def resize_frame(
    frame_path: Path | str,
    target_size: tuple[int, int],
    output_path: Path | str | None = None,
) -> Path:
    """
    Resize a sprite frame to target_size, preserving RGBA transparency.
    Uses NEAREST filter for pixel art (no anti-aliasing).

    Args:
        frame_path:   Input PNG.
        target_size:  (width, height) in pixels.
        output_path:  Where to save. Defaults to overwriting input.

    Returns:
        Saved file path.
    """
    try:
        from PIL import Image
    except ImportError:
        raise ImportError("Pillow not installed. Run: uv add pillow")

    frame_path = Path(frame_path)
    out = Path(output_path) if output_path else frame_path

    with Image.open(frame_path) as img:
        resized = img.resize(target_size, Image.NEAREST)

    out.parent.mkdir(parents=True, exist_ok=True)
    resized.save(str(out), "PNG")
    return out
