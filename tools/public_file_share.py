"""
Public file share — stage local files at a public URL for GPT-Image-2 edits.

The GPT-Image-2-edit endpoint requires PUBLIC HTTP URLs for input images
(RunPod presigned S3 URLs are rejected). This module provides a simple staging
mechanism using the backend's own static file server or an ngrok/cloudflared tunnel.

Usage:
    from tools.public_file_share import stage_file

    public_url = stage_file(Path("local_sprite.png"))
    # → "https://your-tunnel.example.com/files/local_sprite.png"
"""

from __future__ import annotations

import shutil
from pathlib import Path

from loguru import logger


def stage_file(file_path: Path | str) -> str:
    """
    Stage a local file at a publicly accessible URL.

    Reads PUBLIC_BACKEND_URL from settings. If not configured, falls back
    to a simple localhost URL (Kitty App may reject non-public URLs).

    Strategy:
        1. Copy file to PROJECT_ROOT/public_files/<filename>
        2. Return {PUBLIC_BACKEND_URL}/files/<filename>

    The backend serves /files/* as static files (configured in backend/main.py).

    Args:
        file_path: Local file to stage.

    Returns:
        Public URL string.

    Raises:
        FileNotFoundError if file_path doesn't exist.
    """
    from core.config import PROJECT_ROOT, settings

    file_path = Path(file_path)
    if not file_path.is_file():
        raise FileNotFoundError(f"Cannot stage file — not found: {file_path}")

    pub_dir = PROJECT_ROOT / "public_files"
    pub_dir.mkdir(parents=True, exist_ok=True)

    dest = pub_dir / file_path.name
    shutil.copy2(file_path, dest)

    base = settings.public_backend_url.rstrip("/")
    if not base:
        base = f"http://localhost:{settings.backend_port}"
        logger.warning(
            "PUBLIC_BACKEND_URL not set — using localhost URL (Kitty App may reject non-public URLs): {url}",
            url=base,
        )

    url = f"{base}/files/{file_path.name}"
    logger.debug("Staged {f} -> {url}", f=file_path.name, url=url)
    return url


def clean_staged_files(older_than_hours: float = 24.0) -> int:
    """
    Remove staged files older than `older_than_hours` hours.

    Returns:
        Number of files removed.
    """
    import time
    from core.config import PROJECT_ROOT

    pub_dir = PROJECT_ROOT / "public_files"
    if not pub_dir.exists():
        return 0

    cutoff = time.time() - older_than_hours * 3600
    removed = 0
    for f in pub_dir.iterdir():
        if f.is_file() and f.stat().st_mtime < cutoff:
            f.unlink()
            removed += 1

    if removed:
        logger.info("Cleaned {n} stale staged files.", n=removed)
    return removed
