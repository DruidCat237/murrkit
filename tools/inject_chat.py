"""
inject_chat.py — fire-and-forget injector for Claude CLI chat sessions.

Pipes a long user-message into the per-project Claude chat without going through
the React textarea (which times out on multi-KB pastes via Chrome MCP). Talks to
`/api/chat/stream` WebSocket exactly like the frontend does, so:
  - the message is persisted in chat_history.db (visible after UI refresh)
  - Claude CLI subprocess starts with --resume on the project's last session_id
    (auto-loaded by backend), so prior conversation context survives
  - stream events flow through the same StreamGuard (Designer Mode imagination
    check + cost guard + dedup + reward-hack guard)

Usage:
    uv run python -m tools.inject_chat AngryCatPhaser claude_opus .omc/autopilot_megaprompt.md
"""
from __future__ import annotations

import asyncio
import io
import json
import sys
import time
import uuid
from pathlib import Path

import websockets

# Force UTF-8 on stdout so emoji + Polish in event logs survive Windows cp1250.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)

PROJECT_ROOT = Path(__file__).resolve().parents[1]


async def stream(project: str, model: str, message: str) -> None:
    task_id = f"autopilot_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    uri = "ws://127.0.0.1:8002/api/chat/stream"
    print(f"[inject_chat] connecting to {uri} project={project} model={model} task={task_id}")
    print(f"[inject_chat] message length: {len(message)} chars")

    async with websockets.connect(uri, max_size=8 * 1024 * 1024) as ws:
        await ws.send(json.dumps({
            "task_id": task_id,
            "project_name": project,
            "message": message,
            "model": model,
            "attachments": [],
        }))
        tool_count = 0
        token_chars = 0
        warning_count = 0
        async for raw in ws:
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = evt.get("kind", "?")
            if kind == "started":
                print(f"[inject_chat] ▶ started")
            elif kind == "system":
                sid = evt.get("session_id", "")[:12]
                print(f"[inject_chat] system session_id={sid}")
            elif kind == "token":
                token_chars += len(evt.get("text", ""))
            elif kind == "tool_use":
                tool_count += 1
                name = evt.get("name", "?")
                args = (evt.get("args_summary") or "")[:120]
                print(f"[inject_chat] tool#{tool_count}: {name}  {args}")
            elif kind == "tool_result":
                ok = evt.get("ok", True)
                summary = (evt.get("result_summary") or "")[:80]
                tag = "✓" if ok else "✗"
                print(f"[inject_chat] {tag} result: {summary}")
            elif kind == "warning":
                warning_count += 1
                level = evt.get("level", "?")
                text = (evt.get("text") or "")[:200]
                print(f"[inject_chat] ⚠ warning ({level}): {text}")
            elif kind == "final":
                cost = evt.get("cost_usd", 0.0)
                dur_ms = evt.get("duration_ms", 0)
                turns = evt.get("num_turns", 0)
                print(f"[inject_chat] ✅ FINAL — cost=${cost:.4f} duration={dur_ms / 1000:.1f}s turns={turns} tools={tool_count} tokens={token_chars} warnings={warning_count}")
                break
            elif kind == "aborted":
                print(f"[inject_chat] ⏹ aborted: {evt.get('reason')}")
                break
            elif kind == "error":
                print(f"[inject_chat] ✗ error: {evt.get('error')}")
                break


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: python -m tools.inject_chat <project> <model> <message_file>", file=sys.stderr)
        return 2
    project = sys.argv[1]
    model = sys.argv[2]
    message_path = Path(sys.argv[3])
    if not message_path.is_absolute():
        message_path = PROJECT_ROOT / message_path
    if not message_path.is_file():
        print(f"message file not found: {message_path}", file=sys.stderr)
        return 1
    message = message_path.read_text(encoding="utf-8")
    asyncio.run(stream(project, model, message))
    return 0


if __name__ == "__main__":
    sys.exit(main())
