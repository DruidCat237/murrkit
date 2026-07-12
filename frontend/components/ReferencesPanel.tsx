"use client";

/**
 * ReferencesPanel — persistent per-project drop zone for user reference
 * materials. The selected local captain is automatically told these files exist
 * via chat-router system prompt injection so it can read images via vision
 * review, parse text docs, or use extracted video keyframes for
 * compare-to-reference checks.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  References · AngryCat · 12 files                        │
 *   │  Selected captain auto-aware via chat router prompt      │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  [Drag & drop files here, or click to browse]            │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  [thumbnail grid: images, videos with frame badge, docs] │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Storage: backend `.omc/references/<project>/`. Videos auto-extract
 * keyframes on upload for Gemini analysis.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { BACKEND } from "@/lib/api";
import type { ReferenceFile, ReferenceList } from "@/lib/types";

const CATEGORY_COLOR: Record<string, string> = {
  image: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  video: "text-violet-400 border-violet-500/40 bg-violet-500/10",
  document: "text-sky-400 border-sky-500/40 bg-sky-500/10",
  other: "text-text-dim border-line bg-bg-subtle",
};

export default function ReferencesPanel({
  projectName = "default",
}: {
  projectName?: string;
}) {
  const [list, setList] = useState<ReferenceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string[]>([]);
  // Batch progress ("3 of 10") — per-file spinners alone give no sense of
  // how much of a large drag-drop remains.
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReferenceFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Fetch list ---------------------------------------------------------
  const refresh = useCallback(async (attempt = 0) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `${BACKEND}/api/references/list?project=${encodeURIComponent(projectName)}`,
      );
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      setList(await r.json());
    } catch (e) {
      // On first mount the backend port may still be resolving (api.ts probes
      // a candidate list). A network error here is usually that race — wait and
      // retry a couple of times so the panel self-heals instead of stranding on
      // "Failed to fetch".
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, 1000));
        return refresh(attempt + 1);
      }
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---- Upload (drag-drop or click-browse) ---------------------------------
  const uploadOne = useCallback(
    async (file: File) => {
      setUploading((u) => [...u, file.name]);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch(
          `${BACKEND}/api/references/upload?project=${encodeURIComponent(projectName)}`,
          { method: "POST", body: fd },
        );
        if (!r.ok) {
          const t = await r.text();
          setError(`Upload "${file.name}" failed: ${t.slice(0, 140)}`);
        }
      } catch (e) {
        setError(
          `Upload "${file.name}" failed: ${
            e instanceof Error ? e.message : "network error"
          }`,
        );
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    },
    [projectName],
  );

  const uploadMany = useCallback(
    async (files: File[]) => {
      setError(null);
      setBatch({ done: 0, total: files.length });
      // Sequential, not parallel — backend writes one-by-one anyway
      // and serial uploads make the progress UI legible.
      for (const f of files) {
        await uploadOne(f);
        setBatch((b) => (b ? { ...b, done: b.done + 1 } : b));
      }
      setBatch(null);
      await refresh();
    },
    [refresh, uploadOne],
  );

  // ---- Drag-drop handlers --------------------------------------------------
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) uploadMany(files);
  };

  // ---- Open folder in OS file explorer ------------------------------------
  async function openFolderInOS() {
    try {
      const r = await fetch(
        `${BACKEND}/api/references/open-folder?project=${encodeURIComponent(
          projectName,
        )}`,
        { method: "POST" },
      );
      if (!r.ok) {
        const t = await r.text();
        setError(`Open folder failed: ${t.slice(0, 140)}`);
      }
    } catch (e) {
      setError(
        `Open folder failed: ${
          e instanceof Error ? e.message : "network error"
        }`,
      );
    }
  }

  // ---- Delete -------------------------------------------------------------
  async function remove(entry: ReferenceFile) {
    if (
      !confirm(
        `Delete "${entry.name}" from references? The selected captain will lose access to this file.`,
      )
    ) {
      return;
    }
    try {
      await fetch(
        `${BACKEND}/api/references/file?project=${encodeURIComponent(
          projectName,
        )}&name=${encodeURIComponent(entry.name)}`,
        { method: "DELETE" },
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  // ---- Render -------------------------------------------------------------
  const entries = list?.entries ?? [];
  const totalSize = entries.reduce((s, e) => s + e.size_bytes, 0);

  return (
    <div className="h-full w-full flex flex-col bg-bg text-text text-sm">
      {/* ---- HEADER ----------------------------------------------------- */}
      <div className="border-b border-line p-3 space-y-2">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-accent" />
          <span className="text-xs font-semibold uppercase tracking-wider">
            References
          </span>
          <span className="text-[10px] text-text-dim font-mono">
            project: {projectName}
          </span>
          <span className="text-[10px] text-text-subtle ml-auto">
            {entries.length} file{entries.length !== 1 ? "s" : ""}{" "}
            · {formatBytes(totalSize)}
          </span>
          <button
            onClick={openFolderInOS}
            className="opacity-60 hover:opacity-100 hover:text-accent transition-colors"
            title="Open references folder in OS file explorer"
            aria-label="Open in file explorer"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
          <button
            onClick={() => refresh()}
            className="opacity-60 hover:opacity-100"
            title="Refresh list"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="text-[10px] text-text-dim leading-relaxed">
          Drop reference materials here — gameplay clips, real-game screenshots,
          mood-board images, hand sketches, design docs. The selected captain is
          auto-aware via the chat system prompt and uses them as ground-truth
          for design decisions. Videos auto-extract keyframes for Gemini
          compare-to-reference review.
        </div>

        {list && (
          <div className="text-[10px] font-mono text-text-subtle truncate">
            <span className="text-text-dim">root:</span> {list.root}
          </div>
        )}

        {error && (
          <div className="text-[10px] text-err bg-err/10 border border-err/30 rounded px-2 py-1">
            ⚠ {error}
          </div>
        )}
      </div>

      {/* ---- DROP ZONE -------------------------------------------------- */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={[
          "mx-3 mt-3 p-4 border-2 border-dashed rounded-md cursor-pointer transition-colors text-center",
          dragOver
            ? "border-accent bg-accent/10 text-accent"
            : "border-line text-text-dim hover:border-accent/60 hover:bg-bg-subtle/50",
        ].join(" ")}
      >
        <Upload className="h-5 w-5 mx-auto mb-1" />
        <div className="text-xs">
          {dragOver
            ? "Drop to upload"
            : "Drag files here, or click to browse"}
        </div>
        <div className="text-[10px] text-text-subtle mt-0.5">
          Images · Videos (auto-keyframes) · Docs · Max 50 MB per file
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) uploadMany(files);
            // reset so re-picking the same file works
            if (e.target) e.target.value = "";
          }}
        />
      </div>

      {/* ---- ACTIVE UPLOADS -------------------------------------------- */}
      {uploading.length > 0 && (
        <div className="mx-3 mt-2 space-y-1">
          {batch && batch.total > 1 && (
            <div className="text-[10px] text-text-dim">
              Uploading {Math.min(batch.done + 1, batch.total)} of {batch.total}…
            </div>
          )}
          {uploading.map((name) => (
            <div
              key={name}
              className="flex items-center gap-2 text-[10px] text-text-dim font-mono"
            >
              <Loader2 className="h-3 w-3 animate-spin text-accent" />
              <span className="truncate">{name}</span>
            </div>
          ))}
        </div>
      )}

      {/* ---- GRID ------------------------------------------------------- */}
      <div className="flex-1 overflow-y-auto p-3">
        {entries.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {entries.map((e) => (
              <ReferenceCard
                key={e.name}
                entry={e}
                projectName={projectName}
                onOpen={() => setPreview(e)}
                onDelete={() => remove(e)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---- PREVIEW MODAL --------------------------------------------- */}
      {preview && (
        <PreviewModal
          entry={preview}
          projectName={projectName}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Card per reference file
// ============================================================================

function ReferenceCard({
  entry,
  projectName,
  onOpen,
  onDelete,
}: {
  entry: ReferenceFile;
  projectName: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const colorClass = CATEGORY_COLOR[entry.category] ?? CATEGORY_COLOR.other;
  const Icon =
    entry.category === "image"
      ? ImageIcon
      : entry.category === "video"
        ? Video
        : entry.category === "document"
          ? FileText
          : FolderOpen;

  return (
    <div
      className={`group relative border rounded overflow-hidden ${
        colorClass.split(" ")[1]
      } bg-bg-panel hover:shadow-lg transition-shadow`}
    >
      {/* Thumb area */}
      <button
        onClick={onOpen}
        className="block w-full aspect-square bg-bg-subtle relative overflow-hidden"
      >
        {entry.category === "image" ? (
          <img
            src={`${BACKEND}${entry.served_url}`}
            alt={entry.name}
            className="absolute inset-0 w-full h-full object-contain"
            loading="lazy"
          />
        ) : entry.category === "video" && entry.keyframe_paths && entry.keyframe_paths.length > 0 ? (
          // Use first extracted keyframe as thumb
          <img
            src={`${BACKEND}/api/references/keyframe-file?project=${encodeURIComponent(
              projectName,
            )}&video=${encodeURIComponent(entry.name)}&frame=frame_001.jpg`}
            alt={entry.name}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Icon className="h-8 w-8 opacity-50" />
          </div>
        )}
        {/* Video badge */}
        {entry.category === "video" && (
          <div className="absolute top-1 right-1 px-1 py-0.5 rounded bg-black/60 text-white text-[9px] font-mono flex items-center gap-0.5">
            <Film className="h-2.5 w-2.5" />
            {entry.keyframe_count ?? "..."}f
          </div>
        )}
      </button>

      {/* Footer */}
      <div className="px-1.5 py-1 text-[10px]">
        <div className="truncate font-mono" title={entry.name}>
          {entry.name}
        </div>
        <div className="flex items-center gap-1 text-text-subtle">
          <span className={`px-1 rounded ${colorClass} text-[9px]`}>
            {entry.category}
          </span>
          <span className="ml-auto font-mono">{formatBytes(entry.size_bytes)}</span>
        </div>
      </div>

      {/* Delete on hover */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-1 left-1 p-1 rounded bg-err/80 text-white opacity-0 group-hover:opacity-100 transition-opacity"
        title="Delete (selected captain loses access)"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

// ============================================================================
// Preview modal
// ============================================================================

function PreviewModal({
  entry,
  projectName,
  onClose,
}: {
  entry: ReferenceFile;
  projectName: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-line rounded-lg shadow-xl max-w-5xl max-h-[90vh] w-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line p-3 flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-accent" />
          <span className="text-xs font-mono truncate flex-1">{entry.name}</span>
          <span className="text-[10px] text-text-dim font-mono">
            {entry.mime_type} · {formatBytes(entry.size_bytes)}
          </span>
          <button
            onClick={onClose}
            className="opacity-60 hover:opacity-100"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3 flex items-center justify-center bg-bg-subtle">
          {entry.category === "image" ? (
            <img
              src={`${BACKEND}${entry.served_url}`}
              alt={entry.name}
              className="max-w-full max-h-full object-contain"
            />
          ) : entry.category === "video" ? (
            <video
              src={`${BACKEND}${entry.served_url}`}
              controls
              autoPlay
              className="max-w-full max-h-full"
            />
          ) : (
            <div className="text-center text-text-dim">
              <FileText className="h-12 w-12 mx-auto mb-2 opacity-60" />
              <div className="text-xs">Preview not available for this file type.</div>
              <a
                href={`${BACKEND}${entry.served_url}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline text-xs mt-2 inline-block"
              >
                Open in new tab
              </a>
            </div>
          )}
        </div>
        <div className="border-t border-line p-2 text-[10px] font-mono text-text-dim">
          <span className="text-text-subtle">Path for captain:</span> {entry.abs_path}
          {entry.category === "video" && entry.keyframe_count !== undefined && (
            <>
              <br />
              <span className="text-text-subtle">Keyframes:</span>{" "}
              {entry.keyframe_count} extracted ·{" "}
              <code className="bg-bg-panel px-1 rounded">
                {entry.abs_path}.keyframes/frame_NNN.jpg
              </code>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Empty state
// ============================================================================

function EmptyState() {
  return (
    <div className="text-center py-10 text-text-dim text-xs space-y-2">
      <FolderOpen className="h-8 w-8 mx-auto opacity-50" />
      <div>No reference materials yet for this project.</div>
      <div className="text-text-subtle text-[10px] leading-relaxed max-w-md mx-auto">
        Drop a real-game screenshot, a gameplay clip, a hand-drawn level sketch,
        or a design doc. The selected captain is auto-told these files exist and uses
        them via Gemini compare-to-reference reviews.
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// suppress unused imports
void Plus;
