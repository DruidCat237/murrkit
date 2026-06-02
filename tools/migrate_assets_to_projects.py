"""
Migrate shared generated assets into strictly per-project folders.

Background
----------
The Unity-era worker wrote every project's generated assets into ONE shared
tree: ``phaser_game/Assets/Generated/{Sprites,Backgrounds,UI,FX}/``. The Asset
Library scanned that shared tree, so every project saw the same mixed list of
assets from ALL projects.

This script attributes each asset group to its owning project and MOVES it to
``projects/<owner>/Generated/<subfolder>/<slug>/`` so each project's assets are
isolated. The Phaser game runtime loads from ``phaser_game/public/`` (NOT from
``Assets/Generated``), so moving these staging copies is safe for the game.

Ownership source of truth
--------------------------
The SQLite gen-queue DB (``logs/gen_queue.db``, table ``queue_tasks``) tags every
generation task with its ``project``. Each task's on-disk folder name is a slug
derived from the prompt the SAME way ``agents.sprite_pipeline._slugify`` derives
it. We therefore:

  1. Build ``{derived_slug: project}`` from the DB.
  2. For each leaf folder / loose file under ``Assets/Generated/<sub>``:
     a. explicit ground-truth override (folders whose on-disk name was an
        explicit ``character_slug``, not the auto-derived prompt slug),
     b. DB-slug prefix match (truncated folder name <-> full DB slug, with the
        asset-type prefix like ``ui_button_`` / ``fx_dust_`` stripped for loose
        files),
     c. keyword heuristic fallback,
     d. ``_unsorted`` last resort (left in place to report, never guessed).

Every MOVE is recorded in a reversible manifest at
``.omc/state/asset_migration_manifest.json``.

Usage
-----
    python -m tools.migrate_assets_to_projects --dry-run   # print plan only
    python -m tools.migrate_assets_to_projects             # perform the moves

Files are MOVED (``shutil.move``), never deleted. ``.original.png`` backups and
sidecar JSON (``*_frames.json`` etc.) live inside the leaf folder and move with
it. Idempotent: a destination that already exists is skipped.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

# Import the EXACT slugify the pipelines use so derived slugs match on-disk names.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents.sprite_pipeline import _slugify  # noqa: E402

PROJECT_ROOT: Path = Path(__file__).resolve().parents[1]
DB_PATH: Path = PROJECT_ROOT / "logs" / "gen_queue.db"
GENERATED_ROOT: Path = PROJECT_ROOT / "phaser_game" / "Assets" / "Generated"
PROJECTS_DIR: Path = PROJECT_ROOT / "projects"
MANIFEST_PATH: Path = PROJECT_ROOT / ".omc" / "state" / "asset_migration_manifest.json"

# Subfolders under Assets/Generated that hold generated asset groups.
SUBFOLDERS: tuple[str, ...] = ("Sprites", "Backgrounds", "UI", "FX")

# Folders whose on-disk name is an explicit character_slug passed to the
# pipeline (not the auto-derived prompt slug), so the DB-slug match misses them.
# Values are the GROUND-TRUTH owners confirmed from the gen-queue prompts.
OWNER_OVERRIDES: dict[str, str] = {
    "cat_yellow_rebuild": "Cat_Volleyball",
    "cat_black_idle6": "Cat_Volleyball",
    "slingshot_side_angle": "AngryCatPhaser",
    "mouse_blink_2frame": "AngryCatPhaser",
    "mouse_king_with_crown": "AngryCatPhaser",
}

# Asset-type prefixes that asset_pipeline prepends to loose UI/FX/tileset/bg
# file names. Stripped before DB-slug prefix matching so the meaningful tail
# (e.g. "celebration_bur" from "fx_dust_celebration_bur") can match its DB slug.
PREFIX_TOKENS: tuple[str, ...] = (
    "ui_health_bar_", "ui_button_", "ui_panel_", "ui_icon_", "ui_frame_", "ui_",
    "fx_dust_", "fx_spark_", "fx_impact_", "fx_magic_", "fx_smoke_", "fx_",
    "tileset_", "bg_",
)

# Keyword heuristics — last resort before _unsorted.
_CAT_KW = re.compile(r"beach|volleyball|druid|net|sand", re.IGNORECASE)
_ANGRY_KW = re.compile(r"mouse|slingshot|angry.?bird|earthen|confetti|tabby|crown", re.IGNORECASE)

UNSORTED_OWNER = "_unsorted"


@dataclass
class PlanItem:
    src: str
    dst: str
    owner: str
    reason: str


def build_slug_owner_map(db_path: Path) -> dict[str, str]:
    """Build ``{derived_slug: project}`` from the gen-queue DB.

    First-writer wins on slug collisions so a single deterministic owner is
    recorded; collisions across projects are vanishingly unlikely given the
    distinct prompts but we keep it deterministic regardless.
    """
    if not db_path.is_file():
        raise FileNotFoundError(f"gen-queue DB not found: {db_path}")
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT project, payload FROM queue_tasks").fetchall()
    finally:
        conn.close()
    slug_owner: dict[str, str] = {}
    for project, payload in rows:
        prompt = json.loads(payload).get("prompt", "")
        slug = _slugify(prompt, 30)
        if slug:
            slug_owner.setdefault(slug, project)
    return slug_owner


def _strip_asset_prefix(stem: str) -> str:
    for token in PREFIX_TOKENS:
        if stem.startswith(token):
            return stem[len(token):]
    return stem


def _db_match(stem: str, slug_owner: dict[str, str]) -> tuple[str | None, str | None]:
    """Match an on-disk stem against DB slugs by mutual prefix.

    Folder names are truncated DB slugs (or vice-versa), so a prefix relation in
    either direction is a confident match. We try the raw stem first, then the
    asset-type-prefix-stripped tail (for loose UI/FX files).
    """
    stem_l = stem.lower()
    for candidate in (stem_l, _strip_asset_prefix(stem_l)):
        if not candidate:
            continue
        for slug, project in slug_owner.items():
            if slug.startswith(candidate) or candidate.startswith(slug):
                return project, f"db-slug:{slug}"
    return None, None


def resolve_owner(stem: str, slug_owner: dict[str, str]) -> tuple[str, str]:
    """Return ``(owner, reason)`` for an asset group named ``stem``."""
    if stem in OWNER_OVERRIDES:
        return OWNER_OVERRIDES[stem], "override"
    owner, reason = _db_match(stem, slug_owner)
    if owner is not None:
        return owner, reason  # type: ignore[return-value]
    cat = bool(_CAT_KW.search(stem))
    angry = bool(_ANGRY_KW.search(stem))
    if cat and not angry:
        return "Cat_Volleyball", "keyword:cat"
    if angry and not cat:
        return "AngryCatPhaser", "keyword:angry"
    return UNSORTED_OWNER, "unmatched"


def build_plan(slug_owner: dict[str, str]) -> list[PlanItem]:
    """Walk Assets/Generated and produce one PlanItem per asset group.

    An asset group is either a leaf folder (Sprites/Backgrounds) or a loose
    file (UI/FX sometimes hold bare PNGs). Loose files are moved into a slug
    subfolder named after the file stem to mirror the folder layout.
    """
    plan: list[PlanItem] = []
    if not GENERATED_ROOT.is_dir():
        return plan
    for sub in SUBFOLDERS:
        sub_dir = GENERATED_ROOT / sub
        if not sub_dir.is_dir():
            continue
        for entry in sorted(sub_dir.iterdir()):
            if entry.name in _IGNORE_NAMES:
                continue
            # Leaf folder keeps its name; a loose file becomes a slug subfolder
            # named after its stem so the per-project layout stays uniform.
            slug = entry.name if entry.is_dir() else entry.stem
            owner, reason = resolve_owner(slug, slug_owner)
            dst = PROJECTS_DIR / owner / "Generated" / sub / slug
            plan.append(PlanItem(src=str(entry), dst=str(dst), owner=owner, reason=reason))
    return plan


_IGNORE_NAMES = (".DS_Store", "Thumbs.db", "desktop.ini")


def execute_plan(plan: list[PlanItem]) -> tuple[list[PlanItem], list[PlanItem]]:
    """Perform the moves. Returns ``(moved, skipped)``.

    ``item.dst`` is always the slug FOLDER. A directory source is moved to that
    folder path directly; a loose file is moved INTO it under its original name.

    Idempotent: an existing final destination is skipped (not overwritten, not
    deleted). Parent dirs are created as needed.
    """
    moved: list[PlanItem] = []
    skipped: list[PlanItem] = []
    for item in plan:
        src = Path(item.src)
        slug_folder = Path(item.dst)
        if not src.exists():
            skipped.append(item)
            continue
        if src.is_dir():
            final_dst = slug_folder
            if final_dst.exists():
                skipped.append(item)
                continue
            slug_folder.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(final_dst))
        else:
            final_dst = slug_folder / src.name
            if final_dst.exists():
                skipped.append(item)
                continue
            slug_folder.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(final_dst))
        moved.append(item)
    return moved, skipped


def write_manifest(plan: list[PlanItem], moved: list[PlanItem]) -> None:
    """Write a reversible manifest. ``moved`` flags which entries actually moved
    this run (skipped entries carry ``moved=False`` for an accurate record)."""
    moved_srcs = {m.src for m in moved}
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_root": str(GENERATED_ROOT),
        "projects_dir": str(PROJECTS_DIR),
        "entries": [
            {
                "src": item.src,
                "dst": item.dst,
                "owner": item.owner,
                "reason": item.reason,
                "moved": item.src in moved_srcs,
            }
            for item in plan
        ],
    }
    MANIFEST_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _print_plan(plan: list[PlanItem]) -> None:
    by_owner: dict[str, int] = {}
    for item in plan:
        by_owner[item.owner] = by_owner.get(item.owner, 0) + 1
        rel_src = Path(item.src).relative_to(PROJECT_ROOT)
        rel_dst = Path(item.dst).relative_to(PROJECT_ROOT)
        print(f"  [{item.owner:16s}] {rel_src}  ->  {rel_dst}   ({item.reason})")
    print("\n  Summary by owner:")
    for owner in sorted(by_owner):
        print(f"    {owner:16s} {by_owner[owner]} group(s)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the migration plan WITHOUT moving any files.",
    )
    args = parser.parse_args()

    slug_owner = build_slug_owner_map(DB_PATH)
    plan = build_plan(slug_owner)

    if not plan:
        print(f"Nothing to migrate — {GENERATED_ROOT} is empty or missing.")
        return 0

    mode = "DRY-RUN" if args.dry_run else "MIGRATE"
    print(f"=== Asset migration plan ({mode}) — {len(plan)} group(s) ===")
    _print_plan(plan)

    if args.dry_run:
        print("\n(dry-run — no files moved, no manifest written)")
        return 0

    moved, skipped = execute_plan(plan)
    write_manifest(plan, moved)
    print(f"\n=== Done: moved {len(moved)}, skipped {len(skipped)} (already present / missing) ===")
    print(f"Manifest: {MANIFEST_PATH}")
    unsorted = [p for p in plan if p.owner == UNSORTED_OWNER]
    if unsorted:
        print(f"\nWARNING: {len(unsorted)} group(s) could not be attributed (owner={UNSORTED_OWNER}):")
        for item in unsorted:
            print(f"  - {Path(item.src).relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
