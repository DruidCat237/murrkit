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

AssetType = Literal["background", "tileset", "biome_tileset", "ui_element", "particle_fx"]


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


# ---------------------------------------------------------------------------
# Map Studio: biome tilesets (16-tile 4×4 autotile sheet)
# ---------------------------------------------------------------------------

# Canonical role map — MUST stay in lockstep with the Phaser compiler
# (`phaser_game/src/builders/mapSpec.ts` TILE): row-major indices of a 4×4 grid.
BIOME_TILE_ROLES: dict[str, Any] = {
    "TL": 0, "T": 1, "TR": 2,
    "L": 3, "C": 4, "R": 5,
    "BL": 6, "B": 7, "BR": 8,
    "variants": [9, 10, 11],
    "decor": [12, 13, 14, 15],
}

BIOME_TILESET_GRID = 4  # 4×4 cells


def _biome_tileset_prompt(description: str, biome: str) -> str:
    """Prompt for a 16-tile autotile sheet with per-cell role semantics.

    The 3×3 block is a classic blob-lite autotile (center + 8 directional
    edges), row 4 holds standalone decor props on flat neutral grey so the
    rembg post-pass can mask them to alpha (GPT-Image-2 cannot emit
    transparency itself — same trick as the character pipeline).
    """
    return (
        f"2D top-down game terrain tileset for a '{biome}' biome: {description}. "
        f"STRICT LAYOUT — a square sheet divided into a 4x4 grid of 16 equal "
        f"square tiles, no gaps, no borders, no labels; every tile fills its "
        f"cell edge-to-edge. "
        f"Rows 1-3, first 3 columns form a seamless 3x3 autotile blob: the "
        f"middle tile (row 2 col 2) is the pure interior terrain; the 8 tiles "
        f"around it are that same terrain fading out toward the sheet-edge "
        f"side(s) of their cell (top row fades toward the top, left column "
        f"toward the left, corners toward both adjacent sides). "
        f"Column 4 of rows 1-3: three interior VARIANT tiles — same terrain "
        f"with subtle detail differences, seamlessly tileable with the middle "
        f"tile. "
        f"Row 4: four SEPARATE small decor props that belong to this biome "
        f"(plant, stone, flower, debris...), each centred in its cell on a "
        f"FLAT UNIFORM NEUTRAL GREY background, not touching cell edges. "
        f"Consistent palette and pixel-art style across all 16 tiles, evenly "
        f"lit, no characters, no text, no watermark."
    )


def _biome_tileset_prompt_iso(description: str, biome: str) -> str:
    """Prompt for the TRUE-ISOMETRIC variant of the 16-tile autotile sheet.

    Cells are generated SQUARE (a 4×4 grid) with the terrain drawn as one
    2:1-looking rhombus per cell whose corners touch the cell's four edge
    midpoints. Post-processing squashes terrain cells to half height (yielding
    exact 2:1 diamonds), band-crops the decor row (props must NOT be squashed)
    and applies a hard diamond alpha mask, so the model only has to get the
    texture right — the geometry is enforced deterministically.

    Role sides follow the iso projection (see mapSpec.ts): the logical N/E/S/W
    transition sides map to the diamond's top-right / bottom-right /
    bottom-left / top-left edges.
    """
    return (
        f"2D ISOMETRIC game terrain tileset for a '{biome}' biome: {description}. "
        f"STRICT LAYOUT — a square sheet divided into a 4x4 grid of 16 equal "
        f"square cells, no gaps, no borders, no labels. "
        f"Every cell in rows 1-3 contains exactly ONE isometric diamond "
        f"(rhombus) of ground terrain, seen from a classic 2:1 isometric "
        f"angle: the diamond's four corners touch the midpoints of the cell's "
        f"four edges, and everything outside the diamond is FLAT UNIFORM "
        f"NEUTRAL GREY. "
        f"Rows 1-3, first 3 columns form a seamless 3x3 autotile blob of "
        f"diamonds: the middle diamond (row 2 col 2) is the pure interior "
        f"terrain; the 8 diamonds around it are that same terrain fading out "
        f"toward the matching edge(s) of the diamond — top row fades along "
        f"the diamond's two upper edges, left column along the two left "
        f"edges, corners along both adjacent edges. "
        f"Column 4 of rows 1-3: three interior VARIANT diamonds — same "
        f"terrain with subtle detail differences. "
        f"Row 4: four SEPARATE small isometric decor props that belong to "
        f"this biome (plant, stone, flower, debris...), each centred in its "
        f"cell on the same FLAT UNIFORM NEUTRAL GREY background, upright, at "
        f"most HALF the cell tall, not touching cell edges. "
        f"Consistent palette and pixel-art style across all 16 cells, evenly "
        f"lit, no characters, no text, no watermark."
    )


def _alpha_pct(png_path: Path) -> float:
    """% pixels with alpha > 0 (validation that rembg kept the decor prop)."""
    from agents.sprite_pipeline import _alpha_visible_pct
    return _alpha_visible_pct(png_path)


def _diamond_cell_mask(cell_w: int, cell_h: int) -> Any:
    """L-mode alpha mask of a full-cell 2:1 diamond, antialiased via 4×
    supersampling. Applied to the 12 terrain cells of an isometric sheet so
    adjacent diamonds meet on exact geometry regardless of generation slop."""
    from PIL import Image, ImageDraw

    ss = 4
    m = Image.new("L", (cell_w * ss, cell_h * ss), 0)
    d = ImageDraw.Draw(m)
    d.polygon(
        [
            (cell_w * ss // 2, 0), (cell_w * ss - 1, cell_h * ss // 2),
            (cell_w * ss // 2, cell_h * ss - 1), (0, cell_h * ss // 2),
        ],
        fill=255,
    )
    return m.resize((cell_w, cell_h), Image.LANCZOS)


def _mask_decor_tiles(
    sheet_path: Path, tile_paths: list[Path], biome: str, tile_w: int, tile_h: int,
) -> bool:
    """SYNC worker: rembg the four decor tiles, validate each mask, paste the
    alpha versions back into the sheet. Returns True if any cell gained alpha.

    Cell geometry is (tile_w × tile_h): square for orthogonal sheets, 2:1 for
    isometric ones.

    Runs via asyncio.to_thread — up to 8 rembg inferences (4 tiles × 2 model
    fallbacks) take 15-40s, which would freeze heartbeats/WebSockets if run on
    the event loop (the single-call character pipeline predates this rule)."""
    import shutil

    from PIL import Image

    from tools.rembg_wrapper import remove_background

    changed = False
    with Image.open(sheet_path) as sheet_img:
        sheet_img = sheet_img.convert("RGBA")
        for idx in BIOME_TILE_ROLES["decor"]:
            tile_path = tile_paths[idx]
            masked = tile_path.with_name(tile_path.stem + "_alpha.png")
            ok = False
            for model in ("isnet-anime", "u2net"):
                try:
                    remove_background(tile_path, masked, model=model)
                except Exception as e:  # noqa: BLE001 — try next model
                    logger.warning(
                        "biome tileset '{b}': rembg {m} failed on decor {i}: {e}",
                        b=biome, m=model, i=idx, e=e,
                    )
                    continue
                pct = _alpha_pct(masked)
                if 2.0 <= pct <= 98.0:
                    ok = True
                    break
                logger.warning(
                    "biome tileset '{b}': rembg {m} decor {i} alpha {p:.1f}% out of range",
                    b=biome, m=model, i=idx, p=pct,
                )
            if ok:
                shutil.move(str(masked), str(tile_path))  # tiles/ gets the alpha version
                with Image.open(tile_path) as tile_img:
                    cx = (idx % BIOME_TILESET_GRID) * tile_w
                    cy = (idx // BIOME_TILESET_GRID) * tile_h
                    # Clear the cell, then paste the masked prop back in.
                    sheet_img.paste((0, 0, 0, 0), (cx, cy, cx + tile_w, cy + tile_h))
                    sheet_img.paste(tile_img.convert("RGBA"), (cx, cy))
                changed = True
            else:
                masked.unlink(missing_ok=True)
        if changed:
            sheet_img.save(sheet_path)
    return changed


async def generate_biome_tileset(
    description: str,
    biome: str = "terrain",
    *,
    tile_size: int = 64,
    projection: str = "orthogonal",
    base_image_path: Path | str | None = None,
    transparent_decor: bool = True,
    output_dir: Path | None = None,
    project: str | None = None,
) -> AssetResult:
    """
    Generate one biome's 16-tile autotile sheet for Map Studio.

    Pipeline: prompt → GPT-Image-2 (edit-mode when `base_image_path` anchors
    the style to an earlier biome, so a map's tilesets stay one art style) →
    normalize → slice into tiles/ + roles → rembg ONLY the four decor cells
    (terrain must stay opaque) and paste the alpha versions back into the
    sheet → write `tileset.json` → publish the sheet to the stable game path
    ``public/assets/tilesets/<project>/<biome>/sheet.png`` that
    `maps/*.map.yaml` references (regeneration overwrites in place — the map
    YAML never has to change).

    Projections (mirrors mapSpec.ts `tileDims`):
      - "orthogonal": cells are tile_size×tile_size squares, sheet is
        4·tile_size square (unchanged historical behaviour).
      - "isometric":  cells are (2·tile_size)×tile_size — 2:1 diamonds. The
        model paints square cells with a diamond touching the edge midpoints;
        post-processing squashes terrain cells to half height, band-crops the
        decor row (props must stay upright) and applies a hard antialiased
        diamond alpha mask, so the published sheet has exact 2:1 geometry.

    Args:
        description:       Theme, e.g. "lush spring meadow, soft pixel art".
        biome:             Biome id used in map.yaml `tilesets[].biome`.
        tile_size:         Tile edge in px. For isometric this is the diamond
                           HEIGHT (matches map.yaml `tileSize`).
        projection:        "orthogonal" (default) or "isometric".
        base_image_path:   Existing sheet/atlas to anchor style via edit-mode.
        transparent_decor: rembg the decor row to alpha (default True).
        output_dir:        Library output dir override.
        project:           Owning project (threads through to the public path).
    """
    import shutil

    from PIL import Image

    from tools.gpt_image_2 import (
        submit_generate, submit_edit_from_path, poll_until_done,
    )
    from tools.spritesheet_splitter import split_grid
    from agents.sprite_pipeline import (
        _slugify, _default_output_dir, subfolder_for_role,
    )
    from core.config import PROJECT_ROOT

    if projection not in ("orthogonal", "isometric"):
        raise ValueError(
            f"projection must be 'orthogonal' or 'isometric', got {projection!r}"
        )
    iso = projection == "isometric"
    tile_w, tile_h = (tile_size * 2, tile_size) if iso else (tile_size, tile_size)

    biome_slug = _slugify(biome, 20) or "biome"
    slug = f"{biome_slug}_{_slugify(description, 20) or 'tiles'}"

    if output_dir is None:
        output_dir = _default_output_dir(subfolder_for_role("biome_tileset"), project) / slug
    output_dir.mkdir(parents=True, exist_ok=True)

    prompt = (
        _biome_tileset_prompt_iso(description, biome) if iso
        else _biome_tileset_prompt(description, biome)
    )
    if base_image_path:
        logger.info("biome tileset '{b}': edit-mode from {p}", b=biome, p=base_image_path)
        task_id = submit_edit_from_path(
            prompt, base_image_path, "1:1", "high", "2K", project=project,
        )
    else:
        task_id = submit_generate(
            prompt=prompt, size="1:1", quality="high", resolution="2K", project=project,
        )
    image_url, cost = await poll_until_done(task_id)

    import aiohttp
    raw_path = output_dir / "sheet_raw.png"
    async with aiohttp.ClientSession() as session:
        async with session.get(image_url) as resp:
            raw_path.write_bytes(await resp.read())

    sheet_path = output_dir / "sheet.png"
    if iso:
        # Generation is a square 4×4 grid of square cells (side 2·tile_size).
        # Reshape into exact 2:1 cells: squash terrain, band-crop decor, then
        # hard-mask the terrain diamonds — geometry is enforced here, never
        # trusted from the model.
        square = tile_w  # painted cell side before reshape
        gen_px = BIOME_TILESET_GRID * square
        decor_cells = set(BIOME_TILE_ROLES["decor"])
        with Image.open(raw_path) as im:
            im = im.convert("RGBA")
            if im.size != (gen_px, gen_px):
                logger.info(
                    "biome tileset '{b}': normalizing {w}×{h} → {s}×{s}",
                    b=biome, w=im.size[0], h=im.size[1], s=gen_px,
                )
                im = im.resize((gen_px, gen_px), Image.LANCZOS)
            sheet = Image.new(
                "RGBA",
                (BIOME_TILESET_GRID * tile_w, BIOME_TILESET_GRID * tile_h),
                (0, 0, 0, 0),
            )
            dmask = _diamond_cell_mask(tile_w, tile_h)
            for idx in range(BIOME_TILESET_GRID * BIOME_TILESET_GRID):
                c, r = idx % BIOME_TILESET_GRID, idx // BIOME_TILESET_GRID
                cell = im.crop((c * square, r * square, (c + 1) * square, (r + 1) * square))
                if idx in decor_cells:
                    band_top = (square - tile_h) // 2
                    cell = cell.crop((0, band_top, square, band_top + tile_h))
                else:
                    cell = cell.resize((tile_w, tile_h), Image.LANCZOS)
                    cell.putalpha(dmask)
                sheet.paste(cell, (c * tile_w, r * tile_h))
            sheet.save(sheet_path)
    else:
        # Normalize to EXACTLY 4·tile_size square — split_grid and the Phaser
        # tileset math both assume uniform cells.
        sheet_px = BIOME_TILESET_GRID * tile_size
        with Image.open(raw_path) as im:
            im = im.convert("RGBA")
            if im.size != (sheet_px, sheet_px):
                logger.info(
                    "biome tileset '{b}': normalizing {w}×{h} → {s}×{s}",
                    b=biome, w=im.size[0], h=im.size[1], s=sheet_px,
                )
                im = im.resize((sheet_px, sheet_px), Image.LANCZOS)
            im.save(sheet_path)

    tiles_dir = output_dir / "tiles"
    tiles_dir.mkdir(exist_ok=True)
    split = split_grid(
        sheet_path, rows=BIOME_TILESET_GRID, cols=BIOME_TILESET_GRID,
        out_dir=tiles_dir, base_name=biome_slug,
    )
    tile_paths = [Path(p) for p in split["frames"]]

    # Decor cells → alpha. Terrain tiles must stay opaque, so rembg runs on the
    # four decor tiles ONLY, with the same validate-or-keep-original guard the
    # character pipeline uses (a failed mask must not eat a paid generation).
    # Off-thread: the inference loop is seconds-long (see _mask_decor_tiles).
    decor_alpha = False
    if transparent_decor:
        import asyncio

        decor_alpha = await asyncio.to_thread(
            _mask_decor_tiles, sheet_path, tile_paths, biome, tile_w, tile_h,
        )

    # Stable publish path the game loads from (vite publicDir = murrkit/public).
    owner = (project or "").strip() or "default"
    public_rel = f"assets/tilesets/{owner}/{biome_slug}"
    public_dir = PROJECT_ROOT / "public" / public_rel
    public_dir.mkdir(parents=True, exist_ok=True)

    meta = {
        "type": "biome_tileset",
        "biome": biome,
        "theme": description,
        "tile_size": tile_size,
        "projection": projection,
        "tile_width": tile_w,
        "tile_height": tile_h,
        "columns": BIOME_TILESET_GRID,
        "rows": BIOME_TILESET_GRID,
        "sheet": "sheet.png",
        "roles": BIOME_TILE_ROLES,
        "decor_alpha": decor_alpha,
        "map_yaml_image": f"/{public_rel}/sheet.png",
    }
    meta_path = output_dir / "tileset.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    shutil.copy2(sheet_path, public_dir / "sheet.png")
    shutil.copy2(meta_path, public_dir / "tileset.json")

    return AssetResult(
        asset_type="biome_tileset",
        name=slug,
        output_dir=output_dir,
        files=[sheet_path, meta_path, *tile_paths],
        metadata={
            "biome": biome,
            "description": description,
            "projection": projection,
            "roles": BIOME_TILE_ROLES,
            "decor_alpha": decor_alpha,
            "map_yaml_image": meta["map_yaml_image"],
            "published_dir": str(public_dir),
        },
        cost_usd=cost,
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
