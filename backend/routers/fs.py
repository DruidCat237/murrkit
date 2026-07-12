"""
File-system helper router — open project files in the OS editor on click.

Why this exists
---------------
Chat messages constantly reference files the inner Claude wrote — most
importantly `.omc/state/<project>/design.md` (the Game Design Doc). The
user wants those paths to be CLICKABLE in the dashboard and open instantly
in Notepad, instead of hunting through Explorer. The frontend renders any
file-path-looking inline code as a clickable chip and calls this endpoint.

Safety
------
This opens local files on the user's machine, so it MUST NOT become an
arbitrary-file launcher. Every request path is resolved and verified to
live INSIDE the project root (`PROJECT_ROOT`); anything that escapes via
`..` / absolute paths / symlinks is rejected with 403. The backend only
listens on localhost.

Endpoints:
    POST /api/fs/open   {"path": "...", "reveal": false}
        reveal=false → open the file in the editor (Notepad for text on Windows)
        reveal=true  → highlight the file in the OS file manager instead

    GET  /api/fs/tree?root=phaser_game
        Recursive JSON tree of source dirs+files under `root` (repo-relative),
        for the dashboard's in-app code editor. Excludes node_modules / build
        output / binary assets.
    GET  /api/fs/read?path=phaser_game/vite.config.ts
        UTF-8 text contents of a source file (rejects binary / >2MB / outside repo).
    POST /api/fs/write  {"path": "...", "content": "..."}
        Write a source file (path-guarded; creates parent dirs; refuses
        node_modules / build / .git destinations).
"""

from __future__ import annotations

import os
import platform
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel

from core.config import PROJECT_ROOT

router = APIRouter(prefix="/api/fs", tags=["fs"])

# Plain-text-ish files we force into Notepad on Windows (readable/editable as text).
# Anything else (e.g. .png, .mp4) falls back to the OS default app via os.startfile.
_TEXT_EXTS = {
    ".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".log", ".env",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".css", ".scss",
    ".html", ".htm", ".xml", ".toml", ".ini", ".cfg", ".sh", ".bat", ".ps1",
}

# Extensions that would EXECUTE (not just display) under their default Windows
# handler. `os.startfile` on these is remote-code-execution the moment a
# malicious project drops one in — so /api/fs/open reveals them in Explorer
# instead of launching them. (Text ones like .bat/.ps1 already route to notepad
# via _TEXT_EXTS above; this list is the belt-and-braces for the startfile arm.)
_UNSAFE_OPEN_EXTS = {
    ".exe", ".com", ".scr", ".pif", ".msi", ".msp", ".cpl", ".hta",
    ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse",
    ".wsf", ".wsh", ".lnk", ".reg", ".jar", ".gadget", ".application",
}


# Source files surfaced by the in-app code editor tree/read. Anything not in
# this set (binary assets like .png/.jpg/.mp3/.ttf, lockfiles' siblings, etc.)
# is omitted from the tree and rejected by /read.
_SOURCE_EXTS = {
    ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml",
    ".css", ".html", ".md", ".py",
}

# Directories never descended into / never written to. Keeps the tree focused
# on editable game source and keeps writes out of generated / vendored trees.
_EXCLUDED_DIRS = {
    "node_modules", ".next", "dist", ".git", "__pycache__", ".venv",
    ".turbo", "build", ".cache", "coverage", "test-results",
    "playwright-report", ".captures",
}

# Hard ceiling for a single text read/write so the editor never tries to slurp
# a multi-megabyte file into the browser.
_MAX_TEXT_BYTES = 2 * 1024 * 1024  # 2MB


class OpenRequest(BaseModel):
    path: str
    reveal: bool = False


class WriteRequest(BaseModel):
    path: str
    content: str


def _resolve_within_repo(raw: str) -> Path:
    """Resolve `raw` (absolute or repo-relative) and ensure it stays inside PROJECT_ROOT.

    Raises HTTPException(403) on any path that escapes the project root.
    """
    cleaned = (raw or "").strip().strip('"').strip("'")
    if not cleaned:
        raise HTTPException(status_code=400, detail="empty path")
    p = Path(cleaned)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    try:
        resolved = p.resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"bad path: {e}") from None
    root = PROJECT_ROOT.resolve()
    # Path-traversal guard: resolved must equal or live under the repo root.
    # is_relative_to() returns True for the root itself too.
    if not resolved.is_relative_to(root):
        raise HTTPException(status_code=403, detail="path is outside the project root")
    return resolved


@router.post("/open")
async def open_path(req: OpenRequest) -> dict[str, Any]:
    """Open a project file in the OS editor (Notepad for text on Windows)."""
    resolved = _resolve_within_repo(req.path)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"not found: {resolved}")

    system = platform.system()
    try:
        if req.reveal:
            if system == "Windows":
                if resolved.is_dir():
                    subprocess.Popen(["explorer.exe", str(resolved)])
                else:
                    # /select, highlights the file within its folder.
                    subprocess.Popen(["explorer.exe", "/select,", str(resolved)])
            elif system == "Darwin":
                subprocess.Popen(["open", "-R", str(resolved)])
            else:
                subprocess.Popen(["xdg-open", str(resolved if resolved.is_dir() else resolved.parent)])
            return {"ok": True, "path": str(resolved), "action": "reveal", "system": system}

        ext = resolved.suffix.lower()
        if system == "Windows":
            if resolved.is_dir():
                # explorer.exe <dir> reliably opens (and foregrounds) the folder.
                # os.startfile on a directory often returns OK without bringing a
                # window up, which read as "Open folder does nothing".
                subprocess.Popen(["explorer.exe", str(resolved)])
            elif resolved.is_file() and ext in _TEXT_EXTS:
                subprocess.Popen(["notepad.exe", str(resolved)])
            elif resolved.is_file() and ext in _UNSAFE_OPEN_EXTS:
                # Never launch an executable/script with its default handler —
                # a malicious project file would run code. Reveal it instead.
                subprocess.Popen(["explorer.exe", "/select,", str(resolved)])
                return {
                    "ok": True, "path": str(resolved),
                    "action": "reveal", "system": system,
                    "note": f"{ext} is executable — revealed in Explorer instead of opened.",
                }
            else:
                os.startfile(str(resolved))  # type: ignore[attr-defined]  # noqa: S606  (Windows-only)
        elif system == "Darwin":
            subprocess.Popen(["open", str(resolved)])
        else:
            subprocess.Popen(["xdg-open", str(resolved)])
        return {"ok": True, "path": str(resolved), "action": "open", "system": system}
    except Exception as e:  # noqa: BLE001
        logger.exception("fs.open failed for {p}: {e}", p=resolved, e=e)
        raise HTTPException(status_code=500, detail=f"open failed: {e}") from None


# ---- In-app code editor: tree / read / write -------------------------------
#
# These power the dashboard "Code" tab (a Cursor-like editor over the real
# Phaser game source). Every path is funnelled through `_resolve_within_repo`
# so nothing can read or write outside PROJECT_ROOT.


def _rel_to_repo(p: Path) -> str:
    """Repo-relative POSIX path for a resolved path inside PROJECT_ROOT."""
    return p.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()


def _excluded_path(resolved: Path) -> bool:
    """True if any component of the repo-relative path is an excluded dir."""
    rel = _rel_to_repo(resolved)
    return any(part in _EXCLUDED_DIRS for part in rel.split("/"))


def _build_tree(directory: Path) -> dict[str, Any]:
    """Recursively build {name, path, type, children?} for `directory`.

    Dirs in `_EXCLUDED_DIRS` are skipped entirely; files are included only when
    their extension is in `_SOURCE_EXTS`. Empty dirs (no source descendants)
    are pruned so the tree stays readable. Hidden dot-dirs other than the few
    we whitelist implicitly are skipped via the excluded set / dotfile rule.
    """
    children: list[dict[str, Any]] = []
    try:
        entries = sorted(
            directory.iterdir(),
            key=lambda e: (e.is_file(), e.name.lower()),
        )
    except (PermissionError, OSError):
        return {
            "name": directory.name,
            "path": _rel_to_repo(directory),
            "type": "dir",
            "children": [],
        }

    for entry in entries:
        name = entry.name
        if entry.is_dir():
            if name in _EXCLUDED_DIRS or name.startswith("."):
                continue
            subtree = _build_tree(entry)
            # Prune empty dirs so the editor isn't full of dead folders.
            if subtree.get("children"):
                children.append(subtree)
        elif entry.is_file():
            if entry.suffix.lower() in _SOURCE_EXTS:
                children.append({
                    "name": name,
                    "path": _rel_to_repo(entry),
                    "type": "file",
                })

    return {
        "name": directory.name,
        "path": _rel_to_repo(directory),
        "type": "dir",
        "children": children,
    }


@router.get("/tree")
async def fs_tree(root: str = "phaser_game") -> dict[str, Any]:
    """Recursive source-file tree under `root` (repo-relative). Default: phaser_game."""
    resolved = _resolve_within_repo(root)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"root not found: {root}")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"root is not a directory: {root}")
    return _build_tree(resolved)


@router.get("/read")
async def fs_read(path: str) -> dict[str, Any]:
    """Return UTF-8 text of a source file. Rejects binary / oversized / non-source."""
    resolved = _resolve_within_repo(path)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"not found: {path}")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail=f"not a file: {path}")
    if _excluded_path(resolved):
        raise HTTPException(status_code=403, detail="path is in an excluded directory")
    if resolved.suffix.lower() not in _SOURCE_EXTS:
        raise HTTPException(status_code=415, detail=f"unsupported file type: {resolved.suffix}")
    size = resolved.stat().st_size
    if size > _MAX_TEXT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large: {size} bytes (max {_MAX_TEXT_BYTES})",
        )
    try:
        content = resolved.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail="file is not valid UTF-8 text") from None
    return {"path": _rel_to_repo(resolved), "content": content}


@router.post("/write")
async def fs_write(req: WriteRequest) -> dict[str, Any]:
    """Write a source file (path-guarded; creates parent dirs)."""
    resolved = _resolve_within_repo(req.path)
    if _excluded_path(resolved):
        raise HTTPException(status_code=403, detail="refusing to write into an excluded directory")
    if resolved.exists() and resolved.is_dir():
        raise HTTPException(status_code=400, detail="path is a directory")
    if resolved.suffix.lower() not in _SOURCE_EXTS:
        raise HTTPException(status_code=415, detail=f"unsupported file type: {resolved.suffix}")
    if len(req.content.encode("utf-8")) > _MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="content too large")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(req.content, encoding="utf-8", newline="")
    written = resolved.stat().st_size
    logger.info("fs.write {p} ({n} bytes)", p=_rel_to_repo(resolved), n=written)
    return {"ok": True, "path": _rel_to_repo(resolved), "bytes": written}
