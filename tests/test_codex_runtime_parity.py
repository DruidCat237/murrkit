from __future__ import annotations

import asyncio
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from backend.routers import chat


def _image_args(cmd: list[str]) -> list[str]:
    return [cmd[i + 1] for i, part in enumerate(cmd[:-1]) if part == "--image"]


def test_codex_exec_cmd_fresh_and_resume_include_mcp_images_and_model(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    monkeypatch.setattr(chat, "PROJECT_ROOT", tmp_path)
    mcp_config = tmp_path / "backend" / "playtest_mcp.json"
    mcp_config.parent.mkdir(parents=True)
    mcp_config.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(chat, "_PLAYTEST_MCP_CONFIG", mcp_config)
    (tmp_path / ".env").write_text(
        "CODEX_SANDBOX=workspace-write\nCODEX_APPROVAL_POLICY=never\n",
        encoding="utf-8",
    )

    ref_dir = tmp_path / ".omc" / "references" / "Game"
    keyframes = ref_dir / "clip.mp4.keyframes"
    keyframes.mkdir(parents=True)
    ref = ref_dir / "ref.png"
    frame = keyframes / "frame_001.jpg"
    ref.write_bytes(b"image")
    frame.write_bytes(b"image")
    attachment = [{"abs_path": str(ref)}]

    chat._session_by_project.clear()
    fresh = chat._codex_exec_cmd(
        "codex",
        "gpt-test",
        project_name="Game",
        attachments=attachment,
    )

    assert fresh[:4] == ["codex", "--ask-for-approval", "never", "exec"]
    assert "resume" not in fresh
    assert "--json" in fresh
    assert fresh[fresh.index("--cd") + 1] == str(tmp_path)
    assert fresh[fresh.index("--sandbox") + 1] == "workspace-write"
    assert fresh[fresh.index("--model") + 1] == "gpt-test"
    assert fresh[-1] == "-"
    assert any("mcp_servers.playwright.command" in part for part in fresh)
    assert any("mcp_servers.playwright.args" in part for part in fresh)
    assert _image_args(fresh) == [str(ref.resolve()), str(frame.resolve())]

    chat._session_by_project[chat._session_storage_key("Game", "codex")] = "sess-123"
    resumed = chat._codex_exec_cmd(
        "codex",
        "gpt-test",
        project_name="Game",
        attachments=attachment,
    )

    assert "resume" in resumed
    assert resumed[resumed.index("resume") + 1] == "--image"
    assert resumed[-3:] == ["gpt-test", "sess-123", "-"]
    assert _image_args(resumed) == [str(ref.resolve()), str(frame.resolve())]


def test_codex_collects_session_text_and_tool_events() -> None:
    stdout = "\n".join(
        [
            json.dumps({"type": "session.created", "id": "sess-abc"}),
            json.dumps({
                "type": "message",
                "message": {"content": [{"type": "text", "text": "Hello"}]},
            }),
            json.dumps({
                "msg": {
                    "type": "assistant_message",
                    "content": [{"type": "text", "text": " world"}],
                },
            }),
        ],
    ).encode()

    text, session_id = chat._collect_codex_result(stdout)

    assert text == "Hello world"
    assert session_id == "sess-abc"

    tool_event = chat._codex_tool_event(
        {
            "type": "function_call",
            "call_id": "tool-1",
            "name": "shell",
            "arguments": {"cmd": "npm run type-check"},
        },
    )
    assert tool_event == {
        "kind": "tool_use",
        "id": "tool-1",
        "name": "shell",
        "args_summary": '{"cmd": "npm run type-check"}',
    }


def test_agent_session_keys_are_runtime_scoped(monkeypatch: Any) -> None:
    saved: dict[str, str] = {}
    monkeypatch.setattr(chat._project_memory, "update_session", lambda key, sid: saved.update({key: sid}))

    chat._session_by_project.clear()
    chat._remember_agent_session("Game", "claude", "claude-sid")
    chat._remember_agent_session("Game", "codex", "codex-sid")

    assert chat._session_by_project["Game"] == "claude-sid"
    assert chat._session_by_project["codex:Game"] == "codex-sid"
    assert saved == {"Game": "claude-sid", "codex:Game": "codex-sid"}


def test_clear_history_clears_claude_and_codex_sessions(monkeypatch: Any) -> None:
    class _Cursor:
        rowcount = 0

    class _Conn:
        def execute(self, *_args: Any, **_kwargs: Any) -> _Cursor:
            return _Cursor()

    @contextmanager
    def _fake_db() -> Any:
        yield _Conn()

    saved: dict[str, str] = {}
    monkeypatch.setattr(chat, "_db", _fake_db)
    monkeypatch.setattr(chat._project_memory, "save_sessions", lambda sessions: saved.update(sessions))

    chat._session_by_project.clear()
    chat._session_by_project["Game"] = "claude-sid"
    chat._session_by_project["codex:Game"] = "codex-sid"

    result = asyncio.run(chat.clear_history("Game"))

    assert result == {"deleted": 0, "project_name": "Game"}
    assert "Game" not in chat._session_by_project
    assert "codex:Game" not in chat._session_by_project
    assert saved == {}
