"""
Settings & API Config router — read/write `.env`, test API endpoints.

Endpoints:
    GET   /api/config/get               — current sanitized config snapshot
    POST  /api/config/update            — patch .env file (atomic)
    POST  /api/config/test/kitty        — ping Kitty App backend with a tiny prompt
    POST  /api/config/test/deepseek     — ping DeepSeek with a 4-token prompt
    POST  /api/config/test/elevenlabs   — ping ElevenLabs voices endpoint
    POST  /api/config/test/agent        — invoke configured local agent CLI `--version`
    POST  /api/config/test/anthropic    — legacy alias for /test/agent
    POST  /api/config/test/unity_mcp    — ping http://127.0.0.1:8080 or stdio probe
    POST  /api/config/reload            — best-effort: instruct uvicorn worker to
                                          reload (returns hint to user)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from core.config import PROJECT_ROOT, settings

router = APIRouter(prefix="/api/config", tags=["config"])

ENV_PATH = PROJECT_ROOT / ".env"
ENV_EXAMPLE_PATH = PROJECT_ROOT / ".env.example"

DEFAULT_UNITY_MCP_HTTP_URL = "http://127.0.0.1:8080"
LEGACY_TOKEN_KEYS: tuple[str, ...] = ()       # legacy token env-var names auto-migrated to KITTY_APP_TOKEN on save
LEGACY_PRUNE_KEYS: tuple[str, ...] = ()        # dead legacy env vars deleted on save


# Keys we expose for editing (no secrets returned in /get; only flags + plaintext)
_SAFE_KEY_DESCRIPTIONS: dict[str, dict[str, str]] = {
    # Each entry: { "label", "kind" ("secret"|"plain"|"path"|"number"|"bool"), "default" }
    "KITTY_APP_TOKEN":     {"label": "Kitty App code (image-generation credits)", "kind": "secret", "default": ""},
    "DEEPSEEK_API_KEY":    {"label": "DeepSeek API Key", "kind": "secret", "default": ""},
    "DEEPSEEK_BASE_URL":   {"label": "DeepSeek Base URL", "kind": "plain", "default": "https://api.deepseek.com"},
    "DEEPSEEK_MODEL":      {"label": "DeepSeek Model", "kind": "plain", "default": "deepseek-v4-flash"},
    "GEMINI_API_KEY":      {"label": "Google Gemini API Key", "kind": "secret", "default": ""},
    "GEMINI_MODEL":        {"label": "Gemini Model", "kind": "plain", "default": "gemini-3.5-flash"},
    # Kimi K3 captain (Moonshot Anthropic-compatible endpoint; runs through
    # the Claude Code CLI — see chat.py _cli_env_kimi()).
    "KIMI_API_KEY":          {"label": "Kimi K3 API Key (Moonshot)", "kind": "secret", "default": ""},
    "KIMI_MODEL":            {"label": "Kimi Model", "kind": "plain", "default": "kimi-k3[1m]"},
    "KIMI_REASONING_EFFORT": {"label": "Kimi Reasoning Effort (low | high | max)", "kind": "plain", "default": "max"},
    "ELEVENLABS_API_KEY":  {"label": "ElevenLabs API Key", "kind": "secret", "default": ""},
    "MURRKIT_AGENT_CLI":   {"label": "Local agent CLI", "kind": "plain", "default": "claude"},
    "CODEX_CLI_BIN":       {"label": "Codex CLI binary", "kind": "plain", "default": "codex"},
    "CODEX_MODEL":         {"label": "Codex default model (optional)", "kind": "plain", "default": ""},
    "CODEX_MODEL_FAST":    {"label": "Codex balanced model (optional)", "kind": "plain", "default": ""},
    "CODEX_MODEL_HEAVY":   {"label": "Codex heavy model (optional)", "kind": "plain", "default": ""},
    "CODEX_SANDBOX":       {"label": "Codex sandbox", "kind": "plain", "default": "workspace-write"},
    "CODEX_APPROVAL_POLICY": {"label": "Codex approval policy", "kind": "plain", "default": "never"},
    "CLAUDE_CLI_BIN":      {"label": "Claude CLI binary (optional fallback)", "kind": "plain", "default": "claude"},
    "ANTHROPIC_API_KEY":   {"label": "Anthropic API Key (only when MURRKIT_AGENT_CLI=claude)", "kind": "secret", "default": ""},
    "MURRKIT_CLAUDE_EFFORT": {"label": "Captain effort (low/medium/high/xhigh/max — token burn control)", "kind": "plain", "default": "high"},
    "MURRKIT_THINKING_TOKENS": {"label": "Captain thinking budget (tokens per turn)", "kind": "number", "default": "32000"},
    "MURRKIT_CLI_IDLE_TIMEOUT_S": {"label": "Captain silence backstop (seconds; big Fable turns need headroom)", "kind": "number", "default": "900"},
    "UNITY_PROJECT_PATH":  {"label": "Game Project Path", "kind": "path", "default": ""},
    "UNITY_MCP_SERVER":    {"label": "Engine-MCP Server Script Path (stdio)", "kind": "path", "default": ""},
    "UNITY_MCP_HTTP_URL":  {"label": "Engine-MCP HTTP URL (alt transport)", "kind": "plain", "default": DEFAULT_UNITY_MCP_HTTP_URL},
    "BUDGET_LIMIT_USD":    {"label": "Budget Limit (USD)", "kind": "number", "default": "80"},
    "BACKEND_HOST":        {"label": "Backend Host", "kind": "plain", "default": "127.0.0.1"},
    "BACKEND_PORT":        {"label": "Backend Port", "kind": "number", "default": "8001"},
    "PUBLIC_BACKEND_URL":  {"label": "Public Backend URL (for image staging)", "kind": "plain", "default": ""},
    "LOG_LEVEL":           {"label": "Log Level", "kind": "plain", "default": "INFO"},
}


class ConfigField(BaseModel):
    key: str
    label: str
    kind: str
    value: str            # if secret: "" or "***SET***" placeholder
    is_set: bool
    default: str


class ConfigSnapshot(BaseModel):
    fields: list[ConfigField]
    env_file_path: str
    budget_spent_usd: float
    budget_limit_usd: float
    backend_port: int


class ConfigUpdateRequest(BaseModel):
    updates: dict[str, str]   # {KEY: new_value}; empty string keeps current; "__CLEAR__" deletes


class TestResult(BaseModel):
    ok: bool
    detail: str
    elapsed_ms: int
    extra: dict[str, Any] = {}


# ---- .env IO ---------------------------------------------------------------


def _read_env_file() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    out: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _codex_auth_file_present() -> bool:
    """Best-effort Codex login readiness without reading or exposing secrets."""
    home = Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))
    return (home / "auth.json").is_file()


def _atomic_write_env(values: dict[str, str]) -> None:
    """Rewrite .env preserving comments + ordering for known keys; append unknown keys."""
    existing_lines: list[str] = []
    if ENV_PATH.exists():
        existing_lines = ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    elif ENV_EXAMPLE_PATH.exists():
        existing_lines = ENV_EXAMPLE_PATH.read_text(encoding="utf-8", errors="replace").splitlines()

    seen: set[str] = set()
    new_lines: list[str] = []
    for line in existing_lines:
        s = line.strip()
        if not s or s.startswith("#"):
            new_lines.append(line)
            continue
        if "=" in s:
            k, _, _ = s.partition("=")
            k = k.strip()
            if k in values:
                v = values[k]
                if v != "__CLEAR__":
                    new_lines.append(f"{k}={v}")
                # __CLEAR__ → skip line entirely
                seen.add(k)
                continue
        new_lines.append(line)
    # Append any new keys not present in the original file
    appended = False
    for k, v in values.items():
        if k in seen or v == "__CLEAR__":
            continue
        if not appended:
            new_lines.append("")
            new_lines.append("# --- Added by murrkit Settings UI ---")
            appended = True
        new_lines.append(f"{k}={v}")

    # Atomic write
    tmp = ENV_PATH.with_suffix(".env.tmp")
    tmp.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    tmp.replace(ENV_PATH)


# ---- Endpoints --------------------------------------------------------------


@router.get("/get", response_model=ConfigSnapshot)
async def get_config() -> ConfigSnapshot:
    """Return a sanitized config snapshot. Secrets are NEVER returned raw."""
    env = _read_env_file()
    # One-time silent migration: surface the legacy token under the new key so
    # the UI shows "set" even before the user re-saves.
    if "KITTY_APP_TOKEN" not in env:
        for legacy in LEGACY_TOKEN_KEYS:
            if env.get(legacy):
                env["KITTY_APP_TOKEN"] = env[legacy]
                break

    fields: list[ConfigField] = []
    for key, meta in _SAFE_KEY_DESCRIPTIONS.items():
        raw = env.get(key, "")
        is_set = bool(raw)
        if meta["kind"] == "secret":
            value = "***SET***" if is_set else ""
        else:
            value = raw or meta["default"]
        fields.append(ConfigField(
            key=key, label=meta["label"], kind=meta["kind"],
            value=value, is_set=is_set, default=meta["default"],
        ))
    from core.config import budget
    return ConfigSnapshot(
        fields=fields,
        env_file_path=str(ENV_PATH),
        budget_spent_usd=budget.spent_usd,
        budget_limit_usd=settings.budget_limit_usd,
        backend_port=settings.backend_port,
    )


@router.post("/update")
async def update_config(req: ConfigUpdateRequest) -> dict[str, Any]:
    """Write updates atomically. Returns count of changed keys.

    Special value `__CLEAR__` deletes the key from .env.
    Empty string keeps current (no-op).
    """
    current = _read_env_file()
    final_writes: dict[str, str] = {}
    n_changed = 0
    for k, v in req.updates.items():
        if k not in _SAFE_KEY_DESCRIPTIONS:
            continue  # ignore unknown keys defensively
        if v == "":
            continue  # no change
        if v == "__CLEAR__":
            if k in current:
                final_writes[k] = "__CLEAR__"
                n_changed += 1
        else:
            if current.get(k) != v:
                final_writes[k] = v
                n_changed += 1
    # One-shot legacy migration on any save touching KITTY_APP_TOKEN:
    # promote the legacy value (if any) to the new key, then delete the legacy.
    if "KITTY_APP_TOKEN" in final_writes or any(k in current for k in LEGACY_TOKEN_KEYS):
        for legacy in LEGACY_TOKEN_KEYS:
            if legacy in current:
                # If user supplied a new KITTY_APP_TOKEN value, just drop the legacy.
                # Otherwise promote the legacy value to the new key.
                if "KITTY_APP_TOKEN" not in final_writes and current[legacy]:
                    final_writes["KITTY_APP_TOKEN"] = current[legacy]
                    n_changed += 1
                final_writes[legacy] = "__CLEAR__"
                n_changed += 1
    # Prune dead-env keys that lingered from earlier versions.
    for stale in LEGACY_PRUNE_KEYS:
        if stale in current:
            final_writes[stale] = "__CLEAR__"
            n_changed += 1
    if final_writes:
        _atomic_write_env(final_writes)
    return {
        "changed": n_changed,
        "env_file": str(ENV_PATH),
        "note": (
            "Some values (KITTY_APP_TOKEN, DEEPSEEK_API_KEY, etc.) require a backend "
            "restart to take effect. Use 'Reload backend' button."
        ),
    }


@router.post("/reload")
async def reload_backend() -> dict[str, Any]:
    """Hint user how to reload — uvicorn worker can't self-reload via API safely."""
    return {
        "ok": True,
        "note": (
            "Soft reload not supported via API (would kill the request). "
            "Run: `uv run uvicorn backend.main:app --port 8001 --reload` "
            "in your terminal, or restart the backend manually. "
            "Most env changes take effect on next .env read (per-call), but "
            "API keys cached in `core.config.settings` need a full restart."
        ),
    }


# ---- Test endpoints ---------------------------------------------------------


@router.post("/test/kitty", response_model=TestResult)
async def test_kitty() -> TestResult:
    """Verify the user's Kitty App code against the WordPress backend.

    Hits `https://druidcat.com/wp-json/kitty-app/v1/verify` (and /balance for
    credit info) — the SAME upstream the production Kitty AI Studio app uses.

    Reads .env fresh on every call so a just-saved token is picked up without
    needing a full backend restart.
    """
    t0 = time.time()
    env = _read_env_file()
    token = (
        env.get("KITTY_APP_TOKEN")
        or (settings.kitty_app_token.get_secret_value() if settings.kitty_app_token else "")
    )
    if not token:
        return TestResult(ok=False, detail="Kitty App code not set", elapsed_ms=0)

    from tools import kitty_api

    try:
        info = await kitty_api.verify_token(token)
    except kitty_api.KittyApiError as e:
        elapsed = int((time.time() - t0) * 1000)
        if e.status in (401, 403):
            return TestResult(
                ok=False,
                detail="Kitty App code rejected — get a fresh one at druidcat.app/dashboard.",
                elapsed_ms=elapsed,
            )
        return TestResult(ok=False, detail=str(e), elapsed_ms=elapsed)
    except Exception as e:  # noqa: BLE001
        return TestResult(
            ok=False,
            detail=f"Kitty App connection error: {e!s}",
            elapsed_ms=int((time.time() - t0) * 1000),
        )

    # WordPress plugin returns either { valid, userId, username, credits }
    # OR { user_id, user_login, credits } depending on plugin version.
    valid = bool(info.get("valid", True))
    username = info.get("username") or info.get("user_login") or info.get("display_name") or "?"
    credits_raw = info.get("credits")
    credits_str = ""
    if isinstance(credits_raw, int | float):
        credits_str = f" — credits: ${float(credits_raw) / 100:.2f}"

    # Best-effort balance call (some plugin versions inline credits in /verify already)
    if not credits_str:
        try:
            bal = await kitty_api.get_balance(token)
            c = bal.get("credits")
            if isinstance(c, int | float):
                credits_str = f" — credits: ${float(c) / 100:.2f}"
        except Exception:  # noqa: BLE001
            pass

    if not valid:
        return TestResult(
            ok=False,
            detail=f"Kitty App code rejected: {info.get('error', 'invalid')}",
            elapsed_ms=int((time.time() - t0) * 1000),
        )

    return TestResult(
        ok=True,
        detail=f"Kitty App OK — {username}{credits_str}",
        elapsed_ms=int((time.time() - t0) * 1000),
        extra={k: v for k, v in info.items() if k in ("userId", "user_id", "credits", "username")},
    )


@router.post("/test/deepseek", response_model=TestResult)
async def test_deepseek() -> TestResult:
    t0 = time.time()
    if not settings.deepseek_api_key:
        return TestResult(ok=False, detail="DEEPSEEK_API_KEY not set", elapsed_ms=0)
    try:
        from core.deepseek_v4 import DeepSeekV4Client, Message
        async with DeepSeekV4Client() as cli:
            res = await cli.chat(
                messages=[
                    Message(role="system", content="Reply with the single word OK."),
                    Message(role="user", content="ping"),
                ],
                max_tokens=8,
                temperature=0.0,
            )
        return TestResult(
            ok=True,
            detail=f"DeepSeek OK: '{res.text.strip()[:40]}' (tokens {res.input_tokens}/{res.output_tokens})",
            elapsed_ms=int((time.time() - t0) * 1000),
            extra={"cost_usd": res.cost_usd, "model": settings.deepseek_model},
        )
    except Exception as e:  # noqa: BLE001
        return TestResult(
            ok=False,
            detail=f"DeepSeek error: {e!s}",
            elapsed_ms=int((time.time() - t0) * 1000),
        )


@router.post("/test/elevenlabs", response_model=TestResult)
async def test_elevenlabs() -> TestResult:
    t0 = time.time()
    env = _read_env_file()
    key = env.get("ELEVENLABS_API_KEY") or (
        settings.elevenlabs_api_key.get_secret_value() if settings.elevenlabs_api_key else ""
    )
    if not key:
        return TestResult(ok=False, detail="ELEVENLABS_API_KEY not set", elapsed_ms=0)
    base = env.get("ELEVENLABS_BASE_URL") or settings.elevenlabs_base_url
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"{base}/voices",
                headers={"xi-api-key": key},
            )
        elapsed = int((time.time() - t0) * 1000)
        if r.status_code == 200:
            voices = r.json().get("voices", []) or []
            return TestResult(
                ok=True,
                detail=f"ElevenLabs OK — {len(voices)} voices",
                elapsed_ms=elapsed,
                extra={"voice_count": len(voices)},
            )
        return TestResult(
            ok=False,
            detail=f"ElevenLabs HTTP {r.status_code}: {r.text[:300]}",
            elapsed_ms=elapsed,
        )
    except Exception as e:  # noqa: BLE001
        return TestResult(ok=False, detail=f"ElevenLabs error: {e!s}", elapsed_ms=int((time.time() - t0) * 1000))


@router.post("/test/anthropic", response_model=TestResult)
async def test_anthropic() -> TestResult:
    """Check configured local agent CLI presence + version.

    Uses `asyncio.to_thread(subprocess.run, ...)` rather than
    `asyncio.create_subprocess_exec` because the latter requires
    ProactorEventLoopPolicy on Windows. Without that policy it raises
    NotImplementedError with an empty message, leading to the very
    unhelpful 'Claude CLI error: ' the user saw in the UI.
    """
    import asyncio
    t0 = time.time()

    env = _read_env_file()
    agent = (env.get("MURRKIT_AGENT_CLI") or settings.agent_cli or "claude").strip().lower()
    if agent not in {"codex", "claude"}:
        agent = "claude"

    if agent == "claude":
        configured_bin = env.get("CLAUDE_CLI_BIN") or settings.claude_cli_bin or "claude"
        fallback_paths = (
            os.path.expanduser(r"~\.local\bin\claude.exe"),
            os.path.expanduser(r"~\.local\bin\claude.cmd"),
            os.path.expanduser(r"~\AppData\Local\claude\claude.exe"),
        )
    else:
        configured_bin = env.get("CODEX_CLI_BIN") or settings.codex_cli_bin or "codex"
        fallback_paths = (
            "/Applications/Codex.app/Contents/Resources/codex",
            "/usr/local/bin/codex",
            "/opt/homebrew/bin/codex",
        )

    cli = None
    if os.path.sep in configured_bin or (os.path.altsep and os.path.altsep in configured_bin):
        expanded = os.path.expanduser(configured_bin)
        if os.path.isfile(expanded):
            cli = expanded
    if cli is None:
        cli = shutil.which(configured_bin)
    if cli is None:
        for guess in fallback_paths:
            if os.path.isfile(guess):
                cli = guess
                break
    if cli is None:
        label = "Claude" if agent == "claude" else "Codex"
        return TestResult(
            ok=False,
            detail=f"`{configured_bin}` CLI not found — configure {label} CLI before running murrkit",
            elapsed_ms=0,
            extra={"agent": agent},
        )
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            [cli, "--version"],
            capture_output=True,
            timeout=8,
            text=False,
        )
        elapsed = int((time.time() - t0) * 1000)
        out = (result.stdout or result.stderr or b"").decode("utf-8", errors="replace").strip()[:200]
        auth_mode = "subscription (Pro/Max)"
        auth_ready = True
        if agent == "claude" and (env.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")):
            auth_mode = "API ($ANTHROPIC_API_KEY)"
        elif agent == "codex":
            auth_ready = _codex_auth_file_present()
            auth_mode = "Codex login detected (plan not verified)" if auth_ready else "Codex login not detected"
        version = out.split()[-1] if out else "?"
        return TestResult(
            ok=result.returncode == 0 and auth_ready,
            detail=f"{agent} CLI {version} | auth={auth_mode}",
            elapsed_ms=elapsed,
            extra={
                "cli_path": cli,
                "version": version,
                "agent": agent,
                "auth_ready": auth_ready,
                "mode": (
                    "api"
                    if agent == "claude" and (env.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY"))
                    else "subscription"
                ),
                "raw_output": out,
            },
        )
    except subprocess.TimeoutExpired:
        return TestResult(
            ok=False,
            detail=f"{agent} CLI at {cli} timed out after 8s",
            elapsed_ms=int((time.time() - t0) * 1000),
            extra={"cli_path": cli},
        )
    except Exception as e:  # noqa: BLE001
        return TestResult(
            ok=False,
            detail=f"{agent} CLI error: {type(e).__name__}: {e!s}" if str(e) else f"{agent} CLI error: {type(e).__name__} (empty message)",
            elapsed_ms=int((time.time() - t0) * 1000),
            extra={"cli_path": cli},
        )


@router.post("/test/agent", response_model=TestResult)
async def test_agent() -> TestResult:
    """Neutral alias for the configured local agent CLI probe."""
    return await test_anthropic()


@router.post("/test/unity_mcp", response_model=TestResult)
async def test_unity_mcp() -> TestResult:
    """
    Two-pronged check:
      1. HTTP transport (newer): GET {UNITY_MCP_HTTP_URL}/health if reachable.
      2. stdio transport (current): probe engine-MCP server script presence.
    Either succeeding is good.
    """
    t0 = time.time()
    url = os.environ.get("UNITY_MCP_HTTP_URL", DEFAULT_UNITY_MCP_HTTP_URL).rstrip("/")
    notes: list[str] = []
    http_ok = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{url}/")
            if r.status_code < 500:
                http_ok = True
                notes.append(f"HTTP {url} reachable (code {r.status_code})")
            else:
                notes.append(f"HTTP {url} responded {r.status_code}")
    except Exception as e:  # noqa: BLE001
        notes.append(f"HTTP {url} unreachable ({type(e).__name__})")

    stdio_path = settings.unity_mcp_server
    stdio_ok = stdio_path.is_file()
    if stdio_ok:
        notes.append(f"stdio server present: {stdio_path}")
    else:
        notes.append(f"stdio server missing: {stdio_path}")

    ok = http_ok or stdio_ok
    return TestResult(
        ok=ok,
        detail=" | ".join(notes),
        elapsed_ms=int((time.time() - t0) * 1000),
        extra={"http_url": url, "stdio_path": str(stdio_path), "http_ok": http_ok, "stdio_ok": stdio_ok},
    )
