"""
qwen_tools.py — Tool registry for the peer model's vision-review agent mode.

The peer (a second-opinion model, surfaced to the user only as "the peer
reviewer" — we use Qwen-VL here, which is *not* hidden) is a REVIEWER, not a
builder. In murrkit's Phaser architecture the inner Claude writes the game
(level YAML → deterministic TypeScript scene compiler) and the peer
independently LOOKS at the running game and reports gameplay / visual bugs.

Its hands are therefore vision + notes only:
  - game_take_screenshot — one Playwright screenshot of a level (the peer "sees")
  - game_capture_frame   — screenshot appended to a per-project frame buffer
  - qwen_review_frames    — send the captured sequence to Qwen-VL for analysis
  - scratch_write / read   — leave findings for Claude to pick up

Every screenshot comes from the Phaser dev server via headless Playwright
(`backend.routers.phaser.phaser_screenshot`) — the same proven capture path the
playtest pipeline uses (thread + ProactorEventLoop on Windows). There are NO
engine-mutation tools: the peer never edits the scene — that is exclusively
Claude's job, and only through level YAML.

History note: this registry previously wrapped a Unity-MCP proxy
(screenshot / console / hierarchy / gameobject / execute-C# / play-mode /
click-cell). All of that was Unity-editor-specific and was removed when murrkit
migrated to Phaser 3 + Playwright; the underlying `backend.routers.unity`
module no longer exists. The vision-review capability (frame capture + VL
analysis) was preserved and rebuilt on Playwright.

Design notes
------------
- Tool schemas are OpenAI-compatible:
  `{"type": "function", "function": {"name": ..., "description": ..., "parameters": {...}}}`
- Dispatchers are `async def(args: dict) -> dict | str`. Return value is
  JSON-serialised and shipped back to the peer as a `tool` message.
- Every dispatcher converts exceptions into compact error payloads so a single
  failing tool never kills the whole agent loop.

Surface naming: never expose the upstream image/text provider plumbing to the
user.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from loguru import logger

# Tool dispatchers import lazily from backend routers to avoid circular
# imports. Each dispatcher takes a dict (already-parsed JSON args from the peer)
# and returns a JSON-serialisable payload.

DispatchFn = Callable[[dict[str, Any]], Awaitable[Any]]


# ============================================================================
# Screenshot source — Phaser dev server via headless Playwright
# ============================================================================
# One shared capture path so every vision tool behaves identically. The
# endpoint is decorated with `@_proactor_endpoint`, which runs the Playwright
# subprocess on a ProactorEventLoop in a worker thread (Windows-safe) and still
# returns its dict result when awaited directly.


async def _phaser_capture(level_id: str | None, width: int, height: int) -> dict[str, Any]:
    """Take one screenshot of the running Phaser game; return the endpoint payload.

    Thin wrapper over `/api/phaser/screenshot` so all of the peer's vision tools
    share one capture path (Playwright → persisted PNG under
    `public_files/screenshots/`).
    """
    from backend.routers.phaser import ScreenshotRequest, phaser_screenshot  # type: ignore

    req = ScreenshotRequest(level_id=level_id, width=width, height=height)
    return await phaser_screenshot(req)


async def _dispatch_screenshot(args: dict[str, Any]) -> dict[str, Any]:
    """Take a single screenshot of the live Phaser game (headless Playwright).

    Returns the absolute file path; the peer references it in its reply and the
    orchestrator surfaces it to the user / passes it back to Claude. Use for
    one-off visual verification (for a chronological playthrough use
    game_capture_frame instead).
    """
    level_id = args.get("level_id") or args.get("level")
    try:
        width = int(args.get("width") or 1280)
        height = int(args.get("height") or 720)
    except Exception:  # noqa: BLE001 — schema mismatch, default everything
        width, height = 1280, 720

    try:
        shot = await _phaser_capture(level_id, width, height)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}

    src = shot.get("persisted_path") if isinstance(shot, dict) else None
    if not src:
        return {"ok": False, "error": "screenshot produced no path", "raw_head": str(shot)[:200]}
    return {
        "ok": True,
        "abs_path": src,
        "served_url": shot.get("served_url"),
        "size_bytes": shot.get("size_bytes"),
        "note": "Screenshot saved. Reference abs_path when describing the result.",
    }


# ============================================================================
# Scratch pad — markdown reports the peer leaves for Claude (engine-agnostic)
# ============================================================================


async def _dispatch_scratch_write(args: dict[str, Any]) -> dict[str, Any]:
    """Persist a markdown / text report under agent_scratch/qwen/<project>/."""
    from backend.routers.qwen import _scratch_dir

    project = args.get("project") or "default"
    filename = args.get("filename") or "report.md"
    content = args.get("content") or ""
    if ".." in filename or "/" in filename or "\\" in filename:
        return {"ok": False, "error": "filename must be a leaf — no slashes / .."}
    if not filename.endswith((".md", ".txt", ".json", ".log")):
        filename = filename + ".md"
    dst = _scratch_dir(project) / filename
    dst.write_text(content, encoding="utf-8")
    return {
        "ok": True,
        "abs_path": str(dst.resolve()),
        "rel_path": f"agent_scratch/qwen/{project}/{filename}",
        "size_bytes": dst.stat().st_size,
    }


async def _dispatch_scratch_read(args: dict[str, Any]) -> dict[str, Any]:
    from backend.routers.qwen import _scratch_dir

    project = args.get("project") or "default"
    filename = args.get("filename") or ""
    if not filename or ".." in filename or "/" in filename or "\\" in filename:
        return {"ok": False, "error": "filename required + leaf-only"}
    f = _scratch_dir(project) / filename
    if not f.is_file():
        return {"ok": False, "error": f"not found: {filename}"}
    return {
        "ok": True,
        "filename": filename,
        "content": f.read_text(encoding="utf-8", errors="replace"),
    }


# ============================================================================
# Playtest mode — the peer captures a frame sequence, then reviews it
# ============================================================================
# Per-project capture session: list of {label, path} for every frame the
# playtest took. Cleared implicitly by starting a fresh capture sequence.
# Module-level dict — survives within one backend process; fine for this
# short-lived workflow.

_PLAYTEST_FRAMES: dict[str, list[dict[str, str]]] = {}


def _playtest_dir(project: str):
    """`agent_scratch/qwen/<project>/playtest/`."""
    safe = "".join(c for c in project if c.isalnum() or c in ("-", "_"))[:64] or "default"
    from core.config import PROJECT_ROOT  # type: ignore[attr-defined]

    p = Path(PROJECT_ROOT) / "agent_scratch" / "qwen" / safe / "playtest"
    p.mkdir(parents=True, exist_ok=True)
    return p


async def _dispatch_capture_frame(args: dict[str, Any]) -> dict[str, Any]:
    """Screenshot the live Phaser game and append it to the playtest frame buffer.

    [Protected vision capability — rebuilt on Playwright.] Each call drives a
    headless screenshot of the dev-server level and stores it under
    agent_scratch/qwen/<project>/playtest/ with a sequential, labelled filename
    so the later qwen_review_frames call can analyze the buffer as a
    chronological sequence. Pass `level_id` to target a specific level (omit to
    capture whatever the dev server currently serves).
    """
    project = args.get("project") or "default"
    level_id = args.get("level_id") or args.get("level")
    label = args.get("label") or f"frame_{len(_PLAYTEST_FRAMES.get(project, []))}"
    # Sanitize label so it becomes a safe filename.
    safe_label = re.sub(r"[^A-Za-z0-9_-]", "_", label)[:40] or "frame"

    try:
        shot = await _phaser_capture(level_id, 1280, 720)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"screenshot: {e}"}

    src = shot.get("persisted_path") if isinstance(shot, dict) else None
    if not src or not Path(src).is_file():
        return {"ok": False, "error": "screenshot did not produce a file", "raw_head": str(shot)[:200]}

    out_dir = _playtest_dir(project)
    idx = len(_PLAYTEST_FRAMES.setdefault(project, []))
    out = out_dir / f"{idx:03d}_{safe_label}.png"
    try:
        out.write_bytes(Path(src).read_bytes())
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"copy: {e}"}

    _PLAYTEST_FRAMES[project].append({"label": label, "path": str(out.resolve())})
    return {
        "ok": True,
        "frame_idx": idx,
        "label": label,
        "abs_path": str(out.resolve()),
        "total_frames": len(_PLAYTEST_FRAMES[project]),
    }


# Genre-agnostic 2D-game playtest review prompt. Shared with the Qwen-VL
# fallback path in backend/routers/vision.py (imported by name) — keep this a
# module-level constant and keep it game-neutral so it works for ANY 2D game,
# not one specific title.
_REVIEW_SYSTEM_PROMPT = """\
You are reviewing a playthrough of a 2D game, given as an ORDERED SEQUENCE of
screenshots (frames) captured during play. Your job is to find GAMEPLAY and
VISUAL bugs from the pixels — not to redesign the art direction.

## How to read the sequence
You are given N chronological frames, each with a label. The DIFFERENCES
between consecutive frames are where the gameplay lives. If two frames that
should differ look identical, that is a high-priority finding — it usually
means an input/action did not register or the game is stuck. Always check
inter-frame deltas BEFORE commenting on a single frame's aesthetics.

## What counts as a bug (judge this)
- Objects that should move / spawn / disappear in response to an action but don't.
- Sprites that are the wrong size, off-centre, overlapping, clipped by the
  screen edge, or drawn with a visible background box / wrong transparency.
- Missing assets (magenta or checkerboard placeholders, blank rectangles).
- HUD / score / text that is unreadable, overlapping, or never updates.
- Win / lose / end states that never trigger, or trigger incorrectly.
- Physics that is obviously wrong (objects falling through floors, frozen motion).

## What is NOT a bug (do not flag)
- Deliberate static background art / decoration that never changes between
  frames — it is scenery, not a "player token", and is not "inconsistent".
- Overall colour-palette or art-style preferences.
- Anything you cannot point to actual frame evidence for.

## What to return
1. **Frame-by-frame delta** — one line per frame: what changed vs the previous
   frame (e.g. "frame 3: player moved right, coin disappeared" or "frame 4:
   identical to 3 — the action did not register").
2. **Bugs found** — max 5 bullets, ranked by severity. For each: which frame
   revealed it, what is wrong (size? position? overlap? no-response?), and one
   concrete fix at the right scope.
3. **Playability verdict** — ✅ playable / ⚠ playable-with-issues / ❌ broken,
   with a one-sentence reason.

If you cannot tell because frames are identical or ambiguous, say so plainly
and recommend checking the input/action pipeline rather than guessing.
"""


async def _dispatch_review_frames(args: dict[str, Any]) -> dict[str, Any]:
    """Send the captured playtest frame sequence to Qwen-VL for analysis.

    [Protected vision capability.] Builds an OpenAI-style multi-image content
    block with all frames + the structured genre-agnostic prompt, then calls
    qwen-vl-max-latest (the model in our upstream compatible-mode whitelist that
    actually processes image pixels — text-only models accept image blocks but
    reply "No image provided"). Returns the model's textual analysis. Pass the
    current budget `session_id` so the inner VL call bills against the same
    reservation.
    """
    from backend.routers.qwen import _BUDGETS
    from tools.qwen_client import QwenMessage, qwen_chat

    project = args.get("project") or "default"
    custom_question = args.get("question")  # let caller override the standard prompt
    session_id = args.get("session_id")
    if not session_id:
        return {"ok": False, "error": "missing session_id (budget required for inner VL call)"}
    b = _BUDGETS.get(session_id)
    if b is None:
        return {"ok": False, "error": f"unknown budget session {session_id}"}

    frames = _PLAYTEST_FRAMES.get(project, [])
    if not frames:
        return {"ok": False, "error": "no playtest frames captured yet — call game_capture_frame first"}

    # Build multi-image content block. Cap at 10 frames to keep cost bounded.
    sampled = frames[-10:] if len(frames) > 10 else frames
    content_blocks: list[dict[str, Any]] = []
    for f in sampled:
        p = Path(f["path"])
        if not p.is_file():
            continue
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        content_blocks.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{b64}"},
        })

    # Annotate each frame with its sequential index + label so the model can
    # reference them in its delta analysis.
    frame_index = "\n".join(
        f"  frame {i}: label='{f['label']}'" for i, f in enumerate(sampled)
    )
    user_text = (
        f"Playthrough has {len(sampled)} frames, in chronological order:\n"
        f"{frame_index}\n\n"
    )
    if custom_question:
        user_text += custom_question
    else:
        user_text += (
            "Apply the protocol from the system message: frame-by-frame "
            "delta first, then ranked gameplay bugs, then playability verdict."
        )
    content_blocks.append({"type": "text", "text": user_text})

    try:
        result = await qwen_chat(
            [
                QwenMessage(role="system", content=_REVIEW_SYSTEM_PROMPT),
                {"role": "user", "content": content_blocks},
            ],
            budget=b,
            max_output_tokens=2048,
            model="qwen-vl-max-latest",
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"VL inference failed: {e}"}

    return {
        "ok": True,
        "analysis": result["text"],
        "frames_reviewed": len(sampled),
        "frame_labels": [f["label"] for f in sampled],
        "tokens": {"input": result["input_tokens"], "output": result["output_tokens"]},
        "cost_usd": round(result["cost_usd"], 6),
    }


# ============================================================================
# Tool registry — schema (OpenAI-compatible format) + dispatcher
# ============================================================================


# Read-only / safe tools — always enabled. The peer is a reviewer: it looks at
# the game and writes notes, it never mutates the scene.
READ_TOOLS: dict[str, dict[str, Any]] = {
    "game_take_screenshot": {
        "schema": {
            "type": "function",
            "function": {
                "name": "game_take_screenshot",
                "description": (
                    "Take a screenshot of the live Phaser game (headless "
                    "Playwright against the dev server). Returns the absolute "
                    "file path; you can reference it in your reply and the "
                    "orchestrator will surface it to the user / pass it back to "
                    "Claude. Use for one-off visual verification."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "level_id": {
                            "type": "string",
                            "description": "Optional level id (loads /?level=<id>); omit for the current page",
                        },
                        "width": {"type": "integer", "default": 1280},
                        "height": {"type": "integer", "default": 720},
                    },
                    "required": [],
                },
            },
        },
        "dispatch": _dispatch_screenshot,
    },
    "scratch_write": {
        "schema": {
            "type": "function",
            "function": {
                "name": "scratch_write",
                "description": (
                    "Save a markdown report under agent_scratch/qwen/<project>/. "
                    "Claude can later Read it via the standard Read tool. Use for "
                    "playtest reports, review findings, asset wishlists."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": {"type": "string", "default": "default"},
                        "filename": {"type": "string", "description": "leaf filename, .md extension auto-added"},
                        "content": {"type": "string", "description": "Markdown body"},
                    },
                    "required": ["filename", "content"],
                },
            },
        },
        "dispatch": _dispatch_scratch_write,
    },
    "scratch_read": {
        "schema": {
            "type": "function",
            "function": {
                "name": "scratch_read",
                "description": "Read back a scratch file you (or Claude) wrote earlier.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": {"type": "string", "default": "default"},
                        "filename": {"type": "string"},
                    },
                    "required": ["filename"],
                },
            },
        },
        "dispatch": _dispatch_scratch_read,
    },
    "game_capture_frame": {
        "schema": {
            "type": "function",
            "function": {
                "name": "game_capture_frame",
                "description": (
                    "Screenshot the live Phaser game and append it to the "
                    "current playtest frame buffer. Call ONCE after every "
                    "meaningful action (a move, a spawn, a win screen, etc). "
                    "Frames are indexed sequentially so the later "
                    "qwen_review_frames call can analyze them as a chronological "
                    "sequence. Pass level_id to target a specific level."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": {"type": "string", "default": "default"},
                        "level_id": {
                            "type": "string",
                            "description": "Optional level id to load before capturing",
                        },
                        "label": {
                            "type": "string",
                            "description": "short tag, e.g. 'start', 'after_jump', 'win_screen'",
                        },
                    },
                    "required": ["label"],
                },
            },
        },
        "dispatch": _dispatch_capture_frame,
    },
    "qwen_review_frames": {
        "schema": {
            "type": "function",
            "function": {
                "name": "qwen_review_frames",
                "description": (
                    "After a playthrough is finished, call this ONCE to send all "
                    "captured frames as a multi-image sequence to Qwen-VL for "
                    "analysis. Returns a detailed verdict (delta / bugs / "
                    "playability). Costs ~$0.003 for a 6-frame run. Pass your "
                    "current budget session_id so the inner VL call bills "
                    "against the same reservation."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": {"type": "string", "default": "default"},
                        "session_id": {
                            "type": "string",
                            "description": "Qwen budget session_id (the same you're already using)",
                        },
                        "question": {
                            "type": "string",
                            "description": "Optional custom analysis prompt; omit for the standard playtest verdict template",
                        },
                    },
                    "required": ["session_id"],
                },
            },
        },
        "dispatch": _dispatch_review_frames,
    },
}


# Write tools — gated behind allow_writes=True. Intentionally EMPTY in the
# Phaser architecture: the peer is a vision reviewer and never mutates the game
# (all scene edits go through Claude → level YAML). The `allow_writes` plumbing
# is kept so a future Phaser-native write tool can slot in here without changing
# the call sites.
WRITE_TOOLS: dict[str, dict[str, Any]] = {}


def get_tool_schemas(allow_writes: bool = False) -> list[dict[str, Any]]:
    """Return the OpenAI-compatible `tools` array for the peer request."""
    schemas = [t["schema"] for t in READ_TOOLS.values()]
    if allow_writes:
        schemas.extend(t["schema"] for t in WRITE_TOOLS.values())
    return schemas


def get_dispatcher(name: str, *, allow_writes: bool) -> DispatchFn | None:
    """Resolve a tool name to its dispatcher. Returns None for unknown / blocked."""
    if name in READ_TOOLS:
        return READ_TOOLS[name]["dispatch"]
    if allow_writes and name in WRITE_TOOLS:
        return WRITE_TOOLS[name]["dispatch"]
    return None


async def dispatch_tool(name: str, args_json: str, *, allow_writes: bool) -> str:
    """Execute a single tool call and return the JSON-encoded result.

    Always returns a string (the peer's `tool` message content must be string).
    Errors are encoded as JSON so the agent loop can detect + recover.
    """
    fn = get_dispatcher(name, allow_writes=allow_writes)
    if fn is None:
        return json.dumps({
            "ok": False,
            "error": f"unknown or disabled tool: {name}",
            "hint": "writes blocked? set allow_writes=true" if name in WRITE_TOOLS else None,
        })
    try:
        args = json.loads(args_json) if isinstance(args_json, str) else (args_json or {})
    except json.JSONDecodeError as e:
        return json.dumps({"ok": False, "error": f"invalid JSON args: {e}"})

    logger.info("peer-tool-call: {n} args={a}", n=name, a=str(args)[:200])
    try:
        result = await fn(args)
    except Exception as e:  # noqa: BLE001 — defensive, every tool error must be loop-safe
        logger.exception("peer-tool error in {n}", n=name)
        return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"})
    # Compact JSON to keep token cost low.
    try:
        return json.dumps(result, default=str)
    except Exception:  # noqa: BLE001
        return json.dumps({"ok": False, "error": "tool result not JSON-serializable", "repr": repr(result)[:500]})
