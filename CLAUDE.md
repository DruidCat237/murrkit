# murrkit — Claude Code Session Guide

> **Primary project context.** Read this first in every session.

## What this project is

**murrkit** — autonomous Phaser 3 + TypeScript 2D game dev orchestrator.

User types a prompt → multi-agent system drives a **Phaser 3 game** through
code generation + headless playtest + vision compare-gate to autonomously:

1. Generate sprite sheets (GPT-Image-2 via Kitty App) — characters, tilesets, UI
2. Write TypeScript scene + prefab code into `phaser_game/src/`
3. Vite hot-reloads instantly (sub-second iteration vs Unity Editor's 30s)
4. Playwright runs the dev server headlessly, screenshots, dumps Canvas/DOM state
5. Vision compare-gate (Gemini compare-mode) blocks completion claims without pixel-level pass
6. Composition validator inspects the live JS scene-graph (DOM-level), not LLM-described state

## Why this stack vs Unity (Lessons from the retired Unity-based predecessor)

murrkit replaced the retired Unity-based predecessor. Six architectural problems hit a ceiling there:

1. Unity's binary `.unity` scene files are not git-diffable → compounding regressions invisible
2. Iteration cycle 30s (compile-DLL + reload Editor) → Claude can't see results before next action
3. LLM-as-captain over MCP → translation layers, silent fails, no programmatic gates
4. Vision was opt-in (Claude had to choose to screenshot) → he didn't
5. Scene state lives in proprietary Editor format → no transactional rollback
6. Asset import settings (alphaIsTransparency etc.) not cleanly exposed via MCP → atlas bugs unfixable

**Phaser 3 + TypeScript + Vite fixes ALL six by construction:**

- TypeScript scene files are text → git diff shows exact changes → rollback is `git checkout`
- Vite hot-reload is sub-second → 50× faster iteration
- No MCP — direct `await page.evaluate("game.scene.scenes[0].cat.x")` via Playwright
- Screenshot via Playwright is automatic per-turn, not opt-in
- Each level is one TypeScript module + one YAML spec — atomic units
- Sprite import = `this.load.image('cat', 'cat.png')` — one line, no settings dialog

## Stack

| Layer | Tech | Port | Cost ballpark |
|-------|------|------|---------------|
| Frontend (web UI) | Next.js 15 + Tailwind | :3001 | — |
| Backend | FastAPI + WebSocket | :8001 (or :8002+) | — |
| Captain / orchestrator | **Claude Code CLI** (Fable 5, pinned `claude-fable-5`; $10/$50 per MTok via API) | — | subscription, or API via `ANTHROPIC_API_KEY` |
| **Game runtime** | **Phaser 3.85 + TypeScript + Vite** | :5173 | — |
| **Headless playtest** | **Playwright** | — | — |
| **Vision (DEFAULT)** | **Gemini 3.5 Flash** (v2 upgrade — via Kitty `/agent/chat` or direct) | — | cache $0.15/M in |
| Vision (alt) | Gemini 3.5 Pro (heavy long-context QA, when GA) | — | — |
| Log/console triage | DeepSeek V4 Flash | — | $0.14/M in |
| Vision (fallback) | VL fallback via Kitty | — | via Kitty |
| Sprite/image gen | GPT-Image-2 via Kitty | — | $0.04-0.16 / image |
| Audio | ElevenLabs | — | — |
| Python | 3.13 + uv | — | — |
| DB | SQLite | — | — |

## v2 Architecture (2026-05-28 — Opus 4.8 rebuild)

The orchestrator was re-architected. The inner-Claude game-dev captain now:
- **Design-first gate**: any new game / major feature → it FIRST writes a Game Design Doc (genre, control scheme, core loop, physics in world units, asset/spritesheet plan, level beats, win/lose, art direction, juice) ending with `Reply APPROVE to build / EDIT / CANCEL`. NO game code until APPROVE. Approved doc → `.omc/state/<project>/design.md`. (Never asks trivial permission, but ALWAYS confirms the design once.)
- **Systemic imagination**: a vague prompt ("make a Mario platformer") is expanded into a full technical design (controls/physics/levels/AI/failure-states), not just pretty sprites.
- **Persistent memory**: per-project CLI session persisted to `.omc/state/sessions.json` (survives backend restart); `.omc/state/<project>/progress.md` is auto-injected every turn — the inner Claude keeps it updated.

New backend endpoints (v2):
- `POST /api/phaser/drive` — **genre-agnostic ACTIVE PLAY**. Timed keyboard+mouse input scripts (`keydown/keyup/hold/tap/click/drag` with `at_ms`), per-frame `window.__gameState()` snapshots, and responsiveness **asserts** (`player.x_increased`, `player.y_rose_then_fell`=jump, `score_increased`, `scene.win`, `predicate_js`, …). This is how the LLM actually PLAYS + smoke-tests platformers/RPGs/etc. The old `/api/phaser/playtest` slingshot bot is now one adapter.
- WS `/api/chat/autoplay` — **autonomous play→fix loop**: re-invokes the inner Claude with the failing verdict until the test passes. HARD caps (≤10 iters / ≤$8, stuck-detection on repeated failure signature). Opt-in; surfaces to the user only when ready or blocked.
- WS `/api/chat/loop` — **work loop (ralph-style)**: the task prompt is re-injected verbatim every round; the CAPTAIN ends each round with a mandatory marker `LOOP_CONTINUE:/LOOP_DONE:/LOOP_BLOCKED:` that drives the loop. Caps are USER-CONTROLLED in Settings → Work loop (`MURRKIT_LOOP_BUDGET_USD` / `_BUDGET_CAP_USD` / `_ITERS` / `_ITERS_CAP`; ceilings default 100 rounds / $300, `0` = unlimited, live-read per run). The budget gate runs BETWEEN rounds, so one expensive round can overshoot the limit. Stuck = same marker 3× in a row. Chat UI: type `/loop [--iters N] [--budget X] <task>`. Run log: `.omc/state/<project>/loop_log.md` (progress.md stays the captain's). Pure logic: `backend/services/work_loop.py` + `tests/test_work_loop.py`.
- `POST /api/spritesheet/import` — upload a PNG + `rows`×`cols` → 2D-sliced frames + `frames.json`.

**Game-side contract**: any scene driven by `/drive` MUST call `registerGameState(scene, provider)` from `@/systems/gameState` (slingshot scenes get it free via `StateRecorder`).

**Sprite studio**: default **NxN grids (3×3 = 9 frames, up to ~12)** instead of 1×N strips; canonical-seed + GPT-Image-2 edit-mode for character consistency (never chain edits); GPT-Image-2 has NO transparency → flat grey bg + rembg post-mask. Frontend `SpritesheetImportPanel` (upload + live grid overlay) + `AnimatorPanel` (build/preview anims). `frames.json` is now wired into Phaser via `phaser_game/src/systems/anims.ts` → `BootScene` `anims.create` (animations actually play).

**RPG scaffold** (for RPG-Maker-class projects): `phaser_game/src/rpg/` — data-driven schema (items/stats/skills/enemies/balance), systems (`stats`/`inventory`/`combat`), UI kit (`HpMpBars`/`InventoryGrid`/`EquipmentPanel`/`ActionMenu`/`DamageNumber`/`Tooltip`), and `RpgDemoScene` (`?level=rpg_demo`). Reference: `.omc/plans/rpg-engine-foundation.md`. Full v2 design: `.omc/plans/murrkit-v2-rearchitecture.md`.

**Map Studio** (2026-07 flagship): *game with a MAP = write `phaser_game/maps/<id>.map.yaml`*, never hand-place tiles. `src/builders/mapSpec.ts` (schema + 16-tile role convention) + `buildMapFromYAML.ts` (pure `compileMap` → Tiled JSON; seeded PRNG; rect+Voronoi biome regions; auto edge/corner transitions — the EARLIER biome in `tilesets` draws the edge, later sits on top) + `TilemapScene` (`?level=<map id>`, WASD avatar on `spawn`, `walkable:false` collides, `__gameState` wired for `/drive`). Biomes with no `image:` render deterministic placeholder colours → a map is playtestable the second the YAML exists. Per-biome art: gen-queue rows `asset_type:"biome_tileset"`, `name=<biome>` (accept-gate) → `agents/asset_pipeline.generate_biome_tileset` (4×4 autotile prompt → optional edit-mode style anchor → slice → rembg decor row only) publishes to the STABLE path `/assets/tilesets/<project>/<biome>/sheet.png` (map.yaml can reference it before it exists; 404→placeholder). REST: `GET/PUT /api/maps/<id>`, `POST /api/maps/parse` (PUT validates like the compiler), `POST /api/maps/<id>/ai-paint` (DeepSeek paints the layer from an instruction; proposal only, panel applies). Frontend: `Map Studio` center tab (`components/map/MapStudioPanel.tsx` + `MapPainter.tsx`) — RPG-Maker-style per-cell painting (brush/rect/fill/eyedropper/eraser, undo/redo, zoom, procedural presets, AI paint) over a `paint:` block in map.yaml (`legend` char→biome — ALWAYS quote the keys — + `rows`, "." = procedural base wins; applied AFTER regions), plus raw YAML tab, live validation, per-biome generate buttons. When a `biome_tileset` task completes the backend AUTO-WIRES `image:` into every map declaring that biome (comment-preserving line surgery, validated before write; `extra.auto_wired_maps`). **True-iso**: `projection: isometric` in map.yaml renders the SAME logical grid as 2:1 diamonds (`tileSize` = diamond height, width 2×) — placeholders, manual avatar collision (arcade tile collision is ortho-only; TilemapScene samples the biome grid) and `/drive` asserts all work; biome sheets generate with diamond-cell geometry automatically (plan rows carry `extra.projection`, the Map Studio panel sends it from the map's field). Reference: `maps/iso_meadow.map.yaml` + `tests/map_iso.spec.ts`.

## Key paths

```
murrkit/
├── .env                       ← secrets (KITTY_APP_TOKEN, GEMINI_API_KEY, etc.)
├── backend/                   ← FastAPI :8001
│   ├── main.py
│   ├── routers/               ← chat, gen_queue, vision, sprite_gen, asset_gen, etc.
│   └── services/              ← gen_queue worker
├── core/                      ← config, llm clients, project_state
├── tools/                     ← gpt_image_2 (Kitty), gemini_client, deepseek_triage, rembg, etc.
├── agents/                    ← asset_pipeline, sprite_pipeline (Phaser-targeted)
├── frontend/                  ← Next.js dashboard UI :3001
├── phaser_game/               ← THE GAME — Phaser + TS + Vite
│   ├── src/
│   │   ├── main.ts            ← Phaser game entry
│   │   ├── scenes/            ← one TS file per level
│   │   ├── prefabs/           ← reusable game-object classes (Cat, Slingshot, etc.)
│   │   ├── builders/          ← YAML → Phaser scene compiler (+ map compiler)
│   │   └── utils/
│   ├── levels/                ← *.yaml level specs
│   ├── maps/                  ← *.map.yaml Map Studio specs (?level=<id>)
│   ├── public/                ← static assets (sprites, audio, fonts)
│   ├── tests/                 ← Playwright vision-regression specs
│   ├── vite.config.ts
│   └── package.json
├── public/                    ← shared static assets (AngryCat atlases imported here)
│   └── assets/angrycat/       ← 17 sprite atlases + 4 anim controllers + 11 anim clips
├── public_files/              ← runtime: chat_uploads, screenshots, references
├── logs/                      ← rotating .log + chat_history.db
├── .omc/
│   ├── references/AngryCat/   ← user reference images for vision compare-gate
│   ├── state/                 ← failure_log, vision_history, project state
│   └── templates/registry.json ← OSS game-template registry (Phaser examples)
└── pyproject.toml + uv.lock
```

## Quick Start

```bash
cd murrkit

# 1. Python deps
uv sync

# 2. Backend
uv run python -m uvicorn backend.main:app --port 8001

# 3. Frontend (separate terminal)
cd frontend && npm install && npm run dev

# 4. Phaser game (separate terminal)
cd phaser_game && npm install && npm run dev
# → http://localhost:5173

# 5. Headless playtest setup (one-time)
cd phaser_game && npx playwright install chromium
```

## Coding conventions

- Python 3.13, `from __future__ import annotations`, async-first
- ruff + mypy strict
- **No defensive try/except swallowing real errors** (swe-agent-rigor pattern)
- TypeScript strict mode in `phaser_game/`
- Each Phaser scene = one TypeScript file
- Each level = one YAML spec + deterministic Python/TS builder
- Smoke test before claiming "done"

## Architectural rules — what Claude MUST do for game-dev work

1. **Never write Phaser scene .ts directly. Write level YAML.** The `buildLevelFromYAML.ts` compiler generates the scene deterministically. This kills compounding regressions because every fix is a whole-scene rebuild from spec.

2. **Always trigger Playwright screenshot after a YAML change.** Backend exposes `POST /api/phaser/playtest {level_id, duration_s}` which runs headless Chromium, screenshots, returns absolute path + claude_next_step directive to Read the PNG.

3. **Vision compare-gate is HARD, not advisory.** After every visible change: `POST /api/vision/review {mode:"compare", frame_paths:[<latest>], reference_paths:["<.omc/references/AngryCat/angry_birds_ref.png>"]}` → block on verdict.pass==false.

4. **Composition validator runs in browser, not LLM head.** `POST /api/phaser/composition-check {assertions:[...]}` uses Playwright `page.evaluate` to read live scene-graph state. Assertions: `cat.parent === slingshot`, `slingshot.y + slingshot.height/2 === barrelTop.y`, etc. Deterministic, no VLM in loop.

5. **Reflective dialog after EVERY destructive change.** Emit (a) what changed, (b) what should look different, (c) do I see that now (must reference fresh screenshot).

## Autopilot mode

The user has explicitly said: **"claude ma mnie nigdy nie pytać"** — Claude
must NEVER ask "should I do X?" or "is it OK to Y?". Just do it.

Budget cap: $80 total (warning at $1 per single turn).

## Migration from the retired Unity-based predecessor — what was changed

- Dropped: `backend/routers/unity*`, `unity_files`, `unity_hub`, `game_build`, `services/unity_watcher.py`, `core/mcp_client_unity.py`, `tools/*.cs`, `tools/mcp_ivan_call.py`, frontend `unity/`, `UnityHubPanel`, `UnityIntegrationPanel`, `MCPStatusIndicator`.
- Rewritten: `chat.py` system prompt (Unity sections replaced with Phaser/Playwright equivalents).
- Added: `phaser_game/` with Phaser 3.85 + Vite + TS. `agents/phaser_builder.py` (YAML→Scene). `backend/routers/phaser.py` (playtest + composition-check endpoints).
- Mini-bug fixes applied: phantom socket handling in `start_backend.py` (#171), vision.py project tag (#185), default port back to 8001 (no zombies in fresh project).
