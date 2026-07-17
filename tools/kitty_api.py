"""Kitty AI Studio WordPress backend client.

Mirrors the contract used by `the Kitty app's API client`
so murrkit talks to the SAME upstream as the user's production Kitty AI
Studio app. The Kitty App code (`kitty_...`) the user pastes into Settings is
the WordPress JWT-style token, NOT a raw API key.

Endpoints (base = https://druidcat.com/wp-json/kitty-app/v1):

  GET  /verify                            X-Kitty-Token: ...
       → { valid: true, userId, username, credits, ... }

  GET  /balance                           X-Kitty-Token: ...
       → { credits, formatted }

  POST /generate                          X-Kitty-Token: ...
       Body: { workflowId, input, mediaType }
       → { jobId, status, output?, cost? }

  GET  /status/{jobId}?workflowId=...     X-Kitty-Token: ...
       → { jobId, status: pending|processing|completed|failed,
            output: { url|imageURL|videoURL|audioURL }, cost, refunded }

  POST /cancel/{jobId}                    X-Kitty-Token: ...

  POST /upload   (multipart form-data)    X-Kitty-Token: ...
       → { url | s3_key }

The WordPress backend forwards image jobs to the configured provider (GPT-Image-2,
etc.) and hosts the S3 results behind a stable public `/media?key=...&endpoint=1`
URL — that's the SAME asset CDN the production website uses.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import httpx
import requests
from loguru import logger


KITTY_BASE = "https://druidcat.com/wp-json/kitty-app/v1"

# Workflow IDs as defined in `the Kitty app's workflow list`.
# These are the `backendId` (NOT the `endpointId` with `kitty:` prefix).
WORKFLOW_GPT_IMAGE_2 = "gpt-image-2"            # text-to-image
WORKFLOW_GPT_IMAGE_2_EDIT = "gpt-image-2-edit"  # image-to-image
WORKFLOW_NANO_BANANA_2 = "nano-banana-2"        # Gemini Flash Image (edit)
WORKFLOW_NANO_BANANA_PRO = "nano-banana-pro"    # Gemini Flash Image Pro
WORKFLOW_KREA2_TURBO = "krea2-turbo"            # Krea 2 t2i + Style LoRA presets

# Krea 2 Turbo preinstalled Style-LoRA presets — mirrors the krea2-turbo page
# dropdown (druidcat-theme page-cat-motion-ai.php). Trigger words are handled
# server-side; the preset id is all the API needs.
KREA2_LORA_PRESETS = {
    "realism-v2", "ultrareal", "fire-and-ice", "retro-anime",
    "flat-illustration", "moebius", "retro-vintage-photo", "none",
}
# The strength slider on the page runs 0.00–1.50.
KREA2_STRENGTH_MAX = 1.5

# The krea2 worker expects the page's VERBOSE aspect labels (verified live:
# a bare "1:1" was ignored and produced 16:9). Keys = plain ratios accepted
# by build_krea2_input; values = what actually goes on the wire.
KREA2_ASPECT_LABELS = {
    "1:1": "1:1 (Square)",
    "16:9": "16:9 (Widescreen)",
    "9:16": "9:16 (Portrait Widescreen)",
    "4:3": "4:3 (Standard)",
    "3:4": "3:4 (Portrait Standard)",
    "3:2": "3:2 (Photo)",
    "2:3": "2:3 (Portrait Photo)",
    "21:9": "21:9 (Ultrawide)",
}

# Aspect ratios accepted by gpt-image-2 (subset of UI list).
ALLOWED_ASPECT_RATIOS = {
    "auto", "1:1", "16:9", "9:16", "4:3", "3:4",
    "3:2", "2:3", "4:5", "5:4", "21:9",
}
ALLOWED_QUALITY = {"low", "medium", "high"}
ALLOWED_RESOLUTION = {"1K", "2K", "4K"}

# Wide aspect ratios — only ones eligible for true-4K billing on GPT-Image-2.
# Other ratios at 4K are billed at 2K rates (Kitty tariff).
WIDE_ASPECT_RATIOS = {"16:9", "9:16", "21:9"}


def estimate_cost_cents(
    *,
    workflow_id: str,
    quality: str = "medium",
    resolution: str = "1K",
    aspect_ratio: str = "1:1",
    batch: int = 1,
) -> int:
    """Mirror of the Kitty AI Studio app `calculateWorkflowCost` for the
    image-gen workflows we actually call.

    GPT-Image-2 (and -edit): ceil(14 × quality_mult × res_mult)
        quality:     low=0.7  medium=1.0  high=1.5
        resolution:  1K=1.0   2K=1.5      4K=4.0  (wide ratios only)
        non-wide 4K is billed as 2K (1.5×).

    Nano-Banana-2: 1K=20, 2K=30, 4K=40 cents (flat per resolution).

    Krea 2 Turbo: batch-tiered like the website (16¢ single → 14¢/img at 4 →
    12¢/img at 8 → 10¢/img at 16); murrkit submits single jobs, so an N-image
    batch is priced at N × the best tier rate ≤ N (matches the site tiers on
    the tier sizes themselves). `batch` is ignored by other workflows.
    """
    import math

    w = (workflow_id or "").lower()
    if w in ("gpt-image-2", "gpt-image-2-edit"):
        q_mult = {"low": 0.7, "medium": 1.0, "high": 1.5}.get(quality.lower(), 1.0)
        r = resolution.upper()
        r_mult = {"1K": 1.0, "2K": 1.5, "4K": 4.0}.get(r, 1.0)
        if r == "4K" and aspect_ratio not in WIDE_ASPECT_RATIOS:
            r_mult = 1.5  # bill as 2K
        return max(1, math.ceil(14 * q_mult * r_mult))

    if w.startswith("nano-banana-2"):
        return {"4K": 40, "2K": 30}.get(resolution.upper(), 20)

    if w == WORKFLOW_KREA2_TURBO:
        n = max(1, int(batch))
        per_image = {1: 16, 2: 16, 4: 14, 8: 12, 16: 10}
        tier = max((t for t in per_image if t <= n), default=1)
        return int(math.ceil(n * per_image[tier]))

    # Fallback to flat 20¢ for unknown image workflows.
    return 20


def estimate_cost_usd(**kwargs: Any) -> float:
    return estimate_cost_cents(**kwargs) / 100.0


def build_krea2_input(
    prompt: str,
    *,
    aspect_ratio: str = "1:1",
    lora_preset: str = "moebius",
    lora_preset_strength: float = 0.8,
    seed: int | None = None,
) -> dict[str, Any]:
    """Build the `input` payload for a krea2-turbo job.

    Mirrors the krea2-turbo page's `baseParams` exactly (workflow_id is the
    envelope's `workflowId`, not part of input here): prompt, aspect_ratio,
    lora_preset, lora_preset_strength, seed. Trigger words are handled
    server-side per preset — never bake them into the prompt.

    Fail-loud validation: unknown preset / aspect is a caller bug, not
    something to silently coerce. Strength clamps to the page slider range.
    """
    p = (prompt or "").strip()
    if not p:
        raise ValueError("krea2: prompt is empty")
    if lora_preset not in KREA2_LORA_PRESETS:
        raise ValueError(
            f"krea2: unknown lora_preset {lora_preset!r} "
            f"(allowed: {sorted(KREA2_LORA_PRESETS)})"
        )
    aspect_key = (aspect_ratio or "").strip()
    aspect_label = KREA2_ASPECT_LABELS.get(aspect_key)
    if aspect_label is None and aspect_key in KREA2_ASPECT_LABELS.values():
        aspect_label = aspect_key  # already the verbose form
    if aspect_label is None:
        raise ValueError(
            f"krea2: aspect_ratio {aspect_ratio!r} not in {sorted(KREA2_ASPECT_LABELS)}"
        )
    strength = max(0.0, min(float(lora_preset_strength), KREA2_STRENGTH_MAX))
    if seed is None:
        import random
        seed = random.randint(0, 1_000_000_000)
    return {
        "prompt": p,
        "aspect_ratio": aspect_label,
        "lora_preset": lora_preset,
        "lora_preset_strength": strength,
        "seed": int(seed),
    }


def extract_krea2_urls(data: dict[str, Any]) -> list[str]:
    """Pull all result image URLs from a completed krea2 job payload.

    The krea2 worker returns `{output: {outputs: [{url | s3_key}, ...]}}`
    (the site reads `result?.output?.outputs || result?.outputs`). An
    `s3_key` maps to the stable Kitty /media streaming URL — same trick as
    `upload_file_sync`. Falls back to the generic single-URL extractor for
    payloads normalized by the WordPress plugin.
    """
    from urllib.parse import quote

    output = data.get("output") or {}
    outputs = None
    if isinstance(output, dict):
        outputs = output.get("outputs")
    if outputs is None:
        outputs = data.get("outputs")

    urls: list[str] = []
    if isinstance(outputs, list):
        for item in outputs:
            if not isinstance(item, dict):
                continue
            url = item.get("url") or item.get("imageURL")
            s3_key = item.get("s3_key")
            if isinstance(url, str) and url:
                urls.append(url)
            elif isinstance(s3_key, str) and s3_key:
                urls.append(f"{KITTY_BASE}/media?key={quote(s3_key)}&endpoint=1")
    if urls:
        return urls
    # Plugin-normalized single-URL shape (imageURL/url at output top level).
    return [extract_media_url(data)]


class KittyApiError(RuntimeError):
    """Kitty WordPress backend error with HTTP status + refund metadata."""

    def __init__(
        self,
        message: str,
        status: int,
        refunded: bool = False,
        refund_message: str | None = None,
        server_busy: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.refunded = refunded
        self.refund_message = refund_message
        self.server_busy = server_busy


def _load_token() -> str:
    """Return the Kitty App token (X-Kitty-Token).

    Sourced from core.config.settings.kitty_app_token (which reads the
    KITTY_APP_TOKEN env var).
    """
    tok = ""
    try:
        from core.config import settings as _s
        if _s.kitty_app_token:
            tok = _s.kitty_app_token.get_secret_value().strip()
    except Exception:  # noqa: BLE001
        pass
    if not tok:
        raise KeyError(
            "Kitty App code not set. Open Settings → Kitty App code and paste "
            "your token from https://druidcat.app/dashboard."
        )
    return tok


def _headers(token: str | None = None, *, multipart: bool = False) -> dict[str, str]:
    tok = token or _load_token()
    h: dict[str, str] = {"X-Kitty-Token": tok}
    if not multipart:
        h["Content-Type"] = "application/json"
    return h


def _friendly_error(raw: str) -> str:
    """Mirror friendlyErrorMessage from the Kitty app client so users see clean text."""
    low = raw.lower()
    if "shark" in low and "reject" in low:
        return "Your image was rejected by the content safety filter."
    if "content not pass" in low or "content_not_pass" in low:
        return "Content moderation rejected your input."
    if "sensitive" in low and "content" in low:
        return "Your input was flagged as sensitive content."
    if "nsfw" in low:
        return "Your input was flagged as inappropriate (NSFW)."
    if "rate limit" in low or "too many request" in low:
        return "Too many requests — the server is busy. Please wait."
    if "overload" in low or "capacity" in low:
        return "The AI server is currently overloaded. Please try again."
    return raw


# ---------------------------------------------------------------------------
# Sync (requests) — used from worker threads
# ---------------------------------------------------------------------------


def verify_token_sync(token: str | None = None, timeout_s: int = 15) -> dict[str, Any]:
    """GET /verify. Returns the verification payload from the WordPress plugin."""
    import time as _time
    r = requests.get(
        f"{KITTY_BASE}/verify",
        headers={**_headers(token), "Cache-Control": "no-cache"},
        params={"_t": int(_time.time() * 1000)},
        timeout=timeout_s,
    )
    if r.status_code == 401 or r.status_code == 403:
        raise KittyApiError("Invalid or expired Kitty App code.", r.status_code)
    if r.status_code != 200:
        raise KittyApiError(
            f"Kitty verify failed: HTTP {r.status_code}: {r.text[:300]}",
            r.status_code,
        )
    return r.json() or {}


def get_balance_sync(token: str | None = None, timeout_s: int = 15) -> dict[str, Any]:
    import time as _time
    r = requests.get(
        f"{KITTY_BASE}/balance",
        headers={**_headers(token), "Cache-Control": "no-cache"},
        params={"_t": int(_time.time() * 1000)},
        timeout=timeout_s,
    )
    if r.status_code != 200:
        raise KittyApiError(
            f"Kitty balance HTTP {r.status_code}: {r.text[:200]}",
            r.status_code,
        )
    return r.json() or {}


def submit_job_sync(
    workflow_id: str,
    input_: dict[str, Any],
    media_type: str = "image",
    token: str | None = None,
    timeout_s: int = 60,
) -> dict[str, Any]:
    """POST /generate. Returns {jobId, status, output?, cost?}.

    workflow_id is the backendId (no `kitty:` prefix), e.g. "gpt-image-2".
    """
    payload = {
        "workflowId": workflow_id,
        "input": input_,
        "mediaType": media_type,
    }
    logger.info(
        "Kitty submit: workflowId={w} mediaType={m} keys={k}",
        w=workflow_id, m=media_type, k=list(input_.keys()),
    )
    r = requests.post(
        f"{KITTY_BASE}/generate",
        headers=_headers(token),
        json=payload,
        timeout=timeout_s,
    )
    if r.status_code != 200:
        raise KittyApiError(
            _friendly_error(f"Kitty generate HTTP {r.status_code}: {r.text[:400]}"),
            r.status_code,
        )
    data = r.json() or {}
    if not data.get("jobId") and not (
        data.get("status") == "completed" and data.get("output")
    ):
        raise KittyApiError(
            "Kitty backend accepted request but returned no jobId.", 500,
        )
    return data


def get_job_status_sync(
    job_id: str,
    workflow_id: str | None = None,
    token: str | None = None,
    timeout_s: int = 30,
) -> dict[str, Any]:
    """GET /status/{job_id} — with LiteSpeed cache-buster.

    CRITICAL: druidcat.com is fronted by LiteSpeed which IGNORES the plugin's
    `nocache_headers()` and serves the first `running` response forever from
    cache, so we'd never see `completed`. Kitty Studio's own proxy (verified
    in `src/app/api/kitty/[...path]/route.ts`) appends `&_t=${Date.now()}` to
    every status URL for this reason. We do the same here.
    """
    import time as _time
    params: dict[str, Any] = {"_t": int(_time.time() * 1000)}
    if workflow_id:
        params["workflowId"] = workflow_id
    r = requests.get(
        f"{KITTY_BASE}/status/{job_id}",
        headers={
            **_headers(token),
            # Force-bust at the HTTP cache layer too.
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
        },
        params=params,
        timeout=timeout_s,
    )
    if r.status_code != 200:
        raise KittyApiError(
            f"Kitty status HTTP {r.status_code}: {r.text[:200]}",
            r.status_code,
        )
    return r.json() or {}


def wait_for_completion_sync(
    job_id: str,
    workflow_id: str | None = None,
    token: str | None = None,
    poll_interval_s: int | None = None,
    max_wait_min: int | None = None,
) -> dict[str, Any]:
    """Poll /status until completed|failed. Returns the final job payload.

    Cadence + timeout mirror Kitty AI Studio's `pollJobStatus` exactly
    (`the Kitty app`):

      • GPT-Image-2 workflows: 8 s base poll interval, 30 min max wait.
        (Studio comment: "jobs can sit in 'not_started' for 15-25 min
         before the Kitty worker actually picks them up".)
      • Other workflows: 8 s base, 45 min max.

    Override per-call via `poll_interval_s` / `max_wait_min` for tests.
    """
    wf = (workflow_id or "").lower()
    if poll_interval_s is None:
        poll_interval_s = 8  # Studio default base interval
    if max_wait_min is None:
        max_wait_min = 30 if wf.startswith("gpt-image") else 45

    started = time.time()
    poll = 0
    while True:
        if time.time() - started > max_wait_min * 60:
            raise TimeoutError(
                f"Kitty job {job_id} did not finish in {max_wait_min} min "
                f"(Kitty upstream queue can take 15-25 min; if you saw heartbeat "
                f"progress the whole time, it was genuinely queued).",
            )
        time.sleep(poll_interval_s)
        poll += 1
        data = get_job_status_sync(job_id, workflow_id, token)
        status = (data.get("status") or "").lower()
        if poll <= 3 or poll % 10 == 0:
            elapsed_s = int(time.time() - started)
            logger.info(
                "Kitty poll #{p}: job={j} status={s} elapsed={e}s",
                p=poll, j=job_id, s=status, e=elapsed_s,
            )
        if status == "completed":
            return data
        if status == "failed":
            err = data.get("error") or data.get("error_message") or "unknown"
            raise KittyApiError(
                _friendly_error(f"Kitty job {job_id} failed: {err}"),
                500,
                refunded=bool(data.get("refunded")),
                refund_message=data.get("refund_message"),
            )


def extract_media_url(data: dict[str, Any]) -> str:
    """Pull the result media URL from a completed job payload."""
    output = data.get("output") or {}
    if isinstance(output, dict):
        for key in ("videoURL", "imageURL", "audioURL", "url"):
            v = output.get(key)
            if isinstance(v, str) and v:
                return v
    if isinstance(output, list) and output:
        first = output[0]
        if isinstance(first, dict):
            v = first.get("url") or first.get("imageURL")
            if isinstance(v, str) and v:
                return v
    raise KittyApiError(
        f"Kitty completion missing output URL. Keys: {list(output.keys()) if isinstance(output, dict) else 'list'}",
        500,
    )


def upload_file_sync(
    file_bytes: bytes,
    filename: str,
    content_type: str = "application/octet-stream",
    token: str | None = None,
    timeout_s: int = 120,
) -> str:
    """Upload a file. Returns a stable public URL (the /media streaming endpoint
    if s3_key is returned, since presigned URLs sometimes 401).
    """
    files = {"file": (filename, file_bytes, content_type)}
    r = requests.post(
        f"{KITTY_BASE}/upload",
        headers=_headers(token, multipart=True),
        files=files,
        timeout=timeout_s,
    )
    if r.status_code != 200:
        raise KittyApiError(
            f"Kitty upload HTTP {r.status_code}: {r.text[:300]}",
            r.status_code,
        )
    data = r.json() or {}
    s3_key = data.get("s3_key")
    if s3_key:
        # Stable /media URL — server-side auth, no presigned-URL flakiness
        from urllib.parse import quote
        return f"{KITTY_BASE}/media?key={quote(s3_key)}&endpoint=1"
    url = data.get("url")
    if not url:
        raise KittyApiError("Kitty upload returned no URL", 500)
    return str(url)


# ---------------------------------------------------------------------------
# Async wrappers (FastAPI-friendly)
# ---------------------------------------------------------------------------


async def verify_token(token: str | None = None) -> dict[str, Any]:
    """Async /verify."""
    async with httpx.AsyncClient(timeout=20.0) as cli:
        r = await cli.get(
            f"{KITTY_BASE}/verify",
            headers={**_headers(token), "Cache-Control": "no-cache"},
            params={"_t": int(time.time() * 1000)},
        )
    if r.status_code == 401 or r.status_code == 403:
        raise KittyApiError("Invalid or expired Kitty App code.", r.status_code)
    if r.status_code != 200:
        raise KittyApiError(
            f"Kitty verify HTTP {r.status_code}: {r.text[:300]}",
            r.status_code,
        )
    return r.json() or {}


async def get_balance(token: str | None = None) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15.0) as cli:
        r = await cli.get(
            f"{KITTY_BASE}/balance",
            headers={**_headers(token), "Cache-Control": "no-cache"},
            params={"_t": int(time.time() * 1000)},
        )
    if r.status_code != 200:
        raise KittyApiError(
            f"Kitty balance HTTP {r.status_code}: {r.text[:200]}",
            r.status_code,
        )
    return r.json() or {}


async def submit_and_wait(
    workflow_id: str,
    input_: dict[str, Any],
    media_type: str = "image",
    poll_interval_s: int = 3,
    max_wait_min: int = 10,
    token: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """End-to-end: submit a job, poll until completed, return (media_url, payload)."""
    submit_result = await asyncio.to_thread(
        submit_job_sync, workflow_id, input_, media_type, token,
    )
    # Synchronous completion (some short jobs may complete inside submit)
    if submit_result.get("status") == "completed" and submit_result.get("output"):
        return extract_media_url(submit_result), submit_result

    job_id = submit_result["jobId"]
    final = await asyncio.to_thread(
        wait_for_completion_sync,
        job_id, workflow_id, token, poll_interval_s, max_wait_min,
    )
    return extract_media_url(final), final


# ---------------------------------------------------------------------------
# Convenience: generate a GPT-Image-2 image and download it
# ---------------------------------------------------------------------------


async def generate_image(
    prompt: str,
    aspect_ratio: str = "1:1",
    quality: str = "medium",
    resolution: str = "1K",
    token: str | None = None,
    poll_interval_s: int = 3,
    max_wait_min: int = 8,
) -> tuple[str, dict[str, Any]]:
    """Submit a gpt-image-2 text-to-image job and wait for the result URL."""
    if aspect_ratio not in ALLOWED_ASPECT_RATIOS:
        raise ValueError(f"aspect_ratio {aspect_ratio!r} not in {ALLOWED_ASPECT_RATIOS}")
    if quality not in ALLOWED_QUALITY:
        raise ValueError(f"quality {quality!r} not in {ALLOWED_QUALITY}")
    if resolution not in ALLOWED_RESOLUTION:
        raise ValueError(f"resolution {resolution!r} not in {ALLOWED_RESOLUTION}")

    return await submit_and_wait(
        WORKFLOW_GPT_IMAGE_2,
        {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "quality": quality,
            "resolution": resolution,
        },
        media_type="image",
        poll_interval_s=poll_interval_s,
        max_wait_min=max_wait_min,
        token=token,
    )


async def download_to(url: str, dest: Path, timeout_s: int = 120) -> Path:
    """Async download of a Kitty /media URL (or any HTTP URL) to disk."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=True) as cli:
        async with cli.stream("GET", url) as r:
            r.raise_for_status()
            with dest.open("wb") as f:
                async for chunk in r.aiter_bytes(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
    return dest
