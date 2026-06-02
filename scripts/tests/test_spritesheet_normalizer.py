"""Smoke test for tools.spritesheet_normalizer — deterministic, no real assets.

Builds a 3x3 sheet whose content square sits at a DIFFERENT offset/size in each
cell (simulating GPT's uneven frames), then asserts normalize_grid() collapses
the per-frame anchor jitter to ~0 (feet-aligned) and triggers a uniform
down-scale when one frame overflows its cell ("cut ears" case).

Run:  uv run python scripts/tests/test_spritesheet_normalizer.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.spritesheet_normalizer import measure_grid, normalize_grid  # noqa: E402

CELL = 100
ROWS = COLS = 3


def _build_jittered_sheet(path: Path) -> None:
    """3x3 sheet; each cell holds a solid square at a wandering offset+size."""
    sheet = Image.new("RGBA", (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
    # (dx, dy, size) per cell — deliberately all different → big jitter.
    specs = [
        (10, 5, 40), (35, 22, 50), (8, 40, 30),
        (50, 12, 45), (20, 30, 60), (5, 8, 35),
        (40, 50, 38), (15, 18, 44), (30, 5, 52),
    ]
    for idx, (dx, dy, sz) in enumerate(specs):
        r, c = idx // COLS, idx % COLS
        sq = Image.new("RGBA", (sz, sz), (200, 60, 60, 255))
        sheet.paste(sq, (c * CELL + dx, r * CELL + dy), sq)
    sheet.save(path, "PNG")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="ssnorm_"))
    src = tmp / "jittered.png"
    _build_jittered_sheet(src)

    before = measure_grid(src, ROWS, COLS)
    print("BEFORE:", before)
    assert before["jitter_x"] > 5 or before["jitter_y"] > 5, "test sheet not jittery enough"

    out = tmp / "normalized.png"
    res = normalize_grid(src, ROWS, COLS, out_path=out, align="bottom-center", pad=6)
    print("NORMALIZE:", res)

    after = measure_grid(out, ROWS, COLS)
    print("AFTER:", after)

    # Feet-align: every live frame must now share the same bottom anchor (y jitter ~0)
    # and same horizontal centre (x jitter ~0). Allow <=1px for integer rounding.
    assert after["jitter_y"] <= 1.0, f"y jitter not removed: {after['jitter_y']}"
    assert after["jitter_x"] <= 1.0, f"x jitter not removed: {after['jitter_x']}"
    assert res["n_live"] == 9 and res["n_blank"] == 0

    # Overflow case: a frame that fills its whole cell must force scale < 1.
    src2 = tmp / "overflow.png"
    sheet = Image.new("RGBA", (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
    full = Image.new("RGBA", (CELL, CELL), (40, 160, 40, 255))  # fills cell 0 entirely
    sheet.paste(full, (0, 0), full)
    small = Image.new("RGBA", (30, 30), (40, 160, 40, 255))
    sheet.paste(small, (CELL + 10, 10), small)
    sheet.save(src2, "PNG")
    res2 = normalize_grid(src2, ROWS, COLS, out_path=tmp / "ov_norm.png", pad=6)
    print("OVERFLOW:", res2)
    assert res2["scale"] < 1.0, f"overflow should down-scale, got scale={res2['scale']}"
    assert res2["n_overflow"] >= 1

    print("\nALL ASSERTIONS PASSED [OK]")
    print(f"  jitter {before['jitter_x']},{before['jitter_y']}px  ->  "
          f"{after['jitter_x']},{after['jitter_y']}px")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
