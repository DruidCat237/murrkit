"use client";

/**
 * GamePreviewLite — the live game cockpit panel for the Build view.
 *
 * Reuses the embed contract of `components/phaser/PhaserGamePreview` (the IDE's
 * full preview): the Phaser game runs as its own Vite dev server (default
 * :5173) and we iframe `http://127.0.0.1:<port>/?level=<id>`. The backend can
 * spawn / stop / health-check it via `/api/phaser/dev-server/*`.
 *
 * PROJECT-AWARE: the games currently live in ONE shared `phaser_game/` (levels
 * like level_01, platformer, rpg_demo). "Projects" isolate assets/chat, not the
 * game runtime — so we must NOT auto-show one project's game (e.g. AngryCats'
 * level_01) when a different/new project is active. We remember the level a user
 * last previewed PER PROJECT; a project with none shows a "no game yet" state
 * instead of defaulting to someone else's level.
 */

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Gamepad2, Play, RefreshCw, Square } from "lucide-react";
import { BACKEND } from "@/lib/api";
import { useSession } from "@/store/session";

const PREVIEW_LEVEL_PREFIX = "phaser2d.previewLevel.";

function readStoredLevel(project: string): string {
  if (typeof window === "undefined" || !project) return "";
  try {
    return window.localStorage.getItem(PREVIEW_LEVEL_PREFIX + project) ?? "";
  } catch {
    return "";
  }
}

function writeStoredLevel(project: string, level: string): void {
  if (typeof window === "undefined" || !project) return;
  try {
    window.localStorage.setItem(PREVIEW_LEVEL_PREFIX + project, level);
  } catch {
    /* ignore quota */
  }
}

export default function GamePreviewLite() {
  const activeProject = useSession((s) => s.activeProject);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [phaserPort, setPhaserPort] = useState<number>(5173);
  const [running, setRunning] = useState<boolean>(false);
  const [healthy, setHealthy] = useState<boolean>(false);
  // "" = no game chosen for this project yet → show the empty state (NOT a
  // default level, so a new project never inherits AngryCats' level_01).
  const [level, setLevel] = useState<string>("");
  const [levels, setLevels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState<number>(0);

  // When the active project changes, load the level this project last previewed
  // (if any). New / never-previewed projects start with no level.
  useEffect(() => {
    setLevel(readStoredLevel(activeProject));
    setIframeKey((k) => k + 1);
  }, [activeProject]);

  // Poll dev-server status + Phaser health + the (shared) level list every 4s.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const [s, h, l] = await Promise.all([
          fetch(`${BACKEND}/api/phaser/dev-server/status`).then((r) => r.json()).catch(() => ({})),
          fetch(`${BACKEND}/api/phaser/health`).then((r) => r.json()).catch(() => ({})),
          fetch(`${BACKEND}/api/phaser/levels`).then((r) => r.json()).catch(() => ({})),
        ]);
        if (cancelled) return;
        setRunning(Boolean(s.running));
        if (s.port) setPhaserPort(s.port);
        setHealthy(Boolean(h.healthy));
        if (Array.isArray(l.levels)) {
          setLevels(l.levels.map((n: string) => n.replace(/\.yaml$/, "")));
        }
      } catch {
        /* keep last known state */
      }
    };
    probe();
    const id = setInterval(probe, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function selectLevel(next: string) {
    setLevel(next);
    writeStoredLevel(activeProject, next);
    setIframeKey((k) => k + 1);
  }

  const hasLevel = level !== "" && (levels.length === 0 || levels.includes(level));
  const phaserUrl = `http://127.0.0.1:${phaserPort}/?level=${encodeURIComponent(level)}`;

  async function startDev() {
    setBusy("starting");
    try {
      await fetch(`${BACKEND}/api/phaser/dev-server/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: 5173 }),
      });
    } finally {
      setBusy(null);
    }
  }

  async function stopDev() {
    setBusy("stopping");
    try {
      await fetch(`${BACKEND}/api/phaser/dev-server/stop`, { method: "POST" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg-panel">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-text">
          <Gamepad2 className="h-4 w-4 text-accent" />
          Live game
        </span>
        <span
          className={[
            "inline-block h-2 w-2 rounded-full transition-colors",
            healthy ? "bg-ok shadow-[0_0_8px_var(--ok)]" : "bg-text-subtle",
          ].join(" ")}
          title={healthy ? "Dev server healthy" : "Dev server offline"}
        />

        {levels.length > 0 && (
          <>
            <span className="mx-1 h-4 w-px bg-line" />
            <label className="sr-only" htmlFor="build-level">Level</label>
            <select
              id="build-level"
              value={level}
              onChange={(e) => selectLevel(e.target.value)}
              className="bg-bg-subtle border border-line rounded-md text-xs px-2 py-1 text-text outline-none focus:border-accent/60"
            >
              <option value="">(no game yet)</option>
              {levels.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {running ? (
            <button
              onClick={stopDev}
              disabled={busy !== null}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-dim hover:text-text hover:bg-bg-subtle transition-colors disabled:opacity-50"
              title="Stop Vite dev server"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
          ) : (
            <button
              onClick={startDev}
              disabled={busy !== null}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-accent/15 text-accent border border-accent/40 hover:bg-accent/25 transition-colors disabled:opacity-50"
              title="Start Vite dev server"
            >
              <Play className="h-3 w-3" /> Run
            </button>
          )}
          <button
            onClick={() => setIframeKey((k) => k + 1)}
            className="h-7 w-7 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-bg-subtle transition-colors"
            title="Reload preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {hasLevel && (
            <a
              href={phaserUrl}
              target="_blank"
              rel="noreferrer"
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-bg-subtle transition-colors"
              title="Open game in a new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* Canvas / empty states */}
      <div className="relative flex-1 min-h-0 bg-[var(--bg)]">
        {busy && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 text-[10px] uppercase tracking-wider text-accent-warn animate-pulse">
            {busy}…
          </div>
        )}
        {healthy && hasLevel ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={phaserUrl}
            className="absolute inset-0 h-full w-full border-0"
            allow="fullscreen; clipboard-read; clipboard-write; gamepad"
            title="Live Phaser game"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="max-w-sm space-y-4">
              <div
                className="mx-auto h-14 w-14 rounded-2xl flex items-center justify-center"
                style={{ background: "color-mix(in oklab, var(--accent) 14%, transparent)" }}
              >
                <Gamepad2 className="h-7 w-7 text-accent" />
              </div>
              {!healthy ? (
                <div className="space-y-1.5">
                  <h3 className="text-sm font-semibold text-text">Your game runs here</h3>
                  <p className="text-xs text-text-dim leading-relaxed">
                    Press <strong className="text-text">Run</strong> to launch the dev server, then send a
                    prompt to start building. The canvas hot-reloads on every change.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <h3 className="text-sm font-semibold text-text">
                    No game for <span className="text-accent">{activeProject}</span> yet
                  </h3>
                  <p className="text-xs text-text-dim leading-relaxed">
                    Describe the game you want in the chat — the agent builds it and it appears here.
                    {levels.length > 0 && " Or pick an existing level from the dropdown above to preview it."}
                  </p>
                </div>
              )}
              {!running && (
                <button
                  onClick={startDev}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-accent/15 text-accent border border-accent/40 hover:bg-accent/25 transition-colors disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" /> Run dev server
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
