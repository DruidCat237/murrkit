"""
WebSocket broadcast manager for murrkit backend.

Singleton `broadcast_manager` pushes progress events to all connected clients.
Routers call `await broadcast_manager.push(event_type, payload)` during long operations.

Usage (in routers):
    from backend.ws import broadcast_manager

    await broadcast_manager.push("sprite_gen_progress", {
        "animation": "walk",
        "step": 2,
        "total": 5,
        "message": "Generating walk animation...",
    })
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import WebSocket
from loguru import logger


class BroadcastManager:
    """Thread-safe broadcast manager for WebSocket clients."""

    def __init__(self) -> None:
        self._connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.append(ws)
        logger.debug("WS client connected ({n} total)", n=len(self._connections))

    def disconnect(self, ws: WebSocket) -> None:
        try:
            self._connections.remove(ws)
        except ValueError:
            pass
        logger.debug("WS client disconnected ({n} remain)", n=len(self._connections))

    async def push(self, event_type: str, payload: dict[str, Any]) -> None:
        """Push an event to all connected clients. Silently drops on send failure."""
        if not self._connections:
            return

        msg = json.dumps({"type": event_type, **payload})
        dead: list[WebSocket] = []

        for ws in self._connections:
            try:
                await ws.send_text(msg)
            except Exception:  # noqa: BLE001
                dead.append(ws)

        for ws in dead:
            self.disconnect(ws)

    @property
    def connection_count(self) -> int:
        return len(self._connections)


# Module-level singleton
broadcast_manager = BroadcastManager()
