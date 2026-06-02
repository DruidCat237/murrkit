"""
Sprite Pipeline — GPT-Image-2 sprite sheet generation orchestrator.

Flow (per animation):
    1. Build a prompt asking for a rows×cols GRID of frames on a FLAT NEUTRAL
       GREY background (GPT-Image-2 has NO transparency).
    2. Submit to GPT-Image-2 via Kitty App. The FIRST animation is text-to-image
       and becomes the character's CANONICAL SEED; every later animation is a
       gpt-image-2-EDIT anchored to that SAME canonical seed file (never chained
       off the previous edit) so identity / scale / palette stay locked.
    3. rembg each sheet to strip the grey background → alpha.
    4. split_grid() slices the rows×cols sheet into individual frame PNGs and
       writes a correct 2D-aware frames.json (x = col*fw, y = row*fh).

Defaults follow the v2 research (Pillar 5):
    - Bigger by default: 3×3 = 9 frames (up to 4×3 / 3×4 ≈ 12). 5×5+ drifts.
    - Square ≤ 2048, dims multiples of 16.
    - Flat neutral grey background + post-mask (no transparent-bg support).
    - Canonical seed continuity, never chain edits.

Output per character:
    {output_dir}/
        {char_slug}_seed.png              canonical reference (first gen, masked)
        {char_slug}_style_anchor.txt      per-character style-anchor text
        {char_slug}_{anim}_raw.png        raw grey-bg sheet from GPT-Image-2
        {char_slug}_{anim}.png            background-stripped grid sheet
        {char_slug}_{anim}_NN.png         individual frames (row-major)
        {char_slug}_{anim}_frames.json    per-anim 2D grid frames.json
        {char_slug}_atlas.png             master atlas (all anim sheets stacked)
        {char_slug}_frames.json           combined frames.json across anims
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger


# ---------------------------------------------------------------------------
# Output dir resolution
# ---------------------------------------------------------------------------

def _slugify(text: str, max_len: int = 30) -> str:
    """Stable slug — alphanumeric + underscores, no trailing junk."""
    s = re.sub(r"[^a-zA-Z0-9]+", "_", (text or "").strip().lower())
    s = re.sub(r"_{2,}", "_", s).strip("_")
    if len(s) > max_len:
        s = s[:max_len].rstrip("_")
    return s


def _alpha_visible_pct(png_path: Path) -> float:
    """% pixels with alpha > 0. Used to detect rembg destroying a character
    (e.g. U2Net on a white cat → 0% visible)."""
    try:
        from PIL import Image
        import numpy as np
        img = Image.open(png_path)
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        a = np.array(img)[:, :, 3]
        return float((a > 0).sum()) / a.size * 100.0
    except Exception:  # noqa: BLE001
        return 100.0  # if we can't check, assume OK


def _infer_intent(prompt: str, asset_type: str, aspect: str) -> str:
    """Classify what the asset is FOR so downstream tools (and Claude) don't
    confuse a parallax mid layer for a top-down board.

    Returns one of: character | topdown_board | parallax_layer | ui_element |
    tile | particle | unknown.
    """
    p = (prompt or "").lower()
    if asset_type == "sprite":
        return "character"
    if asset_type == "tileset":
        return "tile"
    if asset_type == "ui_element":
        return "ui_element"
    if asset_type == "particle_fx":
        return "particle"
    # Background-type heuristics
    if asset_type == "background":
        if any(k in p for k in ("top-down", "top down", "tic-tac-toe board", "board grid", "playfield")):
            return "topdown_board"
        if any(k in p for k in ("parallax", "sky layer", "mid layer", "far layer", "background layer")):
            return "parallax_layer"
        if aspect in {"16:9", "9:16", "21:9"}:
            return "parallax_layer"
        return "topdown_board" if aspect == "1:1" else "parallax_layer"
    return "unknown"


# Deterministic asset-role → Generated/<subfolder> routing. The subfolder is
# chosen from the asset's DECLARED role, never guessed from the prompt text, so
# a project browser always shows a clean Characters / Backgrounds / UI / FX /
# Tilesets separation. `asset_type` is the canonical role string the gen-queue
# rows + pipelines already use; both the hyphen and underscore spellings of the
# UI / FX roles are accepted so callers can't accidentally mis-route.
ASSET_ROLE_SUBFOLDER: dict[str, str] = {
    "sprite": "Sprites",          # characters, props, creatures, projectiles
    "character": "Sprites",
    "prop": "Sprites",
    "background": "Backgrounds",  # parallax layers, ground, environment, sky
    "environment": "Backgrounds",
    "parallax": "Backgrounds",
    "ui-element": "UI",           # buttons, HUD, panels, icons, frames
    "ui_element": "UI",
    "ui": "UI",
    "particle-fx": "FX",          # particles, sparks, dust, celebration
    "particle_fx": "FX",
    "fx": "FX",
    "tileset": "Tilesets",        # tiles, terrain grids
    "tile": "Tilesets",
}


def subfolder_for_role(asset_type: str) -> str:
    """Map an asset's declared role to its Generated/<subfolder>.

    Deterministic: the result depends ONLY on `asset_type` (the role the caller
    declared), never on the prompt wording. Unknown roles fail loud rather than
    silently dumping into the wrong folder — a new asset type must be registered
    here explicitly so the per-project library stays organized.
    """
    key = (asset_type or "").strip().lower()
    if key not in ASSET_ROLE_SUBFOLDER:
        raise ValueError(
            f"unknown asset role {asset_type!r}; cannot route to a Generated "
            f"subfolder. Known roles: {sorted(set(ASSET_ROLE_SUBFOLDER))}"
        )
    return ASSET_ROLE_SUBFOLDER[key]


def _default_output_dir(subfolder: str, project: str | None = None) -> Path:
    """Resolve where generated assets land — STRICTLY per-project.

    Assets live under ``projects/<project>/Generated/<subfolder>/`` so each
    project's library is isolated (the Asset Library scans only the active
    project's folder). The Phaser game loads from ``phaser_game/public/`` — NOT
    from here — so this path only feeds the library + future generation.

    Args:
        subfolder: ``Sprites`` | ``Backgrounds`` | ``UI`` | ``FX`` | ``Tilesets`` …
        project:   Owning project name (threaded from the gen-queue task). When
                   unknown / blank, falls back to ``projects/_orphans/<sub>`` so
                   nothing is silently mixed into a real project.
    """
    from core.config import PROJECTS_DIR
    owner = (project or "").strip() or "_orphans"
    return PROJECTS_DIR / owner / "Generated" / subfolder


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class AnimStrip:
    """One animation's worth of frames as a rows×cols grid PNG sheet.

    Kept named `AnimStrip` for backward compatibility with the sprite-gen
    router; `rows`/`cols` now describe the 2D grid (a 1×N strip is rows=1).
    """
    name: str           # e.g. "idle"
    path: Path          # absolute path to the (masked) grid sheet PNG
    frame_count: int    # number of frames in this sheet
    frame_width: int
    frame_height: int
    rows: int = 1
    cols: int = 0
    frames: list[str] = field(default_factory=list)  # abs paths, row-major


@dataclass
class SpriteSheetResult:
    """Returned by generate_character_spritesheet()."""
    character_name: str
    output_dir: Path
    atlas_path: Path          # master atlas PNG
    frames_json_path: Path    # combined frames.json
    seed_path: Path | None = None    # canonical seed reference PNG
    style_anchor: str = ""           # per-character style-anchor text
    strips: list[AnimStrip] = field(default_factory=list)
    cost_usd: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "character_name": self.character_name,
            "output_dir": str(self.output_dir),
            "atlas_path": str(self.atlas_path),
            "frames_json_path": str(self.frames_json_path),
            "seed_path": str(self.seed_path) if self.seed_path else None,
            "style_anchor": self.style_anchor,
            "strips": [
                {
                    "name": s.name,
                    "path": str(s.path),
                    "frame_count": s.frame_count,
                    "frame_width": s.frame_width,
                    "frame_height": s.frame_height,
                    "rows": s.rows,
                    "cols": s.cols,
                    "frames": s.frames,
                }
                for s in self.strips
            ],
            "cost_usd": self.cost_usd,
        }


# ---------------------------------------------------------------------------
# Prompt templates per animation
# ---------------------------------------------------------------------------

# High-level one-line summary per animation. NOTE: prompt construction now uses
# the per-cell `ANIM_POSE_SEQUENCES` below (each grid cell gets its OWN distinct
# beat) so the generated sheet is a real animation, not the same pose repeated.
# This table is kept as a human-readable index of what each animation conveys.
ANIM_PROMPT_MODIFIERS: dict[str, str] = {
    "idle":        "standing idle, subtle breathing pose",
    "walk":        "walking cycle, side view, feet moving",
    "run":         "running fast, side view, dynamic pose",
    "attack":      "attacking, weapon swinging or fist raised",
    "hurt":        "recoiling from hit, pain expression",
    "death":       "falling or collapsed, defeat pose",
    "jump":        "mid-air jumping pose",
    "crouch":      "crouching low, defensive stance",
    "cast":        "casting spell, hands raised with magic effect",
    "pickup":      "bending down, reaching for item",
}

# Style suffixes — GPT-Image-2 has NO transparent-background support, so every
# style asks for a FLAT NEUTRAL GREY backdrop instead; the rembg post-process
# strips it to alpha afterwards. (Old prompts asked for "transparent background"
# which the model silently ignored, leaving white/coloured fringes.)
_GREY_BG = (
    "one single flat solid neutral grey (#808080) background filling the whole "
    "image, no scenery, no shadows, no gradient, no vignette, no borders or grid lines"
)

STYLE_SUFFIXES: dict[str, str] = {
    "pixel_art":    f"pixel art style, crisp pixels, retro game, {_GREY_BG}",
    "vector":       f"clean vector illustration, flat colors, game-ready sprite, {_GREY_BG}",
    "hand_painted": f"hand-painted 2D game art, painterly style, {_GREY_BG}",
    "cartoon":      f"cartoon 2D game sprite, bold outlines, vibrant colors, {_GREY_BG}",
}

DEFAULT_ANIMATIONS = ["idle", "walk", "attack", "hurt", "death"]

# Default grid geometry per the v2 research: 3×3 = 9 reliable; up to 4×3 / 3×4
# (~12) coherent; 5×5+ drifts. Callers may override via rows/cols.
DEFAULT_GRID_ROWS = 3
DEFAULT_GRID_COLS = 3
MAX_GRID_FRAMES = 12

# Per-animation, per-frame pose beats. The whole point of a sprite SHEET is that
# every cell is a DIFFERENT instant of the motion — a walk cycle steps through
# contact → recoil → passing → high-point and back, NOT the same standing pose
# nine times. Without enumerating these the model happily renders the identical
# character in every cell (the exact "9 identical cats" bug). We give an ordered
# list of distinct beats per animation and cycle through it to fill N cells.
ANIM_POSE_SEQUENCES: dict[str, list[str]] = {
    "walk": [
        "CONTACT: left foot planted forward (heel down), right leg trailing back on the toe, torso upright, LEFT arm swung back and RIGHT arm swung forward, head level looking ahead",
        "DOWN/recoil: weight drops onto the front leg, both knees bent and hips at their lowest, both arms passing close to the body, torso dipping slightly",
        "PASSING: the rear right leg swings straight through under the hips, weight centred over the planted leg, arms roughly vertical at the sides, head starting to rise",
        "HIGH point: body lifted to its tallest on the front leg, rear leg lifting and bending to swing forward, arms beginning to switch, slight forward lean",
        "CONTACT (opposite): right foot planted forward heel-down, left leg trailing back, arms SWAPPED (right arm back, left arm forward), torso upright",
        "DOWN/recoil (opposite): weight drops onto the right front leg, knees bent, hips lowest, arms close to the body",
        "PASSING (opposite): the left leg swings through under the hips, weight centred, arms vertical, head rising",
        "HIGH point (opposite): body at its tallest on the right leg, left leg lifting to swing forward, arms switching back",
        "MID-STRIDE transition easing back toward the frame-1 contact pose so the cycle loops cleanly",
    ],
    "run": [
        "FULL EXTENSION: airborne, both legs stretched far apart front-and-back, strong forward body lean, arms pumping hard (opposite to the legs), head driving forward",
        "FRONT FOOT STRIKE: lead foot slams down, knee bent to absorb, torso leaning over it, rear leg whipping forward, arms mid-swing",
        "COMPRESSION: weight fully absorbed over the planted front leg, body lowest and coiled, arms tight to the sides",
        "PUSH-OFF: planted leg drives the body up and forward, rear leg sweeping ahead, body rising, arms swinging through",
        "AIRBORNE RECOVERY: both feet off the ground, legs gathering under the hips, body stretched, arms at full pump",
        "FULL EXTENSION (opposite): airborne, legs stretched the other way, arms swapped, forward lean",
        "FRONT FOOT STRIKE (opposite): other foot slams down, knee bent, torso over it, arms mid-swing",
        "COMPRESSION (opposite): weight absorbed on the other leg, body coiled low",
        "PUSH-OFF (opposite) easing back toward the frame-1 extension to loop",
    ],
    "idle": [
        "neutral standing rest, weight evenly centred, arms relaxed at the sides, head facing forward, calm expression",
        "breath IN: chest and shoulders rising slightly, spine lengthening, arms unchanged",
        "breath HELD: shoulders at their highest, tiny upward stretch, gaze steady",
        "breath OUT: shoulders settling back down, chest lowering, body relaxing",
        "weight SHIFT: hips ease slightly to one side, one knee softening, arms swaying a touch",
        "GLANCE: small head turn to look to the side, eyes following, shoulders square",
        "head RETURNS to centre, gaze forward again, weight starting to recentre",
        "weight returning to the neutral centred stance, arms settling",
        "tiny idle FLICK (tail / hand / ear twitch) then settling back to the neutral pose to loop",
    ],
    "attack": [
        "READY stance, weapon or fists drawn back, knees slightly bent, eyes locked on the target",
        "WIND-UP (anticipation): weight loads onto the BACK leg, weapon/fist pulled further back, torso coiling away from the target",
        "LUNGE begins: body uncoils and twists toward the target, front foot stepping in, arm starting to drive forward",
        "STRIKE extending: weapon/fist thrust forward, arm nearly straight, body weight transferring onto the front leg",
        "IMPACT frame: maximum extension and force, full body committed forward, sharp determined expression",
        "FOLLOW-THROUGH past the target, arm continuing its arc, torso rotated fully through",
        "RECOVERY: pulling the weapon/fist back, weight starting to return, body straightening",
        "SETTLING weight back toward centre, guard coming back up",
        "RETURN to the ready stance to loop",
    ],
    "hurt": [
        "neutral pose at the exact instant of impact, eyes widening",
        "sharp RECOIL: head and torso snap backward, arms thrown up, one leg lifting",
        "MAX KNOCK-BACK: body arched away from the hit, off balance, pained expression",
        "STAGGER: arms flailing for balance, feet scrambling, torso tipped back",
        "STUMBLE: weight dropping onto the back foot, knees buckling slightly",
        "LOWEST stagger point, nearly losing footing, hunched over",
        "starting to RECOVER balance, one hand reaching out to steady",
        "STRAIGHTENING up, shaking it off, guard returning",
        "RETURN toward the neutral standing pose",
    ],
    "death": [
        "hit REACTION: body jolting sharply, eyes shut tight",
        "knees BUCKLING, body sagging, arms dropping",
        "COLLAPSING forward or back, all balance lost, torso folding",
        "MID-FALL: limbs going limp, body tipping toward the ground",
        "GROUND IMPACT: body hitting the floor, limbs splaying out",
        "SETTLING onto the ground, last twitch of motion",
        "limp pose lying on the ground, eyes closed",
        "fully COLLAPSED and motionless on the ground",
        "final defeated still pose flat on the ground",
    ],
    "jump": [
        "CROUCH anticipation: body compressed low, knees deeply bent, arms swung back, coiled before launch",
        "EXPLOSIVE push-off: legs extending hard, arms thrown upward, body driving up",
        "LEAVING the ground: body stretched tall, toes pointing down, arms up",
        "RISING: legs tucking up toward the chest, body compact, arms balancing",
        "APEX: at the top of the arc, body gathered, legs tucked, brief float",
        "DESCENT begins: legs reaching down for the ground, arms lowering",
        "FALLING: body stretching toward the ground, legs extending to land",
        "LANDING impact: feet planted, knees deeply bent to absorb (squash), arms forward",
        "RECOVERY: rising back up to a standing pose",
    ],
}

# Fallback when an animation has no enumerated sequence: still force visible
# progression so cells differ.
_GENERIC_POSE_BEATS = [
    "start of the motion",
    "early phase, building momentum",
    "quarter through the motion",
    "approaching the peak",
    "peak / extreme pose of the motion",
    "just past the peak",
    "three-quarters through, settling",
    "near the end of the motion",
    "final frame, returning to rest",
]


def _pose_sequence(animation: str, n: int) -> list[str]:
    """Return exactly `n` ordered, DISTINCT per-cell pose descriptions for an
    animation. Cycles the canonical beats if `n` exceeds the list length."""
    beats = ANIM_POSE_SEQUENCES.get(animation) or _GENERIC_POSE_BEATS
    return [beats[i % len(beats)] for i in range(n)]


def _grid_layout_clause(rows: int, cols: int, animation: str, identity_lock: str) -> str:
    """Build a LONG, rigorous, per-cell model-sheet prompt for a rows×cols grid.

    This is the fix for "random / inconsistent sheets". A terse "render a walk
    cycle" lets GPT-Image-2 redraw the character differently in every cell. So
    instead we:
      (a) declare the image a CHARACTER MODEL SHEET and lock identity HARD,
          restating exactly which character to draw (`identity_lock`),
      (b) enumerate EVERY cell with its explicit grid coordinate AND a detailed,
          distinct pose beat (a numbered, multi-line block — deliberately long),
      (c) forbid every per-cell decoration / uneven spacing that would break the
          fixed-pitch slicer, and pin one fixed camera + facing for mirroring.

    `identity_lock` restates which character: e.g. "the SAME character (a black
    druid cat …)" for text-to-image, or "the EXACT character in the reference
    image" for edit mode.
    """
    n = rows * cols
    poses = _pose_sequence(animation, n)
    # Numbered per-cell lines WITH grid coordinates, so the model deliberately
    # PLACES and VARIES each frame instead of repeating one drawing.
    pose_block = "\n".join(
        f"  - Frame {i + 1} (row {i // cols + 1}, column {i % cols + 1}): {p}."
        for i, p in enumerate(poses)
    )
    return (
        f"This image is a CHARACTER MODEL / ANIMATION SHEET: the EXACT SAME "
        f"character drawn {n} times, in {n} different poses of one continuous "
        f"{animation} cycle. "
        f"IDENTITY LOCK - in EVERY single frame keep {identity_lock} perfectly "
        f"identical: same colours, same outfit and markings, same body "
        f"proportions, same head-to-body ratio, same limb lengths, same facial "
        f"features, same art style and the same line weight. The ONLY thing "
        f"allowed to change between frames is the BODY POSE - never redesign, "
        f"recolour, resize, re-age or re-style the character from cell to cell. "
        f"LAYOUT - lay the {n} poses out in a {rows}-row by {cols}-column grid, "
        f"filled left-to-right then top-to-bottom; every cell is exactly the same "
        f"size; the character is fully visible, CENTERED, at the SAME scale and "
        f"the SAME eye-level in every cell. SAFE MARGIN (critical) - draw the "
        f"WHOLE character a little smaller so EVERY body part (ears, horns, paws, "
        f"tail, weapon, arms raised at the top of a jump) stays well INSIDE its "
        f"cell with a clear empty margin of roughly 12% on all four sides; no part "
        f"may EVER touch, overlap or cross the cell boundary in ANY frame - even "
        f"the tallest or widest pose - because the even slice clips anything past "
        f"the edge (this is exactly how the ears get cut off). Keep the feet near "
        f"(but not at) the bottom margin so the character is bottom-anchored. "
        f"CAMERA - one single fixed viewing angle and the SAME facing direction "
        f"for all {n} frames; never flip, mirror or rotate the character or the "
        f"camera between cells (so the finished sheet can be cleanly horizontally "
        f"mirrored in the game engine). "
        f"THE {n} POSES - each frame is an explicit, DISTINCT instant of the "
        f"motion; no two frames may look the same:\n{pose_block}\n"
        f"BACKGROUND - the ENTIRE image is ONE single continuous flat solid "
        f"neutral grey (#808080) behind every pose; absolutely NO panels, boxes, "
        f"cells, outlines, grid lines, borders, frames, separators or dividers "
        f"between the poses, and NO shadows, ground line, gradient or vignette "
        f"anywhere. A separate program slices this sheet on a fixed, even grid, "
        f"so ANY drawn line, box, label or uneven spacing ruins it."
    )


def build_anim_prompt(
    description: str,
    animation: str,
    style: str = "pixel_art",
    *,
    rows: int = DEFAULT_GRID_ROWS,
    cols: int = DEFAULT_GRID_COLS,
    style_anchor: str = "",
) -> str:
    """Prompt for the FIRST/CANONICAL animation — full text-to-image description.

    This generation becomes the character's canonical seed. The per-character
    `style_anchor` (when present) is prepended so the same identity language
    leads every prompt for this character.
    """
    style_suffix = STYLE_SUFFIXES.get(style, STYLE_SUFFIXES["pixel_art"])
    anchor = f"{style_anchor.strip()} " if style_anchor.strip() else ""
    identity = f"the SAME character ({description.strip()})"
    return (
        f"{anchor}"
        f"Sprite sheet of {description}, {animation} animation. "
        f"{_grid_layout_clause(rows, cols, animation, identity)} "
        f"{style_suffix}."
    )


def build_edit_anim_prompt(
    animation: str,
    style: str = "pixel_art",
    *,
    rows: int = DEFAULT_GRID_ROWS,
    cols: int = DEFAULT_GRID_COLS,
    style_anchor: str = "",
) -> str:
    """Prompt for SUBSEQUENT animations of the same character via
    gpt-image-2-edit, anchored to the CANONICAL SEED image.

    The seed image (passed via `image_urls`) IS the character description, so
    this prompt does NOT re-describe it — it only specifies the new pose/grid
    and demands strict identity consistency. Combined with always editing from
    the same canonical seed (never the previous edit), this locks identity,
    scale and palette across the whole sheet set.
    """
    style_suffix = STYLE_SUFFIXES.get(style, STYLE_SUFFIXES["pixel_art"])
    anchor = f"{style_anchor.strip()} " if style_anchor.strip() else ""
    identity = "the EXACT character shown in the reference image"
    return (
        f"{anchor}"
        f"Using the reference image as the EXACT character (same colours, "
        f"same outfit, same proportions, same face, same scale — do NOT "
        f"redesign it), redraw it as a {animation}-animation sprite sheet. "
        f"{_grid_layout_clause(rows, cols, animation, identity)} "
        f"{style_suffix}. "
        f"Keep the character identity strictly consistent with the reference."
    )


def build_style_anchor(description: str, style: str) -> str:
    """Build the per-character style-anchor text auto-prepended to every prompt.

    Short, identity-bearing language ("the same <description>, consistent
    <style> art style, identical palette and proportions") that we prepend to
    each prompt so every animation sheet keeps a single visual identity even
    before the edit-mode seed anchoring kicks in.
    """
    style_word = style.replace("_", " ")
    return (
        f"Character reference: {description}. "
        f"Consistent {style_word} art style, identical palette, proportions "
        f"and silhouette across every frame."
    )


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

async def generate_character_spritesheet(
    description: str,
    animations: list[str] | None = None,
    *,
    frames_per_anim: int | None = None,
    style: str = "pixel_art",
    sprite_size: tuple[int, int] = (64, 64),
    rows: int = DEFAULT_GRID_ROWS,
    cols: int = DEFAULT_GRID_COLS,
    output_dir: Path | None = None,
    project: str | None = None,
) -> SpriteSheetResult:
    """
    Generate a full character sprite sheet set via GPT-Image-2 → rembg → grid split.

    Default generation is now a rows×cols GRID (3×3 = 9 frames), NOT a 64px 1×N
    4-frame strip. The first animation becomes the CANONICAL SEED; every later
    animation is a gpt-image-2-edit anchored to that same seed file.

    Args:
        description:     Natural language character description.
                         e.g. "knight in blue armor with longsword"
        animations:      List of animation names. Defaults to DEFAULT_ANIMATIONS.
        frames_per_anim: Legacy override. If given, frames are laid out as a
                         single row (rows=1, cols=frames_per_anim). Prefer
                         rows/cols. Capped at MAX_GRID_FRAMES.
        style:           "pixel_art" | "vector" | "hand_painted" | "cartoon"
        sprite_size:     (width, height) hint for each cell; drives the grid
                         pixel-size request (cell_px = max(w, h)).
        rows:            Grid rows (default 3). cols*rows capped at MAX_GRID_FRAMES.
        cols:            Grid columns (default 3).
        output_dir:      Where to write output files. Defaults to
                         projects/<project>/Generated/Sprites/<char_slug>/.
        project:         Owning project name (threaded from the gen-queue task)
                         used to resolve the per-project output dir. Ignored
                         when an explicit output_dir is given.

    Returns:
        SpriteSheetResult with atlas, combined frames.json, canonical seed,
        style anchor, and per-anim grid sheets (each with its own frames.json).

    Raises:
        ImportError if rembg or Pillow not installed.
        RuntimeError if KITTY_APP_TOKEN not set.
        ValueError   if the requested grid exceeds MAX_GRID_FRAMES.
    """
    # Lazy imports — keep module importable without optional deps
    from tools.gpt_image_2 import (
        submit_generate,
        submit_edit_from_path,
        poll_until_done,
        grid_size_request,
    )
    from tools.rembg_wrapper import remove_background
    from tools.sprite_slicer import build_atlas
    from tools.spritesheet_splitter import split_grid
    from tools.spritesheet_normalizer import normalize_grid

    # All image generation routes through Kitty App — the user's business
    # chain handles auth, billing, S3 hosting, and the upstream image provider.
    # Canonical-seed workflow: the FIRST animation is text-to-image and is saved
    # to disk as the character's canonical seed. Every subsequent animation is a
    # gpt-image-2-edit seeded from THAT SAME FILE (never chained off the previous
    # edit) so identity / scale / palette stay locked across the whole set.
    logger.info("sprite_pipeline: routing via Kitty App (kitty_api → druidcat.com)")

    # Resolve grid geometry. frames_per_anim is a legacy 1×N override.
    if frames_per_anim is not None:
        grid_rows, grid_cols = 1, int(frames_per_anim)
    else:
        grid_rows, grid_cols = int(rows), int(cols)
    if grid_rows < 1 or grid_cols < 1:
        raise ValueError(f"grid must be >= 1x1 (got {grid_rows}x{grid_cols})")
    if grid_rows * grid_cols > MAX_GRID_FRAMES:
        raise ValueError(
            f"requested {grid_rows}x{grid_cols}={grid_rows * grid_cols} frames "
            f"exceeds MAX_GRID_FRAMES={MAX_GRID_FRAMES} (5x5+ grids drift)"
        )

    anim_list = animations or DEFAULT_ANIMATIONS
    # Sanitize once and tightly so we don't produce trailing-underscore noise.
    char_slug = _slugify(description, 30) or "sprite"

    if output_dir is None:
        # Characters always route to Generated/Sprites (deterministic by role).
        output_dir = _default_output_dir(subfolder_for_role("sprite"), project) / char_slug
    output_dir.mkdir(parents=True, exist_ok=True)

    # Per-character style anchor — written once, auto-prepended to every prompt.
    style_anchor = build_style_anchor(description, style)
    anchor_path = output_dir / f"{char_slug}_style_anchor.txt"
    anchor_path.write_text(style_anchor, encoding="utf-8")

    # The grid pixel-size request (named aspect + resolution tier). cell_px is
    # driven by the requested per-cell size so callers can still go bigger.
    cell_px = max(int(sprite_size[0]), int(sprite_size[1]), 256)
    aspect, resolution = grid_size_request(grid_rows, grid_cols, cell_px=cell_px)

    logger.info(
        "Generating sprite sheet: {desc!r} grid={r}x{c} anims={anims} style={style} "
        "aspect={asp} res={res}",
        desc=description, r=grid_rows, c=grid_cols, anims=anim_list,
        style=style, asp=aspect, res=resolution,
    )

    strips: list[AnimStrip] = []
    total_cost = 0.0
    # The canonical seed FILE for this character. The first generation writes it
    # (masked reference); every later generation edits from THIS file.
    seed_path: Path | None = None

    for anim in anim_list:
        logger.info("  Generating animation: {anim}", anim=anim)

        if seed_path is None:
            # First anim → text-to-image; this BECOMES the canonical seed.
            prompt = build_anim_prompt(
                description, anim, style,
                rows=grid_rows, cols=grid_cols, style_anchor=style_anchor,
            )
            logger.info(
                "  [{a}] CANONICAL-SEED generation (text-to-image, aspect={s} res={r})",
                a=anim, s=aspect, r=resolution,
            )
            task_id = submit_generate(
                prompt=prompt, size=aspect, quality="high", resolution=resolution,
            )
        else:
            # Subsequent anim → gpt-image-2-edit seeded from the CANONICAL SEED
            # file (never the previous edit). Identity/scale/palette stay locked.
            prompt = build_edit_anim_prompt(
                anim, style,
                rows=grid_rows, cols=grid_cols, style_anchor=style_anchor,
            )
            logger.info(
                "  [{a}] EDIT generation (gpt-image-2-edit) seed={r}",
                a=anim, r=seed_path.name,
            )
            task_id = submit_edit_from_path(
                prompt=prompt,
                seed_path=seed_path,
                size=aspect,
                quality="high",
                resolution=resolution,
            )
        logger.info("  [{a}] submitted task_id={t} — entering poll loop", a=anim, t=task_id)
        try:
            image_url, cost = await poll_until_done(task_id)
        except Exception as e:
            logger.exception("  [{a}] poll FAILED for task {t}: {e}", a=anim, t=task_id, e=e)
            raise
        logger.info(
            "  [{a}] poll DONE — url={u} cost=${c:.4f}",
            a=anim, u=str(image_url)[:120], c=cost,
        )
        total_cost += cost

        # Download raw grey-bg sheet PNG.
        import aiohttp
        sheet_raw_path = output_dir / f"{char_slug}_{anim}_raw.png"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(image_url) as resp:
                    if resp.status != 200:
                        raise RuntimeError(
                            f"download HTTP {resp.status} for {image_url[:120]}",
                        )
                    body = await resp.read()
                    sheet_raw_path.write_bytes(body)
                    logger.info(
                        "  [{a}] downloaded {n} bytes → {p}",
                        a=anim, n=len(body), p=sheet_raw_path,
                    )
        except Exception as e:
            logger.exception(
                "  [{a}] DOWNLOAD failed from {u}: {e}",
                a=anim, u=image_url[:120], e=e,
            )
            raise

        # Strip the flat-grey background → alpha. birefnet-general by default,
        # but VALIDATE: rembg failures are silent (file written, nearly empty).
        # If < 5 % visible pixels, escalate to the next model.
        sheet_clean_path = output_dir / f"{char_slug}_{anim}.png"
        models_to_try = ("birefnet-general", "isnet-anime", "bria-rmbg", "u2net")
        used_model = None
        for model in models_to_try:
            try:
                remove_background(
                    sheet_raw_path,
                    sheet_clean_path,
                    model=model,
                    alpha_matting=True,
                )
            except Exception as e:
                logger.warning("  [{a}] rembg model={m} failed: {e}", a=anim, m=model, e=e)
                continue
            visible_pct = _alpha_visible_pct(sheet_clean_path)
            if visible_pct >= 5.0:
                used_model = model
                logger.info(
                    "  [{a}] rembg done via {m} → {p} (visible alpha {pct:.1f}%)",
                    a=anim, m=model, p=sheet_clean_path.name, pct=visible_pct,
                )
                break
            logger.warning(
                "  [{a}] rembg model={m} produced empty alpha ({pct:.1f}%) — "
                "retrying with next model",
                a=anim, m=model, pct=visible_pct,
            )
        if used_model is None:
            logger.error(
                "  [{a}] ALL bg-removal models failed validation — using raw "
                "image (will keep grey bg)", a=anim,
            )
            import shutil
            shutil.copy(sheet_raw_path, sheet_clean_path)

        # Lock the canonical seed on the first successful (masked) generation.
        # Every subsequent animation edits from THIS file.
        if seed_path is None:
            seed_path = output_dir / f"{char_slug}_seed.png"
            import shutil
            shutil.copy(sheet_clean_path, seed_path)
            logger.info(
                "  [{a}] canonical seed LOCKED → {p} (subsequent anims edit from this)",
                a=anim, p=seed_path.name,
            )

        # OBLIGATORY pixel-perfect alignment BEFORE slicing. GPT-Image-2 places
        # the character at a different spot/size in every cell, so an even slice
        # makes the sprite jitter and bob (the "koślawe / trzęsące się" anims the
        # user kept seeing). normalize_grid re-anchors every frame in place to one
        # feet-aligned anchor — the subsequent even split is then jitter-free.
        # Logged-and-continue on failure: the sheet already exists; a normalize
        # error must not throw away an expensive generation (mirrors rembg above).
        try:
            norm = normalize_grid(
                sheet_clean_path, rows=grid_rows, cols=grid_cols,
                align="bottom-center", pad=6,
            )
            logger.info(
                "    {anim}: aligned frames — jitter ({jx},{jy})px -> 0, "
                "scale={s}, overflow={ov}/{n}",
                anim=anim, jx=norm["jitter_x_before"], jy=norm["jitter_y_before"],
                s=norm["scale"], ov=norm["n_overflow"], n=norm["n_live"],
            )
        except Exception as e:  # noqa: BLE001 — degrade gracefully, log loudly
            logger.warning(
                "    {anim}: normalize_grid failed ({e!r}) — slicing the "
                "un-normalized sheet (frames may jitter)", anim=anim, e=e,
            )

        # Slice the rows×cols grid into frames + correct 2D frames.json.
        split = split_grid(
            sheet_clean_path,
            rows=grid_rows,
            cols=grid_cols,
            out_dir=output_dir,
            base_name=f"{char_slug}_{anim}",
        )

        strips.append(AnimStrip(
            name=anim,
            path=sheet_clean_path,
            frame_count=len(split["frames"]),
            frame_width=split["frame_w"],
            frame_height=split["frame_h"],
            rows=split["rows"],
            cols=split["cols"],
            frames=split["frames"],
        ))
        logger.info(
            "    {anim}: {n} frames ({r}x{c} @ {w}x{h}px), cost ${cost:.4f}",
            anim=anim, n=len(split["frames"]), r=split["rows"], c=split["cols"],
            w=split["frame_w"], h=split["frame_h"], cost=cost,
        )

    # Build master atlas (all anim sheets stacked vertically).
    atlas_path = output_dir / f"{char_slug}_atlas.png"
    build_atlas([s.path for s in strips], atlas_path)

    # Write combined frames.json (2D-aware, across all anims).
    frames_json_path = output_dir / f"{char_slug}_frames.json"
    _write_frames_json(
        frames_json_path,
        strips=strips,
        char_slug=char_slug,
        atlas_path=atlas_path,
    )

    result = SpriteSheetResult(
        character_name=description,
        output_dir=output_dir,
        atlas_path=atlas_path,
        frames_json_path=frames_json_path,
        seed_path=seed_path,
        style_anchor=style_anchor,
        strips=strips,
        cost_usd=total_cost,
    )
    logger.info(
        "Sprite sheet complete: {n_strips} anim sheets, atlas={atlas}, total_cost=${c:.4f}",
        n_strips=len(strips),
        atlas=atlas_path.name,
        c=total_cost,
    )
    return result


def build_static_prop_prompt(description: str, style: str = "cartoon") -> str:
    """Prompt for a SINGLE STATIC object — the opposite of the character model
    sheet. Hard-forbids the legs/grid/animation that turned a 'net post' into a
    walking post with legs."""
    style_suffix = STYLE_SUFFIXES.get(style, STYLE_SUFFIXES["cartoon"])
    return (
        f"A SINGLE STATIC 2D game asset: {description}. Draw the object EXACTLY "
        f"ONCE, centered, shown straight-on from the side as it appears in the "
        f"game, filling most of the frame. It is an INANIMATE OBJECT / PROP: it "
        f"has NO legs, NO feet, NO arms, NO hands, NO face, NO eyes and NO limbs "
        f"of ANY kind, and shows NO motion (unless such a part is literally and "
        f"explicitly named in the description). This is NOT a character and NOT "
        f"an animation. ABSOLUTELY NOT a sprite sheet: NO grid, NO 3x3 / NxN "
        f"layout, NO multiple copies, NO frames, NO walk cycle, NO poses - just "
        f"the one clean object. {style_suffix}"
    )


async def generate_static_sprite(
    description: str,
    *,
    style: str = "cartoon",
    sprite_size: tuple[int, int] = (512, 512),
    project: str | None = None,
    output_dir: Path | None = None,
) -> SpriteSheetResult:
    """Generate ONE STATIC object image — NO animation, NO grid, NO poses, NO
    legs. For inanimate props/obstacles/items that do not move on their own: a
    volleyball net post, a ball, rock, barrel, crate, sign, platform, goal,
    fence, pickup, button. The exact opposite of generate_character_spritesheet.

    Returns a SpriteSheetResult shaped like the character path (atlas = the one
    transparent PNG, frames.json = a trivial 1x1 frame) so the gen-queue and the
    library treat it uniformly. Load it in Phaser with `this.load.image(key, p)`.
    """
    from tools.gpt_image_2 import submit_generate, poll_until_done, grid_size_request
    from tools.rembg_wrapper import remove_background
    from tools.spritesheet_splitter import split_grid

    slug = _slugify(description, 30) or "prop"
    if output_dir is None:
        output_dir = _default_output_dir(subfolder_for_role("sprite"), project) / slug
    output_dir.mkdir(parents=True, exist_ok=True)

    cell_px = max(int(sprite_size[0]), int(sprite_size[1]), 256)
    aspect, resolution = grid_size_request(1, 1, cell_px=cell_px)
    prompt = build_static_prop_prompt(description, style)
    logger.info("static-prop generation (SINGLE image, NO animation): {d!r}", d=description)

    task_id = submit_generate(prompt=prompt, size=aspect, quality="high", resolution=resolution)
    image_url, cost = await poll_until_done(task_id)

    import aiohttp
    raw_path = output_dir / f"{slug}_raw.png"
    async with aiohttp.ClientSession() as session:
        async with session.get(image_url) as resp:
            if resp.status != 200:
                raise RuntimeError(f"download HTTP {resp.status} for {image_url[:120]}")
            raw_path.write_bytes(await resp.read())

    # Strip the flat-grey background → alpha (same model escalation as characters).
    clean_path = output_dir / f"{slug}.png"
    used = None
    for model in ("birefnet-general", "isnet-anime", "bria-rmbg", "u2net"):
        try:
            remove_background(raw_path, clean_path, model=model, alpha_matting=True)
        except Exception as e:  # noqa: BLE001 — try the next model
            logger.warning("static-prop rembg model={m} failed: {e}", m=model, e=e)
            continue
        if _alpha_visible_pct(clean_path) >= 5.0:
            used = model
            break
    if used is None:
        import shutil
        shutil.copy(raw_path, clean_path)
        logger.error("static-prop: all rembg models failed validation — keeping grey bg")

    # Trivial 1x1 grid → 1 frame + frames.json, so the result matches the sprite
    # shape. NO normalize_grid (single frame can't jitter), NO animator.
    split = split_grid(clean_path, rows=1, cols=1, out_dir=output_dir, base_name=slug)
    strip = AnimStrip(
        name="static", path=clean_path, frame_count=1,
        frame_width=split["frame_w"], frame_height=split["frame_h"],
        rows=1, cols=1, frames=split["frames"],
    )
    frames_json_path = output_dir / f"{slug}_frames.json"
    _write_frames_json(frames_json_path, strips=[strip], char_slug=slug, atlas_path=clean_path)

    logger.info("static-prop done: {p} (cost ${c:.4f})", p=clean_path.name, c=cost)
    return SpriteSheetResult(
        character_name=description,
        output_dir=output_dir,
        atlas_path=clean_path,
        frames_json_path=frames_json_path,
        seed_path=None,
        style_anchor="",
        strips=[strip],
        cost_usd=cost,
    )


def _write_frames_json(
    path: Path,
    strips: list[AnimStrip],
    char_slug: str,
    atlas_path: Path,
) -> None:
    """Write a combined, 2D-GRID-AWARE frames.json across all anim sheets.

    Each anim sheet is a rows×cols grid; sheets are stacked vertically in the
    master atlas. A frame's atlas rect is therefore:
        x = col * frame_w
        y = sheet_y_offset + row * frame_h
    with frames enumerated row-major (left→right, top→bottom). The old logic
    assumed a 1×N strip (`x = i * frame_w`, `y = y_offset`) and produced wrong
    rects for any grid with rows > 1.
    """
    sprites: list[dict[str, Any]] = []
    sheet_y_offset = 0  # cumulative vertical offset of this sheet in the atlas
    anims: dict[str, list[str]] = {}

    for strip in strips:
        frame_names: list[str] = []
        for i in range(strip.frame_count):
            row = i // strip.cols if strip.cols else 0
            col = i % strip.cols if strip.cols else i
            name = f"{char_slug}_{strip.name}_{i:02d}"
            sprites.append({
                "name": name,
                "rect": {
                    "x": col * strip.frame_width,
                    "y": sheet_y_offset + row * strip.frame_height,
                    "width": strip.frame_width,
                    "height": strip.frame_height,
                },
                # Center pivot (0.5, 0.5) — characters sit centered in their cells.
                "pivot": {"x": 0.5, "y": 0.5},
                "border": {"left": 0, "right": 0, "top": 0, "bottom": 0},
            })
            frame_names.append(name)
        anims[strip.name] = frame_names
        # Advance past this whole sheet (rows * frame_height) in the atlas.
        sheet_y_offset += strip.rows * strip.frame_height

    data = {
        "atlas": str(atlas_path),
        "char_slug": char_slug,
        # `intent` lets downstream tools (and the inner Claude) know what
        # this asset is FOR. Sprites generated through this pipeline are
        # always characters; other pipelines set their own intent.
        "intent": "character",
        "sprites": sprites,
        "animations": anims,
        "unity_import_hint": {
            "textureType": "Sprite",
            "spriteMode": "Multiple",
            # 100 PPU for hand-drawn cartoon (matches gpt-image-2 output);
            # the old 32 PPU was a pixel-art default that made cartoon
            # sprites huge on screen.
            "pixelsPerUnit": 100,
            # Bilinear for soft cartoon, Point for pixel-art (sprite_pipeline
            # is cartoon; pixel_art_pipeline overrides to Point).
            "filterMode": "Bilinear",
            "alphaIsTransparency": True,
            "spriteAlignment": 9,  # Center — 9 in the importer enum
            "spritePivot": [0.5, 0.5],
            "meshType": "Tight",  # trims transparent border on Sliced mode
            "compression": "None",
        },
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
