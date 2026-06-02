"""
Qwen 3.7 Max client — multimodal peer for Claude.

Routes through the user's Kitty App balance (NOT a direct upstream account) so:
  - Single auth token (KITTY_APP_TOKEN, already in .env)
  - Single balance to track (no separate upstream API key for the user)
  - 33% markup applied server-side at Kitty, transparent to user
  - User never sees the upstream provider — only "Peer via Kitty"

Why Qwen 3.7 Max
----------------
- Multimodal (image input) — can read Game-view screenshots
- 1M-token context — full game console + scene hierarchy + multiple
  screenshots fit in one prompt
- $2.5/M input + $7.5/M output (original; 50%-off promo runs 2026)
  → ~6× cheaper than Claude Opus for the same multimodal call
- Strong agentic tool-use — can call tools like Claude does

Use it for
----------
- Peer-review Claude's plan BEFORE the user spends Kitty money on gen
- Vision-verify game screenshots ("is the white cat actually centered?")
- Generate playtest reports (read console log + 5 screenshots → markdown report)
- Test-plan generation ("list 10 ways to break this tic-tac-toe scene")

NOT for
-------
- Replacing Claude as the orchestrator (the peer is the consultant, not the captain)
- Tool execution against the game engine (Claude has the MCP wiring)

Hard limits (set per-session by the user)
------------------------------------------
- max_tokens: hard cap. Calls past this return KitkitTokenLimitError.
- max_tokens_per_minute: burn-protection rate limit (default 50 000/min).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Sequence

import httpx
from loguru import logger
from pydantic import BaseModel

from core.config import settings


# ============================================================================
# Pricing (original upstream prices — limited-time 50%-off is ignored to
# stay safe when promo ends). 33% markup applied at Kitty when charging.
# ============================================================================

ORIGINAL_PRICE_USD_PER_M = {
    "input": 2.5,
    "cache_create": 3.125,
    "cache_read": 0.25,
    "output": 7.5,
}
KITTY_MARKUP = 1.33

# When user reserves N tokens, we charge upfront at this blended worst-case
# rate so the reservation always covers actual usage. Conservative because
# we'd rather refund excess than fail mid-call when budget runs out.
BLENDED_RESERVE_PRICE_USD_PER_M = ORIGINAL_PRICE_USD_PER_M["cache_create"]  # 3.125

KITTY_API_BASE = "https://druidcat.com/wp-json/kitty-app/v1"


# ============================================================================
# Errors
# ============================================================================


class QwenError(Exception):
    """Base for all Qwen errors."""


class QwenTokenLimitError(QwenError):
    """Raised when the session's hard token cap would be exceeded."""


class QwenRateLimitError(QwenError):
    """Raised when burn-protection rate-limit is hit."""


class QwenKittyError(QwenError):
    """Kitty proxy returned non-2xx (insufficient balance, bad token, etc)."""


# ============================================================================
# Per-session budget state — used by the router for hard limit enforcement
# ============================================================================


@dataclass
class QwenBudget:
    """Per-session Qwen budget.

    `reserved_tokens` is what the user committed to (and is paying Kitty
    for upfront, at markup). `used_tokens` is the actual consumption. When
    used >= reserved, further calls fail loudly.
    """
    session_id: str
    reserved_tokens: int = 0
    used_tokens: int = 0
    cost_usd_actual: float = 0.0      # raw upstream cost (no markup)
    cost_usd_billed: float = 0.0      # what Kitty actually charged user
    call_count: int = 0
    last_call_at: float = 0.0
    # Burn-protection: tokens used in the last 60s
    minute_window: list[tuple[float, int]] = field(default_factory=list)
    max_tokens_per_minute: int = 50_000

    def remaining_tokens(self) -> int:
        return max(0, self.reserved_tokens - self.used_tokens)

    def upfront_cost_usd(self) -> float:
        """What the user paid Kitty when committing this reservation."""
        return self.reserved_tokens / 1_000_000.0 * BLENDED_RESERVE_PRICE_USD_PER_M * KITTY_MARKUP

    def check_rate_limit(self, projected_tokens: int) -> None:
        """Raise if we'd exceed max_tokens_per_minute."""
        now = time.time()
        # Drop entries older than 60s
        self.minute_window = [(t, n) for t, n in self.minute_window if now - t < 60]
        recent = sum(n for _, n in self.minute_window)
        if recent + projected_tokens > self.max_tokens_per_minute:
            raise QwenRateLimitError(
                f"burn-protection: {recent + projected_tokens} tokens/min would "
                f"exceed cap {self.max_tokens_per_minute}. Wait ~{60 - (now - self.minute_window[0][0]):.0f}s."
            )

    def check_hard_limit(self, projected_tokens: int) -> None:
        if self.used_tokens + projected_tokens > self.reserved_tokens:
            raise QwenTokenLimitError(
                f"hard limit: {self.used_tokens + projected_tokens} tokens would "
                f"exceed reservation {self.reserved_tokens}. Increase limit + "
                f"top up Kitty balance to continue."
            )

    def record_call(self, input_tokens: int, output_tokens: int) -> None:
        total = input_tokens + output_tokens
        self.used_tokens += total
        self.cost_usd_actual += (
            input_tokens / 1_000_000.0 * ORIGINAL_PRICE_USD_PER_M["input"]
            + output_tokens / 1_000_000.0 * ORIGINAL_PRICE_USD_PER_M["output"]
        )
        self.cost_usd_billed = self.cost_usd_actual * KITTY_MARKUP
        self.call_count += 1
        self.last_call_at = time.time()
        self.minute_window.append((self.last_call_at, total))


# ============================================================================
# HTTP client
# ============================================================================


class QwenMessage(BaseModel):
    role: str  # "system" | "user" | "assistant"
    content: str | list[dict[str, Any]]  # str OR multimodal blocks


async def qwen_chat(
    messages: Sequence[QwenMessage | dict[str, Any]],
    *,
    budget: QwenBudget,
    model: str = "qwen3.7-max",
    temperature: float = 0.3,
    max_output_tokens: int = 4096,
    enable_thinking: bool = False,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Call Qwen 3.7 Max via Kitty proxy. Hard-limit + rate-check before send.

    Returns dict:
        {
            "text": "...",                  # assistant message (may be empty if tool_calls)
            "tool_calls": [...] | None,     # OpenAI-format tool_calls if any
            "input_tokens": int,
            "output_tokens": int,
            "cost_usd": float,              # billed (with 33% markup)
            "finish_reason": str,
            "raw": {...},                   # full Kitty/Qwen response
        }

    Pass `tools=` (OpenAI schema list) to enable agent-mode. When Qwen
    decides to call a tool, `tool_calls` will be populated and `text` may
    be empty. The caller is responsible for dispatching the tools and
    looping back via another qwen_chat() with the assistant message +
    tool results appended.

    Raises QwenTokenLimitError / QwenRateLimitError / QwenKittyError.
    """
    if not settings.kitty_app_token:
        raise QwenKittyError("KITTY_APP_TOKEN missing in .env")

    # Pre-flight token check — assume worst case of max_output_tokens being
    # produced so we never go over reservation mid-stream.
    projected = _estimate_input_tokens(messages) + max_output_tokens
    budget.check_rate_limit(projected)
    budget.check_hard_limit(projected)

    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            (m.model_dump() if isinstance(m, QwenMessage) else m) for m in messages
        ],
        "temperature": temperature,
        "max_tokens": max_output_tokens,
        "enable_thinking": enable_thinking,
    }
    if tools:
        payload["tools"] = tools
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice
    headers = {
        "X-Kitty-Token": settings.kitty_app_token.get_secret_value(),
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
    }
    cache_buster = {"_t": int(time.time() * 1000)}  # LiteSpeed bypass — same as gpt-image-2

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            r = await client.post(
                f"{KITTY_API_BASE}/qwen-chat",
                json=payload,
                headers=headers,
                params=cache_buster,
            )
        except httpx.RequestError as e:
            raise QwenKittyError(f"network error talking to Kitty: {e!s}") from None

    if r.status_code == 402:
        raise QwenKittyError("insufficient Kitty balance — top up at druidcat.com")
    if r.status_code >= 400:
        raise QwenKittyError(f"Kitty HTTP {r.status_code}: {r.text[:300]}")

    data = r.json()
    # Kitty wraps the upstream response: {choices:[{message:{content, tool_calls?}}], usage:{...}, ...}
    choices = data.get("choices") or []
    text = ""
    tool_calls: list[dict[str, Any]] | None = None
    finish_reason = ""
    if choices:
        msg = choices[0].get("message") or {}
        text = msg.get("content") or ""
        raw_tool_calls = msg.get("tool_calls")
        if raw_tool_calls:
            # Normalise to OpenAI format. Each entry must have id + function.name + function.arguments.
            tool_calls = []
            for tc in raw_tool_calls:
                fn = tc.get("function") or {}
                tool_calls.append({
                    "id": tc.get("id") or f"call_{int(time.time() * 1000)}",
                    "type": tc.get("type") or "function",
                    "function": {
                        "name": fn.get("name") or "",
                        # `arguments` is always a JSON-encoded string per OpenAI spec.
                        "arguments": fn.get("arguments") if isinstance(fn.get("arguments"), str)
                        else __import__("json").dumps(fn.get("arguments") or {}),
                    },
                })
        finish_reason = choices[0].get("finish_reason") or ""
    usage = data.get("usage") or {}
    in_tok = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    out_tok = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)

    budget.record_call(in_tok, out_tok)
    logger.info(
        "Qwen call ok: in={i} out={o} cost=${c:.4f} (billed=${b:.4f}) "
        "remaining_tokens={r} tool_calls={t}",
        i=in_tok, o=out_tok,
        c=in_tok / 1e6 * ORIGINAL_PRICE_USD_PER_M["input"] + out_tok / 1e6 * ORIGINAL_PRICE_USD_PER_M["output"],
        b=(in_tok / 1e6 * ORIGINAL_PRICE_USD_PER_M["input"] + out_tok / 1e6 * ORIGINAL_PRICE_USD_PER_M["output"]) * KITTY_MARKUP,
        r=budget.remaining_tokens(),
        t=len(tool_calls or []),
    )

    return {
        "text": text,
        "tool_calls": tool_calls,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "cost_usd": (in_tok / 1e6 * ORIGINAL_PRICE_USD_PER_M["input"] + out_tok / 1e6 * ORIGINAL_PRICE_USD_PER_M["output"]) * KITTY_MARKUP,
        "finish_reason": finish_reason,
        "raw": data,
    }


async def qwen_vision(
    image_path: str,
    prompt: str,
    *,
    budget: QwenBudget,
    system: str | None = None,
    max_output_tokens: int = 2048,
) -> dict[str, Any]:
    """Convenience wrapper for image-input calls.

    Reads `image_path` from disk, base64-encodes, sends as multimodal user
    message. Use for "look at this game screenshot and tell me what's off".
    """
    import base64
    from pathlib import Path

    p = Path(image_path)
    if not p.is_file():
        raise QwenError(f"image not found: {image_path}")
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    data_url = f"data:image/png;base64,{b64}"

    messages: list[QwenMessage | dict[str, Any]] = []
    if system:
        messages.append(QwenMessage(role="system", content=system))
    messages.append({
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": data_url}},
            {"type": "text", "text": prompt},
        ],
    })
    # qwen3.7-max is text-only — image content must go to a Qwen-VL model.
    return await qwen_chat(
        messages,
        budget=budget,
        max_output_tokens=max_output_tokens,
        model="qwen-vl-max-latest",
    )


def _estimate_input_tokens(messages: Sequence[QwenMessage | dict[str, Any]]) -> int:
    """Rough char/4 estimate for pre-flight budget check. Doesn't need to
    be exact — only used to decide whether to even attempt the call."""
    total = 0
    for m in messages:
        if isinstance(m, QwenMessage):
            content = m.content
        else:
            content = m.get("content", "")
        if isinstance(content, str):
            total += len(content) // 4
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        total += len(block.get("text", "")) // 4
                    elif block.get("type") == "image_url":
                        total += 1000  # ~1k tokens per image (Qwen-VL average)
    return max(total, 1)
