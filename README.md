<div align="center">

# 🐱 murrkit

**An autonomous AI agent that designs, builds, playtests and polishes 2D browser games for you — in Phaser 3 + TypeScript.**

Describe a game in plain language. murrkit's captain *imagines* the full design, generates the sprite sheets, writes the scene code, runs a headless playtest, checks the result with a vision model, and iterates — until it actually plays.

[Live proof-of-concept: **Cat Volleyball** →](https://druidcat.com/cat-volleyball/) · MIT licensed

</div>

---

## What it is

murrkit is a **local web app** (Next.js dashboard + FastAPI backend) that drives a **Claude Code** "captain" to build Phaser games end-to-end:

1. **Imagine** — a vague prompt ("make a Mario-style platformer") is expanded into a full technical design (controls, physics in world units, level beats, AI, win/lose), not just pretty art.
2. **Generate** — sprite sheets / tilesets / UI are produced through the **Kitty** image API (one token, no per-vendor setup).
3. **Write** — the captain writes TypeScript scenes / YAML levels into the Phaser engine; **Vite** hot-reloads in under a second.
4. **Playtest** — **Playwright** drives the game headlessly: timed keyboard/mouse input, per-frame state snapshots, responsiveness asserts.
5. **Vision-gate** — a vision model compares the result to your references and **blocks** "done" claims until it passes.
6. **Iterate** — the play→fix loop re-invokes the captain on failing verdicts until the test passes.

---

## 🚦 What you need — the bare minimum

murrkit is the *orchestrator*. It does **not** ship the AI brain or an image model — it plugs into two services you bring:

| | Service | Why it's required | Cost |
|---|---|---|---|
| 1️⃣ | **[Claude Code](https://claude.com/claude-code) CLI** | The "captain" — the agent that actually designs & writes the game. murrkit spawns it locally. | Anthropic subscription **or** API key |
| 2️⃣ | **[Kitty](https://druidcat.app/dashboard) API token** | Generates every sprite sheet / tileset / UI image. | Pay-as-you-go credits (cheap; ~$0.04–0.16 / image) |

> **That's the whole minimum: Claude Code + a Kitty token.** Everything else (DeepSeek, Gemini, ElevenLabs) is optional and only sharpens vision-QA / audio.

You don't have to touch `.env` by hand — on first launch the app shows a **Setup screen** that walks you through both. (Manual `.env` is documented below too.)

Also needed on your machine (standard dev tooling):
- **Python 3.13** + [`uv`](https://docs.astral.sh/uv/)
- **Node.js 20 LTS** — Next.js 15 needs ≥ 18.18; **20 LTS is the recommended, known-good version**. (Windows heads-up: Node **22.19.0** has a libuv `readlink` regression that breaks `next build` — `npm run dev` is unaffected. See [Troubleshooting](#troubleshooting).)

---

## 1 · Install & configure Claude Code (the captain)

murrkit can't think without it. One-time setup:

```bash
# Install the CLI (npm)
npm install -g @anthropic-ai/claude-code

# Authenticate — opens a browser; sign in with your Anthropic account.
# A Claude Pro/Max subscription works (no per-call billing), or paste an API key.
claude            # run once, follow the login prompt, then /exit
```

Verify it's on your PATH (murrkit calls the `claude` binary directly):

```bash
claude --version
```

murrkit auto-detects the binary and shows its status (Installed / Subscription vs API) in **Settings → Claude Code**. If `claude` isn't found, the Setup screen tells you.

> 💡 No Anthropic account? Claude Code requires one — there is no built-in fallback brain. It is the single non-negotiable dependency.

---

## 2 · Get your Kitty API token (image generation)

Kitty is a hosted proxy that turns prompts into game-ready sprite sheets — no Google Cloud / OpenAI setup, one token covers it.

1. Go to **[druidcat.app/dashboard](https://druidcat.app/dashboard)**.
2. **Sign in** (or create a free account) and top up a little credit.
3. Copy your **Kitty App token** (a `kitty_…` code).
4. Paste it into murrkit's **Setup screen** on first launch — or into `.env` as `KITTY_APP_TOKEN` (see [Configuration](#configuration)).

That's it — image generation works immediately, billed from your Kitty credits.

---

## 3 · Install murrkit

```bash
git clone https://github.com/<your-org>/murrkit.git
cd murrkit

# Python deps
uv sync

# Dashboard deps
cd frontend && npm install && cd ..

# Game-engine deps + headless browser (for playtests)
cd phaser_game && npm install && npx playwright install chromium && cd ..

# Secrets file (you can also fill this from the in-app Setup screen)
cp .env.example .env
```

---

## 4 · Run it (dev)

murrkit is three local servers. Open three terminals (or run `scripts/dev.ps1` / `scripts/dev.sh`):

```bash
# Terminal 1 — backend (FastAPI orchestrator)
uv run uvicorn backend.main:app --port 8001

# Terminal 2 — dashboard (Next.js)
cd frontend && npm run dev          # → http://localhost:3001

# Terminal 3 — game engine (Phaser + Vite)
cd phaser_game && npm run dev        # → http://localhost:5173
```

Then open **http://localhost:3001**.

- **First launch** → the **Setup screen** appears. Add your Claude Code status + Kitty token (and optional keys). Once the minimum is green, you're in.
- Type the game you want in **Chat**. The captain replies with a one-screen **design doc** ending in `Reply APPROVE to build`. Approve it once — then it generates art, writes scenes, playtests and iterates on its own.

> 💡 **Pro tip — double control with Chrome MCP.** If you run Claude Code with the **Chrome MCP** connector, you can just ask Claude: *"launch murrkit in Chrome and show me the dashboard."* Claude opens the real app in a browser, screenshots it, reads the console, and clicks around — so **you and Claude are both watching the same running app**. Great for catching visual bugs the headless playtest misses.

---

## Configuration

Everything lives in `.env` (copied from `.env.example`, never committed). You can edit it directly or use **Settings** inside the app.

| Key | What | Required? | Where to get it |
|-----|------|-----------|-----------------|
| `KITTY_APP_TOKEN` | Image generation (sprite sheets, tilesets, UI) | ✅ **yes** | [druidcat.app/dashboard](https://druidcat.app/dashboard) |
| `DEEPSEEK_API_KEY` | Cheap code reasoning + log triage | optional | [platform.deepseek.com](https://platform.deepseek.com) |
| `GEMINI_API_KEY` | Vision QA / compare-to-reference gate | optional | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `ELEVENLABS_API_KEY` | Sound effects / music | optional | [elevenlabs.io](https://elevenlabs.io) |
| `BUDGET_LIMIT_USD` | Hard stop on cumulative spend | default `80` | — |

> Claude Code is **not** an `.env` key — it's a separately-installed CLI (step 1). murrkit detects it automatically.

---

## Projects are external by design ("cartridge" model)

The engine stays **clean**: every game you generate lives under `projects/` — which is **git-ignored** — so `git pull` never touches your work and your private games never land in the repo. Point murrkit at any folder:

```bash
# .env
# MURRKIT_PROJECTS_DIR=/path/to/my-murrkit-games   # default: ./projects (git-ignored)
```

The engine ships with small example scenes (slingshot, RPG demo). The flagship demo, **Cat Volleyball**, is maintained separately and playable [here](https://druidcat.com/cat-volleyball/).

> The example levels reference sprite assets you generate yourself (kept out of the repo). Run a quick generation, or drop your own PNGs under `public/assets/<game>/`, and the examples render.

---

## Architecture

| Layer | Tech | Port |
|------|------|------|
| Dashboard (web UI) | Next.js 15 + Tailwind | `3001` |
| Backend / orchestrator | FastAPI + WebSocket (Python 3.13) | `8001` |
| Captain | **Claude Code CLI** (you provide) | — |
| Game runtime | **Phaser 3.85 + TypeScript + Vite** | `5173` |
| Headless playtest | **Playwright** | — |
| Vision QA · log triage | Gemini · DeepSeek (optional keys) | — |
| Sprite / image generation | **Kitty** image API | — |

---

## Troubleshooting

**`next build` fails on Windows with `EISDIR: illegal operation on a directory, readlink …`.**
A Node.js/libuv regression in **Node 22.19.0 on Windows**: `fs.readlink` returns `EISDIR` instead of `EINVAL` for regular files, and webpack (used by `next build`) treats that as fatal — so the build dies on the first source file it resolves. It is **not** a code issue: `npm run dev` (Turbopack) and `npm run type-check` (`tsc`) both work fine. Fix: use **Node 20 LTS** (`nvm install 20 && nvm use 20`), a Node 22.x patch without the regression, or build on Linux/CI where `readlink` behaves correctly.

---

## Contributing

PRs welcome. Run the checks before pushing:

```bash
uv run python -m compileall backend core tools agents
cd frontend && npm run type-check
cd phaser_game && npm run typecheck && npm run build
```

## License

[MIT](LICENSE) © druidcat
