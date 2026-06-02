"""Smoke test for /api/chat/stream WebSocket — minimal connect-send-receive."""

from __future__ import annotations

import asyncio
import json
import sys


async def main() -> None:
    try:
        import websockets
    except ImportError:
        print("[SKIP] websockets package not installed — pip install websockets")
        sys.exit(0)

    uri = "ws://127.0.0.1:8001/api/chat/stream"
    print(f"Connecting to {uri}...")
    try:
        async with websockets.connect(uri) as ws:
            print("  Connected.")
            await ws.send(json.dumps({
                "task_id": "smoke_test_001",
                "project_name": "default",
                "message": "Reply with the single word 'PONG' and nothing else.",
                "model": "deepseek_v4",
                "attachments": [],
            }))
            print("  Sent payload.")

            received_events = 0
            saw_token = False
            saw_final = False
            try:
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=60.0)
                    evt = json.loads(raw)
                    received_events += 1
                    kind = evt.get("kind")
                    if kind == "token":
                        saw_token = True
                        print(f"  Token: {evt.get('text', '')[:40]}")
                    elif kind == "final":
                        saw_final = True
                        print(f"  Final: text={evt.get('text', '')[:80]!r} cost=${evt.get('cost_usd', 0):.6f}")
                        break
                    elif kind == "started":
                        print(f"  Started task {evt.get('task_id')}")
                    elif kind == "error":
                        print(f"  ERROR: {evt.get('error')}")
                        break
                    else:
                        print(f"  Event: {kind}")
            except asyncio.TimeoutError:
                print("  [TIMEOUT] no final within 60s")
    except Exception as e:
        print(f"  [FAIL] {e}")
        sys.exit(1)

    print(f"\nReceived {received_events} events")
    print(f"saw_token={saw_token} saw_final={saw_final}")
    if saw_token and saw_final:
        print("[OK] WebSocket chat stream works end-to-end.")
    else:
        print("[WARN] Stream completed but missing token or final.")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
