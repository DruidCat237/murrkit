"""
Asset Library router — browse a project's assets, STRICTLY isolated per project.

The single source of truth is `projects/<project>/` (where `<project>` is the
active project, e.g. `Cat_Volleyball`). Generated sprites / backgrounds / UI /
FX land under `projects/<project>/Generated/<subfolder>/<slug>/` (the gen-queue
worker threads the owning project into the pipeline), and the user can drop
their own art into `projects/<project>/sprites/`, `.../backgrounds/` etc. by
hand. The library scans ONLY the active project's folder recursively, so being
"in Cat_Volleyball" shows ONLY Cat_Volleyball assets — nothing from other
projects is ever mixed in.

The Phaser game loads its runtime assets from `phaser_game/public/` (NOT from
here), so this listing is purely the per-project asset browser + the source for
future generation.

Endpoints:
    GET   /api/library/{project_name}          — full per-project asset listing
    GET   /api/library/{project_name}/raw?asset_id=...
                                                 — serve one asset's bytes inline
    GET   /api/library/{project_name}/zip      — download project as ZIP
    POST  /api/library/{project_name}/import-to-unity?asset_id=...
                                                 — pipe a single asset into the engine
"""

from __future__ import annotations

import io
import json
import mimetypes
import shutil
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from loguru import logger
from pydantic import BaseModel

from core.config import PROJECT_ROOT, PROJECTS_DIR, settings

router = APIRouter(prefix="/api/library", tags=["library"])

# Engine-side folders we surface in the browser. These are the conventional 2D
# asset homes; if any are missing we just skip them silently.
UNITY_ASSET_ROOTS = (
    "Generated",      # everything the worker writes
    "Sprites",        # user-authored characters
    "Backgrounds",
    "UI",
    "Tilesets",
    "Tiles",
    "Particles",
    "Animations",
    "Audio",
    "Materials",
    "Prefabs",
    "Scenes",
)

# Files we ignore — engine meta files, system junk, bg-removal backups.
_IGNORE_SUFFIXES = (".meta", ".tmp", ".bak")
_IGNORE_NAMES = (".DS_Store", "Thumbs.db", "desktop.ini")
# bg_removal's strip-unity-atlas endpoint saves the pre-strip atlas as
# `<name>.original.png` next to the live one. Don't surface those backups
# in the asset browser — they'd just clutter the grid with duplicates.
_IGNORE_PATTERNS = (".original.png",)


# Heuristics for classifying assets — uses both filename and parent path
def _classify(name: str, parent: str) -> str:
    n = name.lower()
    p = parent.lower().replace("\\", "/")
    if "_atlas" in n or "/atlases/" in p:
        return "atlas"
    if "_bg" in n or "background" in n or "/backgrounds/" in p:
        return "background"
    if "tile" in n or "/tileset" in p or "/tiles/" in p:
        return "tileset"
    if "/ui/" in p or n.startswith("ui_") or "_ui" in n:
        return "ui_element"
    if "particle" in n or "/particles/" in p or "_fx" in n:
        return "particle_fx"
    if "/audio/" in p or n.endswith((".wav", ".mp3", ".ogg")):
        return "audio"
    if "/materials/" in p or n.endswith(".mat"):
        return "material"
    if "/prefabs/" in p or n.endswith(".prefab"):
        return "prefab"
    if "/scenes/" in p or n.endswith(".unity"):
        return "scene"
    if "/animations/" in p or n.endswith((".anim", ".controller")):
        return "animation"
    if n.endswith(".cs"):
        return "script"
    if n.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".tga")):
        return "sprite"
    if n.endswith(".json"):
        return "metadata"
    return "other"


def _safe_project_dir(project_name: str) -> Path:
    """Resolve `projects/<project_name>` and refuse anything that escapes it.

    FastAPI binds `{project_name}` to any non-slash segment, and percent-encoded
    separators decode only AFTER routing — so `..%2f..%2f.env` would otherwise
    resolve outside PROJECTS_DIR and let the zip/listing endpoints read the
    repo's `.env` or arbitrary files. Contain it and 400 on traversal.
    """
    root = PROJECTS_DIR.resolve()
    proj = (root / project_name).resolve()
    if proj != root and not proj.is_relative_to(root):
        raise HTTPException(status_code=400, detail="invalid project name")
    return proj


def _skip(p: Path) -> bool:
    """True if this file should NOT show up in the browser."""
    if p.name in _IGNORE_NAMES:
        return True
    if p.suffix.lower() in _IGNORE_SUFFIXES:
        return True
    name_lower = p.name.lower()
    if any(name_lower.endswith(suf) for suf in _IGNORE_PATTERNS):
        return True
    # Exclude anything inside a .trash/ directory so trashed assets don't surface.
    if ".trash" in p.parts:
        return True
    return False


class LibraryAsset(BaseModel):
    id: str
    project_name: str
    type: str
    name: str
    rel_path: str
    served_url: str
    size_bytes: int
    modified_at: str


class ProjectLibrary(BaseModel):
    project_name: str
    project_path: str
    asset_count: int
    total_bytes: int
    assets: list[LibraryAsset]


# ---- Endpoints --------------------------------------------------------------


@router.get("/{project_name}", response_model=ProjectLibrary)
async def get_library(project_name: str) -> ProjectLibrary:
    """Return ONLY the named project's assets — strict per-project isolation.

    Scans `projects/<project_name>/` recursively (generated assets under
    `Generated/<sub>/<slug>/` + any hand-authored art) and nothing else. No
    cross-project tree is consulted, so a project sees exclusively its own
    assets.

    Each asset is served via this router's own `/raw` endpoint using a
    URL-encoded `legacy:<project>/<rel>` id; `_resolve_asset_id` maps that back
    to `projects/<project>/<rel>` on disk and streams the bytes inline.
    """
    assets: list[LibraryAsset] = []
    total = 0
    proj = _safe_project_dir(project_name)

    if proj.is_dir():
        for p in proj.rglob("*"):
            if not p.is_file() or _skip(p):
                continue
            try:
                rel = p.relative_to(proj).as_posix()
            except ValueError:
                continue
            st = p.stat()
            # id = legacy:<project>/<rel>  → _resolve_asset_id maps to
            # PROJECTS_DIR/<project>/<rel>. served_url points at our own /raw
            # endpoint (inline, no Content-Disposition) so it works as <img src>.
            asset_id = f"legacy:{project_name}/{rel}"
            served = f"/api/library/{quote(project_name)}/raw?asset_id={quote(asset_id, safe='')}"
            assets.append(LibraryAsset(
                id=asset_id,
                project_name=project_name,
                type=_classify(p.name, str(p.parent)),
                name=p.name,
                rel_path=f"projects/{project_name}/{rel}",
                served_url=served,
                size_bytes=st.st_size,
                modified_at=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            ))
            total += st.st_size

    # Stable sort: type, then rel_path so a folder's files cluster together.
    assets.sort(key=lambda a: (a.type, a.rel_path))
    return ProjectLibrary(
        project_name=project_name,
        project_path=str(proj),
        asset_count=len(assets),
        total_bytes=total,
        assets=assets,
    )


def _resolve_asset_id(asset_id: str) -> Path | None:
    """Map a LibraryAsset.id back to an absolute path on disk.

    Two id formats:
      - `unity:<rel-from-Assets>`     → <unity_project>/Assets/<rel>
      - `legacy:<project>/<rel>`      → murrkit/projects/<project>/<rel>

    Legacy fallback: ids written before this rewrite were the bare
    project-relative path. Accept those too.
    """
    if asset_id.startswith("unity:"):
        rel = asset_id[len("unity:"):]
        if ".." in rel.split("/"):
            return None
        full = (settings.unity_project_path / "Assets" / rel).resolve()
        try:
            full.relative_to((settings.unity_project_path / "Assets").resolve())
        except ValueError:
            return None
        return full if full.is_file() else None
    if asset_id.startswith("legacy:"):
        rel = asset_id[len("legacy:"):]
        if ".." in rel.split("/"):
            return None
        full = (PROJECTS_DIR / rel).resolve()
        try:
            full.relative_to(PROJECTS_DIR.resolve())
        except ValueError:
            return None
        return full if full.is_file() else None
    # Legacy bare path (pre-rewrite)
    if ".." in asset_id.split("/"):
        return None
    full = (PROJECT_ROOT / asset_id).resolve()
    try:
        full.relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        return None
    return full if full.is_file() else None


@router.get("/{project_name}/raw")
async def serve_asset_raw(project_name: str, asset_id: str) -> FileResponse:
    """Serve an asset's bytes straight from disk for thumbnails / lightbox / drag-out.

    Replaces the removed `/api/unity/assets/...` route that 404'd every preview.
    Path-safety is enforced by `_resolve_asset_id` (rejects `..` and anything
    outside the asset roots). No Content-Disposition → browsers render inline,
    so it works as an <img src>.
    """
    p = _resolve_asset_id(asset_id)
    if p is None:
        raise HTTPException(status_code=404, detail=f"asset not found: {asset_id}")
    media_type, _ = mimetypes.guess_type(p.name)
    return FileResponse(str(p), media_type=media_type or "application/octet-stream")


@router.get("/{project_name}/zip")
async def download_project_zip(project_name: str) -> StreamingResponse:
    """Stream a ZIP of the project (engine Assets/ + legacy + chat history)."""
    safe_proj = _safe_project_dir(project_name)  # 400s on path traversal
    buf = io.BytesIO()
    unity_assets = (settings.unity_project_path / "Assets").resolve()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if unity_assets.is_dir():
            for sub in UNITY_ASSET_ROOTS:
                root = unity_assets / sub
                if not root.is_dir():
                    continue
                for p in root.rglob("*"):
                    if not p.is_file() or _skip(p):
                        continue
                    arc = f"{project_name}/Assets/" + p.relative_to(unity_assets).as_posix()
                    zf.write(p, arc)
        proj = safe_proj
        if proj.is_dir():
            for p in proj.rglob("*"):
                if p.is_file() and not _skip(p):
                    arc = f"{project_name}/legacy/" + p.relative_to(proj).as_posix()
                    zf.write(p, arc)
        # Inject chat history JSON for portability
        try:
            from backend.routers.chat import get_history
            hist = await get_history(project_name=project_name, limit=10000)
            zf.writestr(
                f"{project_name}/__chat_history.json",
                json.dumps([h.model_dump() for h in hist], indent=2),
            )
        except (ImportError, OSError) as e:
            logger.warning("Cannot embed chat history in zip: {e}", e=e)
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename={project_name}.zip",
        },
    )


@router.get("/{project_name}/open-in-explorer")
async def open_in_explorer(project_name: str, asset_id: str) -> dict[str, Any]:
    """Reveal an asset in the OS file explorer.

    Returns the absolute path; the actual `explorer.exe /select,...` call
    happens client-side via the desktop helper if available, otherwise the
    frontend opens the served URL in a new tab.
    """
    full = _resolve_asset_id(asset_id)
    if full is None:
        raise HTTPException(status_code=404, detail=f"Asset '{asset_id}' not found")
    return {"abs_path": str(full), "exists": True}


@router.post("/{project_name}/delete")
async def delete_asset(project_name: str, asset_id: str) -> dict[str, Any]:
    """Soft-delete an asset by moving it to a per-project trash folder.

    Destination: projects/<project>/.trash/<unix_ts>/<original-relative-path>

    The file is MOVED (not deleted) so it can be recovered from disk.
    The scan in get_library() skips .trash/ so trashed assets stop appearing.
    Path-safety is enforced by _resolve_asset_id — returns 404 if the asset
    resolves outside the project, doesn't exist, or the id is malformed.
    """
    full = _resolve_asset_id(asset_id)
    if full is None:
        raise HTTPException(status_code=404, detail=f"Asset '{asset_id}' not found")

    # Ensure the resolved path stays inside this project's directory.
    proj_dir = (PROJECTS_DIR / project_name).resolve()
    try:
        full.relative_to(proj_dir)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="Asset does not belong to the requested project",
        ) from None

    # Build trash destination: projects/<project>/.trash/<ts>/<original-rel>
    rel = full.relative_to(proj_dir)
    ts = int(time.time())
    trash_dest = proj_dir / ".trash" / str(ts) / rel
    trash_dest.parent.mkdir(parents=True, exist_ok=True)

    shutil.move(str(full), str(trash_dest))
    logger.info(
        "Trashed asset {asset_id!r} → {trash_dest}",
        asset_id=asset_id,
        trash_dest=trash_dest,
    )

    trashed_to = trash_dest.relative_to(PROJECTS_DIR).as_posix()
    return {"ok": True, "asset_id": asset_id, "trashed_to": trashed_to}


class RemoveBgResponse(BaseModel):
    ok: bool
    asset_id: str
    output_name: str
    output_asset_id: str
    served_url: str
    model: str
    elapsed_ms: int


_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tga")


@router.post("/{project_name}/remove-bg", response_model=RemoveBgResponse)
async def remove_bg(project_name: str, asset_id: str) -> RemoveBgResponse:
    """Strip the background of ONE library image and save the result NEXT TO it
    as ``<name>-bg_removed.png`` (transparent alpha).

    Uses the SAME local BiRefNet/rembg stack the chat uses automatically
    (``birefnet-general`` — preserves stars/sparkles, handles white fur). The
    original is left untouched; the new ``-bg_removed.png`` appears in the
    library on the next scan. Path-safety via ``_resolve_asset_id`` + an explicit
    project-containment check (same guards as delete).
    """
    import asyncio

    from tools.rembg_wrapper import default_model_for, remove_background

    src = _resolve_asset_id(asset_id)
    if src is None:
        raise HTTPException(status_code=404, detail=f"Asset '{asset_id}' not found")
    if src.suffix.lower() not in _IMAGE_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail="remove-bg only works on image files (png/jpg/webp/…)",
        )

    proj_dir = (PROJECTS_DIR / project_name).resolve()
    try:
        src.relative_to(proj_dir)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="Asset does not belong to the requested project",
        ) from None

    # Output: <stem>-bg_removed.png next to the source (always PNG for alpha).
    # Re-running on an already-stripped file overwrites it instead of stacking
    # "-bg_removed-bg_removed".
    stem = src.stem if src.stem.endswith("-bg_removed") else f"{src.stem}-bg_removed"
    out = src.with_name(f"{stem}.png")

    model = default_model_for("sprite")  # birefnet-general — preserves decorations
    started = time.time()
    await asyncio.to_thread(
        remove_background, src, out, model=model, alpha_matting=True,
    )
    elapsed_ms = int((time.time() - started) * 1000)

    rel = out.relative_to(proj_dir).as_posix()
    out_id = f"legacy:{project_name}/{rel}"
    served = f"/api/library/{quote(project_name)}/raw?asset_id={quote(out_id, safe='')}"
    logger.info(
        "library remove-bg: {s} -> {o} model={m} {ms}ms",
        s=src.name, o=out.name, m=model, ms=elapsed_ms,
    )
    return RemoveBgResponse(
        ok=True,
        asset_id=asset_id,
        output_name=out.name,
        output_asset_id=out_id,
        served_url=served,
        model=model,
        elapsed_ms=elapsed_ms,
    )
