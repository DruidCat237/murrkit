"""
ElevenLabs API client — voice + music (ElevenMusic, April 2026) + sound effects.

Endpoints used:
- /v1/text-to-speech/{voice_id}     — voice generation
- /v1/sound-generation               — text-to-sfx (200 credits default, 40/sec custom)
- /v1/music                          — ElevenMusic (April 2026) — verify exact path on first call

Security:
- API key via SecretStr from settings
- Stream responses to disk to avoid loading large WAV/MP3 into RAM
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
from loguru import logger
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from core.config import settings

AudioFormat = Literal["mp3", "wav", "ogg"]


@dataclass(slots=True)
class GeneratedAudio:
    path: Path
    duration_seconds: float | None
    cost_credits: int
    kind: Literal["voice", "sfx", "music"]


class ElevenLabsClient:
    """Async client for ElevenLabs (voice + music + SFX)."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        if api_key is None:
            if settings.elevenlabs_api_key is None:
                raise RuntimeError("ELEVENLABS_API_KEY not set in .env")
            api_key = settings.elevenlabs_api_key.get_secret_value()
        self._api_key = api_key
        self._base_url = (base_url or settings.elevenlabs_base_url).rstrip("/")
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "ElevenLabsClient":
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._timeout,
            headers={"xi-api-key": self._api_key},
        )
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ---- Sound effects (text-to-SFX) ----
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=15),
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.NetworkError)),
        reraise=True,
    )
    async def generate_sfx(
        self,
        prompt: str,
        out_path: Path,
        *,
        duration_seconds: float | None = None,
        prompt_influence: float = 0.3,
    ) -> GeneratedAudio:
        """
        Generate a sound effect from text. Saves MP3 to `out_path`.

        Pricing (per ElevenLabs docs):
        - duration=None (auto): 200 credits flat
        - duration set: 40 credits / second (max 30s)
        """
        if self._client is None:
            raise RuntimeError("Client not entered. Use 'async with ElevenLabsClient() as c:'")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, float | str] = {
            "text": prompt,
            "prompt_influence": prompt_influence,
        }
        if duration_seconds is not None:
            payload["duration_seconds"] = max(0.5, min(30.0, duration_seconds))

        try:
            async with self._client.stream("POST", "/sound-generation", json=payload) as resp:
                resp.raise_for_status()
                with out_path.open("wb") as f:
                    async for chunk in resp.aiter_bytes():
                        f.write(chunk)
        except httpx.HTTPStatusError as e:
            safe_body = (e.response.text or "")[:300]
            logger.error("ElevenLabs SFX HTTP {status}: {body}", status=e.response.status_code, body=safe_body)
            raise RuntimeError(f"ElevenLabs SFX error {e.response.status_code}: {safe_body}") from None

        cost = 200 if duration_seconds is None else int(40 * duration_seconds)
        logger.info("Generated SFX: {path} ({cost} credits)", path=out_path, cost=cost)
        return GeneratedAudio(
            path=out_path, duration_seconds=duration_seconds, cost_credits=cost, kind="sfx"
        )

    # ---- Music (ElevenMusic, April 2026) ----
    async def generate_music(
        self,
        prompt: str,
        out_path: Path,
        *,
        duration_seconds: float = 30.0,
    ) -> GeneratedAudio:
        """
        Generate background music from text prompt.

        NOTE: ElevenMusic launched April 2026 — verify exact endpoint path
        at https://elevenlabs.io/docs on first call. We default to /music.
        """
        if self._client is None:
            raise RuntimeError("Client not entered.")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "prompt": prompt,
            "duration_seconds": duration_seconds,
        }

        try:
            async with self._client.stream("POST", "/music", json=payload) as resp:
                resp.raise_for_status()
                with out_path.open("wb") as f:
                    async for chunk in resp.aiter_bytes():
                        f.write(chunk)
        except httpx.HTTPStatusError as e:
            safe_body = (e.response.text or "")[:300]
            logger.error("ElevenLabs music HTTP {status}: {body}", status=e.response.status_code, body=safe_body)
            raise RuntimeError(
                f"ElevenLabs music error {e.response.status_code}: {safe_body}\n"
                f"Tip: verify endpoint path on https://elevenlabs.io/docs (ElevenMusic API)"
            ) from None

        # Music pricing varies by plan — log credits as 'unknown' for now
        logger.info("Generated music: {path} ({duration}s)", path=out_path, duration=duration_seconds)
        return GeneratedAudio(
            path=out_path, duration_seconds=duration_seconds, cost_credits=0, kind="music"
        )

    # ---- Voice (TTS) ----
    async def generate_voice(
        self,
        text: str,
        out_path: Path,
        *,
        voice_id: str = "JBFqnCBsd6RMkjVDRZzb",  # default ElevenLabs voice ("George")
        model_id: str = "eleven_multilingual_v2",
    ) -> GeneratedAudio:
        """Generate TTS narration. Saves MP3."""
        if self._client is None:
            raise RuntimeError("Client not entered.")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        url = f"/text-to-speech/{voice_id}"
        payload = {
            "text": text,
            "model_id": model_id,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
        }

        try:
            async with self._client.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                with out_path.open("wb") as f:
                    async for chunk in resp.aiter_bytes():
                        f.write(chunk)
        except httpx.HTTPStatusError as e:
            safe_body = (e.response.text or "")[:300]
            logger.error("ElevenLabs TTS HTTP {status}: {body}", status=e.response.status_code, body=safe_body)
            raise RuntimeError(f"ElevenLabs TTS error {e.response.status_code}: {safe_body}") from None

        # TTS billed per character (varies by plan)
        cost = len(text)  # rough proxy: 1 char ≈ 1 credit on most plans
        logger.info("Generated voice: {path} ({chars} chars)", path=out_path, chars=len(text))
        return GeneratedAudio(
            path=out_path, duration_seconds=None, cost_credits=cost, kind="voice"
        )
