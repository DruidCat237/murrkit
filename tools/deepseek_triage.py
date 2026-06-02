"""
DeepSeek V4 Flash log / console triage specialist.

Why a dedicated module
----------------------
DeepSeek V4 Flash is the cheapest credible reasoning model in our stack:
- $0.14 / 1M input, $0.28 / 1M output (cache-miss)
- $0.0028 / 1M cached input — ~100× cheaper than Claude Opus
- 1M context window (more than enough for a full game console dump
  plus a profiler CSV)
- Text-only — no vision (use Gemini for screenshots)

Best fit: ingest large bodies of log/console/profiler text, return a
structured triage that Claude (the captain) can act on without burning
its own context on noise. Claude reads ~5-15 KB of triage instead of
the original ~200-500 KB dump.

Use cases
---------
- Game engine console after a play-mode crash
- Build logs from `manage_build.run_build`
- Profiler frame dumps after a perf regression
- Test runner output from `manage_runtests`
- Stack-trace clustering ("which of these 47 NullRefs are the same root?")

NOT for: C# code review (Claude is better, already in loop), plan
generation, screenshot analysis (use Gemini), or asset prompt drafting.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from loguru import logger

from core.deepseek_v4 import DeepSeekV4Client, Message, TextPart


# ----- Structured triage output ---------------------------------------------


@dataclass(slots=True)
class TriageResult:
    summary: str                       # one-paragraph human-readable summary
    severity: str                      # "info" | "warning" | "error" | "fatal"
    error_clusters: list[dict[str, Any]]  # [{count, sample_message, likely_cause, fix_hint}]
    top_actions: list[str]             # ranked next-steps for Claude / user
    raw_text: str                      # full model response (for debugging)
    input_tokens: int
    output_tokens: int
    cost_usd: float


# ----- System prompt — laser-focused on game-engine triage -----------------


_TRIAGE_SYSTEM = """\
You are a game-engine log triage specialist. You will be given a large
raw text dump (console, build log, profiler CSV, or test output) and you
must return a STRUCTURED JSON triage report that the orchestrator (Claude
Code) can act on without re-reading the dump.

## Rules
1. **Cluster by root cause**, not by line. If 30 NullReferenceExceptions
   come from the same call site, that's ONE cluster with count=30.
2. **Assign severity per cluster**:
   - "fatal"   — game cannot run (compile errors, scene corruption,
                 GameManager null on start)
   - "error"   — game runs but a feature is broken (NRE inside an event
                 handler, missing asset reference)
   - "warning" — non-blocking but suspicious (deprecation, GC alloc
                 spike, race-condition smell)
   - "info"    — Debug.Log noise the user can probably ignore
3. **No speculation outside the dump**. If you can't tell, say so —
   never invent a fix.
4. **Be terse**. Total response under 400 words.

## Output format — STRICT JSON
{
  "summary": "<one paragraph, 1-3 sentences>",
  "severity": "<worst severity across all clusters>",
  "error_clusters": [
    {
      "count": <int>,
      "sample_message": "<first 200 chars of one occurrence>",
      "stack_top": "<deepest frame mentioned, or null>",
      "likely_cause": "<one sentence>",
      "fix_hint": "<one sentence, scoped to a single file:line if possible>"
    }
  ],
  "top_actions": [
    "<imperative phrase, e.g. 'Reattach GameManager reference to RestartButton in TicTacToe scene'>",
    "<at most 5>"
  ]
}

Return ONLY the JSON object, no markdown fences, no preamble.
"""


# ----- Public API ------------------------------------------------------------


async def triage(
    log_text: str,
    *,
    context_hint: str | None = None,
    model: str = "deepseek-v4-flash",
    max_output_tokens: int = 1200,
) -> TriageResult:
    """Run DeepSeek triage over a raw log dump.

    Args:
        log_text: raw game console / build log / profiler text
        context_hint: optional one-liner telling the model what just
            happened (e.g. "user clicked RestartButton then Play Mode
            crashed within 2s"). Helps cluster by root cause.
        model: DeepSeek model name (default flash — cheapest)
        max_output_tokens: response length cap

    Returns:
        TriageResult with structured clusters + top_actions + cost.
    """
    user_text = log_text.strip()
    if context_hint:
        user_text = f"## Context\n{context_hint}\n\n## Log dump\n{user_text}"

    messages = [
        Message(role="system", content=[TextPart(text=_TRIAGE_SYSTEM)]),
        Message(role="user", content=[TextPart(text=user_text)]),
    ]

    async with DeepSeekV4Client(model=model) as client:
        result = await client.chat(
            messages,
            temperature=0.1,
            max_tokens=max_output_tokens,
            # Force JSON — DeepSeek V4 supports OpenAI-style response_format.
            response_format={"type": "json_object"},
        )

    # Parse the JSON response. We're strict: if it doesn't parse, fail
    # loudly rather than silently dropping clusters.
    import json
    try:
        parsed = json.loads(result.text)
    except json.JSONDecodeError as e:
        logger.warning("DeepSeek triage JSON parse failed: {e}", e=e)
        # Return a degraded but truthful result — better than fabricating
        # clusters from a malformed response.
        return TriageResult(
            summary=f"[triage JSON parse failed: {e}] raw head: {result.text[:300]}",
            severity="warning",
            error_clusters=[],
            top_actions=["Re-run triage with shorter input — model returned malformed JSON"],
            raw_text=result.text,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cost_usd=result.cost_usd,
        )

    return TriageResult(
        summary=str(parsed.get("summary", "")),
        severity=str(parsed.get("severity", "info")),
        error_clusters=list(parsed.get("error_clusters", [])),
        top_actions=list(parsed.get("top_actions", [])),
        raw_text=result.text,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cost_usd=result.cost_usd,
    )


# ----- CLI smoke test --------------------------------------------------------


async def smoke_test() -> None:
    """Verify DeepSeek triage works against a representative game log dump."""
    fake_log = """
[12:34:56] NullReferenceException: Object reference not set to an instance of an object
  at GameManager.HandleAITurn () [0x00012] in GameManager.cs:142
  at CatTacToeCell.OnPointerClick () [0x00008] in CatTacToeCell.cs:67
[12:34:56] NullReferenceException: Object reference not set to an instance of an object
  at GameManager.HandleAITurn () [0x00012] in GameManager.cs:142
[12:34:57] NullReferenceException: Object reference not set to an instance of an object
  at GameManager.HandleAITurn () [0x00012] in GameManager.cs:142
[12:34:58] CS0246: The type or namespace name 'WaitForSecondsRealtime' could not be found
  at Assets/Scripts/GameManager.cs:90
[12:34:59] [Warning] Sprite 'cat_white' missing reference in CellPrefab
"""
    print("[..] DeepSeek triage smoke test")
    result = await triage(
        fake_log,
        context_hint="User clicked Play; AI never moved on first turn.",
    )
    print(f"[OK] severity={result.severity}")
    print(f"     summary: {result.summary[:200]}")
    print(f"     clusters: {len(result.error_clusters)}")
    for c in result.error_clusters:
        print(f"       - x{c.get('count')}: {str(c.get('likely_cause', ''))[:100]}")
    print(f"     top_actions ({len(result.top_actions)}):")
    for a in result.top_actions[:5]:
        print(f"       • {a}")
    print(f"     tokens: {result.input_tokens}+{result.output_tokens}  cost: ${result.cost_usd:.6f}")


if __name__ == "__main__":
    import asyncio
    asyncio.run(smoke_test())
