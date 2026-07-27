"""Tests for _WsChannel — the serialized WS writer + liveness heartbeat.

Regression context: /loop and /autoplay shipped WITHOUT a heartbeat, so any
round that thought quietly for four minutes was killed by the dashboard's
idle watchdog ("Connection lost after 240s of silence"). These tests pin the
two properties that prevent that: pings keep coming while a turn is silent,
and concurrent writers never interleave a frame.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from backend.routers import chat


class FakeWs:
    """Records frames; optionally slow, to expose interleaving."""

    def __init__(self, delay: float = 0.0) -> None:
        self.frames: list[dict] = []
        self._delay = delay
        self._inside = 0
        self.overlapped = False

    async def send_text(self, text: str) -> None:
        self._inside += 1
        if self._inside > 1:
            self.overlapped = True  # two writers inside send at once
        if self._delay:
            await asyncio.sleep(self._delay)
        self.frames.append(json.loads(text))
        self._inside -= 1


@pytest.mark.asyncio
async def test_heartbeat_pings_while_the_turn_is_silent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat, "_WS_HEARTBEAT_INTERVAL_S", 0.02)
    ws = FakeWs()
    ch = chat._WsChannel(ws)
    ch.start_heartbeat()
    await asyncio.sleep(0.11)  # ≈5 intervals of pure silence
    ch.stop_heartbeat()
    await asyncio.sleep(0.03)

    pings = [f for f in ws.frames if f.get("kind") == "ping"]
    assert len(pings) >= 3, f"heartbeat milczy: {ws.frames}"
    assert all(isinstance(p.get("ts"), float) for p in pings)


@pytest.mark.asyncio
async def test_heartbeat_stops_and_stays_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat, "_WS_HEARTBEAT_INTERVAL_S", 0.02)
    ws = FakeWs()
    ch = chat._WsChannel(ws)
    ch.start_heartbeat()
    await asyncio.sleep(0.05)
    ch.stop_heartbeat()
    after_stop = len(ws.frames)
    await asyncio.sleep(0.08)
    assert len(ws.frames) == after_stop, "heartbeat bije po zatrzymaniu"


@pytest.mark.asyncio
async def test_writes_are_serialized(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat, "_WS_HEARTBEAT_INTERVAL_S", 0.005)
    ws = FakeWs(delay=0.004)  # slow socket: unlocked writers would overlap
    ch = chat._WsChannel(ws)
    ch.start_heartbeat()
    await asyncio.gather(*(ch.send({"kind": "token", "i": i}) for i in range(15)))
    ch.stop_heartbeat()
    await asyncio.sleep(0.01)

    assert not ws.overlapped, "równoległe ramki weszły sobie w drogę"
    tokens = [f["i"] for f in ws.frames if f.get("kind") == "token"]
    assert tokens == list(range(15)), tokens


@pytest.mark.asyncio
async def test_a_dead_socket_does_not_crash_the_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat, "_WS_HEARTBEAT_INTERVAL_S", 0.01)

    class DeadWs:
        async def send_text(self, text: str) -> None:
            raise RuntimeError("socket closed")

    ch = chat._WsChannel(DeadWs())
    ch.start_heartbeat()
    await asyncio.sleep(0.05)  # the beat task must swallow it and exit quietly
    ch.stop_heartbeat()


@pytest.mark.asyncio
async def test_closed_peer_does_not_raise_into_the_turn() -> None:
    """The dashboard closes on `final` while the CLI may still emit frames.

    Starlette raises RuntimeError on a post-close send; if that escapes, the
    endpoint's error path tears the captain down mid-tool (real incident
    2026-07-27). The channel must absorb it instead.
    """

    class ClosedWs:
        def __init__(self) -> None:
            self.sent = 0

        async def send_text(self, text: str) -> None:
            self.sent += 1
            raise RuntimeError('Cannot call "send" once a close message has been sent.')

    ws = ClosedWs()
    ch = chat._WsChannel(ws)
    await ch.send({"kind": "token", "text": "a"})   # must not raise
    assert ch.closed is True
    await ch.send({"kind": "token", "text": "b"})   # and must not even try again
    await ch.send({"kind": "final", "text": "c"})
    assert ws.sent == 1, "po zamknieciu nie wolno dalej pisac do gniazda"


@pytest.mark.asyncio
async def test_heartbeat_stops_itself_when_the_peer_closes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat, "_WS_HEARTBEAT_INTERVAL_S", 0.01)

    class ClosedWs:
        def __init__(self) -> None:
            self.sent = 0

        async def send_text(self, text: str) -> None:
            self.sent += 1
            raise RuntimeError("Cannot call \"send\" once a close message has been sent.")

    ws = ClosedWs()
    ch = chat._WsChannel(ws)
    ch.start_heartbeat()
    await asyncio.sleep(0.06)
    assert ws.sent == 1, "heartbeat dobija sie do zamknietego gniazda"
    assert ch.closed is True
