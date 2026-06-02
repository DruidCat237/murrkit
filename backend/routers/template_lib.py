"""
Template Skill — open-source game-template search + clone + registry.

Per OpenGame's "Template Skill" pattern (arXiv 2604.18394, 2026): never
start a game project from a blank file. At session start, the agent
searches known good open-source templates that match the requested
genre, presents the top match(es) to the user, asks permission, clones
the repo locally, then remixes it with the user's own assets instead of
building physics/mechanics from scratch. This eliminates the
floating-slingshot / oversized-walls / broken-physics failure mode
that plagued EXP-3.

Endpoints (prefix `/api/template/`, distinct from the existing
`/api/templates/*` template-BUILDER endpoints in `templates.py`):

    GET  /api/template/registry              — full curated list
    POST /api/template/match                 — find templates matching user prompt
    POST /api/template/clone                 — git clone into Library/Templates/
    GET  /api/template/list-cloned           — what's been cloned already

The registry is a static JSON at `.omc/templates/registry.json` — adding
new templates means editing that file, no code change.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel, Field

from core.config import settings

router = APIRouter(prefix="/api/template", tags=["template-lib"])


_REGISTRY_PATH = (
    Path(__file__).resolve().parents[2] / ".omc" / "templates" / "registry.json"
)


def _load_registry() -> dict[str, Any]:
    if not _REGISTRY_PATH.is_file():
        raise HTTPException(
            status_code=500,
            detail=f"template registry missing at {_REGISTRY_PATH}",
        )
    return json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))


@router.get("/registry")
async def get_registry() -> dict[str, Any]:
    """Full curated template list with metadata.

    Inner Claude calls this FIRST at session start to see what's
    available without doing a live GitHub search. The list covers
    Angry Birds, platformer, top-down shooter, tower defense, match-3,
    endless runner, 2048, breakout, flappy. Always check here BEFORE
    falling back to live `gh search`.
    """
    return _load_registry()


class MatchRequest(BaseModel):
    """User's prompt text — we match against `genre` + `aliases` substrings."""
    prompt: str = Field(..., min_length=2, max_length=500)
    max_results: int = Field(default=3, ge=1, le=10)


@router.post("/match")
async def match_templates(req: MatchRequest) -> dict[str, Any]:
    """Find templates whose `genre`/`aliases` match the user's prompt.

    Heuristic: lowercase the prompt, score each template by how many of
    its aliases appear as substrings. Top matches returned sorted by
    score then stars. Empty result = no curated template fits; caller
    may fall back to a live `gh search` from Bash (we don't shell out
    here to keep this backend dependency-free).
    """
    registry = _load_registry()
    prompt_lc = req.prompt.lower()
    scored: list[tuple[int, dict[str, Any]]] = []
    for t in registry["templates"]:
        score = 0
        if t.get("genre", "").lower() in prompt_lc:
            score += 5
        for alias in t.get("aliases", []):
            if alias.lower() in prompt_lc:
                score += 3
        if "unity" in prompt_lc and t.get("engine") == "Unity":
            score += 1
        if score > 0:
            scored.append((score, t))

    def _star_score(t: dict[str, Any]) -> int:
        v = t.get("stars_at_indexing", 0)
        if isinstance(v, int):
            return v
        if isinstance(v, str) and v.isdigit():
            return int(v)
        if isinstance(v, str) and v == "official":
            return 9999
        return 0

    scored.sort(key=lambda x: (-x[0], -_star_score(x[1])))
    matches = [t for _, t in scored[: req.max_results]]
    return {
        "prompt": req.prompt,
        "matches": matches,
        "match_count": len(matches),
        "license_safe_list": registry["_meta"]["license_safe"],
        "next_step": (
            "Present matches to the user with a one-line summary each, "
            "and ask explicitly: 'Want me to clone <repo> as starter? It "
            "has <has>, missing <missing>. License: <license>.' Wait for "
            "YES / NO before POST /api/template/clone. If no curated "
            "match, run `gh search repos \"<genre> unity 2d\" "
            "--license=MIT,Apache-2.0 --sort=stars --limit=5` via Bash."
        ),
    }


class CloneRequest(BaseModel):
    """Where + what to clone."""
    template_id: str | None = None  # match by registry id (preferred)
    repo_url: str | None = None     # or pass an explicit repo URL
    project: str = "default"
    branch: str | None = None       # defaults to repo's default branch


@router.post("/clone")
async def clone_template(req: CloneRequest) -> dict[str, Any]:
    """Git-clone the template into <game_project>/Library/Templates/<repo>/.

    Why under Library/ — the engine treats Library/ as cache (gitignored, not
    imported into AssetDatabase). The agent can read the repo's scripts +
    prefabs + scenes without polluting the active game project's Assets/
    tree with foreign GUIDs. Then the agent copies the parts it wants
    into a new sibling folder (Assets/_Borrowed/SlingShot/...) and
    rewrites sprite references to the project's own generated assets.

    Safety:
      - Refuses if a template with that name is already cloned (caller
        must delete first if a fresh clone is wanted).
      - Validates repo URL matches a supported git host pattern.
      - Runs git with a 120s timeout so a hanging clone doesn't lock the
        request.
      - On failure, cleans up the partial clone dir before raising.
    """
    registry = _load_registry()

    # Resolve repo URL — registry lookup or explicit
    match: dict[str, Any] | None
    if req.template_id:
        match = next(
            (t for t in registry["templates"] if t["id"] == req.template_id),
            None,
        )
        if match is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"template_id {req.template_id!r} not in registry. "
                    f"GET /api/template/registry to see available ids."
                ),
            )
        repo_url = match["repo"]
        license_str = match.get("license", "unknown")
    elif req.repo_url:
        repo_url = req.repo_url
        license_str = "unknown (passed by URL — verify license manually)"
        match = None
    else:
        raise HTTPException(
            status_code=400,
            detail="must pass either template_id (registry id) or repo_url",
        )

    if repo_url == "<built-in>":
        return {
            "skipped": True,
            "reason": (
                "built-in template — use the corresponding skill "
                "directly, no clone needed"
            ),
        }

    # Validate URL shape
    if not re.match(
        r"^https?://(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)/[\w.-]+/[\w.-]+/?$",
        repo_url.rstrip("/"),
    ):
        raise HTTPException(
            status_code=400,
            detail=f"repo URL doesn't look like a supported git host: {repo_url}",
        )

    # Determine clone destination
    unity_root = Path(settings.unity_project_path)
    if not unity_root.is_dir():
        raise HTTPException(
            status_code=500,
            detail=(
                f"UNITY_PROJECT_PATH={unity_root} not a directory — "
                f"set in .env or via Settings UI"
            ),
        )

    repo_name = repo_url.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
    dest = unity_root / "Library" / "Templates" / repo_name
    if dest.exists():
        return {
            "already_cloned": True,
            "path": str(dest),
            "hint": "delete it first if you want a fresh clone",
            "summary": _summarize_clone(dest),
        }
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Build + run git command
    cmd = ["git", "clone", "--depth=1"]
    if req.branch:
        cmd += ["--branch", req.branch]
    cmd += [repo_url, str(dest)]
    logger.info("template clone: {c}", c=" ".join(cmd))

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120.0)
    except asyncio.TimeoutError as e:
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(
            status_code=504, detail=f"git clone timed out after 120s: {e}"
        ) from e
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=500,
            detail=f"git executable not found on PATH: {e}",
        ) from e

    if proc.returncode != 0:
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(
            status_code=502,
            detail={
                "error": "git clone failed",
                "exit_code": proc.returncode,
                "stderr": stderr.decode(errors="replace")[:2000],
            },
        )

    summary = _summarize_clone(dest)

    return {
        "ok": True,
        "path": str(dest),
        "repo": repo_url,
        "license": license_str,
        "registry_entry": match,
        "summary": summary,
        "next_step": (
            "Read the key_files listed in the registry entry. Understand "
            "the physics + prefab structure. Then copy the bits you want "
            "into Assets/_Borrowed/<feature>/ (NOT into Library/Templates "
            "directly — that dir is ignored by the engine AssetDatabase by "
            "design). Rewrite sprite refs to your own generated assets "
            "(cat_*_v2.png, mouse_*_v2.png etc). Document in chat which "
            "files you borrowed + license attribution if license requires it."
        ),
    }


def _summarize_clone(dest: Path) -> dict[str, Any]:
    """Walk the cloned repo, return file counts + notable files for the agent."""
    counts: dict[str, int] = {}
    notable: list[str] = []
    notable_patterns = ("README", "LICENSE", ".unity", ".prefab", ".asset")
    for p in dest.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(dest)
        if ".git" in rel.parts:
            continue
        ext = p.suffix.lower() or "(no ext)"
        counts[ext] = counts.get(ext, 0) + 1
        if any(pat in p.name for pat in notable_patterns) and len(notable) < 40:
            notable.append(str(rel).replace("\\", "/"))
    # also pull top-level .cs files as they tend to be the main entry scripts
    for cs in (dest / "Assets").rglob("*.cs") if (dest / "Assets").is_dir() else []:
        if len(notable) >= 80:
            break
        notable.append(str(cs.relative_to(dest)).replace("\\", "/"))
    return {
        "file_counts_by_ext": dict(sorted(counts.items(), key=lambda x: -x[1])[:15]),
        "notable_files": notable,
    }


@router.get("/list-cloned")
async def list_cloned() -> dict[str, Any]:
    """List templates already cloned into the active game project's
    `Library/Templates/`. Lets the agent check 'did I already clone this'
    before re-cloning."""
    unity_root = Path(settings.unity_project_path)
    tdir = unity_root / "Library" / "Templates"
    if not tdir.is_dir():
        return {"cloned": [], "templates_dir": str(tdir)}
    cloned: list[dict[str, Any]] = []
    for sub in tdir.iterdir():
        if not sub.is_dir():
            continue
        readme = next(
            (sub / fn for fn in ("README.md", "README", "readme.md", "Readme.md")
             if (sub / fn).is_file()),
            None,
        )
        cloned.append({
            "name": sub.name,
            "path": str(sub),
            "has_readme": readme is not None,
            "readme_head": (
                readme.read_text(encoding="utf-8", errors="replace")[:500]
                if readme else None
            ),
        })
    return {"templates_dir": str(tdir), "cloned": cloned}
