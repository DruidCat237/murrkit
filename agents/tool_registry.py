"""
Tool Registry — aggregates all 2D-specific tools for agent consumption.

Provides a unified interface for discovering and calling tools across:
    - Sprite generation (GPT-Image-2 via Kitty App)
    - Asset generation (backgrounds, tilesets, UI, particles)
    - Audio (ElevenLabs)
    - Unity-MCP (scene wiring, script creation, play mode)

Usage:
    from agents.tool_registry import TOOLS, get_tool

    tool_fn = get_tool("generate_character_spritesheet")
    result = await tool_fn(description="knight", animations=["idle", "walk"])
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable


# Tool descriptor for LLM consumption
ToolSpec = dict[str, Any]

# Registry: name -> (async callable, description)
_REGISTRY: dict[str, tuple[Callable[..., Awaitable[Any]], ToolSpec]] = {}


def _register(
    name: str,
    description: str,
    parameters: dict[str, Any],
) -> Callable:
    def decorator(fn: Callable) -> Callable:
        _REGISTRY[name] = (fn, {
            "name": name,
            "description": description,
            "parameters": parameters,
        })
        return fn
    return decorator


# ---------------------------------------------------------------------------
# Sprite generation tools
# ---------------------------------------------------------------------------

@_register(
    name="generate_character_spritesheet",
    description=(
        "Generate a complete character sprite sheet set via GPT-Image-2. "
        "Produces per-animation strips + master atlas + frames.json."
    ),
    parameters={
        "description": "str — character description e.g. 'knight in blue armor'",
        "animations": "list[str] — e.g. ['idle', 'walk', 'attack'] (default: idle/walk/attack/hurt/death)",
        "frames_per_anim": "int — frames per animation strip (default 4)",
        "style": "str — 'pixel_art' | 'vector' | 'hand_painted' | 'cartoon'",
        "sprite_size": "tuple[int, int] — frame size in pixels (default (64, 64))",
        "output_dir": "str | None — output directory path",
    },
)
async def _gen_spritesheet(**kwargs: Any) -> Any:
    from agents.sprite_pipeline import generate_character_spritesheet
    return await generate_character_spritesheet(**kwargs)


# ---------------------------------------------------------------------------
# Asset generation tools
# ---------------------------------------------------------------------------

@_register(
    name="generate_background",
    description="Generate parallax background layers (sky, far, mid, near).",
    parameters={
        "description": "str — scene description e.g. 'forest at sunset'",
        "layers": "list[str] | None — layer names (default: sky/far/mid/near)",
        "output_dir": "str | None",
    },
)
async def _gen_background(**kwargs: Any) -> Any:
    from agents.asset_pipeline import generate_background
    return await generate_background(**kwargs)


@_register(
    name="generate_tileset",
    description="Generate a tileset PNG sheet (ground, wall, platform, decoration).",
    parameters={
        "description": "str — e.g. 'mossy stone dungeon floor'",
        "tile_type": "str — 'ground' | 'wall' | 'platform' | 'decoration'",
        "output_dir": "str | None",
    },
)
async def _gen_tileset(**kwargs: Any) -> Any:
    from agents.asset_pipeline import generate_tileset
    return await generate_tileset(**kwargs)


@_register(
    name="generate_ui_element",
    description="Generate a UI element PNG (button, panel, health bar, icon).",
    parameters={
        "description": "str — e.g. 'fantasy wooden button with gold border'",
        "element_type": "str — 'button' | 'panel' | 'health_bar' | 'icon' | 'frame'",
        "output_dir": "str | None",
    },
)
async def _gen_ui(**kwargs: Any) -> Any:
    from agents.asset_pipeline import generate_ui_element
    return await generate_ui_element(**kwargs)


@_register(
    name="generate_particle_fx",
    description="Generate a particle effect sprite sheet (dust, spark, impact, magic).",
    parameters={
        "description": "str — e.g. 'golden sparkles with glow'",
        "fx_type": "str — 'dust' | 'spark' | 'impact' | 'magic' | 'smoke'",
        "output_dir": "str | None",
    },
)
async def _gen_particle(**kwargs: Any) -> Any:
    from agents.asset_pipeline import generate_particle_fx
    return await generate_particle_fx(**kwargs)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

TOOLS: dict[str, ToolSpec] = {name: spec for name, (_, spec) in _REGISTRY.items()}


def get_tool(name: str) -> Callable[..., Awaitable[Any]]:
    """Return the async callable for tool `name`. Raises KeyError if not found."""
    if name not in _REGISTRY:
        raise KeyError(f"Tool '{name}' not registered. Available: {list(_REGISTRY.keys())}")
    fn, _ = _REGISTRY[name]
    return fn


def list_tools() -> list[ToolSpec]:
    """Return all tool specs for LLM system prompt injection."""
    return list(TOOLS.values())
