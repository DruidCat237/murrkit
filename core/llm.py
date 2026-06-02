"""
High-level LLM facade with budget tracking.

This is the ONLY entry point agents should use to call LLMs. It:
- enforces budget via `BudgetGuard` (raises before request if would exceed)
- charges actual cost after request
- supports text + multimodal (image) inputs uniformly
- provides convenience helpers for common agent patterns (system+user, vision)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from loguru import logger

from core.config import budget, settings
from core.deepseek_v4 import (
    CompletionResult,
    DeepSeekV4Client,
    Message,
    TextPart,
)

# A rough heuristic for pre-flight budget check (no exact tokenizer pre-call)
_AVG_USD_PER_CALL_ESTIMATE = 0.05


async def complete(
    *,
    system: str,
    user: str,
    images: list[Path | str] | None = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    response_format: dict[str, Any] | None = None,
) -> CompletionResult:
    """
    Smart-route LLM completion:
      - text-only         → DeepSeek V4 (cheap, agentic, code-strong)
      - has images        → Gemini 2.5 Flash (multimodal, free tier 1500/day)
        (DeepSeek V4 is text-only as of April 2026 — see DeepSeek docs)

    Args:
        system: system prompt (instructions, role)
        user: user message text
        images: optional list of image paths — if set, routes to Gemini
        temperature: sampling temperature
        max_tokens: max output tokens
        response_format: optional, e.g. {"type": "json_object"} for JSON output

    Returns:
        CompletionResult — same shape regardless of which provider served it

    Raises:
        BudgetExceededError if pre-flight estimate would exceed budget
        RuntimeError on API error (sanitized)
    """
    budget.check_or_raise(estimated_cost=_AVG_USD_PER_CALL_ESTIMATE)

    # Multimodal → Gemini
    if images:
        from tools.gemini_client import GeminiClient

        # Convert response_format → Gemini's responseMimeType
        mime = None
        if response_format and response_format.get("type") == "json_object":
            mime = "application/json"

        async with GeminiClient() as g:
            gres = await g.generate(
                system=system,
                user=user,
                images=images,
                temperature=temperature,
                max_output_tokens=max_tokens,
                response_mime_type=mime,
            )

        # Adapt to CompletionResult shape so callers don't care which provider
        result = CompletionResult(
            text=gres.text,
            finish_reason=gres.finish_reason,
            input_tokens=gres.input_tokens,
            output_tokens=gres.output_tokens,
            cost_usd=gres.cost_usd,
            raw=gres.raw,
        )
        budget.charge(result.cost_usd)
        logger.info(
            "LLM call (gemini): in={in_tok} out={out_tok} cost=${cost:.6f} budget_left=${left:.4f}",
            in_tok=result.input_tokens,
            out_tok=result.output_tokens,
            cost=result.cost_usd,
            left=budget.remaining_usd,
        )
        return result

    # Text-only → DeepSeek V4
    messages = [
        Message(role="system", content=system),
        Message(role="user", content=user),
    ]
    async with DeepSeekV4Client() as client:
        result = await client.chat(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
        )

    budget.charge(result.cost_usd)
    logger.info(
        "LLM call (deepseek): in={in_tok} out={out_tok} cost=${cost:.5f} budget_left=${left:.4f}",
        in_tok=result.input_tokens,
        out_tok=result.output_tokens,
        cost=result.cost_usd,
        left=budget.remaining_usd,
    )
    return result


async def vision_judge(
    *,
    instruction: str,
    screenshot_path: Path | str,
    expected_intent: str = "",
    extra_context: str = "",
) -> CompletionResult:
    """
    Convenience helper: VLM judge for a single screenshot.

    Used by `agents/tester.py` (decide next action from current frame)
    and `bench/unity_judge.py` (OpenGame-Bench equivalent).
    """
    system = (
        "You are a precise visual judge for a 2D game in development. "
        "Look at the screenshot and answer factually. Output JSON when requested."
    )
    user = f"{instruction}\n\nExpected intent: {expected_intent}\n\nContext: {extra_context}"
    return await complete(
        system=system,
        user=user,
        images=[screenshot_path],
        temperature=0.1,
        max_tokens=2048,
    )


async def smoke_test() -> None:
    """Minimal smoke test: prove the API key + endpoint work."""
    logger.info("Running smoke test against DeepSeek V4...")
    result = await complete(
        system="You are a concise assistant. Reply with one sentence.",
        user="Say 'OK' and confirm you are DeepSeek V4.",
        max_tokens=64,
    )
    logger.success("Smoke test result: {text}", text=result.text.strip())
    logger.info(
        "Tokens in/out: {i}/{o} | cost: ${c:.5f}",
        i=result.input_tokens,
        o=result.output_tokens,
        c=result.cost_usd,
    )
    # Note: avoid unicode emoji here — Windows console (cp1250) can't render them.
    print(f"\n[OK] DeepSeek V4 reachable. Reply: {result.text.strip()}")
    print(f"     Cost: ${result.cost_usd:.5f}  |  Model: {settings.deepseek_model}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(smoke_test())
