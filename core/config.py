"""
Centralized configuration with Pydantic Settings — murrkit.

Talks ONLY to the Kitty AI Studio backend at druidcat.com — see
`tools/kitty_api.py`. The Kitty backend handles all upstream image
generation internally; murrkit never talks to any other vendor API
directly for image gen.

Security:
- All API keys use `SecretStr` so they never leak in logs or `repr()`.
- Loaded from `.env` (which is in `.gitignore`).

Usage:
    from core.config import settings, budget

    token = settings.kitty_app_token.get_secret_value()
    budget.check_or_raise(estimated_cost=0.05)
    budget.charge(actual_cost=0.04)
"""

from __future__ import annotations

import os
import secrets
import threading
from pathlib import Path

from loguru import logger
from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Paths -----------------------------------------------------------------------
PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
ENV_FILE: Path = PROJECT_ROOT / ".env"

# Where generated games/projects live. Override via MURRKIT_PROJECTS_DIR to keep
# projects on a separate drive/folder — fully decoupled from the app code. The
# default (./projects) is git-ignored, so private work never lands in the repo.
_projects_env = os.environ.get("MURRKIT_PROJECTS_DIR", "").strip()
PROJECTS_DIR: Path = (
    Path(_projects_env).expanduser().resolve() if _projects_env else PROJECT_ROOT / "projects"
)


# Settings --------------------------------------------------------------------
class Settings(BaseSettings):
    """Type-safe environment configuration for murrkit."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---- LLM Providers -----------------------------------------------------
    deepseek_api_key: SecretStr | None = None
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-v4-flash"

    gemini_api_key: SecretStr | None = None
    gemini_model: str = "gemini-3.5-flash"
    # Set to False to bypass the Kitty proxy and call Google AI Studio directly
    # (requires GEMINI_API_KEY). Defaults to None → auto-decide: if KITTY_APP_TOKEN
    # is set, prefer Kitty; otherwise direct. Override via .env when Kitty proxy
    # has known issues (e.g. HTTP 417 from upstream Google).
    superagent_gemini_via_kitty: bool | None = None

    # ---- Sprite / Image Generation -----------------------------------------
    # Kitty AI Studio token — single auth for GPT-Image-2 and every other
    # workflow the Kitty backend exposes.
    kitty_app_token: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("KITTY_APP_TOKEN"),
    )

    # ---- Audio ---------------------------------------------------------------
    elevenlabs_api_key: SecretStr | None = None
    elevenlabs_base_url: str = "https://api.elevenlabs.io/v1"

    # ---- Phaser project -----------------------------------------------------
    # Path to the Phaser game folder (`phaser_game/`). Kept under the legacy
    # `unity_*` field names so existing routers that reference them don't break
    # — these are just generic "game folder" pointers now.
    unity_project_path: Path = PROJECT_ROOT / "phaser_game"
    unity_mcp_server: Path = Path("")  # unused — kept for compat

    @property
    def unity_project_name(self) -> str:
        """Returns folder name of the active game project (Phaser)."""
        try:
            return self.unity_project_path.resolve().name
        except Exception:  # noqa: BLE001
            return "phaser_game"

    @property
    def unity_assets_dir(self) -> Path:
        """Returns <game_project>/public/ (Phaser assets root)."""
        return self.unity_project_path / "public"

    @property
    def phaser_game_path(self) -> Path:
        """Phaser-native alias for unity_project_path."""
        return self.unity_project_path

    # ---- Budget Guard -------------------------------------------------------
    budget_limit_usd: float = Field(default=80.0, ge=0.0)

    # ---- Backend ------------------------------------------------------------
    backend_host: str = "127.0.0.1"
    backend_port: int = 8001  # :8001 to coexist with GameTestMVP :8000
    backend_auth_token: str = ""

    # ---- Public file sharing (when an upstream needs a public URL) ---------
    public_backend_url: str = ""  # e.g. https://tunnel.example.com

    # ---- Logging ------------------------------------------------------------
    log_level: str = "INFO"
    log_dir: Path = PROJECT_ROOT / "logs"

    # ---- Feature flags -----------------------------------------------------
    enable_tester_agent: bool = True
    enable_audio_agent: bool = True

    # ---- Validators --------------------------------------------------------
    @field_validator("backend_auth_token", mode="before")
    @classmethod
    def _generate_token_if_missing(cls, v: str | None) -> str:
        """Auto-generate a local backend auth token if .env left it blank."""
        if not v:
            return secrets.token_urlsafe(32)
        return v

    @field_validator("log_dir", mode="after")
    @classmethod
    def _ensure_log_dir(cls, v: Path) -> Path:
        v.mkdir(parents=True, exist_ok=True)
        return v


# BudgetGuard -----------------------------------------------------------------
class BudgetExceededError(RuntimeError):
    """Raised when an action would exceed the configured API budget."""


class BudgetGuard:
    """
    Hard-stop on cumulative API spend.

    Thread-safe: agents may run concurrently.
    """

    def __init__(self, limit_usd: float) -> None:
        self.limit_usd = limit_usd
        self._spent_usd = 0.0
        self._lock = threading.Lock()

    @property
    def spent_usd(self) -> float:
        return self._spent_usd

    @property
    def remaining_usd(self) -> float:
        return max(0.0, self.limit_usd - self._spent_usd)

    def check_or_raise(self, estimated_cost: float) -> None:
        """Raise if `estimated_cost` would push us over the limit."""
        with self._lock:
            if self._spent_usd + estimated_cost > self.limit_usd:
                raise BudgetExceededError(
                    f"Budget block: estimated ${estimated_cost:.4f} would exceed "
                    f"limit ${self.limit_usd:.2f} (already spent ${self._spent_usd:.4f})"
                )

    def charge(self, actual_cost: float) -> None:
        """Record an actual cost. Logs warning at 90% of limit."""
        with self._lock:
            self._spent_usd += actual_cost
            if self._spent_usd > self.limit_usd * 0.9:
                logger.warning(
                    "Budget at {pct:.0f}%: ${spent:.4f}/${limit:.2f}",
                    pct=(self._spent_usd / self.limit_usd) * 100,
                    spent=self._spent_usd,
                    limit=self.limit_usd,
                )

    def reset(self) -> None:
        """Reset spend (e.g., new session)."""
        with self._lock:
            self._spent_usd = 0.0


# Module-level singletons -----------------------------------------------------
settings = Settings()  # type: ignore[call-arg]  # values from .env
budget = BudgetGuard(limit_usd=settings.budget_limit_usd)


# Configure logger early ------------------------------------------------------
import sys as _sys

# Force UTF-8 stdout/stderr on Windows
if hasattr(_sys.stdout, "reconfigure"):
    try:
        _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        _sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

logger.remove()
logger.add(
    sink=_sys.stderr,
    level=settings.log_level,
    format=(
        "<green>{time:HH:mm:ss}</green> | "
        "<level>{level: <8}</level> | "
        "<cyan>{module}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
        "<level>{message}</level>"
    ),
    colorize=True,
)
logger.add(
    sink=str(settings.log_dir / "murrkit_{time:YYYY-MM-DD}.log"),
    level="DEBUG",
    rotation="10 MB",
    retention="14 days",
    encoding="utf-8",
    format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {module}:{function}:{line} - {message}",
)
