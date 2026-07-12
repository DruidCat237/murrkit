"""
Maps router — Map Studio's backend surface over `phaser_game/maps/*.map.yaml`.

The YAML files are the single source of truth (the captain and the human edit
the SAME file); this router only lists, reads, validates and writes them —
compilation to Tiled JSON happens in the Phaser client
(`phaser_game/src/builders/buildMapFromYAML.ts`), never here.

Endpoints:
    GET  /api/maps                → list bundled maps
    GET  /api/maps/{map_id}       → yaml + parsed spec + per-biome tileset status
    PUT  /api/maps/{map_id}       → validate + write yaml (creates new maps too)
    POST /api/maps/parse          → validate a yaml string without writing
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.config import PROJECT_ROOT

router = APIRouter(prefix="/api/maps", tags=["maps"])

_MAPS_DIR = PROJECT_ROOT / "phaser_game" / "maps"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_MAX_YAML_BYTES = 512 * 1024

# Mirrors mapSpec.ts MAP_TILESET_* — keep in lockstep with the Phaser compiler.
_TILESET_GRID = 4


def _map_path(map_id: str) -> Path:
    if not _ID_RE.match(map_id):
        raise HTTPException(status_code=400, detail=f"bad map id {map_id!r} (want [a-z0-9_-])")
    return _MAPS_DIR / f"{map_id}.map.yaml"


def _validate_spec(spec: Any) -> list[str]:
    """Structural validation mirroring mapSpec.ts `validateMapSpec` — keep the
    two in lockstep so the backend never accepts a map the game rejects."""
    errs: list[str] = []
    if not isinstance(spec, dict):
        return ["spec: not a mapping"]
    if not isinstance(spec.get("id"), str) or not spec.get("id"):
        errs.append("missing `id`")
    w, h, ts = spec.get("width"), spec.get("height"), spec.get("tileSize")
    if not isinstance(w, int) or not isinstance(h, int) or w < 1 or h < 1:
        errs.append("width/height must be positive integers (tiles)")
    elif w * h > 512 * 512:
        errs.append(f"{w}×{h} exceeds 512×512 tile cap")
    if not isinstance(ts, int) or ts < 8:
        errs.append("tileSize must be an integer ≥ 8 px")
    tilesets = spec.get("tilesets")
    if not isinstance(tilesets, list) or not tilesets:
        errs.append("needs at least one entry in `tilesets`")
        return errs
    biomes: set[str] = set()
    for t in tilesets:
        b = t.get("biome") if isinstance(t, dict) else None
        if not b:
            errs.append("tileset entry without `biome`")
        elif b in biomes:
            errs.append(f"duplicate tileset biome '{b}'")
        else:
            biomes.add(b)
    for r in spec.get("biomes") or []:
        if not isinstance(r, dict):
            errs.append("region entry is not a mapping")
            continue
        if r.get("biome") not in biomes:
            errs.append(f"region references unknown biome '{r.get('biome')}'")
        if not r.get("rect") and not r.get("seed"):
            errs.append(f"region for '{r.get('biome')}' needs `rect` or `seed`")
    db = spec.get("defaultBiome")
    if db and db not in biomes:
        errs.append(f"defaultBiome '{db}' not declared in `tilesets`")
    return errs


def _parse(yaml_text: str) -> tuple[dict[str, Any] | None, list[str]]:
    if len(yaml_text.encode("utf-8", errors="replace")) > _MAX_YAML_BYTES:
        return None, [f"yaml exceeds {_MAX_YAML_BYTES // 1024} KB"]
    try:
        spec = yaml.safe_load(yaml_text)
    except yaml.YAMLError as e:
        return None, [f"yaml parse error: {e}"]
    errs = _validate_spec(spec)
    return (spec if not errs else None), errs


def _confined_public(rel: str) -> Path | None:
    """Resolve a web-style path STRICTLY inside PROJECT_ROOT/public.

    `image`/`biome` come from user-editable yaml (and `project` from a query
    param) — an absolute path ("C:/…") or a ".." component must not turn the
    existence check into a filesystem oracle. pathlib joins absolute paths by
    REPLACING the base, so resolve + is_relative_to is the actual guard."""
    base = (PROJECT_ROOT / "public").resolve()
    try:
        candidate = (base / rel.lstrip("/")).resolve()
    except (OSError, ValueError):
        return None
    return candidate if candidate.is_relative_to(base) else None


def _tileset_status(spec: dict[str, Any], project_hint: str | None) -> list[dict[str, Any]]:
    """Per-biome generation status: does a published sheet exist, and what
    stable path should map.yaml use once one does?"""
    out: list[dict[str, Any]] = []
    owner = (project_hint or "").strip() or "default"
    for t in spec.get("tilesets") or []:
        if not isinstance(t, dict) or not t.get("biome"):
            continue
        biome = str(t["biome"])
        image = t.get("image")
        image_path = _confined_public(str(image)) if image else None
        suggested = f"/assets/tilesets/{owner}/{biome}/sheet.png"
        candidate = _confined_public(suggested)
        out.append({
            "biome": biome,
            "image": image,
            "image_exists": bool(image_path and image_path.is_file()),
            "suggested_image": suggested,
            "suggested_exists": bool(candidate and candidate.is_file()),
            # Disk path of the published sheet (when it exists) — the UI passes
            # this as base_image_path so later biomes style-match via edit-mode.
            "published_disk_path": str(candidate) if candidate and candidate.is_file() else None,
            "walkable": t.get("walkable", True),
            "color": t.get("color"),
        })
    return out


@router.get("")
async def list_maps() -> dict[str, Any]:
    maps: list[dict[str, Any]] = []
    if _MAPS_DIR.is_dir():
        for p in sorted(_MAPS_DIR.glob("*.map.yaml")):
            maps.append({
                "id": p.name[: -len(".map.yaml")],
                "path": p.relative_to(PROJECT_ROOT).as_posix(),
                "bytes": p.stat().st_size,
                "mtime": p.stat().st_mtime,
            })
    return {"maps": maps, "dir": _MAPS_DIR.relative_to(PROJECT_ROOT).as_posix()}


class ParseRequest(BaseModel):
    yaml_text: str


# NOTE: declared BEFORE /{map_id} so the literal path can never be shadowed
# by the parameterised route.
@router.post("/parse")
async def parse_map(req: ParseRequest) -> dict[str, Any]:
    """Validate a yaml string (live editor feedback) — never touches disk."""
    spec, errs = _parse(req.yaml_text)
    return {"ok": spec is not None, "spec": spec, "errors": errs}


@router.get("/{map_id}")
async def get_map(map_id: str, project: str | None = None) -> dict[str, Any]:
    p = _map_path(map_id)
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"map '{map_id}' not found")
    text = p.read_text(encoding="utf-8")
    spec, errs = _parse(text)
    # A broken file still opens in the editor — spec is null, errors explain why.
    return {
        "id": map_id,
        "yaml": text,
        "spec": spec,
        "errors": errs,
        "tilesets": _tileset_status(spec, project) if spec else [],
        "play_url_hint": f"/?level={map_id}",
    }


class SaveMapRequest(BaseModel):
    yaml_text: str


@router.put("/{map_id}")
async def put_map(map_id: str, req: SaveMapRequest) -> dict[str, Any]:
    """Validate then write. Refuses to persist a spec the game would reject —
    a broken map.yaml would brick `?level=<id>` for the captain's playtests."""
    p = _map_path(map_id)
    spec, errs = _parse(req.yaml_text)
    if spec is None:
        raise HTTPException(status_code=400, detail="; ".join(errs) or "invalid map yaml")
    if spec.get("id") != map_id:
        raise HTTPException(
            status_code=400,
            detail=f"spec id '{spec.get('id')}' must match filename id '{map_id}'",
        )
    _MAPS_DIR.mkdir(parents=True, exist_ok=True)
    created = not p.is_file()
    p.write_text(req.yaml_text, encoding="utf-8")
    return {"ok": True, "id": map_id, "created": created, "spec": spec}
