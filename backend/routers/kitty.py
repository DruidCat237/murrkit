"""Kitty AI Studio account endpoints — verify token + balance.

Thin proxy in front of `tools/kitty_api.py` so the frontend never sees the
raw token. The frontend just calls `/api/kitty/balance` and gets back the
current credit balance for the configured token.
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend.routers.settings import _read_env_file
from core.config import settings

router = APIRouter(prefix="/api/kitty", tags=["kitty"])


class BalanceResponse(BaseModel):
    ok: bool
    credits_cents: int = 0
    credits_usd: float = 0.0
    formatted: str = ""
    username: str | None = None
    detail: str = ""
    elapsed_ms: int = 0


def _load_token() -> str:
    """Read the token fresh from .env so just-saved values take effect."""
    env = _read_env_file()
    return (
        env.get("KITTY_APP_TOKEN")
        or (settings.kitty_app_token.get_secret_value() if settings.kitty_app_token else "")
    )


@router.get("/balance", response_model=BalanceResponse)
async def balance() -> BalanceResponse:
    """Return live Kitty credit balance for the configured token."""
    t0 = time.time()
    tok = _load_token()
    if not tok:
        return BalanceResponse(
            ok=False,
            detail="Kitty App code not set",
            elapsed_ms=0,
        )

    from tools import kitty_api  # late import — avoid startup deps

    try:
        # /verify is the cheapest call that returns credits + identity in one shot.
        info = await kitty_api.verify_token(tok)
    except kitty_api.KittyApiError as e:
        return BalanceResponse(
            ok=False,
            detail=str(e),
            elapsed_ms=int((time.time() - t0) * 1000),
        )
    except Exception as e:  # noqa: BLE001
        return BalanceResponse(
            ok=False,
            detail=f"Kitty connection error: {e!s}",
            elapsed_ms=int((time.time() - t0) * 1000),
        )

    cents = _coerce_int(info.get("credits"))

    # If /verify doesn't carry credits in this plugin version, ask /balance directly.
    if cents == 0:
        try:
            bal = await kitty_api.get_balance(tok)
            cents = _coerce_int(bal.get("credits")) or cents
            if not info.get("username") and bal.get("user_login"):
                info["username"] = bal["user_login"]
        except Exception:  # noqa: BLE001
            pass

    usd = cents / 100.0
    formatted = f"${usd:.2f}"
    username = (
        info.get("username")
        or info.get("user_login")
        or info.get("display_name")
        or None
    )
    return BalanceResponse(
        ok=True,
        credits_cents=cents,
        credits_usd=usd,
        formatted=formatted,
        username=username,
        detail=f"Kitty App OK — {username or 'connected'} — {formatted}",
        elapsed_ms=int((time.time() - t0) * 1000),
    )


@router.get("/verify", response_model=BalanceResponse)
async def verify() -> BalanceResponse:
    """Alias for /balance — same response shape, kept for symmetry with the
    upstream `the Kitty AI Studio app` which uses /verify + /balance."""
    return await balance()


class PriceQuote(BaseModel):
    workflow_id: str = "gpt-image-2"
    quality: str = "medium"
    resolution: str = "1K"
    aspect_ratio: str = "1:1"


class PriceResponse(BaseModel):
    cents: int
    usd: float
    formatted: str
    workflow_id: str
    quality: str
    resolution: str
    aspect_ratio: str


@router.post("/price", response_model=PriceResponse)
async def price(quote: PriceQuote) -> PriceResponse:
    """Exact-match price for an image-gen call, using the same formula as the
    production Kitty AI Studio app (mirrors calculateWorkflowCost in
    the Kitty app workflow list). Use this BEFORE submitting jobs so the user sees the
    real cost — never invent estimates client-side."""
    from tools import kitty_api as _k

    cents = _k.estimate_cost_cents(
        workflow_id=quote.workflow_id,
        quality=quote.quality,
        resolution=quote.resolution,
        aspect_ratio=quote.aspect_ratio,
    )
    usd = cents / 100.0
    formatted = f"${usd:.2f}" if usd >= 0.01 else f"${usd:.4f}"
    return PriceResponse(
        cents=cents,
        usd=usd,
        formatted=formatted,
        workflow_id=quote.workflow_id,
        quality=quote.quality,
        resolution=quote.resolution,
        aspect_ratio=quote.aspect_ratio,
    )


def _coerce_int(v: Any) -> int:
    try:
        if v is None:
            return 0
        return int(v)
    except (TypeError, ValueError):
        return 0
