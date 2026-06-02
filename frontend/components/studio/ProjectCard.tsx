"use client";

/**
 * ProjectCard — one game in the Studio Home gallery.
 *
 * Surfaces name + file count + a derived "kind" hint, and the lifecycle
 * actions that already exist in the backend: open (select + Build view),
 * download ZIP (`/api/library/<name>/zip`), delete (`DELETE /api/projects/<name>`).
 * Rename is wired to a `PUT /api/projects/<old>/<new>` endpoint that MAY NOT
 * EXIST yet — see `onRename` in StudioHome; the button degrades gracefully and
 * does not assume backend support.
 */

import { useState } from "react";
import { Download, Gamepad2, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { projectZipUrl } from "@/lib/api";
import type { Project } from "@/lib/types";

export default function ProjectCard({
  project,
  index,
  onOpen,
  onRename,
  onDelete,
}: {
  project: Project;
  index: number;
  onOpen: (name: string) => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const fileCount = project.asset_count ?? project.files.length;
  const edited = editedAgo(project.mtime);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(project.name)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(project.name);
        }
      }}
      className="studio-card group relative flex flex-col text-left rounded-xl border border-line bg-bg-panel overflow-hidden cursor-pointer reveal"
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      {/* Thumbnail band — a generated, deterministic gradient per project so
          the gallery feels alive even before a real screenshot exists. */}
      <div
        className="relative h-24 w-full overflow-hidden"
        style={{ background: gradientFor(project.name) }}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          <Gamepad2 className="h-8 w-8 text-white/85 drop-shadow" />
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-bg-panel/90 via-bg-panel/10 to-transparent" />
      </div>

      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text">{project.name}</div>
          <div className="mt-0.5 text-[11px] text-text-subtle">
            {fileCount} {fileCount === 1 ? "file" : "files"} · {kindHint(project)}
            {edited && <> · {edited}</>}
          </div>
        </div>

        {/* Overflow menu (rename / delete) */}
        <div className="relative shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="h-7 w-7 flex items-center justify-center rounded-md text-text-subtle opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-text hover:bg-bg-subtle transition-all"
            title="More actions"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && (
            <>
              {/* click-away */}
              <div
                className="fixed inset-0 z-10"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                }}
              />
              <div
                role="menu"
                className="absolute right-0 top-8 z-20 w-36 rounded-lg border border-line bg-bg-panel shadow-elev py-1"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onRename(project.name);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-dim hover:text-text hover:bg-bg-subtle"
                >
                  <Pencil className="h-3.5 w-3.5" /> Rename
                </button>
                <a
                  role="menuitem"
                  href={projectZipUrl(project.name)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setMenuOpen(false)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-dim hover:text-text hover:bg-bg-subtle"
                >
                  <Download className="h-3.5 w-3.5" /> Download ZIP
                </a>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(project.name);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-err/90 hover:text-err hover:bg-err/10"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** "edited 3h ago" from an epoch-SECONDS mtime. Empty string when unknown. */
function editedAgo(mtime?: number): string {
  if (!mtime || mtime <= 0) return "";
  const secs = Math.max(0, Date.now() / 1000 - mtime);
  if (secs < 60) return "edited just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `edited ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `edited ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `edited ${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `edited ${months}mo ago`;
  return `edited ${Math.floor(months / 12)}y ago`;
}

/** A deterministic two-stop gradient seeded from the project name. */
function gradientFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const h1 = hash % 360;
  const h2 = (h1 + 48) % 360;
  return `linear-gradient(135deg, hsl(${h1} 62% 24%), hsl(${h2} 58% 16%))`;
}

/** Cheap, file-name-based guess at the project's nature for the subtitle. */
function kindHint(p: Project): string {
  const f = p.files.map((x) => x.toLowerCase());
  if (f.some((x) => x.includes("rpg"))) return "RPG";
  if (f.some((x) => x.endsWith(".yaml") || x.includes("level"))) return "Level project";
  if (f.some((x) => x.includes("sprite") || x.endsWith(".png"))) return "With sprites";
  if (p.files.length === 0) return "Empty — start a prompt";
  return "Phaser 3";
}
