# murrkit Codex Contributor Instructions

This repo supports Codex CLI as an optional local game-building captain beside
the original Claude Code path.

## Agent Runtime

- Keep Claude Code as the upstream default unless `MURRKIT_AGENT_CLI=codex` is
  explicitly selected in setup or `.env`.
- Use `codex exec` only when the active runtime is Codex.
- Keep internal model keys `claude_sonnet` and `claude_opus` for compatibility:
  they map to Sonnet/Opus under Claude and Balanced/Heavy under Codex.
- Do not remove or weaken the Claude Code path.

## Project Guide

- `CLAUDE.md` is the canonical project guide for game-dev behavior. Preserve
  the GDD gate, imagination step, asset rules, playtest gates, and evidence
  requirements. When running under Codex, translate Claude-specific tool names
  to the real Codex file/shell/local-HTTP tool surface.
- Prefer small, verifiable changes in the Phaser runtime, backend routers, and generated project cartridges.
- After editing Phaser or frontend code, run the relevant type check or build before claiming completion.

## Runtime Boundaries

- Keep generated games and large assets out of git-tracked source.
- Do not commit `.env`, local auth state, provider keys, generated browser captures, `node_modules`, `.venv`, or AppleDouble `._*` files.
- If provider tokens such as Kitty, Gemini, DeepSeek, or ElevenLabs are missing, surface setup instructions instead of faking provider calls.
