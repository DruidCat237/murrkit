"""
Asset Pipeline — generic 2D asset generation (tilesets, backgrounds, UI, particles).

Handles asset types not covered by sprite_pipeline:
    - Backgrounds (parallax layers: sky, far mountains, near hills, ground)
    - Tilesets (ground, wall, platform, decoration tiles)
    - UI elements (buttons, panels, health bars, icons)
    - Particle textures (sparks, dust, impact, magic)

Each asset type has a tailored prompt strategy and output format.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from loguru import logger


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

AssetType = Literal["background", "tileset", "ui_element", "particle_fx"]


@dataclass
class AssetResult:
    asset_type: AssetType
    name: str
    output_dir: Path
    files: list[Path] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    cost_usd: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "asset_type": self.asset_type,
            "name": self.name,
            "output_dir": str(self.output_dir),
            "files": [str(f) for f in self.files],
            "metadata": self.metadata,
            "cost_usd": self.cost_usd,
        }


# ---------------------------------------------------------------------------
# Prompt strategies
# ---------------------------------------------------------------------------

# 2D-background art direction (HARD). A bright sun / sunburst / lens-flare /
# sunset glow is a distracting focal HOTSPOT: it pulls the eye off the gameplay,
# fights the evenly-lit sprites, and ruins flat horizontal tiling + parallax
# compositing. So every layer is evenly, softly lit with NO sun and NO single
# bright focal point, and the sky is a pleasant calm 2D-game blue.
_NO_SUN_RULE = (
    "Do NOT draw a sun, sunburst, sunrise or sunset, bright glow, god rays, lens "
    "flare, or ANY single bright focal hotspot anywhere — it distracts from the "
    "gameplay and breaks flat 2D tiling. Keep the WHOLE layer evenly and softly "
    "lit with no dominant light source and no glare."
)


def _background_prompt(description: str, layer: str) -> str:
    """Build prompt for one parallax layer.

    Each layer is a SEPARATE, cleanly-separable part that the engine composites
    and scrolls independently, so we keep every layer flat, evenly lit, free of a
    focal hotspot, and seamlessly tileable. The sky is a pleasant 2D-game blue
    (optionally a few soft clouds), never a sun/sunset.
    """
    layer_hints = {
        "sky": (
            "the SKY layer (very far background): a pleasant, calm BLUE sky with a "
            "smooth soft vertical gradient (a little lighter toward the horizon), "
            "optionally a few soft, simple, stylised fluffy clouds - and nothing else"
        ),
        "far":    "far-background hills, mountains or city silhouettes, low detail, muted desaturated colours",
        "mid":    "mid-ground hills, trees or buildings, medium detail",
        "near":   "near-ground foliage, props or structures, higher detail",
        "ground": "ground-level strip decoration, seamless horizontal tile",
    }
    hint = layer_hints.get(layer, layer)
    return (
        f"2D game background - {hint}. {description}. "
        f"This is ONE parallax layer that the engine composites and scrolls "
        f"together with other separate layers, so keep it a clean, flat, "
        f"evenly-lit 2D game layer, seamlessly tileable horizontally, wide aspect "
        f"ratio, no characters. {_NO_SUN_RULE}"
    )


def _tileset_prompt(description: str, tile_type: str) -> str:
    """Build prompt for a tileset sheet (16x16 or 32x32 tiles in a grid)."""
    return (
        f"2D game tileset sheet, {tile_type} tiles. {description}. "
        f"Grid layout 8x4 tiles, each tile 64x64px. "
        f"Consistent art style. Top-down or side-view game tiles. "
        f"Pixel art style, transparent or white background."
    )


def _ui_prompt(description: str, element_type: str) -> str:
    """Build prompt for a UI element."""
    return (
        f"2D game UI {element_type}. {description}. "
        f"Clean game UI style, transparent background. "
        f"Game-ready asset, no text labels."
    )


def _particle_prompt(description: str, fx_type: str) -> str:
    """Build prompt for a particle texture sheet."""
    return (
        f"Particle effect sprite sheet, {fx_type}. {description}. "
        f"Small particles on transparent background, horizontal strip of 8 frames. "
        f"Pixel art game style."
    )


# ---------------------------------------------------------------------------
# Main generators
# ---------------------------------------------------------------------------

async def generate_background(
    description: str,
    layers: list[str] | None = None,
    *,
    output_dir: Path | None = None,
    project: str | None = None,
) -> AssetResult:
    """
    Generate parallax background layers.

    Args:
        description: Scene description e.g. "forest with pine trees at sunset"
        layers:      Layer names, default ["sky", "far", "mid", "near"]
        output_dir:  Output directory.
        project:     Owning project (threaded from the gen-queue task) for the
                     per-project output dir. Ignored when output_dir is given.

    Returns:
        AssetResult with one PNG per layer.
    """
    from tools.gpt_image_2 import submit_generate, poll_until_done

    from agents.sprite_pipeline import (
        _slugify, _default_output_dir, subfolder_for_role,
    )

    layer_list = layers or ["sky", "far", "mid", "near"]
    slug = _slugify(description, 30) or "background"

    if output_dir is None:
        # Deterministic role→folder: environment/parallax always land in
        # Backgrounds, never guessed from the prompt.
        output_dir = _default_output_dir(subfolder_for_role("background"), project) / slug
    output_dir.mkdir(parents=True, exist_ok=True)

    files: list[Path] = []
    total_cost = 0.0

    for layer in layer_list:
        logger.info("  Generating bg layer: {layer}", layer=layer)
        prompt = _background_prompt(description, layer)
        task_id = submit_generate(prompt=prompt, size="16:9", quality="high", resolution="2K")
        image_url, cost = await poll_until_done(task_id)
        total_cost += cost

        import aiohttp
        out_path = output_dir / f"bg_{slug}_{layer}.png"
        async with aiohttp.ClientSession() as session:
            async with session.get(image_url) as resp:
                out_path.write_bytes(await resp.read())
        files.append(out_path)

    return AssetResult(
        asset_type="background",
        name=slug,
        output_dir=output_dir,
        files=files,
        metadata={"layers": layer_list, "description": description},
        cost_usd=total_cost,
    )


async def generate_tileset(
    description: str,
    tile_type: str = "ground",
    *,
    output_dir: Path | None = None,
    project: str | None = None,
) -> AssetResult:
    """
    Generate a tileset sheet.

    Args:
        description: e.g. "mossy stone dungeon floor"
        tile_type:   "ground" | "wall" | "platform" | "decoration"
        output_dir:  Output directory.
        project:     Owning project (threaded from the gen-queue task) for the
                     per-project output dir. Ignored when output_dir is given.
    """
    from tools.gpt_image_2 import submit_generate, poll_until_done

    from agents.sprite_pipeline import (
        _slugify, _default_output_dir, subfolder_for_role,
    )

    slug = f"{tile_type}_{_slugify(description, 20) or 'tiles'}"

    if output_dir is None:
        output_dir = _default_output_dir(subfolder_for_role("tileset"), project) / slug
    output_dir.mkdir(parents=True, exist_ok=True)

    prompt = _tileset_prompt(description, tile_type)
    task_id = submit_generate(prompt=prompt, size="4:3", quality="high", resolution="2K")
    image_url, cost = await poll_until_done(task_id)

    import aiohttp
    out_path = output_dir / f"tileset_{slug}.png"
    async with aiohttp.ClientSession() as session:
        async with session.get(image_url) as resp:
            out_path.write_bytes(await resp.read())

    # Write basic sprite-slice import metadata
    meta_path = output_dir / f"tileset_{slug}.json"
    meta_path.write_text(json.dumps({
        "type": "tileset",
        "tile_size": 64,
        "columns": 8,
        "rows": 4,
        "unity_import_hint": {
            "textureType": "Sprite",
            "spriteMode": "Multiple",
            "pixelsPerUnit": 64,
            "filterMode": "Point",
        },
    }, indent=2), encoding="utf-8")

    return AssetResult(
        asset_type="tileset",
        name=slug,
        output_dir=output_dir,
        files=[out_path, meta_path],
        metadata={"tile_type": tile_type, "description": description},
        cost_usd=cost,
    )


async def generate_ui_element(
    description: str,
    element_type: str = "button",
    *,
    output_dir: Path | None = None,
    project: str | None = None,
) -> AssetResult:
    """
    Generate a UI element PNG.

    Args:
        description:  e.g. "fantasy wooden button with gold border"
        element_type: "button" | "panel" | "health_bar" | "icon" | "frame"
        output_dir:   Output directory.
        project:      Owning project (threaded from the gen-queue task) for the
                      per-project output dir. Ignored when output_dir is given.
    """
    from tools.gpt_image_2 import submit_generate, poll_until_done

    from agents.sprite_pipeline import (
        _slugify, _default_output_dir, subfolder_for_role,
    )

    slug = f"ui_{element_type}_{_slugify(description, 15) or 'ui'}"

    if output_dir is None:
        output_dir = _default_output_dir(subfolder_for_role("ui-element"), project) / slug
    output_dir.mkdir(parents=True, exist_ok=True)

    prompt = _ui_prompt(description, element_type)
    task_id = submit_generate(prompt=prompt, size="1:1", quality="high", resolution="1K")
    image_url, cost = await poll_until_done(task_id)

    import aiohttp
    out_path = output_dir / f"{slug}.png"
    async with aiohttp.ClientSession() as session:
        async with session.get(image_url) as resp:
            out_path.write_bytes(await resp.read())

    return AssetResult(
        asset_type="ui_element",
        name=slug,
        output_dir=output_dir,
        files=[out_path],
        metadata={"element_type": element_type, "description": description},
        cost_usd=cost,
    )


async def generate_particle_fx(
    description: str,
    fx_type: str = "dust",
    *,
    output_dir: Path | None = None,
    project: str | None = None,
) -> AssetResult:
    """
    Generate a particle effect sprite sheet.

    Args:
        description: e.g. "golden sparkles with glow"
        fx_type:     "dust" | "spark" | "impact" | "magic" | "smoke"
        output_dir:  Output directory.
        project:     Owning project (threaded from the gen-queue task) for the
                     per-project output dir. Ignored when output_dir is given.
    """
    from tools.gpt_image_2 import submit_generate, poll_until_done

    from agents.sprite_pipeline import (
        _slugify, _default_output_dir, subfolder_for_role,
    )

    slug = f"fx_{fx_type}_{_slugify(description, 15) or 'fx'}"

    if output_dir is None:
        output_dir = _default_output_dir(subfolder_for_role("particle-fx"), project) / slug
    output_dir.mkdir(parents=True, exist_ok=True)

    prompt = _particle_prompt(description, fx_type)
    task_id = submit_generate(prompt=prompt, size="16:2", quality="high", resolution="1K")
    image_url, cost = await poll_until_done(task_id)

    import aiohttp
    out_path = output_dir / f"{slug}.png"
    async with aiohttp.ClientSession() as session:
        async with session.get(image_url) as resp:
            out_path.write_bytes(await resp.read())

    return AssetResult(
        asset_type="particle_fx",
        name=slug,
        output_dir=output_dir,
        files=[out_path],
        metadata={"fx_type": fx_type, "description": description, "frames": 8},
        cost_usd=cost,
    )
