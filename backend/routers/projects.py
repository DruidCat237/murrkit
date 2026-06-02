"""
Projects router — CRUD on murrkit projects.

Each project is a directory under `projects/` with:
  - level YAML specs       (mirrored from phaser_game/levels/, scoped per project)
  - generated sprite assets (from gen-queue, served via /files/...)
  - chat history (sqlite)
  - per-project gen_queue snapshot

murrkit projects live ENTIRELY inside `projects/<name>/`. No dependence on
an external project hub, no scanning of foreign Asset directories. Creating a project
just makes the folder; the gen-queue + chat history attach to it via name.
"""

from __future__ import annotations

import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.config import PROJECT_ROOT, PROJECTS_DIR

router = APIRouter(prefix="/api/projects", tags=["projects"])

# Subfolders we create when scaffolding a new project.
_DEFAULT_SUBDIRS = (
    "sprites",
    "backgrounds",
    "tilesets",
    "ui",
    "audio",
    "levels",
    "references",
)
_IGNORE_SUFFIXES = (".meta", ".tmp", ".bak")
_IGNORE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
_IGNORE_PATTERNS = (".original.png",)

# Canonical project-name rule: starts with a letter, then [A-Za-z0-9_-], 1-64 chars.
# Shared by create + rename so both reject the same set of names.
_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}")
# Subdirs that count as "where the work happens" for the last-touched mtime.
_MTIME_SUBDIRS = ("levels", "sprites")


def _project_mtime(proj_dir: Path) -> float:
    """Last-touched epoch seconds: max mtime of the dir + its level/sprite subdirs.

    Newly-generated assets land in `sprites/` / `levels/`, but writing a file
    inside a subdir doesn't always bump the parent dir's own mtime — so we take
    the max across the project root and those work subdirs.
    """
    mtimes = [proj_dir.stat().st_mtime]
    for sub in _MTIME_SUBDIRS:
        d = proj_dir / sub
        if d.is_dir():
            mtimes.append(d.stat().st_mtime)
    return max(mtimes)


def _flatten_project_files(proj_dir: Path) -> list[str]:
    """Return relative paths of every non-ignored file under `proj_dir`."""
    if not proj_dir.is_dir():
        return []
    out: list[str] = []
    for f in proj_dir.rglob("*"):
        if not f.is_file():
            continue
        if f.name in _IGNORE_NAMES:
            continue
        if f.suffix.lower() in _IGNORE_SUFFIXES:
            continue
        nl = f.name.lower()
        if any(nl.endswith(suf) for suf in _IGNORE_PATTERNS):
            continue
        out.append(f.relative_to(proj_dir).as_posix())
    return out


class ProjectInfo(BaseModel):
    name: str
    path: str
    files: list[str]
    # "Last touched" epoch seconds — max mtime of the dir + its level/sprite
    # subdirs. Lets the gallery sort by most-recently-edited.
    mtime: float
    # Non-ignored file count (same set as `files`) — cheap "how much is here".
    asset_count: int


def _project_info(proj_dir: Path) -> ProjectInfo:
    files = _flatten_project_files(proj_dir)
    return ProjectInfo(
        name=proj_dir.name,
        path=str(proj_dir),
        files=files,
        mtime=_project_mtime(proj_dir),
        asset_count=len(files),
    )


@router.get("", response_model=list[ProjectInfo])
async def list_projects() -> list[ProjectInfo]:
    """List every murrkit project that's been scaffolded under `projects/`."""
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    out: list[ProjectInfo] = []
    for p in sorted(PROJECTS_DIR.iterdir()):
        if not p.is_dir():
            continue
        if p.name.startswith("_") or p.name.startswith("."):
            continue
        out.append(_project_info(p))
    return out


@router.get("/{name}", response_model=ProjectInfo)
async def get_project(name: str) -> ProjectInfo:
    """Get a specific murrkit project by name."""
    proj_dir = PROJECTS_DIR / name
    if not proj_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Project '{name}' not found.")
    return _project_info(proj_dir)


@router.post("/{name}")
async def create_project(name: str) -> dict:
    """Create a new murrkit project with the canonical subfolder layout."""
    # Sanitize name: only [a-zA-Z0-9_-], 1-64 chars, not starting with _ or .
    if not _NAME_RE.fullmatch(name):
        raise HTTPException(
            status_code=400,
            detail=(
                "project name must be 1-64 chars, start with a letter, and "
                "use only letters/digits/underscore/hyphen"
            ),
        )
    proj_dir = PROJECTS_DIR / name
    if proj_dir.exists():
        raise HTTPException(status_code=409, detail=f"Project '{name}' already exists.")
    proj_dir.mkdir(parents=True, exist_ok=True)
    for sub in _DEFAULT_SUBDIRS:
        (proj_dir / sub).mkdir(parents=True, exist_ok=True)
    # Stamp a tiny manifest so we can tell our scaffold apart from a random folder later.
    manifest = proj_dir / "project.json"
    manifest.write_text(
        '{\n'
        f'  "name": "{name}",\n'
        '  "engine": "phaser3",\n'
        '  "language": "typescript",\n'
        f'  "created_at": "{datetime.now(timezone.utc).isoformat()}"\n'
        '}\n',
        encoding="utf-8",
    )
    return {"status": "created", "path": str(proj_dir)}


@router.put("/{old_name}/{new_name}")
async def rename_project(old_name: str, new_name: str) -> dict:
    """Rename a project directory: `projects/<old>` → `projects/<new>`.

    Validates `new_name` against the same rule as create. 404 if `old_name`
    doesn't exist, 409 if `new_name` is already taken.
    """
    if not _NAME_RE.fullmatch(new_name):
        raise HTTPException(
            status_code=400,
            detail=(
                "project name must be 1-64 chars, start with a letter, and "
                "use only letters/digits/underscore/hyphen"
            ),
        )
    old_dir = PROJECTS_DIR / old_name
    if not old_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Project '{old_name}' not found.")
    new_dir = PROJECTS_DIR / new_name
    # `exists()` (not `is_dir()`) so a stray file at the target also blocks.
    # Skip the check when only the case changed (Windows FS is case-insensitive,
    # so `game` → `Game` collides with itself but is a legal rename).
    if new_dir.exists() and old_dir.resolve() != new_dir.resolve():
        raise HTTPException(status_code=409, detail=f"Project '{new_name}' already exists.")
    # shutil.move handles cross-arrangement edge cases; both paths are on the
    # same volume here so it's an atomic os.rename on Windows/POSIX alike.
    shutil.move(str(old_dir), str(new_dir))
    return {"status": "renamed", "old": old_name, "new": new_name, "path": str(new_dir)}


@router.delete("/{name}")
async def delete_project(name: str) -> dict:
    """Delete a murrkit project directory (irreversible)."""
    proj_dir = PROJECTS_DIR / name
    if not proj_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Project '{name}' not found.")
    shutil.rmtree(proj_dir)
    return {"status": "deleted", "name": name}
