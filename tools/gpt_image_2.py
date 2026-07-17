"""GPT-Image-2 client — submit + poll via the Kitty AI Studio WordPress backend.

Internally this module is now a thin facade over `tools/kitty_api.py`, which
talks to `https://druidcat.com/wp-json/kitty-app/v1/` (the same backend the
production Kitty AI Studio app uses). The legacy direct flow has been removed — everything goes through the Kitty App
WordPress backend at druidcat.com.

Public symbols preserved for backward compatibility:
    submit_generate, submit_edit, wait_for_completion, extract_result_url,
    poll_until_done, download_result, ALLOWED_SIZES, ALLOWED_QUALITY,
    ALLOWED_RESOLUTION.

Notes:
- `task_id` returned by submit_* is the Kitty `jobId`.
- Aspect ratios are passed to the Kitty backend as `aspect_ratio` (the GPT
  Image 2 workflow's own param name); the legacy `size` arg here is mapped 1:1.
- Reference images for `submit_edit` should be PUBLIC HTTP URLs (use
  `tools.kitty_api.upload_file_sync` to host private images via the Kitty
  /media streaming endpoint, which is always public).
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests
from loguru import logger

from tools import kitty_api

# ---------------------------------------------------------------------------
# Public enums — kept stable for callers
# ---------------------------------------------------------------------------

ALLOWED_SIZES = kitty_api.ALLOWED_ASPECT_RATIOS
ALLOWED_QUALITY = kitty_api.ALLOWED_QUALITY
ALLOWED_RESOLUTION = kitty_api.ALLOWED_RESOLUTION


# ---------------------------------------------------------------------------
# Usage tracker hook (best-effort)
# ---------------------------------------------------------------------------


def _record_usage(
    *,
    model: str,
    project: str | None,
    resolution: str,
    quality: str,
    size: str,
    prompt: str,
    task_id: str,
    extra: dict[str, Any] | None = None,
) -> None:
    """Best-effort: record submit to backend.usage_tracker.

    Wrapped in try/except because tools/ must remain importable from
    standalone scripts where the backend isn't loaded.
    """
    try:
        from backend.usage_tracker import tracker
        tracker.record_submit(
            project=project or "_global",
            model=model, resolution=resolution, quality=quality,
            size=size, prompt=prompt, task_id=task_id, extra=extra,
        )
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# Sync submit helpers (legacy public surface)
# ---------------------------------------------------------------------------


def _closest_allowed_aspect(raw: str) -> str:
    """Coerce arbitrary pixel ratios like '256:64' into a Kitty-allowed aspect."""
    try:
        w, h = raw.split(":")
        ratio = float(w) / float(h) if float(h) > 0 else 1.0
    except (ValueError, ZeroDivisionError):
        return "1:1"
    candidates = {
        "21:9": 21 / 9,
        "16:9": 16 / 9,
        "5:4": 5 / 4,
        "4:3": 4 / 3,
        "3:2": 3 / 2,
        "1:1": 1.0,
        "2:3": 2 / 3,
        "3:4": 3 / 4,
        "4:5": 4 / 5,
        "9:16": 9 / 16,
    }
    return min(candidates.items(), key=lambda kv: abs(kv[1] - ratio))[0]


# Approximate rendered pixel dimensions per (aspect_ratio, resolution) tier on
# GPT-Image-2 via Kitty. The backend only accepts NAMED aspects + a resolution
# tier (1K/2K/4K) — it does NOT take raw pixel dims — so for an NxN grid we pick
# the named aspect closest to the grid shape, then the smallest resolution tier
# whose long edge covers the requested target. Long edges are clamped to the
# research cap of 2048 px (square ≤ 2048) and are multiples of 16.
_RESOLUTION_LONG_EDGE = {"1K": 1024, "2K": 1536, "4K": 2048}


def grid_size_request(
    rows: int,
    cols: int,
    *,
    cell_px: int = 256,
) -> tuple[str, str]:
    """Resolve an (aspect_ratio, resolution) request for an NxN sprite grid.

    GPT-Image-2 only accepts named aspect ratios + a resolution tier, not raw
    pixel dimensions. We therefore:
      1. derive the closest named aspect for the cols×rows grid shape, and
      2. choose the smallest resolution tier whose long edge >= the desired
         long edge (cols/rows * cell_px), capped at 2048 px.

    Returns (aspect_ratio, resolution) both already validated against the
    Kitty-allowed sets. Dims are effectively multiples of 16 (all tier long
    edges are) and the square cap is 2048.

    Args:
        rows:    Grid rows (>= 1).
        cols:    Grid columns (>= 1).
        cell_px: Desired per-cell edge in px (default 256 → a 3x3 sheet targets
                 ~768px which lands on the 1K tier; a 4x3 targets ~1024px).
    """
    if rows < 1 or cols < 1:
        raise ValueError(f"rows and cols must be >= 1 (got rows={rows}, cols={cols})")

    aspect = _closest_allowed_aspect(f"{cols}:{rows}")
    target_long = max(cols, rows) * int(cell_px)
    # Clamp to the research cap (square ≤ 2048).
    target_long = min(target_long, 2048)

    resolution = "4K"
    for tier in ("1K", "2K", "4K"):
        if _RESOLUTION_LONG_EDGE[tier] >= target_long:
            resolution = tier
            break
    return aspect, resolution


def submit_generate(
    prompt: str,
    size: str = "1:1",
    quality: str = "high",
    resolution: str = "2K",
    timeout_s: int = 60,
    project: str | None = None,
) -> str:
    """Submit a gpt-image-2 (text-to-image) job. Returns task_id.

    `size` is the aspect ratio. Arbitrary pixel ratios (e.g. "256:64") are
    coerced to the closest allowed aspect since the upstream only accepts
    named aspects.
    """
    if size not in ALLOWED_SIZES:
        size = _closest_allowed_aspect(size)
    if quality not in ALLOWED_QUALITY:
        raise ValueError(f"quality {quality!r} not in {ALLOWED_QUALITY}")
    if resolution not in ALLOWED_RESOLUTION:
        raise ValueError(f"resolution {resolution!r} not in {ALLOWED_RESOLUTION}")

    logger.info(
        "Kitty GPT-Image-2 submit: aspect={s} quality={q} res={r} prompt_len={pl}",
        s=size, q=quality, r=resolution, pl=len(prompt),
    )
    data = kitty_api.submit_job_sync(
        kitty_api.WORKFLOW_GPT_IMAGE_2,
        {
            "prompt": prompt,
            "aspect_ratio": size,
            "quality": quality,
            "resolution": resolution,
        },
        media_type="image",
        timeout_s=timeout_s,
    )
    # If the backend completed synchronously, return an inline pseudo-task_id
    # marker that wait_for_completion will short-circuit on.
    job_id = data.get("jobId", "")
    if not job_id and data.get("status") == "completed":
        # Stash payload in a small in-memory cache so wait_for_completion can
        # return it without another round-trip.
        _SYNC_COMPLETIONS[id(data)] = data
        return f"sync:{id(data)}"
    if not job_id:
        raise RuntimeError(f"Kitty submit returned no jobId: {data!r}")
    logger.info("Kitty jobId={t}", t=job_id)
    _record_usage(
        model="gpt-image-2", project=project, resolution=resolution,
        quality=quality, size=size, prompt=prompt, task_id=job_id,
    )
    return job_id


def submit_edit(
    prompt: str,
    image_url: str,
    size: str = "1:1",
    quality: str = "high",
    resolution: str = "2K",
    timeout_s: int = 60,
    project: str | None = None,
) -> str:
    """Submit a gpt-image-2-edit job. Returns task_id."""
    if size not in ALLOWED_SIZES:
        size = _closest_allowed_aspect(size)
    if quality not in ALLOWED_QUALITY:
        raise ValueError(f"quality {quality!r} not in {ALLOWED_QUALITY}")
    if resolution not in ALLOWED_RESOLUTION:
        raise ValueError(f"resolution {resolution!r} not in {ALLOWED_RESOLUTION}")

    logger.info(
        "Kitty GPT-Image-2-edit submit: aspect={s} quality={q} res={r} url={u}",
        s=size, q=quality, r=resolution, u=image_url[:80],
    )
    data = kitty_api.submit_job_sync(
        kitty_api.WORKFLOW_GPT_IMAGE_2_EDIT,
        {
            "prompt": prompt,
            "aspect_ratio": size,
            "quality": quality,
            "resolution": resolution,
            "image_urls": [image_url],
        },
        media_type="image",
        timeout_s=timeout_s,
    )
    job_id = data.get("jobId", "")
    if not job_id and data.get("status") == "completed":
        _SYNC_COMPLETIONS[id(data)] = data
        return f"sync:{id(data)}"
    if not job_id:
        raise RuntimeError(f"Kitty submit_edit returned no jobId: {data!r}")
    logger.info("Kitty edit jobId={t}", t=job_id)
    _record_usage(
        model="gpt-image-2-edit", project=project, resolution=resolution,
        quality=quality, size=size, prompt=prompt, task_id=job_id,
        extra={"source_image_url": image_url[:200]},
    )
    return job_id


def submit_edit_from_path(
    prompt: str,
    seed_path: Path | str,
    size: str = "1:1",
    quality: str = "high",
    resolution: str = "2K",
    timeout_s: int = 60,
    project: str | None = None,
) -> str:
    """Submit a gpt-image-2-edit job seeded from a LOCAL canonical-seed file.

    Uploads the seed PNG to the Kitty /media endpoint (always-public URL) then
    delegates to `submit_edit`. This is the entry point for the canonical-seed
    continuity workflow: a character's first generation is saved to disk as the
    canonical seed, and every later animation sheet edits from THAT same file —
    never from the previous edit — so identity/scale/palette stay locked.
    """
    seed_path = Path(seed_path)
    if not seed_path.is_file():
        raise FileNotFoundError(f"canonical seed not found: {seed_path}")
    body = seed_path.read_bytes()
    seed_url = kitty_api.upload_file_sync(
        body, seed_path.name, content_type="image/png", timeout_s=timeout_s,
    )
    logger.info(
        "Kitty edit seed uploaded: {p} → {u}", p=seed_path.name, u=seed_url[:80],
    )
    return submit_edit(
        prompt=prompt,
        image_url=seed_url,
        size=size,
        quality=quality,
        resolution=resolution,
        timeout_s=timeout_s,
        project=project,
    )


async def generate_single_image(
    prompt: str,
    *,
    workflow_id: str = "gpt-image-2",
    aspect_ratio: str = "1:1",
    quality: str = "high",
    resolution: str = "1K",
    image_urls: list[str] | None = None,
    project: str | None = None,
) -> tuple[str, float]:
    """Generate ONE image with any registered Kitty image model → (url, cost_usd).

    Routes by workflow_id so the asset pipeline (props / backgrounds / tilesets /
    UI) is no longer hardcoded to gpt-image-2:

      - gpt-image-2   → dedicated submit/poll path (keeps the quality knob + the
                        synchronous-completion short-circuit).
      - nano-banana-2 → generic kitty submit_and_wait; aspect is coerced to the
                        closest allowed value (parity with gpt-image-2 leniency,
                        since callers pass sizes like "16:2"); cost is the flat
                        per-resolution tariff (the completion omits cost).

    Unknown/edit-only workflows raise — general callers should pass a
    GENERAL_IMAGE_WORKFLOWS id (validate with kitty_api.resolve_image_workflow).
    """
    from tools import kitty_api as _k

    wf = (workflow_id or _k.WORKFLOW_GPT_IMAGE_2).lower()
    if wf == _k.WORKFLOW_GPT_IMAGE_2:
        task_id = submit_generate(
            prompt=prompt, size=aspect_ratio, quality=quality,
            resolution=resolution, project=project,
        )
        return await poll_until_done(task_id)
    if wf == _k.WORKFLOW_NANO_BANANA_2:
        aspect = (
            aspect_ratio if aspect_ratio in _k.ALLOWED_ASPECT_RATIOS
            else _closest_allowed_aspect(aspect_ratio)
        )
        input_ = _k.build_nano_banana_input(
            prompt, aspect_ratio=aspect, resolution=resolution, image_urls=image_urls,
        )
        url, _payload = await _k.submit_and_wait(
            _k.WORKFLOW_NANO_BANANA_2, input_, media_type="image", max_wait_min=25,
        )
        cost = _k.estimate_cost_usd(
            workflow_id=_k.WORKFLOW_NANO_BANANA_2, resolution=resolution,
        )
        return url, cost
    raise ValueError(
        f"generate_single_image: unsupported workflow_id {workflow_id!r} "
        f"(general image models: {_k.GENERAL_IMAGE_WORKFLOWS})"
    )


# In-memory cache used when the backend completes a job during submit
_SYNC_COMPLETIONS: dict[int, dict[str, Any]] = {}


class PollCancelled(RuntimeError):
    """Raised by wait_for_completion when should_cancel() turns True — lets the
    gen-queue worker stop the poll THREAD (asyncio task cancellation alone can't
    kill a thread, so an un-hooked poll would keep hitting Kitty for ~25 min)."""


def wait_for_completion(
    task_id: str,
    on_poll: Callable[[str, int], None] | None = None,
    poll_interval_s: int = 8,        # Studio default
    max_wait_min: int = 30,          # Studio default for gpt-image-2
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Poll status until completed/failed. Returns the final payload dict.

    Pass `should_cancel` (a cheap thread-safe bool read, e.g. the queue's
    cancel-flag) to make the loop abort promptly when the user cancels instead
    of leaking a 25-minute poll thread.
    """
    if task_id.startswith("sync:"):
        cached = _SYNC_COMPLETIONS.pop(int(task_id.split(":", 1)[1]), None)
        if cached is None:
            raise RuntimeError(f"sync completion {task_id} expired from cache")
        return cached

    def _sleep_or_cancel(seconds: float) -> None:
        # Sleep in small slices so a cancel lands within ~0.5s, not a full poll.
        slept = 0.0
        while slept < seconds:
            if should_cancel is not None and should_cancel():
                raise PollCancelled(f"Kitty poll for job {task_id} cancelled")
            time.sleep(min(0.5, seconds - slept))
            slept += 0.5

    started = time.time()
    poll = 0
    last_status: str | None = None
    while True:
        if should_cancel is not None and should_cancel():
            raise PollCancelled(f"Kitty poll for job {task_id} cancelled")
        if time.time() - started > max_wait_min * 60:
            raise TimeoutError(
                f"Kitty job {task_id} did not finish in {max_wait_min} min",
            )
        _sleep_or_cancel(poll_interval_s)
        poll += 1
        data = kitty_api.get_job_status_sync(task_id, kitty_api.WORKFLOW_GPT_IMAGE_2)
        status = (data.get("status") or "").lower()
        elapsed = int(time.time() - started)
        # INFO-level so we can see polls in the live backend log. Only print
        # on status transitions + every 5th poll so it doesn't spam.
        if status != last_status or poll <= 3 or poll % 5 == 0:
            logger.info(
                "Kitty poll #{p}: job={j} status={s} elapsed={e}s output={o}",
                p=poll, j=task_id, s=status, e=elapsed,
                o="yes" if data.get("output") else "no",
            )
            last_status = status
        if on_poll:
            on_poll(status, elapsed)

        if status == "completed":
            return data
        if status == "failed":
            err = (
                data.get("error")
                or data.get("error_message")
                or data.get("message")
                or "unknown"
            )
            logger.error(
                "Kitty job {tid} failed: {err} | full={dump}",
                tid=task_id, err=err, dump=str(data)[:600],
            )
            raise RuntimeError(
                f"Kitty job {task_id} failed: {err!r}",
            )


def extract_result_url(data: dict[str, Any]) -> str:
    """Pull the result image URL out of a completion payload."""
    return kitty_api.extract_media_url(data)


async def poll_until_done(
    task_id: str,
    poll_interval_s: int = 8,        # Studio default
    max_wait_min: int = 30,          # Studio default for gpt-image-2
) -> tuple[str, float]:
    """Async wrapper. Returns (image_url, cost_usd)."""
    started = time.time()

    def _sync() -> dict[str, Any]:
        return wait_for_completion(
            task_id,
            poll_interval_s=poll_interval_s,
            max_wait_min=max_wait_min,
        )

    try:
        data = await asyncio.to_thread(_sync)
    except Exception as e:
        try:
            from backend.usage_tracker import tracker
            tracker.record_completion(
                task_id,
                elapsed_ms=int((time.time() - started) * 1000),
                status="failed",
                extra={"error": str(e)[:300]},
            )
        except Exception:  # noqa: BLE001
            pass
        raise

    url = extract_result_url(data)

    # Cost: prefer the backend-reported value (cents); else compute via the
    # authoritative estimator so we don't silently under-bill. The legacy
    # hardcoded fallback `{1K:0.04, 2K:0.08, 4K:0.16}` ignored quality
    # multipliers entirely — for "high" 1K it under-reported by 5× (real
    # cost $0.21, reported $0.04). That broke budget tracking + made
    # observation logs claim "estimator over-estimates" when in fact this
    # reporter was wildly under-estimating.
    cost_cents = data.get("cost")
    if isinstance(cost_cents, int | float) and cost_cents > 0:
        cost_usd = float(cost_cents) / 100.0
    else:
        try:
            cost_usd = kitty_api.estimate_cost_cents(
                workflow_id=data.get("workflowId") or data.get("backendId") or "gpt-image-2",
                quality=(data.get("quality") or "medium"),
                resolution=(data.get("resolution") or "1K"),
                aspect_ratio=(data.get("aspect_ratio") or data.get("aspectRatio") or "1:1"),
            ) / 100.0
        except Exception:  # noqa: BLE001 — keep it shipping even if Kitty changes their schema
            cost_usd = 0.14  # medium 1K conservative midpoint

    try:
        from backend.usage_tracker import tracker
        tracker.record_completion(
            task_id,
            elapsed_ms=int((time.time() - started) * 1000),
            status="completed",
            extra={"output_url": url[:200]},
        )
    except Exception:  # noqa: BLE001
        pass

    return url, cost_usd


def download_result(url: str, dest: Path, timeout_s: int = 120) -> Path:
    """Download a generated image to disk. Returns the dest path.

    Kitty's `wp-content/uploads/` URLs are gated behind LiteSpeed +
    X-Kitty-Token auth: a plain `requests.get` returns HTTP 403. Inject
    the token header when the URL points to druidcat.com so downloads
    work for both presigned-S3 outputs (pass-through, no token needed)
    and Kitty-hosted /uploads/* (needs token).
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Downloading Kitty result {u} → {p}", u=url[:80], p=dest.name)
    headers: dict[str, str] = {}
    if "druidcat.com" in url:
        try:
            tok = kitty_api._load_token()
            headers["X-Kitty-Token"] = tok
        except Exception:  # noqa: BLE001
            pass  # token missing; let raise_for_status surface the 403
    with requests.get(url, stream=True, timeout=timeout_s, headers=headers) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 64):
                if chunk:
                    f.write(chunk)
    size_kb = dest.stat().st_size // 1024
    logger.info("Downloaded {n} ({s} KB)", n=dest.name, s=size_kb)
    return dest
