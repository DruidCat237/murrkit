"""
Unified vision / playtest-review gateway.

Claude (the captain) calls this instead of going directly to a specific
vendor. The default provider is `gemini` (cheap, native video, $0.10-0.30
per million tokens). Qwen-VL is kept as a `fallback` provider — Claude
must EXPLICITLY ask for it ("I want a second opinion from a different
vendor"); never auto-selected.

Why this exists
---------------
The earlier pipeline auto-routed any image-bearing /peer/send through
Qwen-VL via Kitty proxy. That:
  - cost more than Gemini for the same quality
  - depended on the upstream provider's availability via Kitty
  - made it tempting to use Qwen for things text-only models would
    handle better
This router enforces "Gemini first, Qwen on explicit request" so we stop
wasting tokens.

Endpoints
---------
POST /api/vision/review     — multi-frame playtest review (Gemini default)
POST /api/vision/triage     — log/console triage (DeepSeek V4 Flash)
POST /api/vision/providers  — list available providers + their tiers
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/vision", tags=["vision"])


# ============================================================================
# Vision-review history — persists every /review and /triage call so the
# frontend can show "Claude just consulted Gemini at 19:42, cost $0.012,
# verdict ❌ broken" timeline. Stored on disk + broadcast over WebSocket
# so the panel updates live.
# ============================================================================

_HISTORY_STORE = (
    Path(__file__).resolve().parents[2] / ".omc" / "state" / "vision_history.json"
)
_HISTORY_MAX = 200  # rolling buffer per project
_HISTORY_LOCK = asyncio.Lock()  # protects concurrent writes


def _load_history() -> dict[str, list[dict[str, Any]]]:
    if not _HISTORY_STORE.is_file():
        return {}
    try:
        return json.loads(_HISTORY_STORE.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001 — corrupt file shouldn't kill the server
        logger.warning("vision history load failed: {e}", e=e)
        return {}


async def _record(project: str, entry: dict[str, Any]) -> None:
    """Append entry to project history, persist, broadcast over WS."""
    async with _HISTORY_LOCK:
        store = _load_history()
        bucket = store.setdefault(project, [])
        bucket.append(entry)
        # Trim rolling buffer
        if len(bucket) > _HISTORY_MAX:
            store[project] = bucket[-_HISTORY_MAX:]
        try:
            _HISTORY_STORE.parent.mkdir(parents=True, exist_ok=True)
            tmp = _HISTORY_STORE.with_suffix(".tmp")
            tmp.write_text(json.dumps(store, indent=2), encoding="utf-8")
            tmp.replace(_HISTORY_STORE)
        except Exception as e:  # noqa: BLE001
            logger.warning("vision history persist failed: {e}", e=e)
    # Broadcast outside the lock to avoid holding it during slow WS sends
    await _broadcast(entry)


# ---- WebSocket fanout -----------------------------------------------------

_subscribers: set[WebSocket] = set()


async def _broadcast(entry: dict[str, Any]) -> None:
    if not _subscribers:
        return
    dead: list[WebSocket] = []
    for ws in list(_subscribers):
        try:
            await ws.send_json(entry)
        except Exception:  # noqa: BLE001 — drop disconnected subscribers
            dead.append(ws)
    for ws in dead:
        _subscribers.discard(ws)


@router.websocket("/ws")
async def vision_ws(ws: WebSocket) -> None:
    """Live stream of vision review/triage events.

    Each event is a JSON object with `{type, project, provider, model,
    cost_usd, tokens, ts, ...}`. Frontend subscribes and updates a
    timeline panel in real time.
    """
    await ws.accept()
    _subscribers.add(ws)
    try:
        while True:
            # We never receive from the client — keep the socket alive
            # by reading + discarding any incoming pings.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _subscribers.discard(ws)


@router.get("/history")
async def get_history(project: str = "default", limit: int = 50) -> dict[str, Any]:
    """Return the rolling vision-review history for a project."""
    store = _load_history()
    entries = store.get(project, [])
    return {
        "project": project,
        "total": len(entries),
        "entries": entries[-limit:][::-1],  # newest first
    }


@router.delete("/history")
async def clear_history(project: str = "default") -> dict[str, Any]:
    async with _HISTORY_LOCK:
        store = _load_history()
        removed = len(store.pop(project, []))
        try:
            _HISTORY_STORE.parent.mkdir(parents=True, exist_ok=True)
            _HISTORY_STORE.write_text(json.dumps(store, indent=2), encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            logger.warning("vision history clear failed: {e}", e=e)
    return {"project": project, "removed": removed}


# ---- /providers -------------------------------------------------------------


@router.get("/providers")
async def list_providers() -> dict[str, Any]:
    """Return the routing table so Claude knows what's available + when to
    use each. This doubles as a documentation endpoint."""
    from tools.gemini_client import _default_use_kitty

    via_kitty = _default_use_kitty()
    gemini_info: dict[str, Any] = {
        "purpose": "Default playtest screenshot / video review.",
        "transport": "kitty_proxy" if via_kitty else "direct_google_ai",
        "transport_note": (
            "Billed from catmotion_credits via Druidcat Kitty App "
            "(/wp-json/kitty-app/v1/agent/chat). No Google Cloud setup "
            "needed."
            if via_kitty
            else "Direct Google AI Studio (GEMINI_API_KEY in .env)."
        ),
    }
    if via_kitty:
        gemini_info["model"] = "gemini-3.5-flash"
        gemini_info["pricing"] = {
            "input_short_ctx_m_usd": 2.86,    # 2.00 * 1.43 margin
            "input_long_ctx_m_usd": 5.72,     # 4.00 * 1.43 (>200K ctx)
            "output_short_ctx_m_usd": 17.16,  # 12.00 * 1.43
            "output_long_ctx_m_usd": 25.74,   # 18.00 * 1.43
            "approx_cost_per_6_frame_review_usd": 0.01,
            "kitty_margin": "43%",
        }
        gemini_info["note"] = (
            "Kitty mode bills at a fixed agent-chat rate regardless of "
            "requested model. Tier param ('lite/flash/pro') is ignored."
        )
    else:
        gemini_info["tiers"] = {
            "lite": {
                "model": "gemini-3.1-flash-lite",
                "cost_per_m_input_usd": 0.075,
                "cost_per_m_output_usd": 0.30,
                "use_for": "cheap screenshot sweeps, 'did anything change/break' style checks",
            },
            "flash": {
                "model": "gemini-3.5-flash",
                "cost_per_m_input_usd": 0.15,
                "cost_per_m_output_usd": 0.60,
                "use_for": "default bug-hunt verdict on a playtest frame sequence (GA 2026-05-19)",
            },
            "pro": {
                "model": "gemini-2.5-pro",
                "cost_per_m_input_usd": 1.25,
                "cost_per_m_output_usd": 5.00,
                "use_for": "high-stakes final-pass audit before ship",
            },
        }

    return {
        "default_vision_provider": "gemini",
        "providers": {
            "gemini": gemini_info,
            "qwen": {
                "purpose": "FALLBACK ONLY — explicit second-opinion from a different vendor.",
                "guidance": (
                    "Use ONLY when Claude has a specific reason to want a "
                    "non-Google opinion (e.g. Gemini result feels off, "
                    "needed for cross-vendor consensus on a high-stakes "
                    "decision). Never auto-select Qwen for routine reviews."
                ),
                "model": "qwen-vl-max-latest",
                "cost_per_m_input_usd": 2.50,
                "cost_per_m_output_usd": 7.50,
                "kitty_markup": "33% on top of base rate",
            },
        },
        "triage_provider": {
            "name": "deepseek",
            "model": "deepseek-v4-flash",
            "purpose": "Log / console / build / profiler text triage.",
            "cost_per_m_input_usd": 0.14,
            "cost_per_m_cached_input_usd": 0.0028,
            "cost_per_m_output_usd": 0.28,
            "no_vision": True,
            "use_for": (
                "Ingest large console dumps or build logs, return JSON "
                "clusters + top_actions so Claude can act without burning "
                "its own context on noise."
            ),
        },
    }


# ---- /review (Gemini default, Qwen fallback) -------------------------------


class ReviewRequest(BaseModel):
    """Multi-frame playtest review.

    `frame_paths`: absolute paths to the chronological PNG/JPG sequence.
    `reference_paths`: optional absolute paths to ground-truth target
        images (e.g. canonical Angry Birds screenshots). When non-empty
        AND `mode="compare"`, the system prompt switches from "chronological
        delta + bug ranking" to "compare current vs reference, enumerate
        every deviation as a structured blocker list, emit JSON verdict".
        This is the ReLook (arXiv 2510.11498) vision-grounded gating pattern.
    `mode`: 'chronological' (default, classic frame-delta review) or
        'compare' (vs reference images, returns structured verdict).
    `provider`: 'gemini' (default), 'qwen' (explicit second-opinion only).
    `tier`: gemini-only — 'lite' / 'flash' / 'pro'.
    `question`: optional extra focus on top of the standard protocol.
    `qwen_session_id`: required when provider=qwen (budget tracking).
    `project`: tag for the history timeline (Claude should pass the active
        project name so the Vision Reviews panel groups correctly).
        BUG #185 FIX: callers MUST pass project explicitly; default kept
        only for backward compatibility with legacy clients.
    """
    frame_paths: list[str] = Field(..., min_length=1, max_length=10)
    reference_paths: list[str] = Field(default_factory=list, max_length=5)
    mode: Literal["chronological", "compare"] = "chronological"
    provider: Literal["gemini", "qwen"] = "gemini"
    tier: Literal["lite", "flash", "pro"] = "flash"
    question: str | None = None
    qwen_session_id: str | None = None
    require_justification: bool = True
    project: str = "default"


class VerdictBlocker(BaseModel):
    """One concrete deviation the current frame has vs the reference."""
    element: str  # e.g. "slingshot", "cat_sprite", "background", "HUD"
    issue: str  # short description of what's wrong
    severity: Literal["critical", "major", "minor"] = "major"


class CompareVerdict(BaseModel):
    """Structured machine-parseable verdict from compare-mode review.

    `pass_`: did the current frame match the reference well enough to
        proceed? False blocks the agent's next action.
    `score_0_10`: overall similarity / quality (0=garbage, 10=match).
    `blockers`: enumerated deviations the agent must address.
    `raw_analysis`: full Gemini text response for debugging.
    """
    pass_: bool = Field(alias="pass")
    score_0_10: int = Field(ge=0, le=10)
    blockers: list[VerdictBlocker]
    raw_analysis: str

    class Config:
        populate_by_name = True


_COMPARE_SYSTEM_PROMPT = """You are a HARSH 2D-game QA inspector. Your defaults are FAIL.
You receive two sets of images:
  - REFERENCE images (the target — what the game SHOULD look like)
  - CURRENT images (the game being built — what it ACTUALLY looks like right now)

⚠️ CRITICAL: do NOT do "vibe compare". Do NOT score on genre similarity. A
screenshot can have blue sky + green ground + cartoon slingshot + cat and
STILL be fundamentally broken if the slingshot floats above its base, the
cat is in the wrong place, or sprites have white backgrounds. You are not
asked "does this look angry-birds-y" — you are asked "does this match the
specific composition/relationships of the reference, pixel by pixel".

==============================================================
MANDATORY CHECKLIST — answer Y/N to EACH item before scoring:
==============================================================

[POSITION] — spatial relationships between objects:
  Q1. Is the slingshot/launcher visually TOUCHING its base/foundation? (NO gap, NO float)
  Q2. Is the projectile (cat/bird) loaded INSIDE the slingshot pouch — between the two prongs?
  Q3. Are ALL target structures STANDING on the ground (not floating, not clipping)?
  Q4. Are all key objects within the visible camera view (not off-screen, not behind HUD)?

[SPRITES] — visual cleanliness:
  Q5. Do ALL character sprites have transparent backgrounds? (NO white/checker squares around them)
  Q6. Are glass/transparent objects actually rendered with transparency (not solid white/opaque)?
  Q7. Are sprite scales consistent with reference (no 5× oversized blocks, no 10× tiny cat)?

[COMPOSITION] — level design:
  Q8. Is the background TILED/extended across the full visible width (not a single stretched plane)?
  Q9. Are there MULTIPLE distinct target groups requiring different shot trajectories (not just one cluster)?
  Q10. Is the HUD (score, ammo, etc.) readable and not overlapping gameplay area?

[POLISH]:
  Q11. Are there ZERO error overlays / red warning banners in the screenshot?
  Q12. Does the overall composition feel intentional, not "AI dropped sprites randomly"?

==============================================================
SCORING — DETERMINISTIC, no vibes:
==============================================================
- Count N answers from Q1–Q12. Call this `n_count`.
- Each N becomes a BLOCKER in the output. severity:
    Q1, Q2, Q11             → "critical" (gameplay-breaking)
    Q3, Q4, Q5, Q6, Q9      → "critical"
    Q7, Q8, Q10, Q12        → "major"
- score_0_10 = max(0, 10 - 2*critical_count - 1*major_count - 1*minor_count). Clamp 0..10.
- pass = (critical_count == 0) AND (major_count <= 1) AND (score_0_10 >= 7)

Default bias: when you are uncertain whether something MEETS the quality bar,
answer N (fail-closed). The agent retries; a false-pass ships garbage.

GROUNDING — equally important, do NOT hallucinate defects:
- Every blocker you list MUST be a defect you can CONCRETELY SEE in the CURRENT
  image, with a specific location. Do NOT invent, assume or speculate defects.
  If you cannot point to it in the pixels, it is NOT a blocker.
- The checklist above is written for a slingshot/Angry-Birds layout. If an item
  does NOT apply to THIS game (e.g. there is NO slingshot, launcher, pouch or
  projectile because it's a different genre like volleyball), mark it PASS (Y) —
  NEVER fail an item for a feature the game does not have, and never invent that
  feature into your analysis.
- BACKGROUND specifically: only flag a background problem you can LITERALLY see
  (a white/checker box, an unfilled gap, an error overlay). A normal clean or
  painted background that looks fine is a PASS — never invent a problem with a
  background that is actually OK.
- Only describe objects that are genuinely visible. Do NOT claim a ball has a
  face/limbs, or that an object exists/is broken, unless it is clearly in frame.

==============================================================
OUTPUT FORMAT — emit EXACTLY this JSON block, nothing else, no markdown fence:
==============================================================
{
  "pass": false,
  "score_0_10": 3,
  "blockers": [
    {"element": "slingshot", "issue": "Q1 NO — slingshot floats ~50px above wooden base, visible gap", "severity": "critical"},
    {"element": "cat", "issue": "Q2 NO — cat lying on far right of level instead of in slingshot pouch", "severity": "critical"},
    {"element": "cat_sprite", "issue": "Q5 NO — visible white square background around cat sprite", "severity": "critical"},
    {"element": "glass_pane", "issue": "Q6 NO — glass renders as solid bright white square, no alpha", "severity": "critical"},
    {"element": "screen_warnings", "issue": "Q11 NO — two red banners visible: Pixel Perfect resolution warning + reference-resolution mismatch", "severity": "critical"}
  ],
  "raw_analysis": "Q1=N Q2=N Q3=Y Q4=Y Q5=N Q6=N Q7=Y Q8=Y Q9=Y Q10=Y Q11=N Q12=N. critical=5 major=1 score=0. Composition has correct biome and target structures present BUT central gameplay element (cat in slingshot) is completely broken, sprites have white halos, and active engine warnings are visible. Fail-closed."
}

Be brutal. The agent claiming "done" with a fail verdict is a feature, not a bug.
"""


async def _review_compare_to_reference(
    *,
    current_paths: list[Path],
    reference_paths: list[Path],
    question: str | None,
    tier: str,
) -> tuple[CompareVerdict, dict[str, int], float, str, bool]:
    """ReLook-pattern compare-to-reference review.

    Sends reference + current images to Gemini with a strict JSON-output
    contract, parses the result into a CompareVerdict so downstream
    pipeline code can gate on `pass_` without re-parsing free text.

    Returns: (verdict, tokens_dict, cost_usd, model_label, via_kitty).
    """
    from tools.gemini_client import (  # local import to dodge circular
        _default_use_kitty, GeminiClient, KITTY_AGENT_DEFAULT_MODEL,
    )

    via_kitty = _default_use_kitty()
    if via_kitty:
        chosen_model = KITTY_AGENT_DEFAULT_MODEL
    else:
        tier_map = {
            "lite": "gemini-3.1-flash-lite",
            "flash": "gemini-3.5-flash",
            "pro": "gemini-2.5-pro",
        }
        chosen_model = tier_map.get(tier, "gemini-3.5-flash")

    all_images = list(reference_paths) + list(current_paths)
    user_text = (
        f"REFERENCE images: first {len(reference_paths)} attached image(s).\n"
        f"CURRENT images: last {len(current_paths)} attached image(s).\n"
        "Compare CURRENT vs REFERENCE and emit the JSON verdict per the "
        "system protocol. No prose outside the JSON block."
    )
    if question:
        user_text += f"\n\nExtra focus from caller: {question}"

    async with GeminiClient(model=chosen_model, via_kitty=via_kitty) as g:
        result = await g.generate(
            system=_COMPARE_SYSTEM_PROMPT,
            user=user_text,
            images=all_images,
            temperature=0.1,  # tight, we want consistent JSON
            max_output_tokens=2048,
            response_mime_type="application/json",
        )

    raw = result.text.strip()
    # Strip code fences if Gemini added them despite instructions
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1] if "```" in raw[3:] else raw[3:]
        if raw.lstrip().startswith("json"):
            raw = raw.lstrip()[4:]
    raw = raw.strip()

    try:
        parsed = json.loads(raw)
        verdict = CompareVerdict.model_validate(parsed)
    except (json.JSONDecodeError, Exception) as e:  # noqa: BLE001
        # FAIL LOUDLY per swe-agent-rigor — don't silently degrade to advisory.
        # Construct a fallback failing verdict so the agent gets blocked
        # rather than coasting on bad parse.
        logger.warning(
            "compare-verdict JSON parse failed ({e}); falling back to "
            "fail-closed verdict with raw text. raw_head={head!r}",
            e=e, head=raw[:200],
        )
        verdict = CompareVerdict(
            pass_=False,
            score_0_10=0,
            blockers=[VerdictBlocker(
                element="vision_pipeline",
                issue=f"Gemini returned unparseable JSON: {str(e)[:120]}",
                severity="critical",
            )],
            raw_analysis=result.text,
        )

    tokens = {"input": result.input_tokens, "output": result.output_tokens}
    model_label = (
        KITTY_AGENT_DEFAULT_MODEL if via_kitty
        else (result.raw.get("modelVersion") or chosen_model)
    )
    return verdict, tokens, result.cost_usd, model_label, via_kitty


@router.post("/review")
async def review_frames(req: ReviewRequest) -> dict[str, Any]:
    """Run vision review on a frame sequence.

    Two modes:
      - `mode="chronological"` (default): classic delta + bug-ranking
        protocol over a temporal sequence (what playtest review used to
        be). Returns free-text `analysis`.
      - `mode="compare"` + `reference_paths` non-empty: ReLook-style
        (arXiv 2510.11498) compare-current-vs-reference review. Returns
        structured `verdict` field: {pass, score_0_10, blockers[], raw_analysis}.
        Callers gate the agent on `verdict.pass` instead of reading prose.

    Routing rule: provider='gemini' is the only default. If 'qwen' is
    requested, `require_justification=true` enforces that the caller
    explicitly opted in (defense against auto-falling-back to expensive
    Qwen by accident).

    BUG #185 FIX: history record now uses req.project (not silent default).
    Backend-injected vision-gate callers pass the active murrkit
    project so the right-side Vision Reviews panel groups entries correctly.
    """
    paths = [Path(p) for p in req.frame_paths]
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise HTTPException(status_code=404, detail=f"frames not found: {missing}")

    ref_paths = [Path(p) for p in req.reference_paths]
    missing_refs = [str(p) for p in ref_paths if not p.is_file()]
    if missing_refs:
        raise HTTPException(
            status_code=404, detail=f"reference frames not found: {missing_refs}"
        )

    # EXP-4 BONUS — auto-inject references from .omc/references/<project>/
    # when caller asked for compare mode but forgot to send paths. This
    # closes a common failure where Claude says mode=compare and the
    # backend would otherwise 400 — instead we scan the project's
    # reference folder and pick up to 5 PNGs automatically.
    if req.mode == "compare" and not ref_paths:
        ref_dir = (
            Path(__file__).resolve().parents[2] / ".omc" / "references" / req.project
        )
        if ref_dir.is_dir():
            auto_refs = sorted(
                p for p in ref_dir.iterdir()
                if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
            )[:5]
            if auto_refs:
                ref_paths = auto_refs
                logger.info(
                    "vision/review auto-injected {n} reference(s) from {d}",
                    n=len(ref_paths), d=ref_dir,
                )

    # If caller asked for compare mode they must (now, after auto-inject)
    # have references; fail loudly otherwise so callers don't silently
    # degrade to chronological mode (which would return prose that the
    # gate-loop can't parse).
    if req.mode == "compare" and not ref_paths:
        raise HTTPException(
            status_code=400,
            detail=(
                f"mode='compare' requires reference_paths (>=1 file). "
                f"No auto-injectable refs found at "
                f".omc/references/{req.project}/. Drop a target image "
                f"(angry_birds_ref.png etc) there or pass reference_paths "
                f"explicitly."
            ),
        )
    if ref_paths and req.mode != "compare":
        raise HTTPException(
            status_code=400,
            detail="reference_paths supplied but mode != 'compare'. Set mode='compare'.",
        )

    # ---- Branch: compare-to-reference (ReLook structured verdict) -----------
    if req.mode == "compare" and req.provider == "gemini":
        verdict, tokens, cost_usd, model_label, via_kitty = await _review_compare_to_reference(
            current_paths=paths,
            reference_paths=ref_paths,
            question=req.question,
            tier=req.tier,
        )
        response = {
            "provider": "gemini",
            "mode": "compare",
            "transport": "kitty_proxy" if via_kitty else "direct_google_ai",
            "model": model_label,
            "verdict": verdict.model_dump(by_alias=True),
            "analysis": verdict.raw_analysis,  # keep for backward UI compatibility
            "frames_reviewed": len(paths),
            "references_used": len(ref_paths),
            "tokens": tokens,
            "cost_usd": round(cost_usd, 6),
        }
        await _record(req.project, {
            "type": "review",
            "ts": time.time(),
            "project": req.project,
            "provider": "gemini",
            "mode": "compare",
            "transport": response["transport"],
            "model": model_label,
            "frames": [str(p) for p in paths],
            "references": [str(p) for p in ref_paths],
            "frame_count": len(paths),
            "question": req.question,
            "verdict": verdict.model_dump(by_alias=True),
            "analysis": verdict.raw_analysis,
            "tokens": tokens,
            "cost_usd": response["cost_usd"],
        })
        return response

    # ---- Branch: chronological (classic behaviour) --------------------------
    if req.provider == "gemini":
        from tools.gemini_client import _default_use_kitty, review_playtest_frames

        via_kitty = _default_use_kitty()
        result = await review_playtest_frames(
            paths,
            question=req.question,
            tier=req.tier,
        )
        from tools.gemini_client import KITTY_AGENT_DEFAULT_MODEL
        _direct_tier_models = {
            "lite": "gemini-3.1-flash-lite",
            "flash": "gemini-3.5-flash",
            "pro": "gemini-2.5-pro",
        }
        model_label = (
            KITTY_AGENT_DEFAULT_MODEL if via_kitty
            else (result.raw.get("modelVersion") or _direct_tier_models.get(req.tier, "gemini-3.5-flash"))
        )
        response = {
            "provider": "gemini",
            "mode": "chronological",
            "transport": "kitty_proxy" if via_kitty else "direct_google_ai",
            "tier": req.tier if not via_kitty else "kitty-fixed",
            "model": model_label,
            "analysis": result.text,
            "frames_reviewed": len(paths),
            "tokens": {"input": result.input_tokens, "output": result.output_tokens},
            "cost_usd": round(result.cost_usd, 6),
        }
        # Record into history + broadcast over WS so the frontend timeline
        # panel updates live without polling.
        await _record(req.project, {
            "type": "review",
            "ts": time.time(),
            "project": req.project,
            "provider": "gemini",
            "mode": "chronological",
            "transport": response["transport"],
            "model": model_label,
            "frames": [str(p) for p in paths],
            "frame_count": len(paths),
            "question": req.question,
            "analysis": result.text,
            "tokens": response["tokens"],
            "cost_usd": response["cost_usd"],
        })
        return response

    # --- Qwen fallback (explicit opt-in only) ---------------------------------
    if not req.qwen_session_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "Qwen requires `qwen_session_id` (a committed budget). Use "
                "POST /api/qwen/budget/commit first, then pass the session_id."
            ),
        )

    import base64
    from tools.qwen_client import QwenMessage, qwen_chat
    from tools.qwen_tools import _REVIEW_SYSTEM_PROMPT
    from backend.routers.qwen import _BUDGETS

    budget = _BUDGETS.get(req.qwen_session_id)
    if budget is None:
        raise HTTPException(status_code=404, detail=f"unknown qwen session {req.qwen_session_id}")

    blocks: list[dict[str, Any]] = []
    for p in paths:
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        blocks.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})
    user_text = f"{len(paths)} chronological frames. " + (
        req.question or "Apply system protocol: delta first, ranked bugs, verdict."
    )
    blocks.append({"type": "text", "text": user_text})

    logger.warning(
        "vision/review using QWEN fallback (claude-justified). frames={n} sid={s}",
        n=len(paths), s=req.qwen_session_id,
    )
    qwen_result = await qwen_chat(
        [
            QwenMessage(role="system", content=_REVIEW_SYSTEM_PROMPT),
            {"role": "user", "content": blocks},
        ],
        budget=budget,
        max_output_tokens=2048,
        model="qwen-vl-max-latest",
    )
    response = {
        "provider": "qwen",
        "transport": "kitty_proxy",
        "tier": "fallback",
        "model": "qwen-vl-max-latest",
        "analysis": qwen_result["text"],
        "frames_reviewed": len(paths),
        "tokens": {
            "input": qwen_result["input_tokens"],
            "output": qwen_result["output_tokens"],
        },
        "cost_usd": round(qwen_result["cost_usd"], 6),
    }
    await _record(req.project, {
        "type": "review",
        "ts": time.time(),
        "project": req.project,
        "provider": "qwen",
        "transport": "kitty_proxy",
        "model": "qwen-vl-max-latest",
        "frames": [str(p) for p in paths],
        "frame_count": len(paths),
        "question": req.question,
        "analysis": qwen_result["text"],
        "tokens": response["tokens"],
        "cost_usd": response["cost_usd"],
    })
    return response


# ---- /triage (DeepSeek V4 Flash) -------------------------------------------


class TriageRequest(BaseModel):
    """Log / console / build / profiler text triage.

    Pass the raw text (up to ~500 KB — DeepSeek V4 Flash has 1M context).
    Get back a structured JSON of error clusters + ranked next-steps.
    """
    log_text: str = Field(..., min_length=1)
    context_hint: str | None = None
    max_output_tokens: int = 1200
    project: str = "default"


@router.post("/triage")
async def triage_log(req: TriageRequest) -> dict[str, Any]:
    from tools.deepseek_triage import triage as _triage

    result = await _triage(
        req.log_text,
        context_hint=req.context_hint,
        max_output_tokens=req.max_output_tokens,
    )
    response = {
        "provider": "deepseek",
        "transport": "direct",
        "model": "deepseek-v4-flash",
        "summary": result.summary,
        "severity": result.severity,
        "error_clusters": result.error_clusters,
        "top_actions": result.top_actions,
        "tokens": {"input": result.input_tokens, "output": result.output_tokens},
        "cost_usd": round(result.cost_usd, 6),
    }
    await _record(req.project, {
        "type": "triage",
        "ts": time.time(),
        "project": req.project,
        "provider": "deepseek",
        "transport": "direct",
        "model": "deepseek-v4-flash",
        "context_hint": req.context_hint,
        "log_chars": len(req.log_text),
        "summary": result.summary,
        "severity": result.severity,
        "cluster_count": len(result.error_clusters),
        "top_actions": result.top_actions,
        "tokens": response["tokens"],
        "cost_usd": response["cost_usd"],
    })
    return response
