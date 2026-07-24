"""
Credit service — bridges murrkit to the DruidCat / Kitty App credit pool.

Background
----------
The DruidCat ecosystem (Kitty AI Studio, Marketing App, CatMotion, NotaGen)
shares a single credit wallet stored as a `catmotion_credits` user-meta on
the WordPress backend at https://druidcat.com.

  - Credits are stored in **cents** ($1 = 100 credits)
  - 1 credit ≈ $0.01 of API cost
  - Balance is read from `/wp-json/marketing-app/v1/balance` with header
    `X-Kitty-Token: <user token>`
  - Top-ups happen on druidcat.com via WooCommerce
  - Pricing matches the existing Kitty App billing in functions-catmotion.php

This module re-implements the same patterns used by the Marketing App's
`kitty-client.ts` so murrkit users can:

  1. Paste a Kitty token → live balance shown in header
  2. See per-action cost preview BEFORE spending
  3. Get blocked with a "top up" modal when out of credits
  4. Fall back to **local API mode** (raw KITTY_APP_TOKEN) if no token set

Cost mapping (in credits / cents)
---------------------------------
  Sprite generation (GPT-Image-2 via Kitty App):
    1K → 4   credits per frame
    2K → 8   credits per frame
    4K → 16  credits per frame
  Asset generation (background / tileset / UI / particle): same per-image
  DeepSeek V4 Flash chat: ~0.1 credit per 1K tokens (negligible)
  Claude Sonnet via Anthropic API: ~0.3 cents per 1K input tokens (with 50%
    markup over Anthropic raw rate to match Marketing App)
  Claude Opus: ~1.5 cents per 1K input tokens

Modes
-----
  - **kitty_app**:    DRUIDCAT_USER_TOKEN is set → balance queried live,
                      credits deducted on-server when calling Kitty App
  - **local_only**:   no token → raw API key used, no credit gating,
                      cost tracked locally in usage_tracker.py

Public surface
--------------
  await get_balance() -> BalanceInfo
  await estimate_cost(action, params) -> CostEstimate
  await check_can_afford(action, params) -> CreditCheck  (raises InsufficientCreditsError)
  get_topup_url() -> str
  get_pricing_table() -> PricingTable
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from loguru import logger

from core.config import settings

# ---------------------------------------------------------------------------
# Constants — extracted from druidcat-website/druidcat-theme/functions-*.php
# ---------------------------------------------------------------------------

DEFAULT_DRUIDCAT_BASE = "https://druidcat.com"
DEFAULT_BALANCE_PATH = "/wp-json/marketing-app/v1/balance"
DEFAULT_VERIFY_PATH = "/wp-json/marketing-app/v1/verify"
DEFAULT_TOPUP_URL = "https://druidcat.com/my-account/?topup=true"
DEFAULT_ACCOUNT_URL = "https://druidcat.com/my-account/"

# 1 credit = 1 cent = $0.01
CENT_PER_CREDIT = 1
USD_PER_CREDIT = 0.01

# GPT-Image-2 per-image cost in CENTS (matches usage_tracker.RESOLUTION_COST_USD)
KITTY_COST_CENTS: dict[str, int] = {
    "1K": 4,    # $0.04
    "2K": 8,    # $0.08
    "4K": 16,   # $0.16
}

# Claude pricing — matches functions-marketing-app.php:marketing_app_pricing()
# Per 1M tokens, USD. We apply a 50% markup (default Marketing App markup).
CLAUDE_PRICING_USD = {
    "claude-fable-5":    {"input": 10.00, "output": 50.00, "cache_write": 12.50, "cache_read": 1.00},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00, "cache_write": 3.75, "cache_read": 0.30},
    # Opus 5 inherits the Opus-tier rate card (same as 4.8) until Anthropic
    # publishes different numbers — update here if they diverge.
    "claude-opus-5":     {"input": 15.00, "output": 75.00, "cache_write": 18.75, "cache_read": 1.50},
    "claude-opus-4-8":   {"input": 15.00, "output": 75.00, "cache_write": 18.75, "cache_read": 1.50},
    "claude-opus-4-7":   {"input": 15.00, "output": 75.00, "cache_write": 18.75, "cache_read": 1.50},
    "claude-haiku-4-5":  {"input": 1.00, "output": 5.00, "cache_write": 1.25, "cache_read": 0.10},
}
CLAUDE_MARKUP_PCT = 50  # +50% = 1.5x raw Anthropic cost

# DeepSeek V4 Flash — published rate (very cheap)
DEEPSEEK_INPUT_USD_PER_1M = 0.07
DEEPSEEK_OUTPUT_USD_PER_1M = 0.27

# Credit tier bands (for UI color coding)
TIER_BANDS = {
    "low":      {"max_cents": 2000,  "label": "Low",      "color": "red"},     # < $20
    "medium":   {"max_cents": 10000, "label": "Medium",   "color": "amber"},   # < $100
    "high":     {"max_cents": 50000, "label": "High",     "color": "green"},   # < $500
    "vip":      {"max_cents": None,  "label": "VIP",      "color": "purple"},  # ≥ $500
}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

CreditMode = Literal["kitty_app", "local_only"]


@dataclass
class BalanceInfo:
    """Snapshot of the user's DruidCat credit balance."""
    mode: CreditMode
    credits_remaining: int       # in cents (= credits); -1 if local_only
    formatted: str               # "$X.XX" — pretty money
    usd_equivalent: float        # credits_remaining / 100
    tier: str                    # "low" | "medium" | "high" | "vip" | "local"
    tier_label: str
    tier_color: str
    ok: bool                     # True if balance fetched successfully
    error: str | None = None     # populated on auth/network failure
    last_checked_at: float = field(default_factory=time.time)
    topup_url: str = DEFAULT_TOPUP_URL
    account_url: str = DEFAULT_ACCOUNT_URL


@dataclass
class CostEstimate:
    """Cost projection for a specific action."""
    action: str
    credits: int                 # in cents
    usd_equivalent: float
    breakdown: dict[str, Any] = field(default_factory=dict)


@dataclass
class CreditCheck:
    """Result of a pre-action affordability check."""
    can_afford: bool
    required_credits: int
    available_credits: int
    shortfall_credits: int
    mode: CreditMode
    estimate: CostEstimate
    balance: BalanceInfo


class InsufficientCreditsError(RuntimeError):
    """Raised when an action would exceed available credits."""

    def __init__(self, check: CreditCheck) -> None:
        self.check = check
        super().__init__(
            f"Insufficient credits: need {check.required_credits}, "
            f"have {check.available_credits} "
            f"(shortfall: {check.shortfall_credits})"
        )


# ---------------------------------------------------------------------------
# Config readers
# ---------------------------------------------------------------------------

def _druidcat_user_token() -> str | None:
    """Returns the user's Kitty API token, or None if unset."""
    raw = os.environ.get("DRUIDCAT_USER_TOKEN", "").strip()
    if raw:
        return raw
    # Pydantic Settings doesn't have this field by default, so read raw .env
    # via the same _read_env_file pattern (lazy import to avoid cycle)
    try:
        from backend.routers.settings import _read_env_file
        env = _read_env_file()
        v = env.get("DRUIDCAT_USER_TOKEN", "").strip()
        return v or None
    except Exception:  # noqa: BLE001
        return None


def _druidcat_base() -> str:
    return os.environ.get("DRUIDCAT_BASE_URL", DEFAULT_DRUIDCAT_BASE).rstrip("/")


def get_topup_url() -> str:
    """Returns the public top-up URL (configurable via env)."""
    return os.environ.get("DRUIDCAT_TOPUP_URL", DEFAULT_TOPUP_URL)


def get_account_url() -> str:
    return os.environ.get("DRUIDCAT_ACCOUNT_URL", DEFAULT_ACCOUNT_URL)


def _classify_tier(credits: int) -> tuple[str, str, str]:
    if credits < 0:
        return ("local", "Local Mode", "neutral")
    for tier_id, band in TIER_BANDS.items():
        max_c = band["max_cents"]
        if max_c is None or credits < max_c:
            return (tier_id, band["label"], band["color"])
    return ("vip", "VIP", "purple")


# ---------------------------------------------------------------------------
# Balance fetch — with cache-busting matching kitty-client.ts pattern
# ---------------------------------------------------------------------------

_BALANCE_CACHE: dict[str, tuple[BalanceInfo, float]] = {}
_CACHE_TTL_SEC = 5.0   # short — balance changes after every operation


async def get_balance(*, force_refresh: bool = False) -> BalanceInfo:
    """
    Fetch the user's DruidCat credit balance.

    Returns a `BalanceInfo` with `mode='local_only'` and `credits_remaining=-1`
    when no DRUIDCAT_USER_TOKEN is configured — in that case the app falls
    back to the raw KITTY_APP_TOKEN and tracks costs locally.

    Returns `ok=False` with an `error` field on token/network failure but
    NEVER raises. The UI surfaces the error inline so the user can fix it.
    """
    token = _druidcat_user_token()
    if not token:
        return BalanceInfo(
            mode="local_only",
            credits_remaining=-1,
            formatted="—",
            usd_equivalent=0.0,
            tier="local",
            tier_label="Local Mode",
            tier_color="neutral",
            ok=True,
            error=None,
            topup_url=get_topup_url(),
            account_url=get_account_url(),
        )

    # Tiny in-process cache — avoid hammering DruidCat on every request
    cache_key = token[:12]
    if not force_refresh:
        cached = _BALANCE_CACHE.get(cache_key)
        if cached and (time.time() - cached[1]) < _CACHE_TTL_SEC:
            return cached[0]

    base = _druidcat_base()
    # Cache-bust query param + headers (same as kitty-client.ts)
    ts = int(time.time() * 1000)
    url = f"{base}{DEFAULT_BALANCE_PATH}?_={ts}"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                url,
                headers={
                    "X-Kitty-Token": token,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                },
            )
        if r.status_code == 401:
            info = BalanceInfo(
                mode="kitty_app",
                credits_remaining=0,
                formatted="—",
                usd_equivalent=0.0,
                tier="low",
                tier_label="Token Invalid",
                tier_color="red",
                ok=False,
                error=(
                    "Kitty token rejected by DruidCat. Generate a fresh one at "
                    f"{get_account_url()} → My Account → API Token."
                ),
                topup_url=get_topup_url(),
                account_url=get_account_url(),
            )
            _BALANCE_CACHE[cache_key] = (info, time.time())
            return info
        if r.status_code != 200:
            # Transient upstream hiccup (502/503/timeout page) — a recent good
            # balance is far more useful than zeroing the user out and blocking
            # every paid action. Serve the cache if we have one.
            cached = _BALANCE_CACHE.get(cache_key)
            if cached is not None:
                return cached[0]
            return BalanceInfo(
                mode="kitty_app",
                credits_remaining=0,
                formatted="—",
                usd_equivalent=0.0,
                tier="low",
                tier_label="Error",
                tier_color="red",
                ok=False,
                error=f"DruidCat /balance returned HTTP {r.status_code}: {r.text[:200]}",
                topup_url=get_topup_url(),
                account_url=get_account_url(),
            )
        body: dict[str, Any] = r.json()
        cents = int(body.get("credits", 0))
        formatted = str(body.get("formatted", f"${cents/100:.2f}"))
        tier_id, tier_label, tier_color = _classify_tier(cents)
        info = BalanceInfo(
            mode="kitty_app",
            credits_remaining=cents,
            formatted=formatted,
            usd_equivalent=cents / 100,
            tier=tier_id,
            tier_label=tier_label,
            tier_color=tier_color,
            ok=True,
            error=None,
            topup_url=get_topup_url(),
            account_url=get_account_url(),
        )
        _BALANCE_CACHE[cache_key] = (info, time.time())
        return info
    except Exception as e:  # noqa: BLE001
        logger.warning("DruidCat /balance fetch error: {e}", e=str(e)[:200])
        # Network blip / DNS / timeout — the error string already promises a
        # cached fallback, so actually honour it: return the last good balance
        # if one is cached rather than falsely zeroing the user's credits.
        cached = _BALANCE_CACHE.get(cache_key)
        if cached is not None:
            return cached[0]
        return BalanceInfo(
            mode="kitty_app",
            credits_remaining=0,
            formatted="—",
            usd_equivalent=0.0,
            tier="low",
            tier_label="Offline",
            tier_color="amber",
            ok=False,
            error=f"Couldn't reach DruidCat ({type(e).__name__}) and no cached balance yet.",
            topup_url=get_topup_url(),
            account_url=get_account_url(),
        )


def clear_balance_cache() -> None:
    _BALANCE_CACHE.clear()


# ---------------------------------------------------------------------------
# Cost estimation
# ---------------------------------------------------------------------------

def _cents(usd: float) -> int:
    """Round UP to next cent — protects us from rounding-down losses."""
    return max(1, int(usd * 100 + 0.5))


def _estimate_sprite(params: dict[str, Any]) -> CostEstimate:
    """
    Sprite-sheet character generation cost.
    params: { animations: [...], frames_per_anim: int, resolution: '1K'|'2K'|'4K' }
    """
    animations = params.get("animations") or ["idle", "walk", "attack", "hurt", "death"]
    frames = int(params.get("frames_per_anim", 4))
    resolution = (params.get("resolution") or "2K").upper()
    n_frames = len(animations) * frames
    per_frame = KITTY_COST_CENTS.get(resolution, 8)
    total = n_frames * per_frame
    return CostEstimate(
        action="sprite_gen_character",
        credits=total,
        usd_equivalent=total / 100,
        breakdown={
            "n_animations": len(animations),
            "frames_per_anim": frames,
            "total_frames": n_frames,
            "resolution": resolution,
            "per_frame_credits": per_frame,
        },
    )


def _estimate_asset(params: dict[str, Any]) -> CostEstimate:
    """
    Single asset generation cost (background, tileset, UI, particle).
    params: { resolution: '1K'|'2K'|'4K', count?: int }
    """
    resolution = (params.get("resolution") or "2K").upper()
    count = int(params.get("count", 1))
    per_image = KITTY_COST_CENTS.get(resolution, 8)
    total = per_image * count
    return CostEstimate(
        action=params.get("asset_type", "asset_gen"),
        credits=total,
        usd_equivalent=total / 100,
        breakdown={
            "resolution": resolution,
            "count": count,
            "per_image_credits": per_image,
        },
    )


def _estimate_chat(params: dict[str, Any]) -> CostEstimate:
    """
    Chat turn cost (rough estimate — actual cost computed post-hoc).
    params: { model: 'deepseek_v4'|'claude_sonnet'|'claude_opus', est_input_tokens, est_output_tokens }
    """
    model = params.get("model", "deepseek_v4")
    in_tokens = int(params.get("est_input_tokens", 4000))
    out_tokens = int(params.get("est_output_tokens", 1500))

    if model == "deepseek_v4":
        usd = (in_tokens * DEEPSEEK_INPUT_USD_PER_1M + out_tokens * DEEPSEEK_OUTPUT_USD_PER_1M) / 1_000_000
        cents = _cents(usd)
        return CostEstimate(
            action="chat_deepseek",
            credits=cents,
            usd_equivalent=cents / 100,
            breakdown={"model": model, "input_tokens": in_tokens, "output_tokens": out_tokens, "raw_usd": usd},
        )

    # Claude — apply markup
    claude_model = {
        "claude_sonnet": "claude-sonnet-4-6",
        "claude_opus":   "claude-opus-5",  # heavy captain route = Opus 5
        "claude_fable":  "claude-fable-5",   # premium Fable 5 route
        "claude_haiku":  "claude-haiku-4-5",
    }.get(model, "claude-sonnet-4-6")
    rates = CLAUDE_PRICING_USD[claude_model]
    raw_usd = (in_tokens * rates["input"] + out_tokens * rates["output"]) / 1_000_000
    marked = raw_usd * (1 + CLAUDE_MARKUP_PCT / 100)
    cents = _cents(marked)
    return CostEstimate(
        action=f"chat_{model}",
        credits=cents,
        usd_equivalent=cents / 100,
        breakdown={
            "model": claude_model,
            "input_tokens": in_tokens,
            "output_tokens": out_tokens,
            "raw_anthropic_usd": raw_usd,
            "markup_pct": CLAUDE_MARKUP_PCT,
            "final_usd": marked,
        },
    )


async def estimate_cost(action: str, params: dict[str, Any] | None = None) -> CostEstimate:
    """Returns the credit cost for a given action — gate for the UI cost preview."""
    p = params or {}
    if action in ("sprite_gen_character", "spritesheet"):
        return _estimate_sprite(p)
    if action.startswith("asset_gen") or action in ("background", "tileset", "ui_element", "particle_fx"):
        if action != "asset_gen":
            p.setdefault("asset_type", action)
        return _estimate_asset(p)
    if action.startswith("chat") or action in ("deepseek_v4", "claude_sonnet", "claude_opus", "claude_fable"):
        if action in ("deepseek_v4", "claude_sonnet", "claude_opus", "claude_fable"):
            p.setdefault("model", action)
        return _estimate_chat(p)
    if action == "build_game":
        # Full-game template build: sprite + assets + chat orchestration
        # Rough estimate — actual depends on template
        return CostEstimate(
            action="build_game",
            credits=p.get("estimated_credits", 200),  # ~$2
            usd_equivalent=p.get("estimated_credits", 200) / 100,
            breakdown={"note": "Aggregate template cost — see template manifest"},
        )

    # Unknown action — return zero so we don't block unintentionally
    return CostEstimate(action=action, credits=0, usd_equivalent=0.0, breakdown={"warning": "unknown action"})


# ---------------------------------------------------------------------------
# Affordability gate
# ---------------------------------------------------------------------------

async def check_can_afford(
    action: str,
    params: dict[str, Any] | None = None,
    *,
    raise_on_fail: bool = False,
) -> CreditCheck:
    """
    Pre-action credit gate. Call BEFORE the expensive API request.

    In `local_only` mode, always returns can_afford=True (raw API key billing
    handled by usage_tracker.py + BudgetGuard).

    Set `raise_on_fail=True` to raise InsufficientCreditsError instead.
    """
    estimate = await estimate_cost(action, params)
    balance = await get_balance()

    if balance.mode == "local_only":
        return CreditCheck(
            can_afford=True,
            required_credits=estimate.credits,
            available_credits=-1,
            shortfall_credits=0,
            mode="local_only",
            estimate=estimate,
            balance=balance,
        )

    available = balance.credits_remaining
    required = estimate.credits
    shortfall = max(0, required - available)
    can_afford = available >= required

    check = CreditCheck(
        can_afford=can_afford,
        required_credits=required,
        available_credits=available,
        shortfall_credits=shortfall,
        mode="kitty_app",
        estimate=estimate,
        balance=balance,
    )
    if not can_afford and raise_on_fail:
        raise InsufficientCreditsError(check)
    return check


# ---------------------------------------------------------------------------
# Pricing table — surfaces all costs to the UI in one shot
# ---------------------------------------------------------------------------

@dataclass
class PricingEntry:
    action: str
    label: str
    description: str
    credits: int
    usd: float
    unit: str  # "per frame", "per image", "per 1K tokens", etc.


def get_pricing_table() -> list[PricingEntry]:
    """Returns the full pricing table for display in Settings + Modal."""
    out: list[PricingEntry] = []

    # GPT-Image-2 per-image
    for res, cents in KITTY_COST_CENTS.items():
        out.append(PricingEntry(
            action=f"kitty_{res.lower()}",
            label=f"Image generation — {res}",
            description=f"GPT-Image-2 via Kitty App, {res} resolution",
            credits=cents,
            usd=cents / 100,
            unit="per image",
        ))

    # Chat models — per 1K input tokens (output usually ~30-50% of input cost)
    for model_key, claude_model in [
        ("claude_sonnet", "claude-sonnet-4-6"),
        ("claude_opus", "claude-opus-5"),
        ("claude_fable", "claude-fable-5"),
        ("claude_haiku", "claude-haiku-4-5"),
    ]:
        rates = CLAUDE_PRICING_USD[claude_model]
        raw_usd_1k = rates["input"] / 1000
        with_markup = raw_usd_1k * (1 + CLAUDE_MARKUP_PCT / 100)
        cents_1k = max(1, int(round(with_markup * 100)))
        out.append(PricingEntry(
            action=model_key,
            label=f"{model_key.replace('_', ' ').title()} chat",
            description=f"{claude_model} via Kitty proxy (incl. {CLAUDE_MARKUP_PCT}% markup)",
            credits=cents_1k,
            usd=cents_1k / 100,
            unit="per 1K input tokens",
        ))

    # DeepSeek
    deepseek_usd_1k = DEEPSEEK_INPUT_USD_PER_1M / 1000
    out.append(PricingEntry(
        action="deepseek_v4",
        label="DeepSeek V4 Flash",
        description="Cheap orchestrator — text reasoning, no markup",
        credits=max(1, int(round(deepseek_usd_1k * 100))),
        usd=deepseek_usd_1k,
        unit="per 1K input tokens",
    ))

    # Bundle estimates for full sprite sheets
    out.append(PricingEntry(
        action="sprite_sheet_5anim_4frames_2k",
        label="Sprite sheet — 5 anims × 4 frames @ 2K",
        description="Typical character sprite sheet (idle/walk/attack/hurt/death)",
        credits=5 * 4 * KITTY_COST_CENTS["2K"],
        usd=(5 * 4 * KITTY_COST_CENTS["2K"]) / 100,
        unit="bundle",
    ))
    out.append(PricingEntry(
        action="full_game_tic_tac_toe",
        label="Cat-Tac-Toe full game",
        description="Sprites + UI + chat orchestration end-to-end",
        credits=120,
        usd=1.20,
        unit="estimate",
    ))

    return out


# ---------------------------------------------------------------------------
# Helpers for routers
# ---------------------------------------------------------------------------

def has_kitty_token() -> bool:
    return _druidcat_user_token() is not None
