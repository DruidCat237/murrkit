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
from loguru import logger
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
    paint = spec.get("paint")
    if paint is not None:
        if (
            not isinstance(paint, dict)
            or not isinstance(paint.get("legend"), dict)
            or not isinstance(paint.get("rows"), list)
        ):
            errs.append("`paint` needs `legend` (char→biome) and `rows` (list of strings)")
        else:
            legend = paint["legend"]
            for ch, b in legend.items():
                # ord()>0xFFFF: non-BMP chars (emoji) are ONE code point here
                # but TWO UTF-16 units in the JS validator — the lockstep
                # contract demands we reject exactly what the game rejects.
                if not isinstance(ch, str) or len(ch) != 1 or ch == "." or ord(ch) > 0xFFFF:
                    errs.append(
                        f"paint legend key {ch!r} must be a single quoted BMP char, not '.' "
                        f"(quote it — bare y/n parse as booleans in yaml; no emoji)"
                    )
                elif b not in biomes:
                    errs.append(f"paint legend '{ch}' → unknown biome '{b}'")
            rows = paint["rows"]
            if isinstance(h, int) and len(rows) > h:
                errs.append(f"paint has {len(rows)} rows but map height is {h}")
            for y2, row in enumerate(rows):
                if not isinstance(row, str):
                    errs.append(f"paint row {y2} is not a string")
                    continue
                if isinstance(w, int) and len(row) > w:
                    errs.append(f"paint row {y2} is {len(row)} chars but map width is {w}")
                bad = sorted({c for c in row if c != "." and c not in legend})
                if bad:
                    errs.append(f"paint row {y2} uses chars missing from legend: {bad}")
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


# ---------------------------------------------------------------------------
# Auto-wire: when a biome_tileset generation completes, insert its published
# `image:` path into every bundled map that declares the biome without one.
# Pure LINE surgery (never re-serialize the yaml — comments must survive),
# and the result is validated before writing so a bad edit can't brick a map.
# ---------------------------------------------------------------------------

_IMAGE_FIELD_RE = re.compile(r"(^|[{\s,])image\s*:", re.M)


def _insert_image_line(text: str, biome: str, image_path: str) -> str | None:
    """Insert `image:` into the `tilesets` entry for `biome`.

    Handles both entry forms used in this repo:
        - biome: grass            →  new `image:` field line after the entry
          color: "#5da548"           (matching field indentation)
        - { biome: grass, ... }   →  `, image: <path>` before the closing `}`

    Returns the new text, or None when the map doesn't declare the biome or
    the entry already carries an `image:`.
    """
    biome_re = re.compile(
        rf"(^|[{{\s]|-\s)biome\s*:\s*[\"']?{re.escape(biome)}[\"']?\s*($|[,}}\s#])", re.M,
    )
    lines = text.split("\n")
    n = len(lines)
    ts_start = next(
        (i for i, ln in enumerate(lines) if re.match(r"^tilesets\s*:\s*(#.*)?$", ln)), None,
    )
    if ts_start is None:
        return None

    i = ts_start + 1
    while i < n:
        ln = lines[i]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            i += 1
            continue
        if re.match(r"^\S", ln):
            break  # next top-level key — tilesets block ended
        m = re.match(r"^(\s*)-\s*(.*)$", ln)
        if not m:
            i += 1
            continue
        indent, rest = m.group(1), m.group(2)
        # Entry span: until the next same-or-shallower `- ` item or a top-level key.
        j = i + 1
        while j < n:
            nxt = lines[j]
            if nxt.strip() == "" or nxt.lstrip().startswith("#"):
                j += 1
                continue
            if re.match(r"^\S", nxt):
                break
            m2 = re.match(r"^(\s*)-\s", nxt)
            if m2 and len(m2.group(1)) <= len(indent):
                break
            j += 1
        span_text = "\n".join(lines[i:j])
        if biome_re.search(span_text):
            if _IMAGE_FIELD_RE.search(span_text):
                return None  # already wired
            if rest.lstrip().startswith("{"):
                # Inline entries in this repo are single-line.
                brace = lines[i].rfind("}")
                if brace == -1:
                    return None
                head = lines[i][:brace].rstrip().rstrip(",")
                lines[i] = f"{head}, image: {image_path} " + lines[i][brace:]
            else:
                field_col = len(indent) + 2  # fields align under the key after "- "
                lines.insert(i + 1, " " * field_col + f"image: {image_path}")
            return "\n".join(lines)
        i = j
    return None


def auto_wire_biome_image(biome: str, image_path: str | None) -> list[str]:
    """Called by the gen-queue biome_tileset worker after publish. Returns the
    ids of maps that were wired. Sync (file IO) — callers to_thread it."""
    if not image_path or not _MAPS_DIR.is_dir():
        return []
    wired: list[str] = []
    for p in sorted(_MAPS_DIR.glob("*.map.yaml")):
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as e:
            logger.warning("auto-wire: cannot read {p}: {e}", p=p.name, e=e)
            continue
        new = _insert_image_line(text, biome, image_path)
        if new is None:
            continue
        spec, errs = _parse(new)
        if spec is None:
            logger.warning(
                "auto-wire {m}: edit would break the map ({e}) — skipped",
                m=p.name, e="; ".join(errs[:2]),
            )
            continue
        p.write_text(new, encoding="utf-8")
        wired.append(p.name[: -len(".map.yaml")])
        logger.info("auto-wire: {m} ← {b} image {i}", m=p.name, b=biome, i=image_path)
    return wired


# ---------------------------------------------------------------------------
# AI paint — DeepSeek fills the per-cell `paint` layer from an instruction.
# Returns a PROPOSAL (legend + rows); nothing is written to disk — the panel
# applies it to the editor and the user saves through the validating PUT.
# ---------------------------------------------------------------------------

_AI_PAINT_MAX_SIDE = 96  # LLM grid cap; bigger maps are painted at 1/k scale

_AI_PAINT_SYSTEM = """\
You are a 2D tile-map painter. You receive a map size, a legend of biome
characters, optionally the current paint grid, and an instruction. Respond
with STRICT JSON: {"rows": ["<row>", ...]} — exactly HEIGHT rows, each
exactly WIDTH characters, using ONLY legend characters and "." (dot).
"." means "leave this cell to the procedural base". Paint coherent, organic
shapes (no checkerboards, no single-cell noise), respect the instruction's
geography (north = row 0, west = column 0), and keep solid/water biomes
connected unless asked otherwise. Return ONLY the JSON object.
"""


class AiPaintRequest(BaseModel):
    instruction: str
    # Panel sends its live grid so the model REFINES instead of restarting.
    rows_hint: list[str] | None = None
    temperature: float = 0.5


@router.post("/{map_id}/ai-paint")
async def ai_paint(map_id: str, req: AiPaintRequest) -> dict[str, Any]:
    p = _map_path(map_id)
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"map '{map_id}' not found")
    spec, errs = _parse(p.read_text(encoding="utf-8"))
    if spec is None:
        raise HTTPException(status_code=400, detail=f"map yaml invalid: {'; '.join(errs)}")
    instruction = req.instruction.strip()
    if not instruction:
        raise HTTPException(status_code=400, detail="instruction is empty")

    width, height = int(spec["width"]), int(spec["height"])
    biomes = [str(t["biome"]) for t in spec["tilesets"]]
    legend = _derive_legend(spec, biomes)
    legend_inv = {b: ch for ch, b in legend.items()}

    # Downscale factor: LLMs handle ≤96-char rows reliably; upscale after.
    k = max(1, -(-max(width, height) // _AI_PAINT_MAX_SIDE))  # ceil div
    ws, hs = -(-width // k), -(-height // k)

    walk = {t["biome"]: t.get("walkable", True) for t in spec["tilesets"]}
    legend_lines = "\n".join(
        f'  "{ch}" = {b}{" (solid/impassable)" if not walk.get(b, True) else ""}'
        for ch, b in legend.items()
    )
    parts = [
        f"Map: WIDTH={ws} HEIGHT={hs} (paint at this exact size).",
        f"Legend:\n{legend_lines}",
    ]
    notes = spec.get("notes")
    if isinstance(notes, str) and notes.strip():
        parts.append(f"Theme: {notes.strip()[:300]}")
    hint = req.rows_hint if (req.rows_hint and k == 1) else None
    if hint:
        clipped = [str(r)[:width].ljust(width, ".") for r in hint[:height]]
        parts.append(
            "Current paint grid (refine it — keep what the instruction doesn't "
            "contradict):\n" + "\n".join(clipped)
        )
    parts.append(f"Instruction: {instruction}")

    from core.deepseek_v4 import DeepSeekV4Client, Message, TextPart

    messages = [
        Message(role="system", content=[TextPart(text=_AI_PAINT_SYSTEM)]),
        Message(role="user", content=[TextPart(text="\n\n".join(parts))]),
    ]
    try:
        async with DeepSeekV4Client() as client:
            result = await client.chat(
                messages,
                temperature=max(0.0, min(1.0, req.temperature)),
                # The formula IS the budget (96×96 worst case → 10 092); the
                # outer cap only guards a runaway, it must never undercut it.
                max_tokens=min(10500, hs * (ws + 6) + 300),
                response_format={"type": "json_object"},
            )
    except RuntimeError as e:
        # No DEEPSEEK_API_KEY configured (or client misuse) — actionable 503.
        raise HTTPException(status_code=503, detail=str(e)) from None

    import json as _json
    try:
        # `or []`: {"rows": null} must degrade like a missing key, not 500.
        raw_rows = _json.loads(result.text).get("rows") or []
    except (_json.JSONDecodeError, AttributeError):
        raise HTTPException(
            status_code=502,
            detail=f"model returned malformed JSON (head: {result.text[:120]!r})",
        ) from None

    # Sanitize hard: unknown chars → ".", pad/truncate to the scaled size.
    allowed = set(legend) | {"."}
    small = []
    for y in range(hs):
        row = str(raw_rows[y]) if y < len(raw_rows) else ""
        small.append("".join(c if c in allowed else "." for c in row)[:ws].ljust(ws, "."))
    # Upscale k× (nearest) and crop to the real map size.
    rows = []
    for y in range(height):
        srow = small[min(hs - 1, y // k)]
        rows.append("".join(srow[min(ws - 1, x // k)] for x in range(width)))

    return {
        "ok": True,
        "legend": legend,
        "rows": rows,
        "downscale": k,
        "cost_usd": result.cost_usd,
        "biome_chars": legend_inv,
    }


def _derive_legend(spec: dict[str, Any], biomes: list[str]) -> dict[str, str]:
    """Char→biome legend: reuse the map's existing paint legend, then assign
    free chars for the rest (first letters, then a-z0-9; '.' reserved)."""
    legend: dict[str, str] = {}
    paint = spec.get("paint")
    if isinstance(paint, dict) and isinstance(paint.get("legend"), dict):
        for ch, b in paint["legend"].items():
            if isinstance(ch, str) and len(ch) == 1 and ch != "." and b in biomes:
                legend[ch] = b
    assigned = set(legend.values())
    pool = "abcdefghijklmnopqrstuvwxyz0123456789"
    for b in biomes:
        if b in assigned:
            continue
        ch = next(
            (c for c in (b[0].lower(), *b.lower(), *pool) if c.isalnum() and c not in legend),
            None,
        )
        if ch is not None:
            legend[ch] = b
            assigned.add(b)
    return legend
