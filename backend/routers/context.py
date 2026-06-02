"""
Context router — single-call endpoint that surfaces the *full* runtime
context to the frontend header (project, game path, Claude CLI version,
DeepSeek model, budget remaining, MCP status). Polled every 30s by the
header strip.

Endpoint:
    GET /api/context/current  → ContextSnapshot
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from core.config import PROJECT_ROOT, budget, settings

router = APIRouter(prefix="/api/context", tags=["context"])

DEFAULT_UNITY_MCP_HTTP_URL = "http://127.0.0.1:8080"


class ContextSnapshot(BaseModel):
    superagent_project: str | None
    unity_project_path: str
    unity_project_name: str
    claude_cli_version: str | None
    claude_cli_path: str | None
    mcp_unity_status: str  # "ready" | "offline" | "unknown"
    mcp_unity_transport: str  # "http" | "stdio" | "unknown"
    deepseek_model: str
    budget_limit_usd: float
    budget_spent_usd: float
    budget_remaining_usd: float
    backend_port: int


def _read_active_project() -> str | None:
    """The frontend writes the active project to a small JSON file on every
    selection (see frontend/components/ProjectsSidebar.tsx). Read it here so
    the backend can echo it back."""
    f = PROJECT_ROOT / ".omc" / "active_project.json"
    if not f.exists():
        return None
    try:
        import json
        data = json.loads(f.read_text(encoding="utf-8"))
        v = data.get("name")
        return str(v) if v else None
    except Exception:  # noqa: BLE001
        return None


async def _detect_unity_mcp() -> tuple[str, str]:
    """Return (status, transport)."""
    url = os.environ.get("UNITY_MCP_HTTP_URL", DEFAULT_UNITY_MCP_HTTP_URL).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"{url}/health")
            if r.status_code < 500:
                return "ready", "http"
    except Exception:  # noqa: BLE001
        pass
    # Fall back to stdio probe
    stdio = settings.unity_mcp_server
    if Path(stdio).is_file():
        return "ready", "stdio"
    return "offline", "unknown"


async def _detect_claude_cli() -> tuple[str | None, str | None]:
    cli = shutil.which("claude")
    if cli is None:
        return None, None
    import asyncio
    import subprocess as _sp
    try:
        # subprocess.run via to_thread — works on any event loop, including
        # the SelectorEventLoop uvicorn may use on Windows.
        result = await asyncio.to_thread(
            _sp.run,
            [cli, "--version"],
            capture_output=True,
            timeout=8,
            text=False,
        )
        out = result.stdout or result.stderr
        version = out.decode("utf-8", errors="replace").strip()[:120]
        return version or None, cli
    except Exception:  # noqa: BLE001
        return None, cli


@router.get("/current", response_model=ContextSnapshot)
async def get_current_context() -> ContextSnapshot:
    status, transport = await _detect_unity_mcp()
    cli_version, cli_path = await _detect_claude_cli()
    return ContextSnapshot(
        superagent_project=_read_active_project(),
        unity_project_path=str(settings.unity_project_path),
        unity_project_name=settings.unity_project_name,
        claude_cli_version=cli_version,
        claude_cli_path=cli_path,
        mcp_unity_status=status,
        mcp_unity_transport=transport,
        deepseek_model=settings.deepseek_model,
        budget_limit_usd=settings.budget_limit_usd,
        budget_spent_usd=budget.spent_usd,
        budget_remaining_usd=budget.remaining_usd,
        backend_port=settings.backend_port,
    )


class SetActiveProjectRequest(BaseModel):
    name: str


@router.post("/active-project")
async def set_active_project(req: SetActiveProjectRequest) -> dict[str, Any]:
    """Persist the selected project so the backend can prepend it to every
    Claude CLI prompt as system context (see chat router)."""
    import json
    p = PROJECT_ROOT / ".omc"
    p.mkdir(parents=True, exist_ok=True)
    (p / "active_project.json").write_text(
        json.dumps({"name": req.name}), encoding="utf-8"
    )
    return {"status": "ok", "name": req.name}
