"""
DeepSeek V4 low-level async client (HTTPX).

Why a custom client and not openai-sdk?
- Full control over request/response logging (security-sensitive)
- We can sanitize headers in error paths to prevent token leaks
- Async-first with retry/backoff via tenacity

This module is INTENTIONALLY low-level. Higher-level agent calls go through
`core/llm.py` which adds budget tracking + structured prompts.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx
from loguru import logger
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from core.config import settings


# Pricing per 1M tokens for budget estimation -------------------------------
# Source: https://api-docs.deepseek.com/quick_start/pricing (verify on first use)
PRICING_USD_PER_M = {
    "deepseek-v4-flash": {"input": 0.30, "output": 0.30},
    "deepseek-v4-pro": {"input": 0.50, "output": 1.50},
    "deepseek-chat": {"input": 0.28, "output": 0.42},  # legacy V3.2
}


# Public types --------------------------------------------------------------
Role = Literal["system", "user", "assistant", "tool"]


@dataclass(slots=True)
class TextPart:
    text: str
    type: Literal["text"] = "text"


@dataclass(slots=True)
class ImagePart:
    image_b64: str           # base64-encoded
    media_type: str = "image/png"
    type: Literal["image_url"] = "image_url"

    @classmethod
    def from_path(cls, path: Path | str) -> "ImagePart":
        p = Path(path)
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        ext = p.suffix.lstrip(".").lower() or "png"
        return cls(image_b64=b64, media_type=f"image/{ext}")

    def to_message_content(self) -> dict[str, Any]:
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{self.media_type};base64,{self.image_b64}"},
        }


ContentPart = TextPart | ImagePart


@dataclass(slots=True)
class Message:
    role: Role
    content: str | list[ContentPart]

    def to_payload(self) -> dict[str, Any]:
        if isinstance(self.content, str):
            return {"role": self.role, "content": self.content}
        # multimodal — list of parts
        parts: list[dict[str, Any]] = []
        for part in self.content:
            if isinstance(part, TextPart):
                parts.append({"type": "text", "text": part.text})
            elif isinstance(part, ImagePart):
                parts.append(part.to_message_content())
        return {"role": self.role, "content": parts}


@dataclass(slots=True)
class CompletionResult:
    text: str
    finish_reason: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    raw: dict[str, Any]


# Client --------------------------------------------------------------------
class DeepSeekV4Client:
    """Async client for DeepSeek V4 chat completions API."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        self._api_key = api_key or settings.deepseek_api_key.get_secret_value()
        self._base_url = (base_url or settings.deepseek_base_url).rstrip("/")
        self._model = model or settings.deepseek_model
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "DeepSeekV4Client":
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._timeout,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
        )
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
    async def chat(
        self,
        messages: list[Message],
        *,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> CompletionResult:
        """Send a chat completion request. Multimodal messages supported."""
        if self._client is None:
            raise RuntimeError("Client not entered. Use 'async with DeepSeekV4Client() as c:'")

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": [m.to_payload() for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools is not None:
            payload["tools"] = tools
        if response_format is not None:
            payload["response_format"] = response_format

        # Log meta only — never the payload (could contain secrets / large images)
        logger.debug(
            "DeepSeek call: model={model} msgs={n_msgs} max_tokens={max_tokens}",
            model=self._model,
            n_msgs=len(messages),
            max_tokens=max_tokens,
        )

        try:
            response = await self._client.post("/chat/completions", json=payload)
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            # Truncate response body and never echo headers (Authorization bearer leak)
            safe_body = (e.response.text or "")[:300]
            logger.error(
                "DeepSeek HTTP {status}: {body}",
                status=e.response.status_code,
                body=safe_body,
            )
            raise RuntimeError(
                f"DeepSeek error {e.response.status_code}: {safe_body}"
            ) from None  # `from None` strips chained exception (may contain headers)

        data: dict[str, Any] = response.json()
        choice = data["choices"][0]
        usage = data.get("usage", {})
        in_tok = int(usage.get("prompt_tokens", 0))
        out_tok = int(usage.get("completion_tokens", 0))
        cost = self._estimate_cost(in_tok, out_tok)

        return CompletionResult(
            text=choice["message"].get("content", "") or "",
            finish_reason=choice.get("finish_reason", "stop"),
            input_tokens=in_tok,
            output_tokens=out_tok,
            cost_usd=cost,
            raw=data,
        )

    def _estimate_cost(self, in_tok: int, out_tok: int) -> float:
        pricing = PRICING_USD_PER_M.get(self._model, {"input": 0.30, "output": 0.30})
        return (in_tok / 1_000_000.0) * pricing["input"] + (
            out_tok / 1_000_000.0
        ) * pricing["output"]
