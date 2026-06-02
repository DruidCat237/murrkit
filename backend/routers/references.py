"""
References router — user-facing reference materials per project.

Concept
-------
Inner Claude can't read the user's mind. When the user uploads a real
Angry Birds screenshot, a gameplay clip, a mood-board, or a hand-drawn
sketch, it should be:
  1. Stored in a known canonical location per project
  2. Visible in a frontend tab with thumbnails
  3. Auto-injected into the chat router system prompt so inner Claude
     knows the paths and can call /api/vision/review or Read them
  4. For videos: keyframes auto-extracted for vision analysis

Storage: `<PROJECT_ROOT>/.omc/references/<project>/` — separate from
engine assets (no reimport churn) and from legacy scratch libraries.

Endpoints:
    GET    /api/references/list?project=X
    POST   /api/references/upload?project=X     (multipart file)
    GET    /api/references/file?project=X&name=Y  (serve file)
    DELETE /api/references/file?project=X&name=Y
    GET    /api/references/keyframes?project=X&video=Y  (list extracted frames)
    POST   /api/references/extract-keyframes?project=X&video=Y
"""

from __future__ import annotations

import asyncio
import mimetypes
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from loguru import logger

from core.config import PROJECT_ROOT

router = APIRouter(prefix="/api/references", tags=["references"])

# Root for all reference materials, project-scoped
_ROOT = PROJECT_ROOT / ".omc" / "references"

# Files >50MB rejected — keeps the folder reasonable for inner Claude scans
_MAX_FILE_BYTES = 50 * 1024 * 1024

# Image / video extensions Claude can meaningfully consume
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
_VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
_DOC_EXT = {".txt", ".md", ".pdf", ".json", ".yaml", ".yml"}


def _project_dir(project: str) -> Path:
    """Sanitize project name and return its references dir, ensure exists."""
    safe = "".join(c for c in project if c.isalnum() or c in "_-").strip("_-")
    if not safe:
        raise HTTPException(status_code=400, detail="invalid project name")
    d = _ROOT / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def _categorize(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in _IMAGE_EXT:
        return "image"
    if ext in _VIDEO_EXT:
        return "video"
    if ext in _DOC_EXT:
        return "document"
    return "other"


def _safe_filename(name: str) -> str:
    """Strip path components, allow alphanumerics + a few common separators."""
    name = Path(name).name  # drop any directory parts
    keep = "._- ()[]"
    cleaned = "".join(c for c in name if c.isalnum() or c in keep).strip()
    return cleaned or f"upload_{int(time.time())}"


# ---- LIST ------------------------------------------------------------------


@router.get("/list")
async def list_refs(project: str = "default") -> dict[str, Any]:
    """List all reference files for a project with metadata."""
    d = _project_dir(project)
    entries: list[dict[str, Any]] = []
    for p in sorted(d.iterdir(), key=lambda x: -x.stat().st_mtime):
        if p.is_dir():
            # Could be a video's keyframes folder — show as collection
            kf_dir = p
            if kf_dir.name.endswith(".keyframes"):
                continue  # hide derived keyframe folders from main list
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        category = _categorize(p.name)
        mime, _ = mimetypes.guess_type(str(p))
        entry = {
            "name": p.name,
            "category": category,
            "size_bytes": st.st_size,
            "modified_at": st.st_mtime,
            "mime_type": mime or "application/octet-stream",
            "served_url": f"/api/references/file?project={project}&name={p.name}",
            "abs_path": str(p.resolve()),
        }
        # If video, check for extracted keyframes
        if category == "video":
            kf_dir = d / f"{p.name}.keyframes"
            if kf_dir.is_dir():
                frames = sorted(kf_dir.glob("frame_*.jpg"))
                entry["keyframe_count"] = len(frames)
                entry["keyframe_paths"] = [str(f.resolve()) for f in frames]
        entries.append(entry)
    return {
        "project": project,
        "root": str(d.resolve()),
        "total": len(entries),
        "entries": entries,
    }


# ---- UPLOAD ----------------------------------------------------------------


@router.post("/upload")
async def upload_ref(
    project: str = "default",
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """Accept a single file upload, save to project's references folder."""
    d = _project_dir(project)
    fname = _safe_filename(file.filename or "upload")
    dest = d / fname
    # Collision: append timestamp suffix
    if dest.exists():
        stem, suf = dest.stem, dest.suffix
        dest = d / f"{stem}_{int(time.time())}{suf}"
    total = 0
    try:
        with dest.open("wb") as out:
            while chunk := await file.read(1024 * 1024):  # 1 MiB chunks
                total += len(chunk)
                if total > _MAX_FILE_BYTES:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"file too large (>{_MAX_FILE_BYTES // (1024 * 1024)} MB)",
                    )
                out.write(chunk)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"upload failed: {e}") from None

    category = _categorize(dest.name)
    result = {
        "ok": True,
        "name": dest.name,
        "category": category,
        "size_bytes": total,
        "abs_path": str(dest.resolve()),
        "served_url": f"/api/references/file?project={project}&name={dest.name}",
    }

    # Auto-extract keyframes for videos (best effort, async)
    if category == "video":
        asyncio.create_task(_extract_keyframes_bg(project, dest.name))
        result["keyframe_extraction"] = "scheduled"

    logger.info(
        "reference uploaded: project={p} name={n} size={s} category={c}",
        p=project, n=dest.name, s=total, c=category,
    )
    return result


# ---- SERVE FILE ------------------------------------------------------------


@router.get("/file")
async def serve_ref(project: str = "default", name: str = "") -> FileResponse:
    if not name:
        raise HTTPException(status_code=400, detail="missing 'name' query param")
    d = _project_dir(project)
    safe = _safe_filename(name)
    p = d / safe
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"reference not found: {safe}")
    mime, _ = mimetypes.guess_type(str(p))
    return FileResponse(path=p, media_type=mime or "application/octet-stream")


# ---- DELETE ----------------------------------------------------------------


@router.delete("/file")
async def delete_ref(project: str = "default", name: str = "") -> dict[str, Any]:
    if not name:
        raise HTTPException(status_code=400, detail="missing 'name' query param")
    d = _project_dir(project)
    safe = _safe_filename(name)
    p = d / safe
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"reference not found: {safe}")
    p.unlink()
    # Also clean up keyframes folder if exists
    kf_dir = d / f"{safe}.keyframes"
    if kf_dir.is_dir():
        shutil.rmtree(kf_dir, ignore_errors=True)
    logger.info("reference deleted: project={p} name={n}", p=project, n=safe)
    return {"ok": True, "name": safe}


# ---- VIDEO KEYFRAMES -------------------------------------------------------


def _find_ffmpeg() -> str | None:
    """Locate ffmpeg — prefer system PATH, fall back to imageio_ffmpeg bundle."""
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg  # type: ignore[import]
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None


async def _extract_keyframes_bg(project: str, video_name: str) -> None:
    """Background task: extract 1 fps JPG keyframes for vision analysis."""
    try:
        d = _project_dir(project)
        video_path = d / video_name
        if not video_path.is_file():
            return
        kf_dir = d / f"{video_name}.keyframes"
        kf_dir.mkdir(exist_ok=True)
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            logger.warning("ffmpeg not found — skip keyframes for {n}", n=video_name)
            return
        # 1 fps, max width 960, quality 3 (good for vision LLM)
        cmd = [
            ffmpeg, "-y", "-i", str(video_path),
            "-vf", "fps=1,scale=960:-1",
            "-q:v", "3",
            str(kf_dir / "frame_%03d.jpg"),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.warning(
                "keyframe extraction failed for {n}: rc={rc} err={e}",
                n=video_name, rc=proc.returncode,
                e=stderr.decode("utf-8", errors="replace")[:300],
            )
            return
        frames = sorted(kf_dir.glob("frame_*.jpg"))
        logger.info(
            "extracted {c} keyframes for {n} in project {p}",
            c=len(frames), n=video_name, p=project,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("keyframe extraction crashed for {n}: {e}", n=video_name, e=e)


@router.post("/open-folder")
async def open_folder_in_os(project: str = "default") -> dict[str, Any]:
    """Open the project's references folder in the OS file explorer.

    Convenience for users who want to copy-paste files in bulk, edit
    metadata, or just inspect what's there without scrolling the panel.
    Best-effort — does NOT block waiting for the OS process to exit.
    """
    import platform
    d = _project_dir(project)
    system = platform.system()
    try:
        if system == "Windows":
            # Use the explicit path; explorer accepts native backslashes.
            subprocess.Popen(["explorer.exe", str(d)])
        elif system == "Darwin":
            subprocess.Popen(["open", str(d)])
        else:
            subprocess.Popen(["xdg-open", str(d)])
        return {"ok": True, "path": str(d), "system": system}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"open failed: {e}") from None


@router.post("/extract-keyframes")
async def trigger_keyframes(project: str = "default", video: str = "") -> dict[str, Any]:
    """Manually re-extract keyframes for an existing video reference."""
    if not video:
        raise HTTPException(status_code=400, detail="missing 'video' query param")
    d = _project_dir(project)
    safe = _safe_filename(video)
    if not (d / safe).is_file():
        raise HTTPException(status_code=404, detail=f"video not found: {safe}")
    asyncio.create_task(_extract_keyframes_bg(project, safe))
    return {"ok": True, "scheduled": safe}


@router.get("/keyframes")
async def list_keyframes(project: str = "default", video: str = "") -> dict[str, Any]:
    """List extracted keyframe paths for a video reference."""
    if not video:
        raise HTTPException(status_code=400, detail="missing 'video' query param")
    d = _project_dir(project)
    safe = _safe_filename(video)
    kf_dir = d / f"{safe}.keyframes"
    if not kf_dir.is_dir():
        return {"project": project, "video": safe, "count": 0, "frames": []}
    frames = sorted(kf_dir.glob("frame_*.jpg"))
    return {
        "project": project,
        "video": safe,
        "count": len(frames),
        "frames": [str(f.resolve()) for f in frames],
        "frame_urls": [
            f"/api/references/keyframe-file?project={project}&video={safe}&frame={f.name}"
            for f in frames
        ],
    }


@router.get("/keyframe-file")
async def serve_keyframe(
    project: str = "default",
    video: str = "",
    frame: str = "",
) -> FileResponse:
    """Serve a single extracted keyframe image."""
    d = _project_dir(project)
    safe_v = _safe_filename(video)
    safe_f = _safe_filename(frame)
    p = d / f"{safe_v}.keyframes" / safe_f
    if not p.is_file():
        raise HTTPException(status_code=404, detail="keyframe not found")
    return FileResponse(path=p, media_type="image/jpeg")


# ---- Helper for chat router: summary string ready to inject into system prompt


def system_prompt_snippet(project: str) -> str:
    """Build a short snippet describing what references are available.

    Called by chat router's prompt builder so inner Claude knows what
    user-supplied materials exist before he starts working.

    Returns empty string if no references exist (zero overhead).
    """
    try:
        d = _project_dir(project)
    except HTTPException:
        return ""
    files = [p for p in d.iterdir() if p.is_file()]
    if not files:
        return ""

    lines: list[str] = [
        "",
        "## USER REFERENCE MATERIALS",
        "",
        f"The user has uploaded {len(files)} reference file(s) for this project.",
        f"Storage root: {d.resolve()}",
        "Browse them and use as ground-truth for design decisions. For images,",
        "pass paths to POST /api/vision/review for compare-to-reference analysis.",
        "For videos, use the auto-extracted keyframes (path: <video>.keyframes/frame_NNN.jpg).",
        "",
        "Files:",
    ]
    for p in sorted(files, key=lambda x: x.name):
        category = _categorize(p.name)
        size_kb = p.stat().st_size // 1024
        line = f"  - [{category}] {p.resolve()} ({size_kb} KB)"
        if category == "video":
            kf_dir = d / f"{p.name}.keyframes"
            if kf_dir.is_dir():
                kf_count = len(list(kf_dir.glob("frame_*.jpg")))
                line += f"  (keyframes: {kf_count} extracted)"
        lines.append(line)
    lines.append("")
    return "\n".join(lines)
