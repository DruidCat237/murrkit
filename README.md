<div align="center">

# 🐱 murrkit

**An autonomous AI agent that designs, builds, playtests and polishes 2D browser games for you — in Phaser 3 + TypeScript.**

Describe a game in plain language. murrkit's captain *imagines* the full design, generates the sprite sheets, writes the scene code, runs a headless playtest, checks the result with a vision model, and iterates — until it actually plays.

[Live proof-of-concept: **Cat Volleyball** →](https://druidcat.com/cat-volleyball/) · MIT licensed

</div>

---

## What it is

murrkit is a **local web app** (Next.js dashboard + FastAPI backend) that drives a local agent "captain" to build Phaser games end-to-end. Claude Code is the original upstream path; Codex CLI can be selected during setup as an optional local-agent runtime.

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
| 1️⃣ | **Claude Code CLI or Codex CLI** | The "captain" — the agent that actually designs & writes the game. murrkit spawns it locally. | Claude subscription/API key, or Codex login with an active Codex subscription/plan |
| 2️⃣ | **[Kitty](https://druidcat.app/dashboard) API token** | Generates every sprite sheet / tileset / UI image. | Pay-as-you-go credits (cheap; ~$0.04–0.16 / image) |

> **That's the whole minimum: one local agent CLI + a Kitty token.** For Codex, murrkit can detect local login, but your Codex account still needs the active access/subscription required by the Codex CLI. Everything else (DeepSeek, Gemini, ElevenLabs) is optional and only sharpens vision-QA / audio.

You don't have to touch `.env` by hand — on first launch the app shows a **Setup screen** that walks you through both. (Manual `.env` is documented below too.)

Also needed on your machine (standard dev tooling):
- **Python 3.13** + [`uv`](https://docs.astral.sh/uv/)
- **Node.js 20 LTS** — Next.js 15 needs ≥ 18.18; **20 LTS is the recommended, known-good version**. (Windows heads-up: Node **22.19.0** has a libuv `readlink` regression that breaks `next build` — `npm run dev` is unaffected. See [Troubleshooting](#troubleshooting).)

---

## 1 · Install & configure a local agent (the captain)

murrkit can't think without it. One-time setup:

Claude Code, the original upstream route:

```bash
npm install -g @anthropic-ai/claude-code
claude        # sign in, then /exit
```

Codex CLI, optional:

```bash
# Verify the Codex CLI is available
codex --version

# Authenticate if needed
codex login
```

Pick one in the first-run Setup screen, or set it manually:

```bash
# .env
MURRKIT_AGENT_CLI=claude   # or: codex
```

murrkit auto-detects the selected binary and shows its status in **Settings → Local Agent**.

Codex mode uses the same captain prompt and gates as Claude Code. It keeps its
own per-project resume session (`codex:<project>`), attaches current chat
images plus persistent reference images/keyframes as native Codex `--image`
inputs, and injects the Playwright MCP config into each `codex exec` run without
mutating your global Codex config. If `CODEX_MODEL_FAST` or
`CODEX_MODEL_HEAVY` are blank, those UI routes fall back to your configured
Codex default model.

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
uv run python -m uvicorn backend.main:app --port 8001

# Terminal 2 — dashboard (Next.js)
cd frontend && npm run dev          # → http://localhost:3001

# Terminal 3 — game engine (Phaser + Vite)
cd phaser_game && npm run dev        # → http://localhost:5173
```

Then open **http://localhost:3001**.

- **First launch** → the **Setup screen** appears. Choose Claude Code or Codex CLI, confirm the selected CLI status, then add your Kitty token. Once the minimum is green, you're in.
- Type the game you want in **Chat**. The captain replies with a one-screen **design doc** ending in `Reply APPROVE to build`. Approve it once — then it generates art, writes scenes, playtests and iterates on its own.

> **Pro tip — double control.** Use the browser/playtest tooling with your selected captain, then ask it: *"launch murrkit in Chrome and show me the dashboard."* The same murrkit imagination, asset, and verification rules apply to both Claude Code and Codex.

---

## Configuration

Everything lives in `.env` (copied from `.env.example`, never committed). You can edit it directly or use **Settings** inside the app.

| Key | What | Required? | Where to get it |
|-----|------|-----------|-----------------|
| `KITTY_APP_TOKEN` | Image generation (sprite sheets, tilesets, UI) | ✅ **yes** | [druidcat.app/dashboard](https://druidcat.app/dashboard) |
| `MURRKIT_AGENT_CLI` | Local captain runtime: `claude` or `codex` | default `claude` | Setup screen |
| `CLAUDE_CLI_BIN` | Claude Code binary path/name | optional | default `claude` |
| `ANTHROPIC_API_KEY` | Bill the Claude captain via the Anthropic API instead of your subscription (needed when the pinned captain model isn't included in your plan) | optional | [platform.claude.com](https://platform.claude.com) |
| `MURRKIT_CLAUDE_EFFORT` | Captain reasoning effort (`low`/`medium`/`high`/`xhigh`/`max`) — token-burn control, esp. on Fable 5 | default `high` | Settings → Local Agent |
| `MURRKIT_THINKING_TOKENS` | Captain extended-thinking budget per turn | default `32000` | Settings |
| `CODEX_CLI_BIN` | Codex CLI binary path/name | optional | default `codex` |
| `CODEX_MODEL_FAST` | Codex model for the Balanced route | optional | blank = Codex default |
| `CODEX_MODEL_HEAVY` | Codex model for the Heavy route | optional | blank = Codex default |
| `CODEX_SANDBOX` | Codex exec sandbox | optional | default `workspace-write` |
| `CODEX_APPROVAL_POLICY` | Nested Codex approval policy | optional | default `never` |
| `DEEPSEEK_API_KEY` | Cheap code reasoning + log triage | optional | [platform.deepseek.com](https://platform.deepseek.com) |
| `GEMINI_API_KEY` | Vision QA / compare-to-reference gate | optional | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `ELEVENLABS_API_KEY` | Sound effects / music | optional | [elevenlabs.io](https://elevenlabs.io) |
| `BUDGET_LIMIT_USD` | Hard stop on cumulative spend | default `80` | — |

> The captain is a separately-installed/authenticated local CLI (step 1) — murrkit detects the selected runtime automatically. By default it runs on your Claude subscription login; set `ANTHROPIC_API_KEY` to switch the captain to Anthropic API billing (pay-as-you-go), which also covers models not included in your subscription plan.

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
| Captain | **Claude Code CLI or Codex CLI** (you provide) | — |
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

---

druidcat.com — open-source AI image & video generation in your browser (Krea 2, Wan, LTX, Z-Image, Qwen). Pay-per-use, no subscription, from a few cents per generation.
