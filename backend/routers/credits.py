"""
Credits router — DruidCat / Kitty App credit balance + cost preview.

Endpoints:
    GET   /api/credits/balance              — live balance from DruidCat
    GET   /api/credits/cost-estimate        — preview cost for an action
    POST  /api/credits/refresh              — force re-fetch (busts cache)
    GET   /api/credits/pricing              — full pricing table
    GET   /api/credits/topup-url            — public top-up URL
    POST  /api/credits/can-afford           — gate before expensive ops
    WS    /api/credits/live                 — pushes balance every 30s + on demand

The credit system is non-blocking: if `DRUIDCAT_USER_TOKEN` is unset the user
runs in `local_only` mode and we just track costs in `usage_tracker` against
local API mode. No API gating happens locally.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel

from core import credits as credits_core

router = APIRouter(prefix="/api/credits", tags=["credits"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class BalanceResponse(BaseModel):
    mode: str
    credits_remaining: int
    formatted: str
    usd_equivalent: float
    tier: str
    tier_label: str
    tier_color: str
    ok: bool
    error: str | None
    last_checked_at: float
    topup_url: str
    account_url: str


class CostEstimateResponse(BaseModel):
    action: str
    credits: int
    usd_equivalent: float
    breakdown: dict[str, Any]


class CreditCheckResponse(BaseModel):
    can_afford: bool
    required_credits: int
    available_credits: int
    shortfall_credits: int
    mode: str
    estimate: CostEstimateResponse
    balance: BalanceResponse


class PricingEntryModel(BaseModel):
    action: str
    label: str
    description: str
    credits: int
    usd: float
    unit: str


class PricingTableResponse(BaseModel):
    entries: list[PricingEntryModel]
    topup_url: str
    account_url: str
    mode: str


class CanAffordRequest(BaseModel):
    action: str
    params: dict[str, Any] | None = None


class TopupUrlResponse(BaseModel):
    topup_url: str
    account_url: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _balance_to_response(b: credits_core.BalanceInfo) -> BalanceResponse:
    return BalanceResponse(
        mode=b.mode,
        credits_remaining=b.credits_remaining,
        formatted=b.formatted,
        usd_equivalent=b.usd_equivalent,
        tier=b.tier,
        tier_label=b.tier_label,
        tier_color=b.tier_color,
        ok=b.ok,
        error=b.error,
        last_checked_at=b.last_checked_at,
        topup_url=b.topup_url,
        account_url=b.account_url,
    )


def _estimate_to_response(e: credits_core.CostEstimate) -> CostEstimateResponse:
    return CostEstimateResponse(
        action=e.action,
        credits=e.credits,
        usd_equivalent=e.usd_equivalent,
        breakdown=e.breakdown,
    )


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


@router.get("/balance", response_model=BalanceResponse)
async def get_balance(force_refresh: bool = False) -> BalanceResponse:
    """Live balance from DruidCat (or `local_only` placeholder)."""
    b = await credits_core.get_balance(force_refresh=force_refresh)
    return _balance_to_response(b)


@router.get("/cost-estimate", response_model=CostEstimateResponse)
async def get_cost_estimate(
    action: str,
    resolution: str = "2K",
    n_animations: int = 5,
    frames_per_anim: int = 4,
    count: int = 1,
    model: str = "deepseek_v4",
    est_input_tokens: int = 4000,
    est_output_tokens: int = 1500,
) -> CostEstimateResponse:
    """Compute the credit cost for an action. Used by UI to show preview."""
    params: dict[str, Any] = {
        "resolution": resolution,
        "count": count,
        "frames_per_anim": frames_per_anim,
        "animations": ["idle"] * n_animations,
        "model": model,
        "est_input_tokens": est_input_tokens,
        "est_output_tokens": est_output_tokens,
    }
    estimate = await credits_core.estimate_cost(action, params)
    return _estimate_to_response(estimate)


@router.post("/refresh", response_model=BalanceResponse)
async def force_refresh() -> BalanceResponse:
    """Bust cache and re-fetch balance. Use after a top-up."""
    credits_core.clear_balance_cache()
    b = await credits_core.get_balance(force_refresh=True)
    return _balance_to_response(b)


@router.get("/pricing", response_model=PricingTableResponse)
async def get_pricing() -> PricingTableResponse:
    """Full pricing table for the Settings → Credits panel."""
    entries = credits_core.get_pricing_table()
    mode = "kitty_app" if credits_core.has_kitty_token() else "local_only"
    return PricingTableResponse(
        entries=[PricingEntryModel(**e.__dict__) for e in entries],
        topup_url=credits_core.get_topup_url(),
        account_url=credits_core.get_account_url(),
        mode=mode,
    )


@router.get("/topup-url", response_model=TopupUrlResponse)
async def get_topup_url() -> TopupUrlResponse:
    return TopupUrlResponse(
        topup_url=credits_core.get_topup_url(),
        account_url=credits_core.get_account_url(),
    )


@router.post("/can-afford", response_model=CreditCheckResponse)
async def can_afford(req: CanAffordRequest) -> CreditCheckResponse:
    """Affordability gate. Returns shortfall when underfunded; never raises."""
    check = await credits_core.check_can_afford(req.action, req.params or {})
    return CreditCheckResponse(
        can_afford=check.can_afford,
        required_credits=check.required_credits,
        available_credits=check.available_credits,
        shortfall_credits=check.shortfall_credits,
        mode=check.mode,
        estimate=_estimate_to_response(check.estimate),
        balance=_balance_to_response(check.balance),
    )


# ---------------------------------------------------------------------------
# WebSocket — live balance push
# ---------------------------------------------------------------------------


@router.websocket("/live")
async def live(ws: WebSocket) -> None:
    """
    Push the current balance every 30s + on demand (client sends `{"type":"refresh"}`).
    Subscribers receive `{"type":"balance","balance":{...}}`.
    """
    await ws.accept()
    try:
        # Initial push
        b = await credits_core.get_balance()
        await ws.send_text(json.dumps({
            "type": "balance",
            "balance": _balance_to_response(b).model_dump(),
        }))

        # Polling task — every 30s
        async def _poller() -> None:
            while True:
                await asyncio.sleep(30)
                try:
                    fresh = await credits_core.get_balance(force_refresh=True)
                    await ws.send_text(json.dumps({
                        "type": "balance",
                        "balance": _balance_to_response(fresh).model_dump(),
                    }))
                except Exception:  # noqa: BLE001
                    break

        poll_task = asyncio.create_task(_poller())
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("type") == "refresh":
                    credits_core.clear_balance_cache()
                    fresh = await credits_core.get_balance(force_refresh=True)
                    await ws.send_text(json.dumps({
                        "type": "balance",
                        "balance": _balance_to_response(fresh).model_dump(),
                    }))
                elif msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
        finally:
            poll_task.cancel()
    except WebSocketDisconnect:
        logger.debug("Credits WS client disconnected.")
    except Exception as e:  # noqa: BLE001
        logger.warning("Credits WS error: {e}", e=str(e)[:200])
