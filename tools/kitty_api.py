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
) -> int:
    """Mirror of the Kitty AI Studio app `calculateWorkflowCost` for the
    image-gen workflows we actually call.

    GPT-Image-2 (and -edit): ceil(14 × quality_mult × res_mult)
        quality:     low=0.7  medium=1.0  high=1.5
        resolution:  1K=1.0   2K=1.5      4K=4.0  (wide ratios only)
        non-wide 4K is billed as 2K (1.5×).

    Nano-Banana-2: 1K=20, 2K=30, 4K=40 cents (flat per resolution).
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

    # Fallback to flat 20¢ for unknown image workflows.
    return 20


def estimate_cost_usd(**kwargs: Any) -> float:
    return estimate_cost_cents(**kwargs) / 100.0


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
