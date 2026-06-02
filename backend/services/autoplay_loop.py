"""
Autonomous autoplay loop — Pillar 3 of the murrkit v2 re-architecture.

This module holds the *pure, genre-agnostic* business logic for the
self-improving play→fix loop. The actual orchestration (spawning the inner
Claude CLI, running the Playwright playtest/drive harness, streaming WebSocket
events) lives in `backend/routers/chat.py` — see the `/api/chat/autoplay`
endpoint — because that is where the CLI-subprocess + cost machinery already
exists and MUST be reused, not duplicated.

The loop, conceptually:

    for i in range(max_iters):
        1. Invoke inner Claude with the goal (+ on i>0 the previous round's
           failing verdict as "here's what failed, fix it" feedback).
        2. Run the test (playtest → verdict_pass; drive → verdict_pass means
           all asserts pass AND 0 console errors).
        3. If pass → DONE (success).
        4. Else feed the verdict back and continue.

    HARD STOPS (all mandatory — runaway-cost guard):
      - max_iters reached            → reason="caps"
      - cumulative cost ≥ budget_usd → reason="caps"
      - SAME failure signature 3× in → reason="stuck" (needs human)
        a row

Everything here is side-effect-free except `render_progress_md`'s caller and
the disk write that the router performs via `core.project_memory`. Failures in
this module are raised loudly — there is no error-swallowing (per the
swe-agent-rigor / CLAUDE.md "no defensive try/except" rule). The ONE tolerated
soft spot is signature hashing of malformed verdicts, which falls back to a
stable string rather than crashing the loop.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

# ---- Hard caps (non-negotiable runaway-cost guard) -------------------------
# These ceilings are enforced regardless of what the client requests. The
# request defaults are lower; the client may raise them up to these caps but
# never beyond. See `clamp_caps`.

MAX_ITERS_DEFAULT = 6
MAX_ITERS_HARD_CAP = 10
BUDGET_USD_DEFAULT = 4.0
BUDGET_USD_HARD_CAP = 8.0

# Stop when the identical failure signature repeats this many times in a row.
STUCK_REPEAT_THRESHOLD = 3

TestKind = Literal["playtest", "drive"]
DoneReason = Literal["success", "caps", "stuck"]


# ---- Request / config ------------------------------------------------------


@dataclass
class AutoplayConfig:
    """Validated, cap-clamped configuration for one autoplay run.

    Build via `from_request` so the hard caps are always applied — never
    construct directly from untrusted client input.
    """

    project_name: str
    goal: str
    test_kind: TestKind
    test_payload: dict[str, Any]
    max_iters: int
    budget_usd: float

    @classmethod
    def from_request(cls, req: dict[str, Any]) -> AutoplayConfig:
        """Parse + validate a raw request dict (from the WS first-message JSON).

        Raises ValueError on missing/invalid required fields (fail loudly —
        the router surfaces this as a {kind:"error"} event). Caps are clamped,
        not rejected: a client asking for max_iters=999 gets 10, not a 400.
        """
        project_name = str(req.get("project_name") or "").strip()
        if not project_name:
            raise ValueError("autoplay: 'project_name' is required")

        goal = str(req.get("goal") or "").strip()
        if not goal:
            raise ValueError("autoplay: 'goal' (free-text objective) is required")

        test_kind = req.get("test_kind")
        if test_kind not in ("playtest", "drive"):
            raise ValueError(
                f"autoplay: 'test_kind' must be 'playtest' or 'drive', got {test_kind!r}"
            )

        test_payload = req.get("test_payload")
        if not isinstance(test_payload, dict):
            raise ValueError(
                "autoplay: 'test_payload' must be an object (the playtest/drive "
                f"request body run each round), got {type(test_payload).__name__}"
            )

        max_iters, budget_usd = clamp_caps(
            req.get("max_iters", MAX_ITERS_DEFAULT),
            req.get("budget_usd", BUDGET_USD_DEFAULT),
        )
        return cls(
            project_name=project_name,
            goal=goal,
            test_kind=test_kind,  # type: ignore[arg-type]
            test_payload=test_payload,
            max_iters=max_iters,
            budget_usd=budget_usd,
        )


def clamp_caps(max_iters: Any, budget_usd: Any) -> tuple[int, float]:
    """Clamp client-requested caps to the hard limits.

    `max_iters` → int in [1, MAX_ITERS_HARD_CAP]; `budget_usd` → float in
    (0, BUDGET_USD_HARD_CAP]. Invalid/non-numeric values fall back to the
    defaults rather than raising — the caller already validated the
    load-bearing fields; caps are advisory knobs with safe defaults.
    """
    try:
        mi = int(max_iters)
    except (TypeError, ValueError):
        mi = MAX_ITERS_DEFAULT
    mi = max(1, min(mi, MAX_ITERS_HARD_CAP))

    try:
        bu = float(budget_usd)
    except (TypeError, ValueError):
        bu = BUDGET_USD_DEFAULT
    if bu <= 0:
        bu = BUDGET_USD_DEFAULT
    bu = min(bu, BUDGET_USD_HARD_CAP)
    return mi, bu


# ---- Test-verdict normalization --------------------------------------------


@dataclass
class RoundVerdict:
    """Normalized outcome of one test run, independent of test_kind.

    `passed` is the single source of truth the loop branches on:
      - playtest: raw `verdict_pass`
      - drive:    raw `verdict_pass` (already = all asserts pass AND 0
                  console errors, per phaser._phaser_drive_impl)

    `signature` is a stable hash of WHAT failed (anomaly types + failed-assert
    names + console-error presence) used to detect a stuck loop. `feedback` is
    the human/model-readable failure summary fed back to Claude next round.
    """

    passed: bool
    signature: str
    feedback: str
    raw: dict[str, Any] = field(default_factory=dict)


def summarize_verdict(test_kind: TestKind, result: dict[str, Any]) -> RoundVerdict:
    """Reduce a raw playtest/drive result dict to a RoundVerdict.

    Knows the shape of both harness responses (verified against
    backend/routers/phaser.py):
      - playtest → {verdict_pass, enemies_killed, dynamic_verdict:{anomalies:[...]},
                    console_errors:[...]}
      - drive    → {verdict_pass, asserts:[{name,pass,evidence}], console_errors:[...]}
    """
    passed = bool(result.get("verdict_pass"))
    console_errors = result.get("console_errors") or []
    err_count = len(console_errors)

    if test_kind == "playtest":
        dynamic = result.get("dynamic_verdict") or {}
        anomalies = dynamic.get("anomalies") or []
        anomaly_types = sorted(
            {str(a.get("type", "?")) for a in anomalies if isinstance(a, dict)}
        )
        enemies_killed = result.get("enemies_killed")
        sig = _signature(
            kind="playtest",
            anomalies=anomaly_types,
            failed_asserts=[],
            has_console_errors=err_count > 0,
        )
        feedback = _playtest_feedback(
            anomalies=anomalies,
            console_errors=console_errors,
            enemies_killed=enemies_killed,
        )
        return RoundVerdict(passed=passed, signature=sig, feedback=feedback, raw=result)

    # drive
    asserts = result.get("asserts") or []
    failed = [
        str(a.get("name", "?"))
        for a in asserts
        if isinstance(a, dict) and not a.get("pass")
    ]
    sig = _signature(
        kind="drive",
        anomalies=[],
        failed_asserts=sorted(failed),
        has_console_errors=err_count > 0,
    )
    feedback = _drive_feedback(asserts=asserts, console_errors=console_errors)
    return RoundVerdict(passed=passed, signature=sig, feedback=feedback, raw=result)


def _signature(
    *,
    kind: str,
    anomalies: list[str],
    failed_asserts: list[str],
    has_console_errors: bool,
) -> str:
    """Stable short hash of the failure shape (NOT the pass/fail bit).

    Two rounds that fail the same way (same anomaly types, same failed-assert
    names, same console-error presence) hash identically → the loop can detect
    it is stuck. Pass rounds also get a signature but the loop only compares
    signatures on failing rounds.
    """
    payload = {
        "kind": kind,
        "anomalies": anomalies,
        "failed_asserts": failed_asserts,
        "console_errors": has_console_errors,
    }
    try:
        blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError):
        # Defensive only: payload is built from plain str/bool/list above, so
        # this is unreachable in practice — but a malformed signature must
        # never crash the loop. Fall back to a stable repr.
        blob = repr(payload)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def _playtest_feedback(
    *,
    anomalies: list[dict[str, Any]],
    console_errors: list[dict[str, Any]],
    enemies_killed: Any,
) -> str:
    """Render a playtest failure into a feedback block for the next prompt."""
    lines: list[str] = []
    if anomalies:
        lines.append("Dynamic anomalies detected (window.__phaserTrace):")
        for a in anomalies[:8]:
            if not isinstance(a, dict):
                continue
            t = a.get("type", "?")
            sev = a.get("severity", "?")
            desc = a.get("description", "")
            at = a.get("t_ms")
            at_s = f" @{at}ms" if at is not None else ""
            lines.append(f"  - [{sev}] {t}{at_s}: {desc}")
    if console_errors:
        lines.append(f"Console errors ({len(console_errors)}):")
        for c in console_errors[:8]:
            txt = c.get("text") if isinstance(c, dict) else str(c)
            lines.append(f"  - {str(txt)[:200]}")
    if enemies_killed is not None:
        lines.append(f"enemies_killed={enemies_killed} (need >=1 for a pass).")
    if not lines:
        lines.append(
            "verdict_pass=false but no anomalies / console errors / kill-count "
            "surfaced — inspect the playtest grid_path + final_state to find why."
        )
    return "\n".join(lines)


def _drive_feedback(
    *,
    asserts: list[dict[str, Any]],
    console_errors: list[dict[str, Any]],
) -> str:
    """Render a drive failure into a feedback block for the next prompt."""
    lines: list[str] = []
    failed = [
        a for a in asserts if isinstance(a, dict) and not a.get("pass")
    ]
    if failed:
        lines.append("Failed control-responsiveness asserts:")
        for a in failed[:12]:
            name = a.get("name", "?")
            expect = a.get("expect", "?")
            ev = a.get("evidence", "")
            lines.append(f"  - {name} (expect {expect}) — evidence: {str(ev)[:200]}")
    if console_errors:
        lines.append(f"Console errors ({len(console_errors)}):")
        for c in console_errors[:8]:
            txt = c.get("text") if isinstance(c, dict) else str(c)
            lines.append(f"  - {str(txt)[:200]}")
    if not lines:
        lines.append(
            "verdict_pass=false but every assert passed and no console errors — "
            "check whether the input script actually exercised the feature "
            "(state_timeline / grid_path)."
        )
    return "\n".join(lines)


# ---- Stop-condition evaluation ---------------------------------------------


@dataclass
class StopDecision:
    """Whether the loop should stop, and why."""

    stop: bool
    reason: DoneReason | None = None
    detail: str = ""


def evaluate_stop(
    *,
    iteration: int,
    max_iters: int,
    cost_so_far: float,
    budget_usd: float,
    recent_signatures: list[str],
) -> StopDecision:
    """Evaluate the three mandatory HARD-STOP conditions.

    Called AFTER a failing round (a passing round is handled by the caller as
    success before this is consulted). Order matters only for the `reason`
    label when several trip at once; "stuck" is reported first because it is
    the most actionable for the user (needs human), then caps.

    - stuck : the last STUCK_REPEAT_THRESHOLD signatures are identical
    - caps  : cumulative cost ≥ budget_usd, OR this was the final allowed iter
    """
    if is_stuck(recent_signatures):
        return StopDecision(
            stop=True,
            reason="stuck",
            detail=(
                f"same failure signature {STUCK_REPEAT_THRESHOLD}× in a row "
                f"({recent_signatures[-1]}) — needs human"
            ),
        )
    if cost_so_far >= budget_usd:
        return StopDecision(
            stop=True,
            reason="caps",
            detail=f"cumulative cost ${cost_so_far:.4f} ≥ budget ${budget_usd:.2f}",
        )
    if iteration + 1 >= max_iters:
        return StopDecision(
            stop=True,
            reason="caps",
            detail=f"max_iters={max_iters} reached",
        )
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
    """Pre-iteration budget gate.

    Checked BEFORE spawning the inner Claude for the next round so we never
    start a turn we cannot afford. (The post-round `evaluate_stop` is the main
    guard; this is the belt-and-suspenders that prevents one final expensive
    turn from blowing way past budget.)
    """
    if cost_so_far >= budget_usd:
        return StopDecision(
            stop=True,
            reason="caps",
            detail=f"cumulative cost ${cost_so_far:.4f} ≥ budget ${budget_usd:.2f} (pre-turn)",
        )
    return StopDecision(stop=False)


# ---- Prompt construction ---------------------------------------------------


def build_iteration_prompt(
    *,
    cfg: AutoplayConfig,
    iteration: int,
    prev_verdict: RoundVerdict | None,
) -> str:
    """Construct the prompt handed to the inner Claude for round `iteration`.

    Round 0 = the bare goal plus the autoplay framing. Rounds >0 = the goal
    plus the previous round's failure feedback ("here's what failed, fix it").
    The framing makes the inner Claude aware it is inside an autonomous loop so
    it focuses on the smallest fix that flips the verdict rather than re-asking
    the user (the loop is opt-in and headless — the user is NOT watching).
    """
    test_desc = (
        "a slingshot playtest (`POST /api/phaser/playtest`)"
        if cfg.test_kind == "playtest"
        else "a genre-agnostic drive script (`POST /api/phaser/drive`)"
    )
    head = [
        "## AUTOPLAY LOOP (autonomous play→fix — you are NOT being watched live)",
        "",
        f"You are inside an automated self-improvement loop, round "
        f"{iteration + 1}/{cfg.max_iters}. After your turn the backend will run "
        f"{test_desc} and judge pass/fail automatically — you do NOT need to run "
        "it yourself (though you may, to inspect intermediate state). Do NOT ask "
        "the user anything; the loop only surfaces to them when the goal passes, "
        "the budget/iteration cap is hit, or you are provably stuck.",
        "",
        "### GOAL (make the automated test pass)",
        cfg.goal.strip(),
        "",
    ]
    if prev_verdict is None or iteration == 0:
        head += [
            "This is round 1. Implement the goal with the smallest viable change "
            "that will make the automated test pass, keep "
            f"`.omc/state/{cfg.project_name}/progress.md` current, then stop.",
        ]
    else:
        head += [
            f"### PREVIOUS ROUND ({iteration}) FAILED — here is what the automated "
            "test reported. Fix the ROOT CAUSE, do not paper over it:",
            "```",
            prev_verdict.feedback.strip() or "(no detail)",
            "```",
            "",
            "Make the smallest change that flips the failing signal above to a "
            f"pass. Update `.omc/state/{cfg.project_name}/progress.md` with what "
            "you tried and stop — the backend will re-test automatically.",
        ]
    return "\n".join(head)


# ---- Progress doc rendering ------------------------------------------------


def render_progress_md(
    *,
    cfg: AutoplayConfig,
    rounds: list[dict[str, Any]],
    done_reason: DoneReason | None,
    cost_so_far: float,
) -> str:
    """Render the autoplay run log as `progress.md` content.

    Overwrites the project's progress.md each iteration (the router calls
    `core.project_memory.write_progress`). Keeps the schema the rest of the
    system expects (`## Design decisions` / `## Done` / `## Open bugs / TODO`)
    so the auto-injection in `_memory_prompt_snippet` stays consistent, plus an
    autoplay-specific run table.

    `rounds` is a list of per-iteration dicts: {i, verdict_pass, signature,
    cost_so_far, feedback}.
    """
    ts = datetime.now(timezone.utc).isoformat()
    lines: list[str] = [
        f"# Autoplay progress — {cfg.project_name}",
        "",
        f"_Last updated: {ts} (autoplay loop, test_kind={cfg.test_kind})_",
        "",
        "## Design decisions",
        f"- Autonomous autoplay loop active for goal: **{cfg.goal.strip()}**",
        f"- Caps: max_iters={cfg.max_iters}, budget=${cfg.budget_usd:.2f}.",
        "",
        "## Done",
    ]
    passed_round = next((r for r in rounds if r.get("verdict_pass")), None)
    if passed_round is not None:
        lines.append(
            f"- ✅ Goal PASSED on round {passed_round.get('i', 0) + 1} "
            f"(cost so far ${passed_round.get('cost_so_far', 0.0):.4f})."
        )
    elif done_reason is None:
        lines.append("- (in progress — no passing round yet)")
    else:
        lines.append(f"- Not yet passing; loop stopped with reason `{done_reason}`.")
    lines += ["", "## Open bugs / TODO"]
    last_fail = next(
        (r for r in reversed(rounds) if not r.get("verdict_pass")), None
    )
    if last_fail is not None and not (passed_round and passed_round is rounds[-1]):
        fb = (last_fail.get("feedback") or "").strip()
        if fb:
            lines.append("- Latest failing verdict:")
            for fl in fb.splitlines():
                lines.append(f"  {fl}")
    else:
        lines.append("- (none outstanding from autoplay)")

    lines += [
        "",
        "## Autoplay round log",
        "",
        "| round | verdict_pass | signature | cost_so_far |",
        "|------:|:------------:|:----------|------------:|",
    ]
    for r in rounds:
        lines.append(
            f"| {r.get('i', 0) + 1} "
            f"| {'✅' if r.get('verdict_pass') else '❌'} "
            f"| `{r.get('signature', '')}` "
            f"| ${r.get('cost_so_far', 0.0):.4f} |"
        )
    lines += [
        "",
        f"_Total cost this run: ${cost_so_far:.4f}. "
        f"Final reason: {done_reason or '(running)'}._",
        "",
    ]
    return "\n".join(lines)
