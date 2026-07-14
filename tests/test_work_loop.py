"""Pure-logic tests for backend/services/work_loop.py (the ralph-style
work-loop sibling of autoplay): config clamping, marker parsing, stuck
detection, stop precedence, prompt construction, log rendering."""

from __future__ import annotations

import pytest

from backend.services import work_loop as wl

# ---- clamp_caps / config -----------------------------------------------------


def test_clamp_caps_defaults_on_garbage() -> None:
    assert wl.clamp_caps(None, None) == (wl.MAX_ITERS_DEFAULT, wl.BUDGET_USD_DEFAULT)
    assert wl.clamp_caps("x", "y") == (wl.MAX_ITERS_DEFAULT, wl.BUDGET_USD_DEFAULT)
    assert wl.clamp_caps(0, -3) == (1, wl.BUDGET_USD_DEFAULT)


def test_clamp_caps_hard_ceilings() -> None:
    mi, bu = wl.clamp_caps(999, 999.0)
    assert mi == wl.MAX_ITERS_HARD_CAP
    assert bu == wl.BUDGET_USD_HARD_CAP


def test_config_requires_project_and_prompt() -> None:
    with pytest.raises(ValueError, match="project_name"):
        wl.WorkLoopConfig.from_request({"prompt": "x"})
    with pytest.raises(ValueError, match="prompt"):
        wl.WorkLoopConfig.from_request({"project_name": "p"})
    cfg = wl.WorkLoopConfig.from_request(
        {"project_name": "p", "prompt": "zadanie", "max_iters": 3, "budget_usd": 2.5}
    )
    assert (cfg.max_iters, cfg.budget_usd) == (3, 2.5)


# ---- marker parsing ------------------------------------------------------------


def test_parse_marker_variants() -> None:
    assert wl.parse_marker("...\nLOOP_CONTINUE: zrobiłem X, dalej Y").status == "continue"
    assert wl.parse_marker("...\nLOOP_DONE: testy 7/7").status == "done"
    assert wl.parse_marker("...\nLOOP_BLOCKED: wybierz styl").status == "blocked"


def test_parse_marker_last_one_wins() -> None:
    text = (
        "Protokół każe kończyć markerem LOOP_DONE: <dowód>.\n"
        "Zrobiłem przyrost.\n"
        "LOOP_CONTINUE: następna runda — kolizje\n"
    )
    m = wl.parse_marker(text)
    assert m.status == "continue"
    assert "kolizje" in m.detail


def test_parse_marker_missing() -> None:
    m = wl.parse_marker("skończyłem turę bez markera")
    assert m.status == "missing"
    assert m.signature == wl.parse_marker("inny tekst, też bez markera").signature


def test_signature_ignores_cosmetic_rewording() -> None:
    a = wl.parse_marker("LOOP_CONTINUE:  Dalej   KOLIZJE")
    b = wl.parse_marker("LOOP_CONTINUE: dalej kolizje")
    c = wl.parse_marker("LOOP_CONTINUE: dalej pathfinding")
    assert a.signature == b.signature
    assert a.signature != c.signature


# ---- stop logic -----------------------------------------------------------------


def _cont(detail: str) -> wl.LoopMarker:
    return wl.parse_marker(f"LOOP_CONTINUE: {detail}")


def test_stop_done_and_blocked_win() -> None:
    done = wl.parse_marker("LOOP_DONE: dowód")
    d = wl.evaluate_stop(
        marker=done, iteration=99, max_iters=1, cost_so_far=999.0, budget_usd=1.0,
        recent_signatures=[done.signature] * 5,
    )
    assert (d.stop, d.reason) == (True, "done")
    blocked = wl.parse_marker("LOOP_BLOCKED: decyzja")
    d = wl.evaluate_stop(
        marker=blocked, iteration=0, max_iters=10, cost_so_far=0.0, budget_usd=10.0,
        recent_signatures=[blocked.signature],
    )
    assert (d.stop, d.reason) == (True, "blocked")


def test_stop_stuck_after_three_identical() -> None:
    m = _cont("to samo")
    sigs = [m.signature, m.signature, m.signature]
    d = wl.evaluate_stop(
        marker=m, iteration=1, max_iters=10, cost_so_far=0.0, budget_usd=10.0,
        recent_signatures=sigs,
    )
    assert (d.stop, d.reason) == (True, "stuck")
    # Two identical + one different → not stuck.
    sigs2 = [m.signature, _cont("inne").signature, m.signature]
    d2 = wl.evaluate_stop(
        marker=m, iteration=1, max_iters=10, cost_so_far=0.0, budget_usd=10.0,
        recent_signatures=sigs2,
    )
    assert d2.stop is False


def test_stop_caps_budget_and_iters() -> None:
    m = _cont("praca")
    d = wl.evaluate_stop(
        marker=m, iteration=0, max_iters=10, cost_so_far=6.0, budget_usd=6.0,
        recent_signatures=[m.signature],
    )
    assert (d.stop, d.reason) == (True, "caps")
    d2 = wl.evaluate_stop(
        marker=m, iteration=9, max_iters=10, cost_so_far=0.1, budget_usd=6.0,
        recent_signatures=[m.signature],
    )
    assert (d2.stop, d2.reason) == (True, "caps")
    d3 = wl.evaluate_stop(
        marker=m, iteration=0, max_iters=10, cost_so_far=0.1, budget_usd=6.0,
        recent_signatures=[m.signature],
    )
    assert d3.stop is False


def test_pre_iteration_budget_gate() -> None:
    assert wl.should_block_before_iteration(cost_so_far=5.0, budget_usd=5.0).stop is True
    assert wl.should_block_before_iteration(cost_so_far=4.9, budget_usd=5.0).stop is False


# ---- prompt construction ---------------------------------------------------------


def _cfg(prompt: str = "Zbuduj mapę i mechaniki.") -> wl.WorkLoopConfig:
    return wl.WorkLoopConfig.from_request({"project_name": "cats", "prompt": prompt})


def test_prompt_reinjects_task_verbatim_every_round() -> None:
    cfg = _cfg("UNIKALNE-ZADANIE-XYZ")
    p0 = wl.build_iteration_prompt(cfg=cfg, iteration=0, prev=None)
    p5 = wl.build_iteration_prompt(cfg=cfg, iteration=5, prev=_cont("dalej"))
    assert "UNIKALNE-ZADANIE-XYZ" in p0
    assert "UNIKALNE-ZADANIE-XYZ" in p5
    assert "w rundzie 1/" in p0
    assert "w rundzie 6/" in p5
    assert "LOOP_CONTINUE" in p0 and "LOOP_DONE" in p0 and "LOOP_BLOCKED" in p0


def test_prompt_threads_previous_continue_detail() -> None:
    p = wl.build_iteration_prompt(cfg=_cfg(), iteration=2, prev=_cont("dokończ kolizje wody"))
    assert "dokończ kolizje wody" in p
    assert "Kontynuuj" in p


def test_prompt_reminds_protocol_on_missing_marker() -> None:
    missing = wl.parse_marker("bez markera")
    p = wl.build_iteration_prompt(cfg=_cfg(), iteration=1, prev=missing)
    assert "NIE zakończyłeś" in p


def test_progress_md_path_mentions_project() -> None:
    p = wl.build_iteration_prompt(cfg=_cfg(), iteration=0, prev=None)
    assert ".omc/state/cats/progress.md" in p


# ---- log rendering ---------------------------------------------------------------


def test_render_loop_log_table_and_escaping() -> None:
    cfg = _cfg()
    log = wl.render_loop_log(
        cfg=cfg,
        rounds=[
            {"i": 0, "status": "continue", "detail": "a | b", "cost_so_far": 0.5},
            {"i": 1, "status": "done", "detail": "x" * 300, "cost_so_far": 1.25},
        ],
        done_reason="done",
        cost_so_far=1.25,
    )
    assert "| 1 | continue | a \\| b | $0.5000 |" in log
    assert "…" in log  # long detail truncated
    assert "Final reason: done" in log
