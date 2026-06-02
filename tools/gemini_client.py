"""
Gemini multimodal client with TWO transport modes.

## Mode A — Kitty proxy (DEFAULT when KITTY_APP_TOKEN is set)

Routes through Druidcat Kitty App's `/agent/chat` endpoint, which is an
OpenAI-compatible Vertex AI Gemini gateway. Billing comes from the
user's `catmotion_credits` balance (43% margin already applied
server-side). No Google Cloud / Vertex AI / API key setup required.

  POST https://druidcat.com/wp-json/kitty-app/v1/agent/chat
  Header: X-Kitty-Token: <user token>
  Body: OpenAI chat completion shape (multi-image via image_url blocks)
  Model: gemini-3.5-flash (Kitty default; GA 2026-05-19, current best vision)

Kitty effective rates (post 1.43× margin):
  Input  ≤200K ctx: $2.86 / 1M tokens
  Input  >200K ctx: $5.72 / 1M tokens
  Output ≤200K ctx: $17.16 / 1M tokens
  Output >200K ctx: $25.74 / 1M tokens
  → ~$0.01 per 6-frame playtest review at ~3K input tokens
  → image tokens are small (256-1024 per image) so cost stays bounded

## Mode B — direct Google AI Studio (fallback)

Uses `GEMINI_API_KEY` against generativelanguage.googleapis.com. Cheaper
per-token but requires user to set up an AI Studio key. Kept as fallback
for users without a Kitty balance.

  Direct rates (May 2026):
    gemini-3.1-flash-lite: $0.075 / M (cheap sweep / triage, native video)
    gemini-3.5-flash:      $0.15 / M  (default bug hunt; GA 2026-05-19)
    gemini-2.5-pro:        $1.25 / M  (final audit)

The default is Mode A. To force Mode B, instantiate with `via_kitty=False`
or set `SUPERAGENT_GEMINI_VIA_KITTY=0` in .env.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from loguru import logger
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from core.config import settings

# ---- Pricing tables --------------------------------------------------------

# DIRECT (Mode B): Google AI Studio / Vertex AI raw rates per 1M tokens
# (May 2026 — verified against ai.google.dev/gemini-api/docs/pricing).
PRICING_DIRECT_USD_PER_M = {
    # gemini-3.5-flash — GA 2026-05-19, current default vision model (1M ctx).
    "gemini-3.5-flash": {"input": 0.15, "output": 0.60},
    "gemini-3.1-flash-lite": {"input": 0.075, "output": 0.30},
    "gemini-2.5-flash-lite": {"input": 0.10, "output": 0.40},
    "gemini-2.5-flash": {"input": 0.075, "output": 0.30},
    "gemini-2.5-pro": {"input": 1.25, "output": 5.00},
    "gemini-3-flash-preview": {"input": 0.10, "output": 0.40},
}

# KITTY (Mode A): Druidcat Kitty App /agent/chat rates per 1M tokens.
# Source: KITTY_AGENT_INPUT_RATE_* and KITTY_AGENT_MARGIN in
# the Kitty WordPress plugin (server-side, closed)
# (verified 2026-05-25). 1.43x margin already applied — these are the
# effective USD a user is billed per 1M tokens from their catmotion_credits
# balance. Long-context tier triggers above 200K prompt tokens.
KITTY_AGENT_MARGIN = 1.43
# Kitty's /agent/chat credits handler bills at a single fixed agent-chat rate
# (the 1.43× margin below) regardless of which Gemini model is requested, so
# both the current default (gemini-3.5-flash) and the legacy 3.1-pro alias map
# to the same effective per-1M-token cost. Keep both keys so the cost
# estimator's `.get(model, ...[DEFAULT])` fallback can never KeyError.
_KITTY_AGENT_RATES = {
    "input_short": 2.00 * KITTY_AGENT_MARGIN,   # ≤200K ctx → $2.86 / 1M
    "input_long":  4.00 * KITTY_AGENT_MARGIN,   # >200K ctx → $5.72 / 1M
    "output_short": 12.00 * KITTY_AGENT_MARGIN, # ≤200K ctx → $17.16 / 1M
    "output_long":  18.00 * KITTY_AGENT_MARGIN, # >200K ctx → $25.74 / 1M
}
PRICING_KITTY_USD_PER_M = {
    "gemini-3.5-flash": dict(_KITTY_AGENT_RATES),
    "gemini-3.1-pro-preview": dict(_KITTY_AGENT_RATES),  # back-compat alias
}
# Kitty's /agent/chat allow-list passes any `google/<model>` through to
# Vertex AI. gemini-3.5-flash (GA 2026-05-19) is the current best vision model
# and the new default for game-frame QA + reference compare.
KITTY_AGENT_DEFAULT_MODEL = "gemini-3.5-flash"
KITTY_AGENT_CHAT_URL = "https://druidcat.com/wp-json/kitty-app/v1/agent/chat"

# Back-compat alias — old code imports PRICING_USD_PER_M.
PRICING_USD_PER_M = PRICING_DIRECT_USD_PER_M


# Standard playtest-review system prompt — bake game-context awareness so
# the model doesn't waste tokens commenting on background art / decoration.
# Tightened from an earlier VL-model version after we caught the model calling
# corner paw prints "should be colored per player" on a board game (they're static
# decoration). Same protocol, provider-agnostic.
PLAYTEST_REVIEW_SYSTEM = """\
You are reviewing screenshots from a Unity 2D game playtest. Your job is
to spot GAMEPLAY bugs, NOT redesign the visual theme.

## What is gameplay (judge this)
- Player / AI tokens placed in cells, on grids, or in scene
  - Size: do they fit in their designated slot?
  - Position: centered? Off-center? Drifting?
  - Overlap: do adjacent tokens touch / overlap each other or borders?
  - Distinguishability: can you tell which player placed what?
- UI chrome that affects play: buttons, score, turn indicator, win/draw
  state. Are they fully inside the visible Game view, or clipping at
  edges?
- Click feedback (does each click produce a visible state change?).

## What is decoration (DO NOT judge)
- Static background art (skies, forests, corner ornaments, scalloped
  borders, paw prints in corners).
- Color palettes.
- Theme aesthetics.

## How to read a sequence
You may receive N chronological frames. The DIFFERENCES between frames
are where gameplay lives. If two frames look identical, that is THE most
important finding — it means a click didn't register. Always check
inter-frame deltas BEFORE commenting on single-frame aesthetics.

## What to return
1. Frame-by-frame delta (one line per frame).
2. Gameplay bugs (max 5 bullets, ranked by severity). For each: which
   frame revealed it, what's wrong, one concrete fix at the right scope.
3. Playability verdict: PLAYABLE / PLAYABLE_WITH_ISSUES / BROKEN,
   one-sentence reason.

If frames are identical: say "frames identical, click pipeline broken,
cannot evaluate gameplay" — do NOT speculate about cosmetics.

## Grounding (do NOT hallucinate)
Only report a bug you can CONCRETELY SEE in a specific frame, naming which
frame and where. Never invent a defect, never claim something is wrong that
you cannot point to, and never describe an object (or a problem with the
background) that is not actually visible. If something looks fine, say it's
fine — a clean painted background is NOT a bug.
"""


@dataclass(slots=True)
class GeminiResult:
    text: str
    finish_reason: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    raw: dict[str, Any]


def _default_use_kitty() -> bool:
    """Pick the default transport. Kitty wins when KITTY_APP_TOKEN exists
    UNLESS user explicitly opts out via SUPERAGENT_GEMINI_VIA_KITTY=0.

    Precedence:
      1. Pydantic settings field `superagent_gemini_via_kitty` (loaded from .env)
      2. Raw `SUPERAGENT_GEMINI_VIA_KITTY` env var (for ad-hoc override)
      3. Auto-decide: True if KITTY_APP_TOKEN set, else False
    """
    import os

    # 1. Pydantic settings (loaded from .env at startup)
    pydantic_override = settings.superagent_gemini_via_kitty
    if pydantic_override is not None:
        return pydantic_override

    # 2. Raw env var (in case someone sets it after settings load, or via shell)
    override = os.environ.get("SUPERAGENT_GEMINI_VIA_KITTY", "").strip().lower()
    if override in {"0", "false", "no", "off"}:
        return False
    if override in {"1", "true", "yes", "on"}:
        return True

    # 3. Auto-decide — prefer Kitty if token is set
    return settings.kitty_app_token is not None


class GeminiClient:
    """Async client for Gemini multimodal API.

    Default transport is Mode A (Kitty proxy) when a Kitty token is set —
    no Google Cloud setup needed, billed from catmotion_credits. Pass
    `via_kitty=False` to force Mode B (direct AI Studio key).
    """

    DEFAULT_TIMEOUT = 90.0

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        via_kitty: bool | None = None,
    ) -> None:
        if via_kitty is None:
            via_kitty = _default_use_kitty()
        self._via_kitty = via_kitty

        if via_kitty:
            # Kitty path — needs KITTY_APP_TOKEN, no Google key required
            if settings.kitty_app_token is None:
                raise RuntimeError(
                    "via_kitty=True but KITTY_APP_TOKEN missing in .env. "
                    "Either set it (top up at druidcat.com/kitty-app) or "
                    "pass via_kitty=False to use a direct GEMINI_API_KEY."
                )
            self._api_key = settings.kitty_app_token.get_secret_value()
            self._model = model or KITTY_AGENT_DEFAULT_MODEL
            self._base_url = KITTY_AGENT_CHAT_URL  # full URL, not a base
        else:
            # Direct Google AI Studio path
            if api_key is None:
                if settings.gemini_api_key is None:
                    raise RuntimeError(
                        "via_kitty=False but GEMINI_API_KEY missing in .env. "
                        "Get a free key at https://aistudio.google.com/apikey, "
                        "or set KITTY_APP_TOKEN and rely on the Kitty proxy."
                    )
                api_key = settings.gemini_api_key.get_secret_value()
            self._api_key = api_key
            self._model = model or settings.gemini_model
            self._base_url = "https://generativelanguage.googleapis.com/v1beta"

        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "GeminiClient":
        self._client = httpx.AsyncClient(timeout=self._timeout)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=20),
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.NetworkError)),
        reraise=True,
    )
    async def generate(
        self,
        *,
        system: str,
        user: str,
        images: list[Path | str] | None = None,
        temperature: float = 0.3,
        max_output_tokens: int = 4096,
        response_mime_type: str | None = None,
    ) -> GeminiResult:
        """
        Send a multimodal prompt to Gemini.

        Args:
            system: system instruction
            user: user message text
            images: list of image paths to include (PNG/JPG/WebP)
            temperature: sampling temperature
            max_output_tokens: max output length
            response_mime_type: e.g. 'application/json' for structured output

        Returns:
            GeminiResult with .text, .cost_usd, .input_tokens, .output_tokens
        """
        if self._client is None:
            raise RuntimeError("GeminiClient not entered.")

        if self._via_kitty:
            return await self._generate_kitty(
                system=system, user=user, images=images,
                temperature=temperature, max_output_tokens=max_output_tokens,
                response_mime_type=response_mime_type,
            )
        return await self._generate_direct(
            system=system, user=user, images=images,
            temperature=temperature, max_output_tokens=max_output_tokens,
            response_mime_type=response_mime_type,
        )

    # -------- Mode A: Kitty proxy (default) ---------------------------------

    async def _generate_kitty(
        self,
        *,
        system: str,
        user: str,
        images: list[Path | str] | None,
        temperature: float,
        max_output_tokens: int,
        response_mime_type: str | None,
    ) -> GeminiResult:
        """Send via Kitty `/agent/chat` — OpenAI-compatible Vertex AI proxy.

        Builds standard OpenAI chat completion shape with multi-image
        content blocks (Vertex AI's OpenAI-compat layer accepts data URLs
        in `image_url`). Billing handled server-side from
        catmotion_credits.
        """
        assert self._client is not None

        # Build OpenAI-style content blocks: images as image_url, then text
        user_content: list[dict[str, Any]] = []
        if images:
            for img in images:
                p = Path(img)
                if not p.exists():
                    raise FileNotFoundError(f"Image not found: {p}")
                ext = p.suffix.lstrip(".").lower() or "png"
                mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
                b64 = base64.b64encode(p.read_bytes()).decode("ascii")
                user_content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                })
        user_content.append({"type": "text", "text": user})

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            "temperature": temperature,
            "max_tokens": max_output_tokens,
        }
        if response_mime_type == "application/json":
            payload["response_format"] = {"type": "json_object"}

        headers = {
            "X-Kitty-Token": self._api_key,
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        }
        import time as _time
        params = {"_t": int(_time.time() * 1000)}  # LiteSpeed cache-bust

        logger.debug(
            "Gemini (kitty) call: model={m} images={i}",
            m=self._model, i=len(images) if images else 0,
        )

        try:
            resp = await self._client.post(
                self._base_url, headers=headers, json=payload, params=params,
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            safe = (e.response.text or "")[:300]
            logger.error("Gemini-Kitty HTTP {s}: {b}", s=e.response.status_code, b=safe)
            raise RuntimeError(
                f"Gemini via Kitty error {e.response.status_code}: {safe}"
            ) from None

        data = resp.json()
        # OpenAI-compatible response: {choices:[{message:{content,role}}], usage:{prompt_tokens, completion_tokens}, ...}
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError(f"Gemini-Kitty returned no choices: {str(data)[:200]}")
        msg = choices[0].get("message") or {}
        text = msg.get("content") or ""
        finish_reason = choices[0].get("finish_reason") or "stop"

        usage = data.get("usage") or {}
        in_tok = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        out_tok = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
        cost = self._estimate_cost_kitty(in_tok, out_tok)

        return GeminiResult(
            text=text,
            finish_reason=finish_reason,
            input_tokens=in_tok,
            output_tokens=out_tok,
            cost_usd=cost,
            raw=data,
        )

    # -------- Mode B: direct Google AI Studio (fallback) --------------------

    async def _generate_direct(
        self,
        *,
        system: str,
        user: str,
        images: list[Path | str] | None,
        temperature: float,
        max_output_tokens: int,
        response_mime_type: str | None,
    ) -> GeminiResult:
        """Original direct-to-Google path. Kept for users without a Kitty
        balance who provide their own GEMINI_API_KEY."""
        assert self._client is not None

        parts: list[dict[str, Any]] = [{"text": user}]
        if images:
            for img in images:
                p = Path(img)
                if not p.exists():
                    raise FileNotFoundError(f"Image not found: {p}")
                ext = p.suffix.lstrip(".").lower() or "png"
                mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
                b64 = base64.b64encode(p.read_bytes()).decode("ascii")
                parts.append({"inline_data": {"mime_type": mime, "data": b64}})

        payload: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_output_tokens,
                # Disable Gemini 2.5 thinking budget so visible output isn't
                # silently consumed by internal CoT (caused 79-token JSON
                # truncations in compare-gate calls). Safe for 2.5 Flash/Pro
                # and ignored by older models.
                "thinkingConfig": {"thinkingBudget": 0},
            },
        }
        if response_mime_type:
            payload["generationConfig"]["responseMimeType"] = response_mime_type

        url = f"{self._base_url}/models/{self._model}:generateContent"
        headers = {"X-goog-api-key": self._api_key, "Content-Type": "application/json"}

        logger.debug(
            "Gemini (direct) call: model={m} parts={n} images={i}",
            m=self._model, n=len(parts), i=len(images) if images else 0,
        )

        try:
            resp = await self._client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            safe = (e.response.text or "")[:300]
            logger.error("Gemini-direct HTTP {s}: {b}", s=e.response.status_code, b=safe)
            raise RuntimeError(
                f"Gemini direct error {e.response.status_code}: {safe}"
            ) from None

        data = resp.json()
        candidates = data.get("candidates", [])
        if not candidates:
            raise RuntimeError(f"Gemini returned no candidates: {str(data)[:200]}")

        cand = candidates[0]
        content = cand.get("content", {})
        text_parts = [
            p.get("text", "") for p in content.get("parts", []) if "text" in p
        ]
        text = "".join(text_parts)

        usage = data.get("usageMetadata", {})
        in_tok = int(usage.get("promptTokenCount", 0))
        out_tok = int(usage.get("candidatesTokenCount", 0))
        cost = self._estimate_cost_direct(in_tok, out_tok)

        return GeminiResult(
            text=text,
            finish_reason=cand.get("finishReason", "STOP"),
            input_tokens=in_tok,
            output_tokens=out_tok,
            cost_usd=cost,
            raw=data,
        )

    # -------- Cost estimators -----------------------------------------------

    def _estimate_cost_direct(self, in_tok: int, out_tok: int) -> float:
        pricing = PRICING_DIRECT_USD_PER_M.get(
            self._model, {"input": 0.075, "output": 0.30}
        )
        return (in_tok / 1_000_000.0) * pricing["input"] + (
            out_tok / 1_000_000.0
        ) * pricing["output"]

    def _estimate_cost_kitty(self, in_tok: int, out_tok: int) -> float:
        """Apply Kitty's two-tier pricing — long context (>200K) bills at
        the higher rate. Mirrors the PHP `kitty_agent_calculate_cost`."""
        rates = PRICING_KITTY_USD_PER_M.get(
            self._model, PRICING_KITTY_USD_PER_M[KITTY_AGENT_DEFAULT_MODEL]
        )
        if in_tok > 200_000:
            input_rate = rates["input_long"]
            output_rate = rates["output_long"]
        else:
            input_rate = rates["input_short"]
            output_rate = rates["output_short"]
        return (in_tok / 1_000_000.0) * input_rate + (
            out_tok / 1_000_000.0
        ) * output_rate

    def _estimate_cost(self, in_tok: int, out_tok: int) -> float:
        """Back-compat shim — dispatches to the right estimator based on transport."""
        return (
            self._estimate_cost_kitty(in_tok, out_tok) if self._via_kitty
            else self._estimate_cost_direct(in_tok, out_tok)
        )


# ---- Playtest-review helpers ------------------------------------------------


async def review_playtest_frames(
    frames: list[Path | str],
    *,
    question: str | None = None,
    model: str | None = None,
    tier: str = "flash",
    via_kitty: bool | None = None,
) -> GeminiResult:
    """Send a chronological sequence of playtest screenshots to Gemini for
    a structured bug-hunt verdict.

    Transport priority:
      via_kitty=True  → use Kitty proxy (billed from catmotion_credits).
                        Model defaults to gemini-3.5-flash; Kitty bills at a
                        fixed agent-chat rate regardless of what's requested
                        (per kitty-app-api.php). The `tier` argument is
                        ignored in Kitty mode and we log a notice so the
                        caller knows.
      via_kitty=False → use direct Google AI Studio key. `tier` picks the
                        model:
                          - "lite"  → gemini-3.1-flash-lite (~$0.001/6f)
                          - "flash" → gemini-3.5-flash      (~$0.005/6f)
                          - "pro"   → gemini-2.5-pro        (~$0.05/6f)
      via_kitty=None  → autodetect (Kitty if KITTY_APP_TOKEN set).

    Returns GeminiResult with .text, .cost_usd, .input_tokens, .output_tokens.
    """
    if via_kitty is None:
        via_kitty = _default_use_kitty()

    if via_kitty:
        chosen_model = model or KITTY_AGENT_DEFAULT_MODEL
        if tier != "flash":
            logger.info(
                "review_playtest_frames: tier='{t}' ignored in Kitty mode "
                "(billed at fixed Kitty agent-chat rate). To use the "
                "tier system, pass via_kitty=False with a GEMINI_API_KEY.",
                t=tier,
            )
    else:
        tier_map = {
            "lite": "gemini-3.1-flash-lite",
            "flash": "gemini-3.5-flash",
            "pro": "gemini-2.5-pro",
        }
        chosen_model = model or tier_map.get(tier, "gemini-3.5-flash")

    user_text = (
        f"{len(frames)} chronological frames follow. Apply the system "
        "protocol: delta first, then ranked bugs, then verdict."
    )
    if question:
        user_text += f"\n\nAdditional focus: {question}"

    async with GeminiClient(model=chosen_model, via_kitty=via_kitty) as g:
        return await g.generate(
            system=PLAYTEST_REVIEW_SYSTEM,
            user=user_text,
            images=list(frames),
            temperature=0.2,
            max_output_tokens=2048,
        )


# ---- CLI smoke test --------------------------------------------------------
async def smoke_test() -> None:
    """Verify Gemini API key + multimodal call works."""
    print("[..] Gemini smoke test (text-only first, then image if provided)")

    async with GeminiClient() as g:
        # Text-only
        r1 = await g.generate(
            system="You are concise.",
            user="Say 'OK' and confirm you are Gemini.",
            max_output_tokens=64,
        )
        print(f"[OK] Text reply: {r1.text.strip()[:120]}")
        print(f"     in={r1.input_tokens} out={r1.output_tokens} cost=${r1.cost_usd:.6f}")

        # Try multimodal if a test image exists
        import sys

        if len(sys.argv) > 1:
            img_path = Path(sys.argv[1])
            if img_path.exists():
                print(f"\n[..] Multimodal call with {img_path.name}")
                r2 = await g.generate(
                    system="Describe what you see in 1 sentence.",
                    user="What is in this image?",
                    images=[img_path],
                    max_output_tokens=128,
                )
                print(f"[OK] Vision reply: {r2.text.strip()[:200]}")
                print(f"     in={r2.input_tokens} out={r2.output_tokens} cost=${r2.cost_usd:.6f}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(smoke_test())
