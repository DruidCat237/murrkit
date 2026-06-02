"""
Background removal wrapper using rembg (multiple high-quality models).

Models available (downloaded on first use):
  - isnet-anime        ← DEFAULT for character/cartoon sprites (cute_chibi cats etc).
                         Tuned on anime/cartoon art — keeps white fur, soft edges.
  - birefnet-general   ← Photoroom-grade SOTA for general subjects (backgrounds,
                         tilesets). Slower (~3 s/image), highest fidelity edges.
  - birefnet-general-lite Lighter / faster variant of BiRefNet.
  - u2net              ← Old default. Generic; OK fallback, struggles on white
                         characters because it confuses subject with background.
  - bria-rmbg          ← Strong general-purpose alternative.

Install: `uv add onnxruntime rembg` (CPU). First call downloads ~50–500 MB
depending on model.

Public API:
    remove_background(input, output, *, model="isnet-anime",
                      alpha_matting=True, post_process=True) -> Path
    remove_background_batch(pairs, **kwargs) -> list[Path]
    list_models() -> list[str]
    default_model_for(asset_type) -> str

The fallback for when onnxruntime/rembg isn't available is a *flood-fill from
edges* — only border-connected white pixels become transparent, so white cat
fur in the middle of the image survives. The previous threshold-based fallback
ate the cats. Don't bring it back.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from loguru import logger

# Cache the rembg `session` object per model so we don't re-create / re-download
# on every call. Module-level state is fine here — rembg sessions are thread-safe.
_session_cache: dict[str, object] = {}


def list_models() -> list[str]:
    """All model names rembg knows about."""
    from rembg.sessions import sessions_class

    return [s.name() for s in sessions_class]


def default_model_for(asset_type: str) -> str:
    """Pick the best model for the asset role.

    Empirical observations on gpt-image-2 output (see tools/bg_compare.py):
      - `birefnet-general` preserves decorative elements (stars, hearts, sparkles,
        speech bubbles) that surround a character. Best for cute_chibi with
        win-celebration props. Slower (~50 s/image first run, ~5 s warmed).
      - `isnet-anime` is tighter — strips anything that isn't the main subject.
        Useful when you want JUST the character silhouette without decoration.
      - `u2net` is the old default; it confuses white characters with white
        background. Don't use for white characters.

    Default to `birefnet-general` because most of our character gens want
    the decorations preserved. Override per-call by passing `model=`.
    """
    t = asset_type.lower()
    if t in {"sprite_silhouette", "icon_strict", "tight"}:
        return "isnet-anime"
    # Default for everything else — including character sprites with deco,
    # backgrounds, tilesets, UI elements.
    return "birefnet-general"


def _get_session(model: str) -> object:
    """Get or create a cached rembg session for the given model."""
    if model in _session_cache:
        return _session_cache[model]
    from rembg import new_session

    logger.info("rembg: creating session for model={m} (first use downloads weights)", m=model)
    sess = new_session(model)
    _session_cache[model] = sess
    return sess


def remove_background(
    input_path: Path | str,
    output_path: Path | str,
    *,
    model: str = "isnet-anime",
    alpha_matting: bool = True,
    alpha_matting_foreground_threshold: int = 240,
    alpha_matting_background_threshold: int = 10,
    alpha_matting_erode_size: int = 10,
    post_process: bool = True,
) -> Path:
    """Remove background from one image.

    Args:
        input_path:   Source PNG / JPG.
        output_path:  Destination RGBA PNG.
        model:        Rembg model name. See `list_models()`. Default
                      `isnet-anime` — best for our generated cartoon cats.
        alpha_matting: Enable trimap-style alpha matting for soft edges
                       (hair, fur). On by default — the failure mode the
                       user pointed out (white fur eaten) is what this fixes.
        alpha_matting_foreground_threshold, alpha_matting_background_threshold,
        alpha_matting_erode_size: Standard rembg alpha-matting knobs.
        post_process: Mask post-processing toggle.

    Returns:
        output_path as Path.
    """
    from PIL import Image

    input_path = Path(input_path)
    output_path = Path(output_path)

    if not input_path.is_file():
        raise FileNotFoundError(f"rembg input not found: {input_path}")

    try:
        from rembg import remove  # type: ignore[import]

        session = _get_session(model)
        logger.info(
            "rembg: model={m} alpha_matting={am} → {p}",
            m=model, am=alpha_matting, p=input_path.name,
        )
        with Image.open(input_path) as img:
            result: Image.Image = remove(
                img,
                session=session,
                alpha_matting=alpha_matting,
                alpha_matting_foreground_threshold=alpha_matting_foreground_threshold,
                alpha_matting_background_threshold=alpha_matting_background_threshold,
                alpha_matting_erode_size=alpha_matting_erode_size,
                post_process_mask=post_process,
            )
    except (ImportError, SystemExit, OSError) as e:
        logger.warning(
            "rembg unavailable ({err}) — falling back to edge-flood-fill "
            "(NOT the destructive threshold fallback that ate white cats).",
            err=type(e).__name__,
        )
        result = _edge_flood_fallback(input_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(str(output_path), "PNG")
    logger.info("rembg: wrote {p} ({k} KB)", p=output_path.name, k=output_path.stat().st_size // 1024)
    return output_path


def _edge_flood_fallback(input_path: Path) -> "Image.Image":  # noqa: F821
    """Flood-fill near-white pixels FROM THE EDGES of the image only.

    Why edge-flood instead of global threshold: gpt-image-2 output has white
    background AROUND the character, but the character itself may also have
    white pixels (white cat fur, sparkles, eyes). A global threshold strips
    all white pixels and eats the character. Edge-flood walks inward from
    the borders and only marks the contiguous outer-white region as
    transparent — interior white survives.

    Crude vs rembg-isnet-anime but never destructive.
    """
    from collections import deque
    from PIL import Image

    img = Image.open(input_path).convert("RGBA")
    w, h = img.size
    pixels = img.load()
    if pixels is None:
        return img

    def is_bg(rgb: tuple[int, int, int, int]) -> bool:
        r, g, b, _ = rgb
        # Near-white, with a small tolerance for JPEG / dithering noise.
        return r >= 240 and g >= 240 and b >= 240

    # Seed: every border pixel that's near-white.
    visited = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bg(pixels[x, y]):
                idx = y * w + x
                if not visited[idx]:
                    visited[idx] = 1
                    q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(pixels[x, y]):
                idx = y * w + x
                if not visited[idx]:
                    visited[idx] = 1
                    q.append((x, y))

    # 4-connected flood fill — only the contiguous border-touching white
    # region becomes transparent.
    while q:
        x, y = q.popleft()
        r, g, b, _ = pixels[x, y]
        pixels[x, y] = (r, g, b, 0)
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                idx = ny * w + nx
                if not visited[idx] and is_bg(pixels[nx, ny]):
                    visited[idx] = 1
                    q.append((nx, ny))

    return img


def remove_background_batch(
    pairs: Iterable[tuple[Path | str, Path | str]],
    *,
    model: str = "isnet-anime",
    **kwargs: object,
) -> list[Path]:
    """Batch helper. Reuses one session across all calls."""
    results: list[Path] = []
    for src, dst in pairs:
        results.append(remove_background(src, dst, model=model, **kwargs))
    return results
