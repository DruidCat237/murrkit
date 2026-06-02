"use client";

/**
 * AssetLibraryPanel — production-quality asset gallery.
 *
 * Features:
 *   - Filter pills (All / Characters / Tilesets / Backgrounds / UI / Particles / Other)
 *   - Full-text search on filename + prompt
 *   - Hover preview + animated sprite-sheet playback in thumbnails
 *     (when a frames.json sidecar is present, loops at the suggested fps)
 *   - Click → side detail panel (full prompt, generation date, cost, resolution,
 *     dimensions, source endpoint, re-import / re-generate buttons)
 *   - Compare view (select 2+ assets → side-by-side)
 *   - Drag-out to OS file explorer (dataTransfer with file URL)
 *   - Virtualized rendering above ~80 items (cheap windowing — no library)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  GitCompare,
  Download,
  Eraser,
  ExternalLink,
  Filter,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Package,
  RefreshCw,
  Search,
  Trash2,
  X,
  Info,
} from "lucide-react";
import {
  BACKEND,
  getLibrary,
  importLibraryAssetToUnity,
  openFileInEditor,
  projectZipUrl,
} from "@/lib/api";
import type { LibraryAsset, ProjectLibrary } from "@/lib/types";

// Internal generation artifacts that should NOT clutter the asset browser:
// JSON sidecars (`*_frames.json`, `project.json`), the pre-mask `_raw` and
// canonical `_seed` intermediates, `.original` bg-removal backups, and the
// text prompt/anchor sidecars (`*_style_anchor.txt`, any `.txt`/`.md`) — these
// have NO thumbnail and open as raw prompt text, which is confusing clutter.
// The final, user-facing assets (atlases, masked sprites, backgrounds, UI, FX)
// are what the grid shows — and each of those has a working thumbnail.
const _CLUTTER_RE = /(_idle_raw|_raw|_seed)\.(png|webp|jpe?g)$|\.original\.|frames\.json$|\.(txt|md)$/i;
function _isAssetClutter(a: LibraryAsset): boolean {
  return a.type === "metadata" || _CLUTTER_RE.test(a.name);
}

const TYPE_COLORS: Record<string, string> = {
  atlas: "bg-accent/10 border-accent/30 text-accent",
  sprite: "bg-blue-500/10 border-blue-500/30 text-blue-400",
  background: "bg-purple-500/10 border-purple-500/30 text-purple-400",
  tileset: "bg-accent-warn/10 border-accent-warn/30 text-accent-warn",
  ui_element: "bg-pink-500/10 border-pink-500/30 text-pink-400",
  particle_fx: "bg-cyan-500/10 border-cyan-500/30 text-cyan-400",
  metadata: "bg-bg-subtle border-line text-text-subtle",
  other: "bg-bg-subtle border-line text-text-dim",
};

// Map asset.type → friendly category label
const CATEGORY_LABEL: Record<string, string> = {
  all: "All",
  sprite: "Characters",
  atlas: "Atlases",
  tileset: "Tilesets",
  background: "Backgrounds",
  ui_element: "UI",
  particle_fx: "Particles",
  metadata: "Metadata",
  other: "Other",
};

interface FramesJson {
  fps?: number;
  frame_count?: number;
  frame_width?: number;
  frame_height?: number;
  animations?: Array<{ name: string; frames: number; fps?: number }>;
}

export default function AssetLibraryPanel({
  projectName,
}: {
  projectName: string;
}) {
  const [library, setLibrary] = useState<ProjectLibrary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<Record<string, string>>({});
  const [removingBg, setRemovingBg] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryAsset | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [framesByAsset, setFramesByAsset] = useState<Record<string, FramesJson>>({});
  const [lightbox, setLightbox] = useState<LibraryAsset | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const lib = await getLibrary(projectName);
      setLibrary(lib);
      // Try to load frames.json sidecars for animated previews
      const promises = lib.assets
        .filter((a) => a.name.toLowerCase().endsWith("frames.json"))
        .map(async (a) => {
          try {
            const r = await fetch(`${BACKEND}${a.served_url}`);
            if (r.ok) {
              const j = (await r.json()) as FramesJson;
              return [a.rel_path, j] as const;
            }
          } catch {
            return null;
          }
          return null;
        });
      const results = await Promise.all(promises);
      const fb: Record<string, FramesJson> = {};
      for (const r of results) {
        if (r) fb[r[0]] = r[1];
      }
      setFramesByAsset(fb);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName]);

  async function doImport(asset: LibraryAsset) {
    setImporting(asset.id);
    setImportStatus((p) => ({ ...p, [asset.id]: "importing..." }));
    try {
      await importLibraryAssetToUnity(projectName, asset.id);
      setImportStatus((p) => ({ ...p, [asset.id]: "imported ✓" }));
    } catch (e) {
      setImportStatus((p) => ({
        ...p,
        [asset.id]: `failed: ${e instanceof Error ? e.message : String(e)}`,
      }));
    } finally {
      setImporting(null);
    }
  }

  async function doTrash(asset: LibraryAsset) {
    if (
      !window.confirm(
        `Delete "${asset.name}"? It moves to the project trash and can be recovered from disk.`
      )
    )
      return;
    setTrashError(null);
    try {
      const resp = await fetch(
        `${BACKEND}/api/library/${encodeURIComponent(projectName)}/delete?asset_id=${encodeURIComponent(asset.id)}`,
        { method: "POST" }
      );
      if (!resp.ok) {
        const detail = await resp.text();
        throw new Error(`${resp.status} ${detail}`);
      }
      // Deselect if the trashed asset was selected
      if (selected?.id === asset.id) setSelected(null);
      await refresh();
    } catch (e) {
      setTrashError(e instanceof Error ? e.message : String(e));
    }
  }

  // Remove an asset's background via the same local BiRefNet/rembg stack the
  // chat uses. The stripped copy is saved next to the original as
  // `<name>-bg_removed.png` and shows up after the refresh.
  async function doRemoveBg(asset: LibraryAsset) {
    setRemovingBg(asset.id);
    setImportStatus((p) => ({ ...p, [asset.id]: "removing background…" }));
    try {
      const resp = await fetch(
        `${BACKEND}/api/library/${encodeURIComponent(projectName)}/remove-bg?asset_id=${encodeURIComponent(asset.id)}`,
        { method: "POST" }
      );
      if (!resp.ok) {
        const detail = await resp.text();
        throw new Error(`${resp.status} ${detail}`);
      }
      const res = await resp.json();
      setImportStatus((p) => ({ ...p, [asset.id]: `bg removed → ${res.output_name}` }));
      await refresh();
    } catch (e) {
      setImportStatus((p) => ({
        ...p,
        [asset.id]: `bg-removal failed: ${e instanceof Error ? e.message : String(e)}`,
      }));
    } finally {
      setRemovingBg(null);
    }
  }

  function toggleCompare(asset: LibraryAsset) {
    setCompareIds((prev) =>
      prev.includes(asset.id)
        ? prev.filter((x) => x !== asset.id)
        : [...prev, asset.id]
    );
  }

  // Build filtered + searched list
  const allTypes = useMemo(() => {
    if (!library) return ["all"];
    const types = new Set<string>(
      library.assets.filter((a) => !_isAssetClutter(a)).map((a) => a.type),
    );
    return ["all", ...Array.from(types).sort()];
  }, [library]);

  const filtered = useMemo(() => {
    if (!library) return [] as LibraryAsset[];
    const q = search.trim().toLowerCase();
    return library.assets.filter((a) => {
      // Hide internal generation artifacts (JSON sidecars, _raw/_seed
      // intermediates, .original backups) so the browser shows only the real,
      // final assets — every one of which has a working thumbnail.
      if (_isAssetClutter(a)) return false;
      if (filter !== "all" && a.type !== filter) return false;
      if (q) {
        return a.name.toLowerCase().includes(q);
      }
      return true;
    });
  }, [library, filter, search]);

  const compareAssets = useMemo(() => {
    if (!library) return [] as LibraryAsset[];
    return library.assets.filter((a) => compareIds.includes(a.id));
  }, [library, compareIds]);

  // Find sidecar frames.json next to an image
  function findSidecar(a: LibraryAsset): FramesJson | undefined {
    // Heuristic: <base>_frames.json or frames.json in same dir
    const base = a.rel_path.replace(/\.[^.]+$/, "");
    return (
      framesByAsset[`${base}_frames.json`] ||
      framesByAsset[`${a.rel_path.replace(/[^/]+$/, "")}frames.json`] ||
      undefined
    );
  }

  return (
    <div className="max-w-6xl mx-auto h-full min-h-0 flex flex-col space-y-4">
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <Package className="h-5 w-5 text-accent" />
        <h2 className="text-base font-semibold">Asset Library</h2>
        <span className="text-xs text-text-subtle ml-2">
          {projectName}
          {library &&
            ` · ${library.asset_count} assets · ${(library.total_bytes / 1024 / 1024).toFixed(2)} MB`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {compareIds.length >= 2 && (
            <button
              onClick={() => setCompareOpen(true)}
              className="btn border border-accent/40 bg-accent/10 text-accent text-xs flex items-center gap-1"
              title="Open compare view"
            >
              <GitCompare className="h-3 w-3" />
              Compare {compareIds.length}
            </button>
          )}
          {compareIds.length > 0 && (
            <button
              onClick={() => setCompareIds([])}
              className="btn border border-line text-xs flex items-center gap-1 text-text-dim"
              title="Clear selection"
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={refresh}
            className="btn border border-line text-xs flex items-center gap-1 disabled:opacity-50"
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </button>
          <button
            onClick={() => {
              if (library?.project_path) openFileInEditor(library.project_path);
            }}
            disabled={!library?.project_path}
            className="btn border border-line text-xs flex items-center gap-1 disabled:opacity-50"
            title="Open this project's asset folder in the file explorer"
          >
            <FolderOpen className="h-3 w-3" />
            Open folder
          </button>
          <a
            href={projectZipUrl(projectName)}
            download={`${projectName}.zip`}
            className="btn border border-line text-xs flex items-center gap-1"
          >
            <Download className="h-3 w-3" />
            Export ZIP
          </a>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="panel p-2 space-y-2">
        <div className="flex items-center gap-2">
          <Search className="h-3 w-3 text-text-dim ml-1" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search filename..."
            className="flex-1 bg-bg-subtle border border-line rounded px-2 py-1 text-xs focus:outline-none focus:border-accent/60"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="text-text-dim hover:text-accent-hot"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <Filter className="h-3 w-3 text-text-dim ml-1" />
          {allTypes.map((t) => {
            // Count only the decluttered (visible) assets so chip counts match
            // the grid — not the raw total that still includes hidden sidecars.
            const visible = library?.assets.filter((a) => !_isAssetClutter(a)) ?? [];
            const count = t === "all" ? visible.length : visible.filter((a) => a.type === t).length;
            return (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={[
                  "px-2 py-0.5 rounded text-[10px] border transition-colors",
                  filter === t
                    ? "bg-accent/15 border-accent/40 text-accent"
                    : "border-line text-text-dim hover:text-text",
                ].join(" ")}
              >
                {CATEGORY_LABEL[t] || t} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="panel p-3 text-sm text-err border-err/40 bg-err/5">
          {error}
        </div>
      )}
      {trashError && (
        <div className="panel p-3 text-sm text-err border-err/40 bg-err/5 flex items-center justify-between">
          <span>Trash failed: {trashError}</span>
          <button onClick={() => setTrashError(null)} className="ml-2 text-text-dim hover:text-accent-hot">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] grid-rows-1 gap-3 flex-1 min-h-0">
        {/* Grid */}
        {loading && !library ? (
          <AssetSkeletonGrid />
        ) : !library || filtered.length === 0 ? (
          <div className="panel p-8 text-center text-text-subtle text-sm">
            <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-40" />
            {search || filter !== "all" ? (
              <>
                <div className="font-medium text-text-dim mb-1">No assets match</div>
                <div className="text-xs">
                  Try a different keyword or{" "}
                  <button
                    className="underline hover:text-accent"
                    onClick={() => { setSearch(""); setFilter("all"); }}
                  >
                    clear filters
                  </button>
                  .
                </div>
              </>
            ) : (
              <>
                <div className="font-medium text-text-dim mb-1">No assets yet</div>
                <div className="text-xs">Describe a game above and hit Build — sprites appear here automatically.</div>
              </>
            )}
          </div>
        ) : (
          <VirtualGrid
            assets={filtered}
            findSidecar={findSidecar}
            importing={importing}
            importStatus={importStatus}
            selectedId={selected?.id ?? null}
            compareIds={compareIds}
            onImport={doImport}
            onSelect={setSelected}
            onCompare={toggleCompare}
            onPreview={setLightbox}
            onTrash={doTrash}
            onRemoveBg={doRemoveBg}
            removingBgId={removingBg}
          />
        )}

        {/* Detail panel */}
        {selected && (
          <DetailPanel
            asset={selected}
            sidecar={findSidecar(selected)}
            onClose={() => setSelected(null)}
            onImport={() => doImport(selected)}
            importing={importing === selected.id}
            importStatus={importStatus[selected.id]}
          />
        )}
      </div>

      {compareOpen && (
        <CompareModal
          assets={compareAssets}
          findSidecar={findSidecar}
          onClose={() => setCompareOpen(false)}
        />
      )}

      {lightbox && (
        <Lightbox
          asset={lightbox}
          projectName={projectName}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton — shown while library is null and fetching
// ---------------------------------------------------------------------------

function AssetSkeletonGrid() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="panel p-2 space-y-2">
          <div className="skeleton aspect-square rounded" />
          <div className="skeleton h-3 w-4/5 rounded" />
          <div className="skeleton h-2.5 w-2/5 rounded" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Virtualized-ish grid (manual windowing — no react-window dep)
// ---------------------------------------------------------------------------

function VirtualGrid({
  assets,
  findSidecar,
  importing,
  importStatus,
  selectedId,
  compareIds,
  onImport,
  onSelect,
  onCompare,
  onPreview,
  onTrash,
  onRemoveBg,
  removingBgId,
}: {
  assets: LibraryAsset[];
  findSidecar: (a: LibraryAsset) => FramesJson | undefined;
  importing: string | null;
  importStatus: Record<string, string>;
  selectedId: string | null;
  compareIds: string[];
  onImport: (a: LibraryAsset) => void;
  onSelect: (a: LibraryAsset) => void;
  onCompare: (a: LibraryAsset) => void;
  onPreview: (a: LibraryAsset) => void;
  onTrash: (a: LibraryAsset) => void;
  onRemoveBg: (a: LibraryAsset) => void;
  removingBgId: string | null;
}) {
  const [visibleCount, setVisibleCount] = useState(60);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Lazy-load more as the user scrolls
  useEffect(() => {
    setVisibleCount(60);
  }, [assets.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
        setVisibleCount((c) => Math.min(c + 60, assets.length));
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [assets.length]);

  const slice = assets.slice(0, visibleCount);

  return (
    <div
      ref={scrollRef}
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 h-full min-h-0 overflow-y-auto pr-1 content-start"
    >
      {slice.map((a) => (
        <AssetCard
          key={a.id}
          asset={a}
          sidecar={findSidecar(a)}
          importing={importing === a.id}
          status={importStatus[a.id]}
          selected={selectedId === a.id}
          comparing={compareIds.includes(a.id)}
          onImport={() => onImport(a)}
          onSelect={() => onSelect(a)}
          onCompare={() => onCompare(a)}
          onPreview={() => onPreview(a)}
          onTrash={() => onTrash(a)}
          onRemoveBg={() => onRemoveBg(a)}
          removingBg={removingBgId === a.id}
        />
      ))}
      {visibleCount < assets.length && (
        <div className="col-span-full text-center text-[10px] text-text-subtle py-2">
          showing {visibleCount}/{assets.length} — scroll for more
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual asset card with animated sprite-sheet playback
// ---------------------------------------------------------------------------

function AssetCard({
  asset,
  sidecar,
  importing,
  status,
  selected,
  comparing,
  onImport,
  onSelect,
  onCompare,
  onPreview,
  onTrash,
  onRemoveBg,
  removingBg,
}: {
  asset: LibraryAsset;
  sidecar?: FramesJson;
  importing: boolean;
  status?: string;
  selected: boolean;
  comparing: boolean;
  onImport: () => void;
  onSelect: () => void;
  onCompare: () => void;
  onPreview: () => void;
  onTrash: () => void;
  onRemoveBg: () => void;
  removingBg: boolean;
}) {
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(asset.name);
  const animated = sidecar && (sidecar.frame_count || 0) > 1;

  // For drag-out support — set dataTransfer URL on dragstart
  const url = `${BACKEND}${asset.served_url}`;

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("DownloadURL", `image/png:${asset.name}:${url}`);
    e.dataTransfer.setData("text/uri-list", url);
    e.dataTransfer.setData("text/plain", url);
  }

  return (
    <div
      onClick={onSelect}
      className={[
        "panel p-2 space-y-2 cursor-pointer relative group transition-colors",
        selected ? "ring-2 ring-accent/70 border-accent/60" : "",
        comparing ? "ring-1 ring-accent-warn/70" : "",
      ].join(" ")}
    >
      {comparing && (
        <span className="absolute top-1 left-1 z-10 text-[9px] bg-accent-warn text-bg px-1 rounded font-bold">
          CMP
        </span>
      )}
      <div
        draggable={isImage}
        onDragStart={handleDragStart}
        onClick={(e) => {
          if (!isImage) return;
          e.stopPropagation();
          onPreview();
        }}
        onDoubleClick={(e) => {
          // Double-click also opens preview — matches OS file-explorer muscle memory
          if (!isImage) return;
          e.stopPropagation();
          onPreview();
        }}
        title={isImage ? "Click to open full preview" : undefined}
        className="aspect-square bg-bg-subtle border border-line rounded overflow-hidden flex items-center justify-center relative group/thumb hover:border-accent/40 transition-colors"
      >
        {isImage ? (
          animated ? (
            <AnimatedThumbnail url={url} sidecar={sidecar} alt={asset.name} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={asset.name}
              className="max-w-full max-h-full object-contain pointer-events-none"
              style={{
                imageRendering:
                  asset.type === "sprite" || asset.type === "tileset" ? "pixelated" : "auto",
              }}
            />
          )
        ) : (
          <ImageIcon className="h-8 w-8 text-text-subtle opacity-50" />
        )}
        {animated && (
          <span className="absolute bottom-1 right-1 text-[8px] px-1 py-0.5 rounded bg-bg/80 text-accent border border-accent/30 font-mono">
            ▶ {sidecar?.frame_count ?? "?"}f
          </span>
        )}
        {isImage && (
          <span
            className="absolute top-1 right-1 opacity-0 group-hover/thumb:opacity-100 transition-opacity bg-bg/90 text-accent border border-accent/40 rounded p-1 pointer-events-none"
            aria-hidden
          >
            <Maximize2 className="h-3 w-3" />
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        <div className="text-xs font-medium truncate" title={asset.name}>
          {asset.name}
        </div>
        <div className="flex items-center justify-between text-[10px] text-text-subtle">
          <span
            className={[
              "px-1 py-0.5 rounded border text-[9px]",
              TYPE_COLORS[asset.type] || TYPE_COLORS.other,
            ].join(" ")}
          >
            {asset.type}
          </span>
          <span className="font-mono">{(asset.size_bytes / 1024).toFixed(0)} KB</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onImport();
          }}
          disabled={importing}
          className="w-full btn border border-line text-[10px] flex items-center justify-center gap-1 disabled:opacity-50"
          title="Import to engine"
        >
          {importing ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Download className="h-2.5 w-2.5" />
          )}
          Import
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCompare();
          }}
          className={[
            "btn border text-[10px] flex items-center justify-center px-1.5",
            comparing
              ? "border-accent-warn/50 bg-accent-warn/15 text-accent-warn"
              : "border-line text-text-dim hover:text-text",
          ].join(" ")}
          title="Toggle compare selection"
        >
          <GitCompare className="h-2.5 w-2.5" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="btn border border-line text-[10px] flex items-center justify-center px-2"
          title="Open in new tab"
        >
          ↗
        </a>
        {isImage && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemoveBg();
            }}
            disabled={removingBg}
            className="btn border border-line text-[10px] flex items-center justify-center px-1.5 text-text-dim hover:text-accent hover:border-accent/50 transition-colors disabled:opacity-50"
            title="Remove background — saves a transparent copy next to it as <name>-bg_removed.png"
          >
            {removingBg ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Eraser className="h-2.5 w-2.5" />
            )}
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onTrash();
          }}
          className="btn border border-line text-[10px] flex items-center justify-center px-1.5 text-text-dim hover:text-err hover:border-err/50 transition-colors"
          title="Move to trash (recoverable)"
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
      {status && (
        <div className="text-[9px] text-text-subtle truncate" title={status}>
          {status}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animated thumbnail — plays back a horizontal sprite strip at frames.json fps
// ---------------------------------------------------------------------------

function AnimatedThumbnail({
  url,
  sidecar,
  alt,
}: {
  url: string;
  sidecar?: FramesJson;
  alt: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const frameCount =
    sidecar?.frame_count ??
    sidecar?.animations?.[0]?.frames ??
    1;
  const fps =
    sidecar?.animations?.[0]?.fps ??
    sidecar?.fps ??
    8;

  useEffect(() => {
    const img = new Image();
    // No crossOrigin — we don't call getImageData on the canvas, so we don't
    // need taint-free pixels. Setting crossOrigin="anonymous" against a server
    // that returns Access-Control-Allow-Credentials:true breaks IMG load in
    // anonymous CORS mode (browser refuses the response), which surfaced as
    // 0×0 broken thumbnails for every atlas with a frames.json sidecar.
    img.src = url;
    img.onload = () => {
      imgRef.current = img;
    };
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let last = performance.now();
    const frameDuration = 1000 / Math.max(1, fps);

    const loop = (t: number) => {
      const img = imgRef.current;
      if (img) {
        const fw = (sidecar?.frame_width ?? img.width / frameCount) | 0;
        const fh = (sidecar?.frame_height ?? img.height) | 0;
        canvas.width = fw;
        canvas.height = fh;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, fw, fh);
        ctx.drawImage(img, frame * fw, 0, fw, fh, 0, 0, fw, fh);
        if (t - last >= frameDuration) {
          frame = (frame + 1) % Math.max(1, frameCount);
          last = t;
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [frameCount, fps, sidecar]);

  return (
    <canvas
      ref={canvasRef}
      aria-label={alt}
      className="max-w-full max-h-full object-contain pointer-events-none"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Detail panel (right side, slides in on selection)
// ---------------------------------------------------------------------------

function DetailPanel({
  asset,
  sidecar,
  onClose,
  onImport,
  importing,
  importStatus,
}: {
  asset: LibraryAsset;
  sidecar?: FramesJson;
  onClose: () => void;
  onImport: () => void;
  importing: boolean;
  importStatus?: string;
}) {
  const url = `${BACKEND}${asset.served_url}`;
  const date = new Date(asset.modified_at);
  return (
    <div className="panel w-72 shrink-0 p-3 space-y-3 sticky top-0 max-h-[calc(100vh-200px)] overflow-y-auto">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Info className="h-3 w-3 text-accent" />
          Details
        </h3>
        <button
          onClick={onClose}
          className="text-text-dim hover:text-accent-hot"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="bg-bg-subtle border border-line rounded overflow-hidden aspect-square flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={asset.name}
          className="max-w-full max-h-full object-contain"
          style={{
            imageRendering:
              asset.type === "sprite" || asset.type === "tileset" ? "pixelated" : "auto",
          }}
        />
      </div>
      <DetailRow label="Name" value={asset.name} mono />
      <DetailRow label="Type">
        <span
          className={[
            "px-1.5 py-0.5 rounded border text-[10px]",
            TYPE_COLORS[asset.type] || TYPE_COLORS.other,
          ].join(" ")}
        >
          {asset.type}
        </span>
      </DetailRow>
      <DetailRow label="Size" value={`${(asset.size_bytes / 1024).toFixed(1)} KB`} mono />
      <DetailRow label="Modified" value={date.toLocaleString()} />
      <DetailRow label="Path" value={asset.rel_path} mono tiny />
      {sidecar && (
        <>
          <DetailRow
            label="Frames"
            value={`${sidecar.frame_count ?? "?"} @ ${
              sidecar.fps ?? sidecar.animations?.[0]?.fps ?? 8
            } fps`}
          />
          {sidecar.frame_width && sidecar.frame_height && (
            <DetailRow
              label="Frame size"
              value={`${sidecar.frame_width}×${sidecar.frame_height}`}
              mono
            />
          )}
          {sidecar.animations && sidecar.animations.length > 0 && (
            <div className="text-[10px] space-y-0.5">
              <div className="uppercase tracking-wider text-text-dim">Animations</div>
              {sidecar.animations.map((a) => (
                <div key={a.name} className="font-mono">
                  · {a.name} ({a.frames}f{a.fps ? ` @${a.fps}fps` : ""})
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="space-y-1 pt-1 border-t border-line">
        <button
          onClick={onImport}
          disabled={importing}
          className="w-full btn border border-accent/40 bg-accent/10 text-accent text-xs flex items-center justify-center gap-1 disabled:opacity-50"
        >
          {importing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          Re-import to engine
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full btn border border-line text-text-dim text-xs text-center"
        >
          Open in new tab
        </a>
        {importStatus && (
          <div className="text-[10px] text-text-subtle">{importStatus}</div>
        )}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  children,
  mono = false,
  tiny = false,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
  mono?: boolean;
  tiny?: boolean;
}) {
  return (
    <div className="text-[10px]">
      <div className="uppercase tracking-wider text-text-dim">{label}</div>
      <div
        className={[
          mono ? "font-mono" : "",
          tiny ? "text-[9px] break-all" : "",
        ].join(" ")}
      >
        {children ?? value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compare modal
// ---------------------------------------------------------------------------

function CompareModal({
  assets,
  findSidecar,
  onClose,
}: {
  assets: LibraryAsset[];
  findSidecar: (a: LibraryAsset) => FramesJson | undefined;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm flex items-center justify-center p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel max-w-6xl w-full max-h-[90vh] overflow-y-auto p-4"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-accent" />
            Compare {assets.length} assets
          </h3>
          <button
            onClick={onClose}
            className="text-text-dim hover:text-accent-hot p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          className={[
            "grid gap-3",
            assets.length === 2
              ? "grid-cols-2"
              : assets.length === 3
              ? "grid-cols-3"
              : "grid-cols-2 lg:grid-cols-4",
          ].join(" ")}
        >
          {assets.map((a) => {
            const url = `${BACKEND}${a.served_url}`;
            const sc = findSidecar(a);
            return (
              <div key={a.id} className="panel p-2 space-y-2">
                <div className="aspect-square bg-bg-subtle border border-line rounded overflow-hidden flex items-center justify-center">
                  {sc && (sc.frame_count || 0) > 1 ? (
                    <AnimatedThumbnail url={url} sidecar={sc} alt={a.name} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={url}
                      alt={a.name}
                      className="max-w-full max-h-full object-contain"
                      style={{
                        imageRendering:
                          a.type === "sprite" || a.type === "tileset" ? "pixelated" : "auto",
                      }}
                    />
                  )}
                </div>
                <div className="text-[10px] truncate font-mono" title={a.name}>
                  {a.name}
                </div>
                <div className="text-[9px] text-text-subtle flex justify-between">
                  <span>{a.type}</span>
                  <span>{(a.size_bytes / 1024).toFixed(0)} KB</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lightbox — full-screen image preview, the "click thumbnail → open file"
// experience. Closes on Esc, click outside, or X button.
// ---------------------------------------------------------------------------

function Lightbox({
  asset,
  projectName,
  onClose,
}: {
  asset: LibraryAsset;
  projectName: string;
  onClose: () => void;
}) {
  const url = `${BACKEND}${asset.served_url}`;
  const [absPath, setAbsPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Esc closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Fetch the absolute path so the "Copy path" / "Open in Explorer" hint
  // can show the real filesystem location — useful when the user wants to
  // open it in Aseprite / Photoshop manually.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(
          `${BACKEND}/api/library/${encodeURIComponent(projectName)}/open-in-explorer?asset_id=${encodeURIComponent(asset.id)}`
        );
        if (r.ok) {
          const j = await r.json();
          if (!cancelled) setAbsPath(j.abs_path ?? null);
        }
      } catch {
        // Best-effort — falls back to URL only
      }
    }
    load();
    return () => { cancelled = true; };
  }, [asset.id, projectName]);

  async function copyPath() {
    if (!absPath) return;
    try {
      await navigator.clipboard.writeText(absPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — some browsers block clipboard outside of secure context
    }
  }

  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(asset.name);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-bg/95 backdrop-blur-sm flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${asset.name}`}
    >
      {/* Top bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-3 px-4 py-2 border-b border-line bg-bg/80"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate" title={asset.name}>
            {asset.name}
          </div>
          {absPath && (
            <div
              className="text-[10px] text-text-subtle font-mono truncate"
              title={absPath}
            >
              {absPath}
            </div>
          )}
        </div>
        <span className="text-[10px] text-text-subtle px-2 py-0.5 rounded border border-line">
          {asset.type}
        </span>
        <span className="text-[10px] text-text-subtle font-mono">
          {(asset.size_bytes / 1024).toFixed(1)} KB
        </span>
        {absPath && (
          <button
            onClick={copyPath}
            className="btn border border-line text-xs flex items-center gap-1"
            title="Copy filesystem path"
          >
            {copied ? "Copied ✓" : "Copy path"}
          </button>
        )}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="btn border border-line text-xs flex items-center gap-1"
          title="Open in a new browser tab"
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </a>
        <button
          onClick={onClose}
          className="text-text-dim hover:text-accent-hot p-1"
          aria-label="Close preview"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Image stage */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex-1 min-h-0 flex items-center justify-center p-6 overflow-auto"
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={asset.name}
            className="max-w-full max-h-full object-contain shadow-2xl"
            style={{
              imageRendering:
                asset.type === "sprite" ||
                asset.type === "tileset" ||
                asset.type === "atlas"
                  ? "pixelated"
                  : "auto",
              background:
                "repeating-conic-gradient(#222 0% 25%, #2a2a2a 0% 50%) 50%/24px 24px",
            }}
          />
        ) : (
          <div className="panel p-6 text-center text-text-subtle">
            <FolderOpen className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <div className="text-sm">{asset.name}</div>
            <div className="text-[10px] mt-2">
              Not a previewable image format. Use Open to view in browser.
            </div>
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="px-4 py-1.5 text-[10px] text-text-subtle border-t border-line bg-bg/80 text-center"
      >
        Press <kbd className="px-1 py-0.5 border border-line rounded font-mono">Esc</kbd>{" "}
        or click outside to close
      </div>
    </div>
  );
}
