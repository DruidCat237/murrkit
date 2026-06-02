"""
Texture Packer — sprite atlas packing via Pillow bin-packing.

Simple rectangle packing for sprite atlases. No external CLI dependency —
uses a pure-Python shelf packing algorithm (good enough for game sprites).

For production, consider FreeTexPacker CLI or TexturePacker (paid).
This module provides the MVP implementation that covers the spritesheet use case.

Usage:
    from tools.texture_packer import pack_sprites

    atlas_path, metadata = pack_sprites(
        sprite_paths=["knight_idle_00.png", "knight_idle_01.png", ...],
        output_path="knight_atlas.png",
        max_size=(2048, 2048),
    )
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from loguru import logger


@dataclass
class PackedSprite:
    name: str
    x: int
    y: int
    width: int
    height: int
    source_path: str


def pack_sprites(
    sprite_paths: list[Path | str],
    output_path: Path | str,
    *,
    max_size: tuple[int, int] = (2048, 2048),
    padding: int = 2,
    power_of_two: bool = True,
) -> tuple[Path, list[PackedSprite]]:
    """
    Pack multiple sprite PNGs into a single atlas texture.

    Uses a simple shelf-packing algorithm: rows fill left-to-right,
    new row starts when current row is full. Good for uniform-size sprites
    (like sprite strip frames) and reasonable for mixed sizes.

    Args:
        sprite_paths:  Input PNG files.
        output_path:   Output atlas PNG path.
        max_size:      Maximum atlas dimensions.
        padding:       Pixel gap between sprites (prevents bleeding).
        power_of_two:  Round atlas size up to next power of two.

    Returns:
        (atlas_path, list_of_PackedSprite)

    Raises:
        ImportError if Pillow not installed.
        RuntimeError if sprites don't fit in max_size.
    """
    try:
        from PIL import Image
    except ImportError:
        raise ImportError("Pillow not installed. Run: uv add pillow")

    output_path = Path(output_path)
    sprites: list[tuple[str, Image.Image]] = []

    for p in sprite_paths:
        p = Path(p)
        with Image.open(p) as img:
            sprites.append((p.stem, img.copy()))

    if not sprites:
        raise ValueError("No sprites provided to pack_sprites()")

    # Shelf-packing
    max_w, max_h = max_size
    packed: list[PackedSprite] = []
    shelf_x = padding
    shelf_y = padding
    shelf_height = 0
    canvas_w = padding
    canvas_h = padding

    for name, img in sprites:
        w, h = img.size
        padded_w = w + padding
        padded_h = h + padding

        if shelf_x + padded_w > max_w:
            # New shelf
            shelf_x = padding
            shelf_y += shelf_height + padding
            shelf_height = 0

        if shelf_y + padded_h > max_h:
            raise RuntimeError(
                f"Atlas overflow: sprites don't fit in {max_w}x{max_h}. "
                "Increase max_size or reduce sprite count."
            )

        packed.append(PackedSprite(
            name=name,
            x=shelf_x,
            y=shelf_y,
            width=w,
            height=h,
            source_path=name,
        ))

        canvas_w = max(canvas_w, shelf_x + padded_w)
        canvas_h = max(canvas_h, shelf_y + padded_h)
        shelf_x += padded_w
        shelf_height = max(shelf_height, h)

    # Round up to power of two if requested
    if power_of_two:
        def next_pow2(n: int) -> int:
            p = 1
            while p < n:
                p <<= 1
            return p
        canvas_w = next_pow2(canvas_w)
        canvas_h = next_pow2(canvas_h)

    # Composite
    atlas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    sprite_map = {name: img for name, img in sprites}

    for ps in packed:
        img = sprite_map.get(ps.name)
        if img:
            atlas.paste(img, (ps.x, ps.y))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(str(output_path), "PNG")

    logger.info(
        "pack_sprites: {n} sprites -> {w}x{h}px atlas at {p}",
        n=len(packed),
        w=canvas_w,
        h=canvas_h,
        p=output_path.name,
    )

    # Save metadata JSON alongside atlas
    meta_path = output_path.with_suffix(".json")
    meta_path.write_text(
        json.dumps(
            {
                "atlas": output_path.name,
                "size": [canvas_w, canvas_h],
                "sprites": [
                    {
                        "name": ps.name,
                        "x": ps.x,
                        "y": ps.y,
                        "width": ps.width,
                        "height": ps.height,
                    }
                    for ps in packed
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    return output_path, packed
