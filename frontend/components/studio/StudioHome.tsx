"use client";

/**
 * StudioHome — the prompt-first landing surface.
 *
 * Two halves:
 *   1. A hero "New Game" console: a big prompt-box ("Describe the game you want
 *      to build…") + an optional project name + a Create-and-start action that
 *      scaffolds the project (`POST /api/projects/<name>`), selects it, stashes
 *      the prompt for the Build view to prefill into chat, and switches views.
 *   2. A searchable project gallery from `GET /api/projects`. Cards open into
 *      the Build view; rename / ZIP / delete are wired to existing endpoints
 *      (rename is best-effort — see `renameProject`).
 *
 * Power users get a quiet "Open full IDE" affordance. Branding stays neutral:
 * Phaser / TypeScript only — no upstream model-vendor names.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Code2,
  Loader2,
  RefreshCcw,
  Search,
  Sparkles,
  Wand2,
} from "lucide-react";
import { BACKEND, renameProject as apiRenameProject, setActiveProject as apiSetActiveProject } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { useSession } from "@/store/session";
import { useView } from "@/store/view";
import type { Project } from "@/lib/types";
import ProjectCard from "./ProjectCard";

/** localStorage key the Build view reads once to prefill the chat prompt. */
export const PENDING_PROMPT_KEY = "phaser2d.pendingPrompt";

const PROMPT_IDEAS = [
  "A cozy 2D platformer where a cat collects yarn balls across rooftops",
  "A top-down dungeon crawler with melee combat and pickups",
  "An endless runner with double-jump and increasing speed",
  "A turn-based RPG battle with HP/MP bars and a skill menu",
];

export default function StudioHome() {
  const setActiveProject = useSession((s) => s.setActiveProject);
  const activeProject = useSession((s) => s.activeProject);
  const openBuild = useView((s) => s.openBuild);
  const openIde = useView((s) => s.openIde);

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND}/api/projects`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list: Project[] = await res.json();
      // Hide the always-present "default" scratch project from the gallery so
      // Home reads as "your games", not internals — it stays reachable via IDE.
      setProjects(list.filter((p) => p.name !== "default"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openProject(projectName: string) {
    setActiveProject(projectName);
    openBuild();
  }

  /** Create a project from the hero box, then jump straight into Build. */
  async function createAndStart() {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      toast("error", "Type your game idea in the big box above first");
      focusPromptBox();
      return;
    }
    // Derive a project name from the explicit field, else from the prompt.
    const candidate = name.trim() || deriveNameFromPrompt(trimmedPrompt);
    const safe = sanitizeName(candidate);
    if (!safe) {
      toast("error", "Project name: start with a letter, then letters/digits/_/- only");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch(`${BACKEND}/api/projects/${safe}`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        toast("error", `Couldn't create project: ${err.detail ?? "unknown"}`);
        return;
      }
      // Stash the prompt; the Build view prefills it into ChatPanel on mount
      // via the `chat:prefill` event so the user can review before sending.
      try {
        window.localStorage.setItem(PENDING_PROMPT_KEY, trimmedPrompt);
      } catch {
        /* ignore quota */
      }
      toast("success", `Created "${safe}" — opening your studio`);
      setActiveProject(safe);
      setPrompt("");
      setName("");
      openBuild();
    } catch (e) {
      toast("error", `Network: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function deleteProject(projectName: string) {
    if (!confirm(`Delete "${projectName}" and ALL its generated assets? This cannot be undone.`)) {
      return;
    }
    try {
      const res = await fetch(`${BACKEND}/api/projects/${projectName}`, { method: "DELETE" });
      if (!res.ok) {
        toast("error", `Delete failed: HTTP ${res.status}`);
        return;
      }
      toast("success", `Deleted "${projectName}"`);
      // If we just deleted the project the session is pointed at, reset to
      // 'default' (and update the backend pointer) — otherwise the whole app
      // stays aimed at a project that no longer exists on disk.
      if (activeProject === projectName) {
        setActiveProject("default");
        await apiSetActiveProject("default").catch(() => { /* pointer is best-effort */ });
      }
      await load();
    } catch (e) {
      toast("error", `Network: ${(e as Error).message}`);
    }
  }

  async function renameProject(oldName: string) {
    const next = window.prompt(`Rename "${oldName}" to:`, oldName);
    if (next === null) return;
    const safe = sanitizeName(next);
    if (!safe || safe === oldName) {
      if (safe !== oldName) toast("error", "Invalid name — start with a letter, [A-Za-z0-9_-]");
      return;
    }
    // Optimistic: swap the name in-place so the card relabels instantly. Snapshot
    // the previous list so we can revert on failure.
    const prevProjects = projects;
    setProjects((list) => list.map((p) => (p.name === oldName ? { ...p, name: safe } : p)));
    try {
      const result = await apiRenameProject(oldName, safe);
      toast("success", `Renamed to "${result.new}"`);
      // If the renamed project was the active one, repoint the session +
      // backend context so chat/library keep targeting the right folder.
      if (activeProject === oldName) {
        setActiveProject(safe);
        await apiSetActiveProject(safe).catch(() => { /* pointer is best-effort */ });
      }
    } catch (e) {
      setProjects(prevProjects); // revert
      toast("error", `Rename failed: ${(e as Error).message}`);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
    // Most-recently-edited first. Projects without an mtime sort last, then by
    // name so the order stays stable.
    return [...matched].sort((a, b) => {
      const am = a.mtime ?? 0;
      const bm = b.mtime ?? 0;
      if (bm !== am) return bm - am;
      return a.name.localeCompare(b.name);
    });
  }, [projects, query]);

  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--bg)]">
      {/* Top bar — neutral branding + IDE escape hatch */}
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 sm:px-6 h-14 border-b border-line bg-bg-overlay backdrop-blur-md">
        <div className="flex items-center gap-2">
          <div
            className="h-8 w-8 rounded-lg flex items-center justify-center"
            style={{ background: "color-mix(in oklab, var(--accent) 22%, transparent)" }}
          >
            <span className="text-accent font-bold text-xs">2D</span>
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-text">murrkit Studio</div>
            <div className="text-[10px] text-text-subtle">Prompt to playable game</div>
          </div>
        </div>
        <button
          onClick={openIde}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-text-dim border border-line hover:text-text hover:border-line-strong transition-colors"
          title="Open the full VS-Code-style workspace"
        >
          <Code2 className="h-3.5 w-3.5" />
          Open full IDE
        </button>
      </header>

      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 pb-20">
        {/* ── Hero: New Game console ───────────────────────────────── */}
        <section className="pt-10 sm:pt-16 pb-10 reveal">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-accent/10 text-accent border border-accent/25">
              <Sparkles className="h-3 w-3" />
              New game
            </span>
          </div>
          <h1 className="text-center text-2xl sm:text-4xl font-bold tracking-tight text-text">
            Describe a game.{" "}
            <span className="text-accent">Watch it build itself.</span>
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-center text-sm text-text-dim leading-relaxed">
            Type what you want in plain language. The studio designs it, generates the
            sprites, writes the Phaser 3 + TypeScript code, and plays it back — live.
          </p>

          {/* Prompt console */}
          <div className="studio-console mt-7 rounded-2xl border border-line bg-bg-panel p-3 sm:p-4 shadow-elev">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!creating) void createAndStart();
                }
              }}
              rows={3}
              placeholder="Describe the game you want to build…  e.g. a 2D platformer where a cat dodges falling crates"
              className="w-full resize-none bg-transparent text-sm sm:text-base text-text placeholder-text-subtle outline-none px-2 py-1.5 leading-relaxed"
              autoFocus
            />

            <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2 border-t border-line pt-3">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <label htmlFor="new-project-name" className="sr-only">Project name (optional)</label>
                <input
                  id="new-project-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="project name (optional)"
                  className="flex-1 min-w-0 bg-bg-subtle border border-line rounded-lg px-3 py-2 text-xs text-text placeholder-text-subtle outline-none focus:border-accent/60"
                />
              </div>
              <button
                onClick={() => void createAndStart()}
                disabled={creating}
                aria-disabled={!prompt.trim()}
                className="group inline-flex items-center justify-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold bg-accent text-bg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed aria-disabled:opacity-60 transition-all shadow-[0_0_0_0_var(--accent)] hover:shadow-glow"
              >
                {creating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Creating…
                  </>
                ) : (
                  <>
                    <Wand2 className="h-4 w-4" /> Create &amp; build
                    <ArrowRight className="h-4 w-4 -ml-0.5 transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
              </button>
            </div>

            {/* Idea chips */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {PROMPT_IDEAS.map((idea) => (
                <button
                  key={idea}
                  onClick={() => setPrompt(idea)}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-line text-text-subtle hover:text-text hover:border-accent/40 hover:bg-accent/5 transition-colors"
                >
                  {idea.length > 46 ? `${idea.slice(0, 46)}…` : idea}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-text-subtle">
            Press <kbd className="kbd">Cmd</kbd>/<kbd className="kbd">Ctrl</kbd> + <kbd className="kbd">Enter</kbd> to create
          </p>
        </section>

        {/* ── Project gallery ──────────────────────────────────────── */}
        <section className="reveal" style={{ animationDelay: "80ms" }}>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-sm font-semibold text-text">Your games</h2>
            {projects.length > 0 && (
              <span className="text-[11px] text-text-subtle tabular-nums">{projects.length}</span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-subtle" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search games…"
                  className="w-40 sm:w-56 bg-bg-subtle border border-line rounded-lg pl-8 pr-3 py-1.5 text-xs text-text placeholder-text-subtle outline-none focus:border-accent/60"
                />
              </div>
              <button
                onClick={() => void load()}
                disabled={loading}
                className="h-8 w-8 flex items-center justify-center rounded-lg border border-line text-text-dim hover:text-text hover:border-line-strong transition-colors"
                title="Refresh"
              >
                <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {error && (
            <p className="mb-3 text-xs text-accent-warn">
              Couldn&apos;t reach the backend ({error}). Is it running on :8001+?
            </p>
          )}

          {loading && projects.length === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="skeleton h-[164px] rounded-xl" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <EmptyState onFocusPrompt={() => focusPromptBox()} />
          ) : filtered.length === 0 ? (
            <p className="text-xs text-text-dim py-8 text-center">
              No games match &ldquo;{query}&rdquo;.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map((p, i) => (
                <ProjectCard
                  key={p.name}
                  project={p}
                  index={i}
                  onOpen={openProject}
                  onRename={renameProject}
                  onDelete={deleteProject}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyState({ onFocusPrompt }: { onFocusPrompt: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-bg-panel/40 px-6 py-12 text-center">
      <div
        className="mx-auto mb-4 h-14 w-14 rounded-2xl flex items-center justify-center"
        style={{ background: "color-mix(in oklab, var(--accent) 14%, transparent)" }}
      >
        <Sparkles className="h-7 w-7 text-accent" />
      </div>
      <h3 className="text-sm font-semibold text-text">No games yet</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-xs text-text-dim leading-relaxed">
        Your studio is empty. Describe a game in the box above and the agent will
        scaffold the project, generate art, and write the code for you.
      </p>
      <button
        onClick={onFocusPrompt}
        className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-accent/15 text-accent border border-accent/40 hover:bg-accent/25 transition-colors"
      >
        <Wand2 className="h-3.5 w-3.5" /> Start your first game
      </button>
    </div>
  );
}

/** Scroll to + focus the hero prompt box (used from the empty state). */
function focusPromptBox() {
  const el = document.querySelector<HTMLTextAreaElement>(".studio-console textarea");
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();
  }
}

/** Turn a free-text prompt into a safe-ish project slug seed. */
function deriveNameFromPrompt(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 3);
  const base = words.join("-") || "game";
  return `${base}-${Math.random().toString(36).slice(2, 5)}`;
}

const STOPWORDS = new Set([
  "the", "and", "with", "that", "where", "you", "your", "want", "build", "make",
  "create", "game", "play", "are", "for", "from", "this", "into", "out",
]);

/** Backend rule: starts with a letter, then [A-Za-z0-9_-], max 64. */
function sanitizeName(raw: string): string {
  let s = raw.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
  // Ensure it starts with a letter.
  if (s && !/^[A-Za-z]/.test(s)) s = `g${s}`;
  s = s.slice(0, 64);
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s) ? s : "";
}
