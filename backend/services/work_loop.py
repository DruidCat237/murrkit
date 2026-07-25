"""
Work loop — ralph-style autonomous WORK mode for the captain ("the boulder
never stops"). Sibling of `autoplay_loop.py`, generalized past play→fix:

    autoplay: goal + automated TEST decides pass/fail each round.
    work loop: TASK PROMPT re-injected verbatim each round; the CAPTAIN
               decides via an explicit end-of-turn MARKER:

                   LOOP_CONTINUE: <co zrobił + co planuje następne>
                   LOOP_DONE:     <dowód weryfikacji (test/smoke/screenshot)>
                   LOOP_BLOCKED:  <decyzja/brakująca rzecz od człowieka>

This module is the *pure* business logic (config clamping, marker parsing,
stop conditions, prompt construction, run-log rendering). Orchestration —
spawning the inner Claude CLI, streaming WS events — lives in
`backend/routers/chat.py` (`/api/chat/loop`), reusing the exact machinery the
chat + autoplay endpoints already share.

HARD STOPS (mandatory runaway guard, mirroring autoplay):
  - LOOP_DONE                      → reason="done"
  - LOOP_BLOCKED                   → reason="blocked" (needs human)
  - max_iters reached / budget hit → reason="caps"
  - SAME marker signature 3× in a  → reason="stuck" (spinning in place —
    row (incl. 3× missing marker)     needs human)

The loop writes its own run log to `.omc/state/<project>/loop_log.md` and
NEVER touches progress.md — that file belongs to the captain, which is told
to keep it current every round.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

# ---- Caps (runaway guard — USER-CONTROLLED from Settings) -------------------
# Every value below is a FALLBACK: the live value comes from `.env` (Settings
# → Work loop), read per run without a restart. A long agentic round can cost
# several dollars, so the shipped ceiling is generous ($300) rather than the
# old hard-wired $20 that cut real work mid-plan.
#
#   MURRKIT_LOOP_BUDGET_USD      default spend for a run without --budget
#   MURRKIT_LOOP_BUDGET_CAP_USD  ceiling for --budget      (0 / "unlimited" → ∞)
#   MURRKIT_LOOP_ITERS           default rounds without --iters
#   MURRKIT_LOOP_ITERS_CAP       ceiling for --iters       (0 / "unlimited" → ∞)
#
# NOTE ON OVERSHOOT: the budget gate runs BETWEEN rounds, never inside one, so
# a single expensive round can carry the total past the limit before the loop
# notices (observed: $35 total against a $20 budget). Budget the CEILING, not
# the exact spend — leave room for one round of headroom.

MAX_ITERS_DEFAULT = 8
MAX_ITERS_HARD_CAP = 100
BUDGET_USD_DEFAULT = 6.0
BUDGET_USD_HARD_CAP = 300.0

# "Unlimited" iterations is represented as a very large int (keeps the return
# type an int); at any realistic per-round cost this is never reached.
_ITERS_UNLIMITED = 1_000_000
_UNLIMITED_WORDS = {"unlimited", "none", "off", "inf", "infinite", "0"}


def _env_value(key: str, default: str = "") -> str:
    """Read a `KEY=value` override live from `.env` (no restart needed),
    falling back to the process environment.

    Mirrors `chat.py::_env_value`; duplicated instead of imported so this pure
    logic module never pulls in a router. `core.config` is imported lazily for
    the same reason.
    """
    import os

    try:
        from core.config import PROJECT_ROOT

        env_path = PROJECT_ROOT / ".env"
        if env_path.is_file():
            for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, _, v = s.partition("=")
                if k.strip().upper() == key:
                    return v.strip().strip('"').strip("'")
    except (ImportError, OSError):
        pass  # no config module / unreadable .env → fall through to os.environ
    return os.environ.get(key, default)


def budget_hard_cap() -> float:
    """Ceiling for one run's spend. Settings: MURRKIT_LOOP_BUDGET_CAP_USD;
    `0` / `unlimited` removes the ceiling entirely."""
    raw = _env_value("MURRKIT_LOOP_BUDGET_CAP_USD", "").strip().lower()
    if not raw:
        return BUDGET_USD_HARD_CAP
    if raw in _UNLIMITED_WORDS:
        return math.inf
    try:
        value = float(raw)
    except ValueError:
        return BUDGET_USD_HARD_CAP
    return math.inf if value <= 0 else value


def iters_hard_cap() -> int:
    """Ceiling for one run's round count. Settings: MURRKIT_LOOP_ITERS_CAP;
    `0` / `unlimited` lifts it to `_ITERS_UNLIMITED`."""
    raw = _env_value("MURRKIT_LOOP_ITERS_CAP", "").strip().lower()
    if not raw:
        return MAX_ITERS_HARD_CAP
    if raw in _UNLIMITED_WORDS:
        return _ITERS_UNLIMITED
    try:
        value = int(float(raw))
    except ValueError:
        return MAX_ITERS_HARD_CAP
    return _ITERS_UNLIMITED if value <= 0 else value


def budget_default() -> float:
    """Spend for a run started without `--budget`. Settings:
    MURRKIT_LOOP_BUDGET_USD."""
    raw = _env_value("MURRKIT_LOOP_BUDGET_USD", "").strip()
    try:
        value = float(raw)
    except ValueError:
        return BUDGET_USD_DEFAULT
    return value if value > 0 else BUDGET_USD_DEFAULT


def iters_default() -> int:
    """Rounds for a run started without `--iters`. Settings:
    MURRKIT_LOOP_ITERS."""
    raw = _env_value("MURRKIT_LOOP_ITERS", "").strip()
    try:
        value = int(float(raw))
    except ValueError:
        return MAX_ITERS_DEFAULT
    return value if value > 0 else MAX_ITERS_DEFAULT


def fmt_budget(value: float) -> str:
    """Human-readable budget for logs/messages (`∞` instead of `inf`)."""
    return "∞" if math.isinf(value) else f"${value:.2f}"

# Stop when the identical marker signature repeats this many times in a row.
STUCK_REPEAT_THRESHOLD = 3

MarkerStatus = Literal["continue", "done", "blocked", "missing"]
DoneReason = Literal["done", "blocked", "caps", "stuck"]

_MARKER_RE = re.compile(
    r"^\s*LOOP_(CONTINUE|DONE|BLOCKED)\s*[::]\s*(.*?)\s*$", re.MULTILINE
)


# ---- Request / config ------------------------------------------------------


@dataclass
class WorkLoopConfig:
    """Validated, cap-clamped configuration for one work-loop run.

    Build via `from_request` so the hard caps are always applied — never
    construct directly from untrusted client input.
    """

    project_name: str
    prompt: str
    max_iters: int
    budget_usd: float

    @classmethod
    def from_request(cls, req: dict[str, Any]) -> WorkLoopConfig:
        """Parse + validate a raw request dict (from the WS first-message JSON).

        Raises ValueError on missing required fields (fail loudly — the router
        surfaces this as a {kind:"error"} event). Caps are clamped, not
        rejected: a client asking for max_iters=999 gets 25, not a 400.
        """
        project_name = str(req.get("project_name") or "").strip()
        if not project_name:
            raise ValueError("loop: 'project_name' is required")

        prompt = str(req.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("loop: 'prompt' (the task re-injected each round) is required")

        max_iters, budget_usd = clamp_caps(
            req.get("max_iters", iters_default()),
            req.get("budget_usd", budget_default()),
        )
        return cls(
            project_name=project_name,
            prompt=prompt,
            max_iters=max_iters,
            budget_usd=budget_usd,
        )


def clamp_caps(max_iters: Any, budget_usd: Any) -> tuple[int, float]:
    """Clamp client-requested caps to the CONFIGURED ceilings (Settings →
    Work loop; see `budget_hard_cap`/`iters_hard_cap`). Garbage input falls
    back to the configured defaults rather than raising — the caller already
    validated the load-bearing fields."""
    try:
        mi = int(max_iters)
    except (TypeError, ValueError):
        mi = iters_default()
    mi = max(1, min(mi, iters_hard_cap()))

    try:
        bu = float(budget_usd)
    except (TypeError, ValueError):
        bu = budget_default()
    if bu <= 0:
        bu = budget_default()
    return mi, min(bu, budget_hard_cap())


# ---- Marker parsing ---------------------------------------------------------


@dataclass
class LoopMarker:
    """The captain's end-of-turn verdict for one round.

    `signature` is a stable short hash of (status, normalized detail) used for
    stuck detection: three identical signatures in a row = the captain is
    repeating itself without progress. A missing marker gets its own stable
    signature, so three protocol violations in a row also trip the guard.
    """

    status: MarkerStatus
    detail: str
    signature: str


def parse_marker(final_text: str) -> LoopMarker:
    """Extract the LAST loop marker from the captain's final message.

    Last one wins so the captain may quote the protocol earlier in its
    message (e.g. when explaining what it is about to do) without confusing
    the loop. No marker at all → status "missing" (the next round's prompt
    reminds the captain of the protocol; repeated misses trip stuck).
    """
    matches = list(_MARKER_RE.finditer(final_text or ""))
    if not matches:
        return LoopMarker(status="missing", detail="", signature=_signature("missing", ""))
    m = matches[-1]
    status_raw = m.group(1).lower()
    status: MarkerStatus = (
        "continue" if status_raw == "continue"
        else "done" if status_raw == "done"
        else "blocked"
    )
    detail = m.group(2).strip()
    return LoopMarker(status=status, detail=detail, signature=_signature(status, detail))


def _signature(status: str, detail: str) -> str:
    """Stable short hash of the marker shape. Detail is lower-cased and
    whitespace-collapsed so cosmetic rewording does not defeat stuck
    detection."""
    norm = " ".join(detail.lower().split())
    return hashlib.sha1(f"{status}|{norm}".encode()).hexdigest()[:12]


# ---- Stop-condition evaluation ---------------------------------------------


@dataclass
class StopDecision:
    """Whether the loop should stop, and why."""

    stop: bool
    reason: DoneReason | None = None
    detail: str = ""


def evaluate_stop(
    *,
    marker: LoopMarker,
    iteration: int,
    max_iters: int,
    cost_so_far: float,
    budget_usd: float,
    recent_signatures: list[str],
) -> StopDecision:
    """Evaluate the stop conditions AFTER one captain round.

    Precedence: the captain's own verdict (done/blocked) wins, then stuck
    (most actionable — needs human), then caps. `recent_signatures` must
    already include this round's signature.
    """
    if marker.status == "done":
        return StopDecision(stop=True, reason="done", detail=marker.detail)
    if marker.status == "blocked":
        return StopDecision(stop=True, reason="blocked", detail=marker.detail)
    if is_stuck(recent_signatures):
        return StopDecision(
            stop=True,
            reason="stuck",
            detail=(
                f"same marker signature {STUCK_REPEAT_THRESHOLD}× in a row "
                f"({recent_signatures[-1]}) — needs human"
            ),
        )
    if cost_so_far >= budget_usd:
        return StopDecision(
            stop=True,
            reason="caps",
            detail=f"cumulative cost ${cost_so_far:.4f} ≥ budget {fmt_budget(budget_usd)}",
        )
    if iteration + 1 >= max_iters:
        return StopDecision(stop=True, reason="caps", detail=f"max_iters={max_iters} reached")
    return StopDecision(stop=False)


def is_stuck(recent_signatures: list[str]) -> bool:
    """True when the last STUCK_REPEAT_THRESHOLD signatures are all identical."""
    if len(recent_signatures) < STUCK_REPEAT_THRESHOLD:
        return False
    tail = recent_signatures[-STUCK_REPEAT_THRESHOLD:]
    return len(set(tail)) == 1


def should_block_before_iteration(
    *, cost_so_far: float, budget_usd: float
) -> StopDecision:
    """Pre-iteration budget gate — never start a turn we cannot afford."""
    if cost_so_far >= budget_usd:
        return StopDecision(
            stop=True,
            reason="caps",
            detail=f"cumulative cost ${cost_so_far:.4f} ≥ budget {fmt_budget(budget_usd)} (pre-turn)",
        )
    return StopDecision(stop=False)


# ---- Prompt construction ---------------------------------------------------


def build_iteration_prompt(
    *,
    cfg: WorkLoopConfig,
    iteration: int,
    prev: LoopMarker | None,
) -> str:
    """Construct the prompt handed to the inner Claude for round `iteration`.

    The TASK is re-injected verbatim every round (ralph-style) so it survives
    any session compaction; the loop framing tells the captain it is headless,
    must do ONE meaningful increment, keep progress.md current, and MUST end
    with exactly one marker line.
    """
    head = [
        "## WORK LOOP (autonomiczna pętla robocza — NIKT nie patrzy na żywo)",
        "",
        f"Jesteś w rundzie {iteration + 1}/{cfg.max_iters} autonomicznej pętli. "
        "Po Twojej turze backend odpali następną rundę Z TYM SAMYM zadaniem — "
        "kontynuujesz własną pracę. Zasady rundy:",
        "  1. Zrób JEDEN sensowny, DOMKNIĘTY przyrost (feature/fix/weryfikacja) — "
        "nie otwieraj trzech frontów naraz.",
        "  2. Weryfikuj po każdej zmianie (playtest/drive/test/screenshot) — "
        "wg reguł projektu.",
        f"  3. Aktualizuj `.omc/state/{cfg.project_name}/progress.md` "
        "(co zrobione, co następne, otwarte problemy).",
        "  4. NIE zadawaj użytkownikowi pytań i nie czekaj na odpowiedź — "
        "jeśli potrzebujesz decyzji człowieka, zakończ markerem LOOP_BLOCKED.",
        "  5. OSTATNIA linia Twojej odpowiedzi MUSI być DOKŁADNIE jednym z markerów:",
        "     LOOP_CONTINUE: <co zrobiłeś + co planujesz w następnej rundzie>",
        "     LOOP_DONE: <dowód, że CAŁE zadanie jest skończone i zweryfikowane>",
        "     LOOP_BLOCKED: <konkretna decyzja/rzecz, której potrzebujesz od człowieka>",
        "     (LOOP_DONE tylko ze świeżym dowodem weryfikacji — nie na pamięć.)",
        "",
        "### ZADANIE (niezmienne przez całą pętlę)",
        cfg.prompt.strip(),
        "",
    ]
    if prev is None or iteration == 0:
        head += [
            "To jest runda 1 — zacznij od rekonesansu stanu projektu "
            "(progress.md, repo), potem pierwszy przyrost.",
        ]
    elif prev.status == "missing":
        head += [
            "### PROTOKÓŁ: w poprzedniej rundzie NIE zakończyłeś odpowiedzi "
            "markerem LOOP_*. To obowiązkowe — bez markera pętla nie wie, czy "
            "kontynuować. Dokończ przyrost i zamknij rundę poprawnym markerem.",
        ]
    else:
        head += [
            f"### POPRZEDNIA RUNDA ({iteration}) zgłosiła LOOP_CONTINUE:",
            "```",
            prev.detail or "(bez szczegółów)",
            "```",
            "Kontynuuj dokładnie od tego miejsca — nie zaczynaj od nowa.",
        ]
    return "\n".join(head)


# ---- Run-log rendering -------------------------------------------------------


def render_loop_log(
    *,
    cfg: WorkLoopConfig,
    rounds: list[dict[str, Any]],
    done_reason: DoneReason | None,
    cost_so_far: float,
) -> str:
    """Render the work-loop run log (written to `.omc/state/<project>/loop_log.md`).

    Deliberately NOT progress.md — that file is the captain's to maintain;
    this log is the loop's own audit trail. `rounds` items:
    {i, status, detail, signature, cost_so_far}.
    """
    ts = datetime.now(UTC).isoformat()
    lines: list[str] = [
        f"# Work-loop log — {cfg.project_name}",
        "",
        f"_Last updated: {ts}_",
        "",
        f"Caps: max_iters={cfg.max_iters}, budget={fmt_budget(cfg.budget_usd)}. "
        f"Status: {done_reason or '(running)'}.",
        "",
        "## Zadanie",
        "",
        "```",
        cfg.prompt.strip(),
        "```",
        "",
        "## Rundy",
        "",
        "| runda | marker | szczegół | koszt (skumulowany) |",
        "|------:|:-------|:---------|--------------------:|",
    ]
    for r in rounds:
        detail = str(r.get("detail", "")).replace("|", "\\|")
        if len(detail) > 160:
            detail = detail[:157] + "…"
        lines.append(
            f"| {r.get('i', 0) + 1} "
            f"| {r.get('status', '?')} "
            f"| {detail} "
            f"| ${r.get('cost_so_far', 0.0):.4f} |"
        )
    lines += [
        "",
        f"_Total cost this run: ${cost_so_far:.4f}. "
        f"Final reason: {done_reason or '(running)'}._",
        "",
    ]
    return "\n".join(lines)
