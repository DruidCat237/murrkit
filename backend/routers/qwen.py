"""
Qwen 3.7 Max router — multimodal peer assistant for Claude.

Endpoints:
    GET   /api/qwen/pricing                — current rates + markup info
    POST  /api/qwen/budget/commit          — user commits N tokens (charges Kitty)
    GET   /api/qwen/budget/{session_id}    — current usage + remaining
    POST  /api/qwen/budget/cancel          — release unused tokens (best-effort)
    POST  /api/qwen/ask                    — text-only question
    POST  /api/qwen/vision                 — image + prompt (game screenshot QA)
    POST  /api/qwen/test                   — small sanity call ($0.01 worth)

UX flow:
    1. User opens chat with Claude.
    2. Claude proposes "use Qwen for vision QA of this screenshot — needs ~5000
       tokens, costs $0.02 from your Kitty balance. Accept?"
    3. User clicks Accept → backend calls /api/qwen/budget/commit with the
       proposed limit + 33% markup, deducts from Kitty, returns session_id.
    4. Claude calls /api/qwen/ask or /vision with that session_id.
    5. Backend enforces hard limit + rate limit BEFORE every call.
    6. If user wants to stop early, /budget/cancel releases the reservation
       (Kitty refunds the unused portion).
"""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path as _BootPath
from typing import Any

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel, Field

from tools.qwen_client import (
    BLENDED_RESERVE_PRICE_USD_PER_M,
    KITTY_MARKUP,
    ORIGINAL_PRICE_USD_PER_M,
    QwenBudget,
    QwenError,
    QwenKittyError,
    QwenMessage,
    QwenRateLimitError,
    QwenTokenLimitError,
    qwen_chat,
    qwen_vision,
)

router = APIRouter(prefix="/api/qwen", tags=["qwen"])


# ============================================================================
# Persistent budget store
# ============================================================================
# `_BUDGETS` lives in memory for hot-path performance (every call reads it),
# but we mirror it to disk on every mutation so backend restarts don't strand
# the user's committed token reservation. The user already paid Kitty for the
# tokens — losing the session id means they have to re-commit and re-pay.

_BUDGET_STORE: _BootPath = (
    _BootPath(__file__).resolve().parents[2] / ".omc" / "state" / "qwen_budgets.json"
)


def _serialize_budget(b: QwenBudget) -> dict[str, Any]:
    return {
        "session_id": b.session_id,
        "reserved_tokens": b.reserved_tokens,
        "used_tokens": b.used_tokens,
        "cost_usd_actual": b.cost_usd_actual,
        "cost_usd_billed": b.cost_usd_billed,
        "call_count": b.call_count,
        "last_call_at": b.last_call_at,
        "minute_window": [[t, n] for t, n in b.minute_window],
        "max_tokens_per_minute": b.max_tokens_per_minute,
    }


def _deserialize_budget(d: dict[str, Any]) -> QwenBudget:
    b = QwenBudget(
        session_id=d["session_id"],
        reserved_tokens=int(d.get("reserved_tokens", 0)),
        used_tokens=int(d.get("used_tokens", 0)),
        cost_usd_actual=float(d.get("cost_usd_actual", 0.0)),
        cost_usd_billed=float(d.get("cost_usd_billed", 0.0)),
        call_count=int(d.get("call_count", 0)),
        last_call_at=float(d.get("last_call_at", 0.0)),
        max_tokens_per_minute=int(d.get("max_tokens_per_minute", 50_000)),
    )
    b.minute_window = [(float(t), int(n)) for t, n in d.get("minute_window", [])]
    return b


def _persist_budgets() -> None:
    """Atomic save — write to tmp + rename so a crash mid-write can't corrupt."""
    try:
        _BUDGET_STORE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _BUDGET_STORE.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({sid: _serialize_budget(b) for sid, b in _BUDGETS.items()}, indent=2),
            encoding="utf-8",
        )
        tmp.replace(_BUDGET_STORE)
    except Exception as e:  # noqa: BLE001 — never let persistence break the call path
        logger.warning("qwen budget persist failed: {e}", e=e)


def _load_budgets() -> dict[str, QwenBudget]:
    try:
        if not _BUDGET_STORE.is_file():
            return {}
        data = json.loads(_BUDGET_STORE.read_text(encoding="utf-8"))
        loaded = {sid: _deserialize_budget(d) for sid, d in data.items()}
        if loaded:
            logger.info("qwen: restored {n} budget(s) from {p}", n=len(loaded), p=_BUDGET_STORE)
        return loaded
    except Exception as e:  # noqa: BLE001
        logger.warning("qwen budget load failed (starting fresh): {e}", e=e)
        return {}


# Hydrate on module import so the budgets survive backend restart.
_BUDGETS: dict[str, QwenBudget] = _load_budgets()


# ============================================================================
# Pricing + budget management
# ============================================================================


@router.get("/pricing")
async def pricing() -> dict[str, Any]:
    """Public pricing — show this to the user before they commit."""
    return {
        "model": "qwen3.7-max",
        "vendor_via": "Kitty App",  # never expose the upstream provider to end user
        "prices_per_million_tokens_usd": {
            "input": ORIGINAL_PRICE_USD_PER_M["input"],
            "output": ORIGINAL_PRICE_USD_PER_M["output"],
            "cache_create": ORIGINAL_PRICE_USD_PER_M["cache_create"],
            "cache_read": ORIGINAL_PRICE_USD_PER_M["cache_read"],
        },
        "kitty_markup": KITTY_MARKUP,
        "upfront_blended_rate_usd_per_million": BLENDED_RESERVE_PRICE_USD_PER_M,
        "user_visible_rate_usd_per_million": round(
            BLENDED_RESERVE_PRICE_USD_PER_M * KITTY_MARKUP, 4
        ),
        "example_reservations": [
            {
                "tokens": 100_000,
                "kitty_cost_usd": round(0.1 * BLENDED_RESERVE_PRICE_USD_PER_M * KITTY_MARKUP, 4),
                "good_for": "~5 vision-QA calls or ~20 text Q&A",
            },
            {
                "tokens": 500_000,
                "kitty_cost_usd": round(0.5 * BLENDED_RESERVE_PRICE_USD_PER_M * KITTY_MARKUP, 4),
                "good_for": "full playtest report + 10 vision checks",
            },
            {
                "tokens": 1_000_000,
                "kitty_cost_usd": round(1.0 * BLENDED_RESERVE_PRICE_USD_PER_M * KITTY_MARKUP, 4),
                "good_for": "deep iteration session, multiple peer reviews",
            },
        ],
        "burn_protection_default_tokens_per_minute": 50_000,
        "notes": [
            "Reservation is charged from Kitty balance UPFRONT. Unused portion is "
            "refunded when you cancel or session ends.",
            "Hard limit is enforced server-side BEFORE every Qwen call — even if "
            "Claude tries to overspend in a loop, the call is rejected with 402.",
            "Burn protection caps token-per-minute usage (default 50 000) so a "
            "runaway loop can't drain a 1M reservation in 30 seconds.",
        ],
    }


class CommitRequest(BaseModel):
    max_tokens: int = Field(..., ge=10_000, le=2_000_000)
    max_tokens_per_minute: int = Field(50_000, ge=5_000, le=500_000)
    purpose: str = Field("ad-hoc Qwen session", max_length=200)


class CommitResponse(BaseModel):
    session_id: str
    reserved_tokens: int
    upfront_cost_usd: float
    kitty_charged: bool
    note: str


@router.post("/budget/commit", response_model=CommitResponse)
async def commit_budget(req: CommitRequest) -> CommitResponse:
    """Reserve N tokens. Charges Kitty balance upfront (best-effort). Returns
    a session_id that subsequent /ask /vision calls must pass.

    NOTE on Kitty charging: we DON'T yet implement the actual server-side
    Kitty debit here — that requires the WordPress plugin to expose
    /wp-json/kitty-app/v1/qwen-reserve. For now we record the intent + let
    the actual charge happen on the first /ask call (Kitty's qwen-chat
    endpoint will deduct per-call). When the WP endpoint exists, swap this
    to do the upfront deduct so the user can't oversubscribe.
    """
    upfront = round(req.max_tokens / 1_000_000.0 * BLENDED_RESERVE_PRICE_USD_PER_M * KITTY_MARKUP, 4)
    sid = "qwen_" + secrets.token_hex(8)
    _BUDGETS[sid] = QwenBudget(
        session_id=sid,
        reserved_tokens=req.max_tokens,
        max_tokens_per_minute=req.max_tokens_per_minute,
    )
    _persist_budgets()
    logger.info(
        "qwen: commit sid={s} tokens={t} upfront=${u:.4f} purpose={p}",
        s=sid, t=req.max_tokens, u=upfront, p=req.purpose,
    )
    return CommitResponse(
        session_id=sid,
        reserved_tokens=req.max_tokens,
        upfront_cost_usd=upfront,
        kitty_charged=False,
        note=(
            "Pay-as-you-go for now — per-call Kitty debit happens inside "
            "/wp-json/kitty-app/v1/qwen-chat. Switch to upfront reservation "
            "once the /qwen-reserve WP endpoint lands."
        ),
    )


@router.get("/budget/active")
async def get_active_budget() -> dict[str, Any] | None:
    """Newest live Qwen session, or null if no session is committed.

    Used by the title-bar QwenBudgetBadge so the user sees a live token
    indicator without having to navigate to the Qwen tab.

    NOTE: this route MUST be declared before /budget/{session_id} — FastAPI
    matches in registration order and the parametric route would otherwise
    swallow "active" as a session id.
    """
    if not _BUDGETS:
        return None
    # Pick the session with the most recent activity (or commit if no calls yet).
    sid, b = max(
        _BUDGETS.items(),
        key=lambda kv: (kv[1].last_call_at or 0, kv[1].reserved_tokens),
    )
    return {
        "session_id": sid,
        "reserved_tokens": b.reserved_tokens,
        "used_tokens": b.used_tokens,
        "remaining_tokens": b.remaining_tokens(),
        "cost_usd_billed": round(b.cost_usd_billed, 6),
        "call_count": b.call_count,
    }


@router.get("/budget/{session_id}")
async def get_budget(session_id: str) -> dict[str, Any]:
    b = _BUDGETS.get(session_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"unknown session {session_id}")
    return {
        "session_id": session_id,
        "reserved_tokens": b.reserved_tokens,
        "used_tokens": b.used_tokens,
        "remaining_tokens": b.remaining_tokens(),
        "cost_usd_actual": round(b.cost_usd_actual, 6),
        "cost_usd_billed": round(b.cost_usd_billed, 6),
        "call_count": b.call_count,
        "max_tokens_per_minute": b.max_tokens_per_minute,
        "last_call_at": b.last_call_at,
    }


@router.post("/budget/cancel")
async def cancel_budget(session_id: str) -> dict[str, Any]:
    b = _BUDGETS.pop(session_id, None)
    if b is None:
        raise HTTPException(status_code=404, detail=f"unknown session {session_id}")
    _persist_budgets()
    refunded_tokens = b.remaining_tokens()
    return {
        "session_id": session_id,
        "refunded_tokens": refunded_tokens,
        "note": "Server-side refund happens automatically on next Kitty sync — "
                "for now you simply stop paying for unused tokens.",
    }


# ============================================================================
# Inference
# ============================================================================


class AskRequest(BaseModel):
    session_id: str
    messages: list[dict[str, Any]]
    temperature: float = 0.3
    max_output_tokens: int = Field(4096, ge=64, le=32_000)
    enable_thinking: bool = False


@router.post("/ask")
async def ask(req: AskRequest) -> dict[str, Any]:
    b = _BUDGETS.get(req.session_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"unknown session {req.session_id}")
    try:
        result = await qwen_chat(
            [QwenMessage(**m) for m in req.messages],
            budget=b,
            temperature=req.temperature,
            max_output_tokens=req.max_output_tokens,
            enable_thinking=req.enable_thinking,
        )
    except QwenTokenLimitError as e:
        raise HTTPException(status_code=402, detail=f"token limit: {e}") from None
    except QwenRateLimitError as e:
        raise HTTPException(status_code=429, detail=f"rate limit: {e}") from None
    except QwenKittyError as e:
        raise HTTPException(status_code=502, detail=f"kitty: {e}") from None
    except QwenError as e:
        raise HTTPException(status_code=500, detail=str(e)) from None
    _persist_budgets()
    return result


class VisionRequest(BaseModel):
    session_id: str
    image_path: str
    prompt: str
    system: str | None = None
    max_output_tokens: int = Field(2048, ge=64, le=8000)


@router.post("/vision")
async def vision(req: VisionRequest) -> dict[str, Any]:
    """Image + prompt → Qwen-VL analysis. Use for 'is the white cat actually
    centered in this game screenshot?'-type questions."""
    b = _BUDGETS.get(req.session_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"unknown session {req.session_id}")
    try:
        result = await qwen_vision(
            req.image_path,
            req.prompt,
            budget=b,
            system=req.system,
            max_output_tokens=req.max_output_tokens,
        )
    except QwenTokenLimitError as e:
        raise HTTPException(status_code=402, detail=f"token limit: {e}") from None
    except QwenRateLimitError as e:
        raise HTTPException(status_code=429, detail=f"rate limit: {e}") from None
    except QwenKittyError as e:
        raise HTTPException(status_code=502, detail=f"kitty: {e}") from None
    except QwenError as e:
        raise HTTPException(status_code=500, detail=str(e)) from None
    _persist_budgets()
    return result


## ============================================================================
## Scratch pad — Qwen writes markdown reports / playtest notes that the inner
## Claude (and the user) can read. Path: <project-root>/agent_scratch/qwen/<project>/
## Always under the repo so Claude's bypassPermissions allow-list already
## covers it; nothing escapes via `..`.
## ============================================================================


from pathlib import Path as _Path
from core.config import PROJECT_ROOT as _PROJECT_ROOT


def _scratch_dir(project: str) -> _Path:
    safe = "".join(c for c in project if c.isalnum() or c in ("-", "_"))[:64] or "default"
    p = _PROJECT_ROOT / "agent_scratch" / "qwen" / safe
    p.mkdir(parents=True, exist_ok=True)
    return p


class ScratchWriteRequest(BaseModel):
    project: str = "default"
    filename: str = Field(..., min_length=1, max_length=120)
    content: str
    append: bool = False


@router.post("/scratch/write")
async def scratch_write(req: ScratchWriteRequest) -> dict[str, Any]:
    """Write/append a markdown report to the Qwen scratch pad.

    Claude reads these via standard Read tool — the path is in the prompt.
    """
    if ".." in req.filename or "/" in req.filename or "\\" in req.filename:
        raise HTTPException(status_code=400, detail="filename must be a leaf — no slashes / ..")
    if not req.filename.endswith((".md", ".txt", ".json", ".log")):
        req.filename = req.filename + ".md"
    dst = _scratch_dir(req.project) / req.filename
    mode = "a" if req.append else "w"
    with dst.open(mode, encoding="utf-8") as f:
        if req.append:
            f.write("\n\n---\n\n")
        f.write(req.content)
    logger.info("qwen scratch: {m} {p} ({n} chars)",
                m=("append" if req.append else "write"), p=dst, n=len(req.content))
    return {
        "ok": True,
        "abs_path": str(dst.resolve()),
        "rel_path": f"agent_scratch/qwen/{req.project}/{req.filename}",
        "size_bytes": dst.stat().st_size,
    }


@router.get("/scratch/list")
async def scratch_list(project: str = "default") -> dict[str, Any]:
    d = _scratch_dir(project)
    items = sorted(d.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    return {
        "project": project,
        "scratch_dir": str(d.resolve()),
        "files": [
            {
                "name": p.name,
                "size_bytes": p.stat().st_size,
                "modified_at": p.stat().st_mtime,
            }
            for p in items if p.is_file()
        ],
    }


@router.get("/scratch/read")
async def scratch_read(project: str = "default", filename: str = "") -> dict[str, Any]:
    if not filename or ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="filename required + leaf-only")
    f = _scratch_dir(project) / filename
    if not f.is_file():
        raise HTTPException(status_code=404, detail=f"not found: {filename}")
    return {
        "filename": filename,
        "size_bytes": f.stat().st_size,
        "content": f.read_text(encoding="utf-8", errors="replace"),
    }


## ============================================================================
## Peer chat — dedicated transcript shared between user-facing Claude chat
## and Qwen. Stored per project so the Qwen panel can show prior history.
## ============================================================================


from datetime import datetime as _datetime, timezone as _tz

# In-memory peer transcript per project. Resets on backend restart — that's
# fine, peer chats are short-lived and the persistent state lives in the
# scratch-pad files anyway.
_PEER_TRANSCRIPTS: dict[str, list[dict[str, Any]]] = {}


class PeerSendRequest(BaseModel):
    session_id: str         # Qwen budget session
    project: str = "default"
    role: str = "user"      # "user" (Claude or human) | "system"
    message: str
    image_path: str | None = None
    save_as: str | None = None  # if set, scratch-pad filename to persist Qwen's reply
    system: str | None = None


@router.post("/peer/send")
async def peer_send(req: PeerSendRequest) -> dict[str, Any]:
    """Send one message to Qwen on the project's peer-chat transcript.

    Returns Qwen's response + appends both messages to the transcript +
    optionally saves Qwen's reply to a scratch file Claude can Read.
    """
    b = _BUDGETS.get(req.session_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"unknown qwen session {req.session_id}")

    transcript = _PEER_TRANSCRIPTS.setdefault(req.project, [])
    user_entry = {
        "role": req.role,
        "content": req.message,
        "ts": _datetime.now(_tz.utc).isoformat(),
        "image_path": req.image_path,
    }
    transcript.append(user_entry)

    # Build messages for Qwen — system + last 20 transcript entries (keeps
    # context manageable; full history in scratch files).
    system_prompt = (
        req.system
        or "You are a peer reviewer for a Claude-driven 2D game "
           "build pipeline. Be terse and concrete. When asked to inspect a "
           "screenshot, enumerate every visible element + flag anything off "
           "(misalignment, missing assets, colour clash). When asked for a "
           "playtest report, structure it: WHAT WORKED / WHAT BROKE / FIX LIST. "
           "You can request a scratch-pad write by saying 'SCRATCH <filename>: "
           "<markdown>' and the orchestrator will save it for Claude to read."
    )

    history = transcript[-20:]
    msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for e in history:
        if e.get("image_path"):
            # Reconstruct multimodal content
            import base64
            p = _Path(e["image_path"])
            if p.is_file():
                b64 = base64.b64encode(p.read_bytes()).decode("ascii")
                msgs.append({"role": e["role"], "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    {"type": "text", "text": e["content"]},
                ]})
                continue
        msgs.append({"role": e["role"], "content": e["content"]})

    # Multimodal calls MUST go to a vision model — qwen3.7-max is text-only
    # and 400s on `image_url` content blocks. Auto-route to qwen-vl-max-latest
    # when any history entry carries an image; otherwise stay on the default
    # text model (cheaper, longer context).
    has_image = any(e.get("image_path") for e in history)
    pick_model = "qwen-vl-max-latest" if has_image else "qwen3.7-max"

    try:
        result = await qwen_chat(
            [QwenMessage(**m) for m in msgs],
            budget=b,
            max_output_tokens=4096,
            model=pick_model,
        )
    except QwenTokenLimitError as e:
        raise HTTPException(status_code=402, detail=str(e)) from None
    except QwenRateLimitError as e:
        raise HTTPException(status_code=429, detail=str(e)) from None
    except QwenKittyError as e:
        raise HTTPException(status_code=502, detail=str(e)) from None

    assistant_entry = {
        "role": "assistant",
        "content": result["text"],
        "ts": _datetime.now(_tz.utc).isoformat(),
        "tokens": {
            "input": result["input_tokens"], "output": result["output_tokens"],
        },
        "cost_usd": result["cost_usd"],
    }
    transcript.append(assistant_entry)

    # Auto-extract SCRATCH directives from Qwen's reply + persist
    scratch_saved: list[dict[str, str]] = []
    for line in result["text"].split("\n"):
        m = line.strip()
        if m.startswith("SCRATCH "):
            try:
                head, _, body = m[len("SCRATCH "):].partition(":")
                fn = head.strip()
                if fn and body:
                    scratch_dir = _scratch_dir(req.project)
                    if not fn.endswith((".md", ".txt", ".json", ".log")):
                        fn = fn + ".md"
                    dst = scratch_dir / fn
                    dst.write_text(body.strip(), encoding="utf-8")
                    scratch_saved.append({"filename": fn, "size_bytes": str(dst.stat().st_size)})
            except Exception:  # noqa: BLE001 — best-effort directive parsing
                pass
    if req.save_as:
        scratch_dir = _scratch_dir(req.project)
        fn = req.save_as
        if not fn.endswith((".md", ".txt", ".json", ".log")):
            fn = fn + ".md"
        (scratch_dir / fn).write_text(result["text"], encoding="utf-8")
        scratch_saved.append({"filename": fn, "size_bytes": str((scratch_dir / fn).stat().st_size)})

    _persist_budgets()
    return {
        "response": result["text"],
        "transcript_length": len(transcript),
        "tokens": {"input": result["input_tokens"], "output": result["output_tokens"]},
        "cost_usd": result["cost_usd"],
        "scratch_saved": scratch_saved,
        "remaining_tokens": b.remaining_tokens(),
    }


@router.get("/peer/transcript")
async def peer_transcript(project: str = "default") -> dict[str, Any]:
    return {
        "project": project,
        "messages": _PEER_TRANSCRIPTS.get(project, []),
    }


@router.post("/peer/clear")
async def peer_clear(project: str = "default") -> dict[str, Any]:
    n = len(_PEER_TRANSCRIPTS.get(project, []))
    _PEER_TRANSCRIPTS.pop(project, None)
    return {"cleared": n}


## ============================================================================
## Agent mode — peer with Phaser vision-review tool-calling
##
## Captain / lieutenant protocol
## -----------------------------
## Claude is THE manager. When Claude calls /agent/run, the call is
## synchronous — Claude waits for the full multi-iteration loop to finish
## before doing anything else. No fire-and-forget. If Qwen starts looping
## (the same tool with the same args twice in a row, or an obvious dead
## end), Claude can call /agent/stop to interrupt mid-iteration. The next
## iteration sees the cancel flag and exits the loop with a "[cancelled
## by orchestrator]" final message.
## ============================================================================


# Cancellation flags — keyed by session_id. The agent loop checks this before
# each iteration. Set true by /agent/stop, cleared when the loop exits.
_AGENT_STOP_FLAGS: dict[str, bool] = {}

# Per-project busy state so the UI + Claude can tell when Qwen is mid-loop.
# Records {project: {session_id, started_at, current_iteration}} or empty.
_AGENT_BUSY: dict[str, dict[str, Any]] = {}


@router.post("/agent/stop")
async def agent_stop(session_id: str) -> dict[str, Any]:
    """Set the cancel flag for an in-flight /agent/run loop.

    Claude calls this when Qwen is looping or producing garbage. The loop
    detects the flag between iterations and exits cleanly with a final
    "[cancelled by orchestrator]" message — partial tool results are still
    appended to the transcript so Claude can see what Qwen did before being
    stopped. Token consumption up to that point is already billed.
    """
    if session_id not in _BUDGETS:
        raise HTTPException(status_code=404, detail=f"unknown session {session_id}")
    _AGENT_STOP_FLAGS[session_id] = True
    return {"ok": True, "session_id": session_id, "note": "stop flag set; loop will exit on next iteration"}


@router.get("/agent/status")
async def agent_status(project: str = "default") -> dict[str, Any]:
    """Is Qwen currently running in agent mode for this project?"""
    busy = _AGENT_BUSY.get(project)
    return {
        "busy": busy is not None,
        "info": busy,
    }


class AgentRunRequest(BaseModel):
    session_id: str
    project: str = "default"
    message: str
    image_path: str | None = None
    allow_writes: bool = False
    max_iterations: int = 8
    system: str | None = None


@router.post("/agent/run")
async def agent_run(req: AgentRunRequest) -> dict[str, Any]:
    """Run the peer in agent mode — function calling against the vision-review tools.

    Multi-turn loop:
      1. Send messages + tool schemas to the peer.
      2. If the peer replies with `tool_calls`, dispatch them locally
         (Playwright screenshots + VL review + scratch notes), append the
         results as `role: tool` messages, send back.
      3. Repeat until the peer returns a plain text reply OR we hit
         `max_iterations` OR the token budget runs out.

    Every assistant + tool message is also appended to the per-project peer
    transcript so the user sees the full agentic conversation in the panel.
    """
    from tools.qwen_tools import dispatch_tool, get_tool_schemas

    b = _BUDGETS.get(req.session_id)
    if b is None:
        raise HTTPException(status_code=404, detail=f"unknown qwen session {req.session_id}")

    transcript = _PEER_TRANSCRIPTS.setdefault(req.project, [])

    # Build system + initial user message.
    system_prompt = req.system or (
        "You are an autonomous vision-review peer for a 2D Phaser game build "
        "pipeline. Your tools let you screenshot the live game (headless "
        "Playwright), capture a sequence of frames, and analyze them with a "
        "vision model. Look at the ACTUAL pixels BEFORE answering speculative "
        "questions. Save findings via scratch_write so Claude (the "
        "orchestrator) can read them later. Be terse. Stop calling tools as "
        "soon as you have enough information to answer."
    )

    initial_user_entry = {
        "role": "user",
        "content": req.message,
        "ts": _datetime.now(_tz.utc).isoformat(),
        "image_path": req.image_path,
    }
    transcript.append(initial_user_entry)

    # Working message list — separate from transcript because OpenAI's tool
    # protocol needs strict role+id chaining the transcript doesn't preserve.
    msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    # Bring in the last ~10 transcript entries for short-term context.
    for e in transcript[-10:]:
        if e.get("image_path"):
            import base64
            p = _Path(e["image_path"])
            if p.is_file():
                bb = base64.b64encode(p.read_bytes()).decode("ascii")
                msgs.append({"role": e["role"], "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{bb}"}},
                    {"type": "text", "text": e["content"]},
                ]})
                continue
        msgs.append({"role": e["role"], "content": e["content"]})

    tool_schemas = get_tool_schemas(allow_writes=req.allow_writes)
    tool_call_log: list[dict[str, Any]] = []
    total_input = 0
    total_output = 0
    total_cost = 0.0
    iterations = 0
    final_text = ""
    scratch_saved: list[dict[str, str]] = []
    cancelled = False
    # Vision model is required when any history entry includes an image —
    # qwen3.7-max is text-only and 400s on image_url content blocks. Once we
    # flip to qwen-vl-max-latest for this loop, stay on it for all iterations
    # so multi-turn tool results keep working consistently.
    has_image_in_history = any(e.get("image_path") for e in transcript[-10:])
    pick_model = "qwen-vl-max-latest" if has_image_in_history else "qwen3.7-max"

    # Clear stale stop flag + register busy state so /agent/status + Claude
    # can see what's happening.
    _AGENT_STOP_FLAGS.pop(req.session_id, None)
    _AGENT_BUSY[req.project] = {
        "session_id": req.session_id,
        "started_at": _datetime.now(_tz.utc).isoformat(),
        "current_iteration": 0,
        "max_iterations": req.max_iterations,
    }

    for iteration in range(req.max_iterations):
        iterations = iteration + 1
        _AGENT_BUSY[req.project]["current_iteration"] = iterations

        # CAPTAIN PROTOCOL — check if Claude / user pressed Stop
        if _AGENT_STOP_FLAGS.pop(req.session_id, False):
            cancelled = True
            final_text = f"[cancelled by orchestrator at iteration {iterations}/{req.max_iterations}]"
            transcript.append({
                "role": "system",
                "content": final_text,
                "ts": _datetime.now(_tz.utc).isoformat(),
            })
            break

        try:
            result = await qwen_chat(
                [QwenMessage(**m) if "tool_call_id" not in m and "tool_calls" not in m else m for m in msgs],  # type: ignore[arg-type]
                budget=b,
                max_output_tokens=2048,
                tools=tool_schemas,
                model=pick_model,
            )
        except QwenTokenLimitError as e:
            _AGENT_BUSY.pop(req.project, None)  # clear busy on exception
            _persist_budgets()
            raise HTTPException(status_code=402, detail=str(e)) from None
        except QwenRateLimitError as e:
            _AGENT_BUSY.pop(req.project, None)
            _persist_budgets()
            raise HTTPException(status_code=429, detail=str(e)) from None
        except QwenKittyError as e:
            _AGENT_BUSY.pop(req.project, None)
            _persist_budgets()
            raise HTTPException(status_code=502, detail=str(e)) from None

        total_input += result["input_tokens"]
        total_output += result["output_tokens"]
        total_cost += result["cost_usd"]

        tool_calls = result.get("tool_calls")

        if tool_calls:
            # Append the assistant message verbatim (with tool_calls) before the tool replies.
            msgs.append({
                "role": "assistant",
                "content": result["text"] or None,
                "tool_calls": tool_calls,
            })
            # Surface to transcript so the user sees what Qwen is doing.
            for tc in tool_calls:
                transcript.append({
                    "role": "assistant",
                    "content": f"🛠 tool call: `{tc['function']['name']}` args: `{tc['function']['arguments'][:200]}`",
                    "ts": _datetime.now(_tz.utc).isoformat(),
                })
            # Dispatch each tool.
            for tc in tool_calls:
                tool_name = tc["function"]["name"]
                args_json = tc["function"]["arguments"]
                try:
                    tool_result = await dispatch_tool(
                        tool_name, args_json, allow_writes=req.allow_writes
                    )
                except Exception as e:  # noqa: BLE001
                    tool_result = f'{{"ok":false,"error":"{type(e).__name__}: {e}"}}'
                tool_call_log.append({
                    "iteration": iterations,
                    "name": tool_name,
                    "args": args_json,
                    "result": tool_result[:1500],  # cap for response payload
                })
                # Surface result to transcript (truncated).
                transcript.append({
                    "role": "system",
                    "content": f"↳ `{tool_name}` → `{tool_result[:300]}{'…' if len(tool_result) > 300 else ''}`",
                    "ts": _datetime.now(_tz.utc).isoformat(),
                })
                # Feed back to Qwen as the spec demands.
                msgs.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": tool_result,
                })
            continue  # Next iteration — Qwen reasons over tool results.

        # No tool calls — this is the final text reply.
        final_text = result["text"] or ""
        msgs.append({"role": "assistant", "content": final_text})

        # Auto-extract SCRATCH directives, same as plain /peer/send.
        for line in final_text.split("\n"):
            m = line.strip()
            if m.startswith("SCRATCH "):
                try:
                    head, _, body = m[len("SCRATCH "):].partition(":")
                    fn = head.strip()
                    if fn and body:
                        scratch_dir = _scratch_dir(req.project)
                        if not fn.endswith((".md", ".txt", ".json", ".log")):
                            fn = fn + ".md"
                        dst = scratch_dir / fn
                        dst.write_text(body.strip(), encoding="utf-8")
                        scratch_saved.append({"filename": fn, "size_bytes": str(dst.stat().st_size)})
                except Exception:  # noqa: BLE001
                    pass

        transcript.append({
            "role": "assistant",
            "content": final_text,
            "ts": _datetime.now(_tz.utc).isoformat(),
            "tokens": {"input": total_input, "output": total_output},
            "cost_usd": round(total_cost, 6),
        })
        break
    else:
        # Loop exhausted without a final text reply.
        final_text = (
            f"[agent halted: hit max_iterations={req.max_iterations} "
            f"after {len(tool_call_log)} tool calls without converging]"
        )
        transcript.append({
            "role": "system",
            "content": final_text,
            "ts": _datetime.now(_tz.utc).isoformat(),
        })

    # Clear busy state + persist updated budget on exit (success, cancel, or
    # max_iterations).
    _AGENT_BUSY.pop(req.project, None)
    _AGENT_STOP_FLAGS.pop(req.session_id, None)
    _persist_budgets()

    return {
        "response": final_text,
        "iterations": iterations,
        "cancelled": cancelled,
        "tool_calls": tool_call_log,
        "tokens": {"input": total_input, "output": total_output},
        "cost_usd": round(total_cost, 6),
        "scratch_saved": scratch_saved,
        "remaining_tokens": b.remaining_tokens(),
        "transcript_length": len(transcript),
    }


@router.post("/test")
async def test() -> dict[str, Any]:
    """Tiny smoke call (~$0.005) so the user can verify Kitty plumbing works
    without committing a real session. Bills from a one-shot 10k-token
    budget that's immediately discarded."""
    b = QwenBudget(session_id="smoke-test", reserved_tokens=10_000)
    try:
        result = await qwen_chat(
            [QwenMessage(role="user", content="Reply with exactly: pong")],
            budget=b,
            max_output_tokens=16,
        )
    except QwenKittyError as e:
        return {"ok": False, "error": str(e)}
    return {
        "ok": True,
        "response": result["text"],
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
        "cost_usd_billed": round(result["cost_usd"], 6),
    }
