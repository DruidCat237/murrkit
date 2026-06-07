"use client";

/**
 * ProjectsSidebar — murrkit project list.
 *
 * Lists every project scaffolded under `murrkit/projects/<name>/`.
 * Each project gets its own gen-queue history, chat session, references,
 * generated sprites, and (when authored) level YAMLs. No game-engine dependence.
 */

import { useState, useEffect, useCallback } from "react";
import { Folder, FolderOpen, Plus, RefreshCcw, Trash2, Sparkles, Download } from "lucide-react";
import { BACKEND, backendReady, projectZipUrl } from "@/lib/api";
import { toast } from "@/components/Toaster";
import { useLayout } from "@/store/layout";

interface PhaserProject {
  name: string;
  path: string;
  files: string[];
}

export default function ProjectsSidebar({
  activeProject,
  onSelect,
}: {
  activeProject?: string;
  onSelect?: (name: string) => void;
}) {
  const [projects, setProjects] = useState<PhaserProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const openCenterTab = useLayout((s) => s.openOrFocusCenterTab);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Wait for the port probe before reading BACKEND. Without this, the first
      // mount reads the *seed* URL (a possibly-stale env port) and one-shot
      // fails with "Failed to fetch" while the real backend is on :8001.
      await backendReady;
      const res = await fetch(`${BACKEND}/api/projects`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list: PhaserProject[] = await res.json();
      setProjects(list);
      // Stale-project cleanup: if activeProject (from localStorage of a
      // previous session) doesn't exist in the backend's
      // current list, reset to "default" so the title-bar pill doesn't
      // keep showing a ghost project name.
      if (activeProject && activeProject !== "default" && !list.some((p) => p.name === activeProject)) {
        onSelect?.("default");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeProject, onSelect]);

  useEffect(() => { void load(); }, [load]);

  function openProject(name: string) {
    onSelect?.(name);
    openCenterTab("chat");
  }

  async function createProject() {
    const name = sanitizeName(newName);
    if (!name) {
      toast("error", "Project name: letters, digits, _, - only (start with letter)");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`${BACKEND}/api/projects/${name}`, { method: "POST" });
      if (res.ok) {
        toast("success", `Project '${name}' created`);
        setNewName("");
        await load();
        onSelect?.(name);
        openCenterTab("chat");
      } else {
        const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        toast("error", `Failed: ${err.detail ?? "unknown"}`);
      }
    } catch (e) {
      toast("error", `Network: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function deleteProject(name: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete project '${name}' and ALL its generated assets? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${BACKEND}/api/projects/${name}`, { method: "DELETE" });
      if (res.ok) {
        toast("success", `Deleted '${name}'`);
        if (activeProject === name) onSelect?.("default");
        await load();
      } else {
        toast("error", `Failed: HTTP ${res.status}`);
      }
    } catch (err) {
      toast("error", `Network: ${(err as Error).message}`);
    }
  }

  return (
    <div className="p-3 space-y-4">
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
            Phaser projects
          </p>
          <button
            onClick={load}
            className="h-6 w-6 flex items-center justify-center rounded text-text-dim hover:text-text"
            title="Refresh"
            disabled={loading}
          >
            <RefreshCcw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Create new project */}
        <div className="flex items-center gap-1 mb-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createProject(); }}
            placeholder="New project name…"
            className="flex-1 bg-bg-subtle border border-line rounded px-2 py-1 text-xs text-text placeholder-text-subtle outline-none focus:border-accent"
            disabled={creating}
          />
          <button
            onClick={createProject}
            disabled={creating || !newName.trim()}
            className="h-7 w-7 flex items-center justify-center rounded border border-line bg-bg-subtle hover:border-accent hover:text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Create project"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {error && (
          <p className="text-[10px] text-amber-400 mb-2">⚠ {error}</p>
        )}

        {loading && projects.length === 0 ? (
          <p className="text-xs text-text-subtle italic">loading…</p>
        ) : projects.length === 0 ? (
          <div className="text-xs text-text-subtle space-y-2 p-3 border border-dashed border-line rounded">
            <p>No Phaser projects yet.</p>
            <p>Type a name above and press <kbd className="kbd">Enter</kbd> to create one.</p>
            <p className="text-text-dim">Each project gets its own gen-queue, chat history,
              references, and level YAMLs — fully isolated.</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {projects.map((p) => {
              const isActive = p.name === activeProject;
              const fileCount = p.files.length;
              return (
                <li key={p.name}>
                  {/* Use a div + onClick instead of <button> so we can nest
                      inner buttons (delete / download zip) without HTML
                      validation tripping on button-in-button. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openProject(p.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openProject(p.name);
                      }
                    }}
                    className={[
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left group cursor-pointer",
                      isActive
                        ? "bg-accent/15 border border-accent/40 text-text"
                        : "hover:bg-bg-subtle text-text-dim hover:text-text",
                    ].join(" ")}
                  >
                    {isActive ? <FolderOpen className="h-3.5 w-3.5 text-accent" /> : <Folder className="h-3.5 w-3.5" />}
                    <span className="flex-1 truncate font-medium">{p.name}</span>
                    <span className="text-[10px] text-text-subtle">{fileCount}f</span>
                    <a
                      href={projectZipUrl(p.name)}
                      onClick={(e) => e.stopPropagation()}
                      target="_blank"
                      rel="noreferrer"
                      className="opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded hover:text-accent"
                      title="Download project as ZIP"
                    >
                      <Download className="h-3 w-3" />
                    </a>
                    <button
                      onClick={(e) => deleteProject(p.name, e)}
                      className="opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded hover:text-red-400"
                      title="Delete project"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {p.path && (
                    <p className="text-[10px] text-text-subtle truncate pl-7 -mt-0.5" title={p.path}>
                      {p.path}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="pt-2 border-t border-line">
        <div className="flex items-center gap-2 text-[10px] text-text-subtle">
          <Sparkles className="h-3 w-3" />
          <span>Phaser 3 · TypeScript · Vite</span>
        </div>
        <p className="text-[10px] text-text-subtle mt-1 leading-relaxed">
          Selecting a project scopes the chat, gen-queue, and references panel to it.
          Open the <strong>Game</strong> tab in the center to preview the running Phaser scene.
        </p>
      </section>
    </div>
  );
}

function sanitizeName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Backend enforces: starts with letter, then [A-Za-z0-9_-]+, max 64.
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(trimmed)) return "";
  return trimmed;
}
