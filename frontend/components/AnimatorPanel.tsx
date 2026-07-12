"use client";

/**
 * AnimatorPanel — the "animator that works". Pick a sliced sprite sheet (or any
 * atlas with a frames.json sidecar), build NAMED animations by clicking frames
 * into an ordered sequence, set FPS + loop, watch a LIVE requestAnimationFrame
 * playback, and save the animation config so it wires into the game.
 *
 * Flow:
 *   1. Choose a source — an atlas from the project library (auto-loads its
 *      frames.json sidecar if present) or paste/upload an atlas + set rows×cols.
 *   2. The frame palette shows every slice. Click a frame to append it to the
 *      current animation's sequence; drag in the sequence strip to reorder.
 *   3. Name the animation, set FPS + loop mode, watch it play live.
 *   4. Save → POST /api/animation/save (the canonical AnimationSpec sidecar the
 *      backend + Phaser anims loader consume). Frames carry pixel rects so the
 *      game can register them directly.
 *
 * No vendor/model branding is surfaced anywhere in this UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Film,
  FolderOpen,
  Grid3X3,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  BACKEND,
  getLibrary,
  saveAnimationSpec,
} from "@/lib/api";
import type {
  AnimFrame,
  AnimationSpec,
  LibraryAsset,
  LoopMode,
  ProjectLibrary,
} from "@/lib/types";
import { useToasts } from "./Toaster";
import { useSession } from "@/store/session";

const FPS_PRESETS = [6, 8, 12, 15, 24, 30];
const LOOP_MODES: LoopMode[] = ["loop", "once", "ping-pong", "reverse"];

/** A frame slice in the palette: pixel rect on the chosen atlas. */
interface PaletteFrame {
  index: number;
  rect: [number, number, number, number];
}

export default function AnimatorPanel() {
  const project = useSession((s) => s.activeProject);
  const toast = useToasts();

  // ---- source atlas ------------------------------------------------------
  const [atlasUrl, setAtlasUrl] = useState<string | null>(null);
  const [atlasName, setAtlasName] = useState<string>("");
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);

  // ---- animation being built --------------------------------------------
  const [animName, setAnimName] = useState("idle");
  const [fps, setFps] = useState(12);
  const [loopMode, setLoopMode] = useState<LoopMode>("loop");
  const [sequence, setSequence] = useState<number[]>([]); // palette indices, ordered
  const [playing, setPlaying] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Build the palette from the grid + image size.
  const palette: PaletteFrame[] = useMemo(() => {
    if (!imgSize) return [];
    const c = Math.max(1, cols);
    const r = Math.max(1, rows);
    const fw = Math.floor(imgSize.w / c);
    const fh = Math.floor(imgSize.h / r);
    const out: PaletteFrame[] = [];
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        out.push({ index: row * c + col, rect: [col * fw, row * fh, fw, fh] });
      }
    }
    return out;
  }, [imgSize, rows, cols]);

  // When a new atlas loads, default the sequence to "all frames in order" so
  // the user immediately sees a playing animation instead of a blank preview.
  const loadAtlas = useCallback((url: string, name: string, grid?: { rows: number; cols: number }) => {
    setAtlasUrl(url);
    setAtlasName(name);
    setImgSize(null);
    setSequence([]);
    if (grid) { setRows(grid.rows); setCols(grid.cols); }
  }, []);

  // Auto-seed the sequence once the palette is known and nothing is selected yet.
  useEffect(() => {
    if (palette.length > 0 && sequence.length === 0) {
      setSequence(palette.map((p) => p.index));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette.length]);

  function appendFrame(index: number) {
    setSequence((s) => [...s, index]);
  }
  function clearSequence() { setSequence([]); }

  // Convert the ordered palette indices into AnimFrame[] for save/preview.
  const frames: AnimFrame[] = useMemo(() => {
    const byIndex = new Map(palette.map((p) => [p.index, p] as const));
    const durMs = Math.round(1000 / Math.max(1, fps));
    return sequence
      .map((i) => byIndex.get(i))
      .filter((p): p is PaletteFrame => !!p)
      .map((p) => ({ rect: p.rect, duration_ms: durMs, tag: animName || undefined }));
  }, [sequence, palette, fps, animName]);

  async function save() {
    if (!atlasUrl) {
      toast.warn("Load a sprite sheet first");
      return;
    }
    if (frames.length === 0) {
      toast.warn("Add at least one frame to the animation");
      return;
    }
    const name = animName.trim() || "anim";
    const spec: AnimationSpec = {
      name,
      // Store a backend-relative path when we can so the sidecar is portable.
      atlas: atlasRelPath(atlasUrl),
      fps,
      loop_mode: loopMode,
      frames,
    };
    setSaving(true);
    setSaveError(null);
    try {
      await saveAnimationSpec(project, name, spec);
      toast.success(`Saved "${name}" — ${frames.length}f @ ${fps} FPS`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      // Inline + selectable next to the Save button; the toast alone
      // disappears before the user can read a long backend detail.
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line shrink-0 flex-wrap">
        <Film className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Animator</h2>
        <span className="text-[10px] text-text-subtle ml-2">
          Pick a sheet · click frames to build a sequence · live preview · save
        </span>
        <span className="text-[10px] text-text-dim font-mono ml-auto">project: {project}</span>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* ---- left: source + palette ------------------------------------ */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-line">
          <SourcePicker project={project} onPick={loadAtlas} />

          {atlasUrl ? (
            <FramePalette
              atlasUrl={atlasUrl}
              atlasName={atlasName}
              rows={rows}
              cols={cols}
              onRows={setRows}
              onCols={setCols}
              palette={palette}
              onSize={setImgSize}
              onPick={appendFrame}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-text-subtle text-sm p-6 text-center">
              <div>
                <Grid3X3 className="h-10 w-10 mx-auto mb-2 opacity-40" />
                <div>Pick a sprite sheet above to start.</div>
                <div className="text-xs text-text-dim mt-1">
                  Slice one first in the Spritesheet Import tab.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ---- right: animation builder + preview ------------------------ */}
        <aside className="w-80 shrink-0 flex flex-col bg-bg-panel overflow-y-auto">
          {/* preview */}
          <div className="p-4 border-b border-line">
            <div className="text-[10px] uppercase tracking-wider text-text-dim mb-2">
              Live preview
            </div>
            <LivePreview
              atlasUrl={atlasUrl}
              frames={frames}
              fps={fps}
              loopMode={loopMode}
              playing={playing}
            />
            <div className="flex items-center gap-1 mt-2">
              <button
                onClick={() => setPlaying((v) => !v)}
                className="btn btn-ghost p-1.5"
                title={playing ? "Pause" : "Play"}
              >
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => setPlaying(false)}
                className="btn btn-ghost p-1.5"
                title="Stop"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] text-text-subtle ml-auto font-mono">
                {frames.length}f · {Math.round(1000 / Math.max(1, fps))}ms/f
              </span>
            </div>
          </div>

          {/* settings */}
          <div className="p-4 space-y-3 border-b border-line">
            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-text-dim">Animation name</span>
              <input
                value={animName}
                onChange={(e) => setAnimName(e.target.value)}
                placeholder="idle / walk / attack"
                className="w-full bg-bg-subtle border border-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
              />
            </label>

            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-text-dim">FPS</span>
                <span className="text-sm font-bold font-mono text-accent">{fps}</span>
              </div>
              <input
                type="range"
                min={1}
                max={60}
                value={fps}
                onChange={(e) => setFps(parseInt(e.target.value, 10))}
                className="w-full accent-accent cursor-pointer"
                aria-label="Playback FPS"
              />
              <div className="flex items-center gap-1 mt-1">
                {FPS_PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setFps(p)}
                    className={[
                      "text-[10px] px-1.5 py-0.5 rounded-full border font-mono transition-colors",
                      fps === p
                        ? "bg-accent text-bg border-accent"
                        : "border-line text-text-dim hover:text-text hover:border-accent/40",
                    ].join(" ")}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-text-dim">Loop mode</span>
              <select
                value={loopMode}
                onChange={(e) => setLoopMode(e.target.value as LoopMode)}
                className="w-full bg-bg-subtle border border-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
              >
                {LOOP_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>

          {/* sequence editor */}
          <div className="p-4 space-y-2 flex-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-dim">
                Sequence ({sequence.length})
              </span>
              <button
                onClick={clearSequence}
                className="text-[10px] text-text-dim hover:text-accent-hot flex items-center gap-1"
                title="Clear sequence"
              >
                <Trash2 className="h-3 w-3" /> clear
              </button>
            </div>
            <SequenceStrip
              atlasUrl={atlasUrl}
              palette={palette}
              sequence={sequence}
              onReorder={setSequence}
              onRemove={(pos) => setSequence((s) => s.filter((_, i) => i !== pos))}
            />
            <p className="text-[10px] text-text-subtle leading-relaxed">
              Click frames in the palette to append. Drag chips to reorder, click
              the × to remove. The preview plays the sequence live.
            </p>
          </div>

          {/* save */}
          <div className="p-4 border-t border-line">
            <button
              onClick={save}
              disabled={saving || !atlasUrl || frames.length === 0}
              className="btn btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save animation @ {fps} FPS
            </button>
            {saveError && (
              <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-300 select-text">
                Save failed: {saveError}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Strip the backend origin so the saved atlas path is portable across hosts. */
function atlasRelPath(url: string): string {
  if (url.startsWith(BACKEND)) return url.slice(BACKEND.length);
  return url;
}

// ---------------------------------------------------------------------------
// Source picker — choose an atlas from the project library.
// ---------------------------------------------------------------------------

/** A sliceable sheet from the project library + its optional frames.json sidecar. */
interface SheetOption {
  asset: LibraryAsset;
  /** Sibling `*_frames.json` in the same folder, when present. */
  sidecar: LibraryAsset | null;
}

/** Strip a trailing `_atlas` / `_sheet` suffix so an image pairs with its sidecar. */
function sheetStem(name: string): string {
  return name
    .replace(/\.(png|webp)$/i, "")
    .replace(/_(atlas|sheet|spritesheet)$/i, "");
}

/** Directory portion of a backend rel_path, e.g. "projects/X/sprites/foo/". */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i >= 0 ? relPath.slice(0, i + 1) : "";
}

/**
 * Pair each image atlas/sprite with the `*_frames.json` sidecar that lives in
 * the SAME folder and shares its stem (the library lists json entries too).
 */
function buildSheetOptions(assets: LibraryAsset[]): SheetOption[] {
  const jsons = assets.filter((a) => /_frames\.json$/i.test(a.name));
  const images = assets.filter(
    (a) =>
      /\.(png|webp)$/i.test(a.name) &&
      (a.type === "atlas" || a.type === "sprite" || a.type === "tileset"),
  );

  const options = images.map<SheetOption>((asset) => {
    const dir = dirOf(asset.rel_path);
    const stem = sheetStem(asset.name);
    const sidecar =
      jsons.find(
        (j) =>
          dirOf(j.rel_path) === dir &&
          j.name.toLowerCase().startsWith(stem.toLowerCase()),
      ) ?? null;
    return { asset, sidecar };
  });

  // Surface sheets that have a real frames.json sidecar first — those slice for
  // free; the rest still work once the user sets rows×cols.
  options.sort((a, b) => {
    if (!!a.sidecar !== !!b.sidecar) return a.sidecar ? -1 : 1;
    return a.asset.name.localeCompare(b.asset.name);
  });
  return options;
}

/**
 * Read rows×cols from a frames.json sidecar. Supports the grid schema written by
 * the spritesheet importer (`{ grid: { rows, cols } }`); returns null for atlas-
 * style sidecars without a grid so the user can set rows×cols manually.
 */
async function readSidecarGrid(url: string): Promise<{ rows: number; cols: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (data && typeof data === "object" && "grid" in data) {
      const grid = (data as { grid?: { rows?: unknown; cols?: unknown } }).grid;
      const rows = Number(grid?.rows);
      const cols = Number(grid?.cols);
      if (Number.isFinite(rows) && Number.isFinite(cols) && rows >= 1 && cols >= 1) {
        return { rows, cols };
      }
    }
  } catch {
    /* unreadable sidecar — fall back to manual rows×cols */
  }
  return null;
}

function SourcePicker({
  project,
  onPick,
}: {
  project: string;
  onPick: (url: string, name: string, grid?: { rows: number; cols: number }) => void;
}) {
  const [library, setLibrary] = useState<ProjectLibrary | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setLibrary(await getLibrary(project));
    } catch {
      setLibrary(null);
    } finally {
      setLoading(false);
    }
  }, [project]);

  // Refresh whenever the active project changes (refresh closes over `project`).
  useEffect(() => { refresh(); }, [refresh]);

  const sheets = buildSheetOptions(library?.assets ?? []);

  async function handlePick(assetId: string) {
    const opt = sheets.find((s) => s.asset.id === assetId);
    if (!opt) return;
    const grid = opt.sidecar
      ? (await readSidecarGrid(`${BACKEND}${opt.sidecar.served_url}`)) ?? undefined
      : undefined;
    onPick(`${BACKEND}${opt.asset.served_url}`, opt.asset.name, grid);
  }

  return (
    <div className="px-4 py-2 border-b border-line shrink-0 flex items-center gap-2 flex-wrap">
      <FolderOpen className="h-3.5 w-3.5 text-text-dim" />
      <span className="text-[10px] uppercase tracking-wider text-text-dim">Source sheet</span>
      <select
        value=""
        onChange={(e) => { void handlePick(e.target.value); }}
        className="bg-bg-subtle border border-line rounded px-2 py-1 text-xs max-w-xs flex-1 focus:outline-none focus:border-accent"
      >
        <option value="" disabled>
          {sheets.length ? "Select an atlas / sprite…" : "No sprite sheets in library yet"}
        </option>
        {sheets.map(({ asset, sidecar }) => (
          <option key={asset.id} value={asset.id}>
            {asset.name}{sidecar ? "  ·  sliced" : ""}
          </option>
        ))}
      </select>
      <button
        onClick={refresh}
        className="btn btn-ghost p-1.5"
        title="Refresh library"
        disabled={loading}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Frame palette — the sliced sheet with a grid + clickable cells.
// ---------------------------------------------------------------------------

function FramePalette({
  atlasUrl,
  atlasName,
  rows,
  cols,
  onRows,
  onCols,
  palette,
  onSize,
  onPick,
}: {
  atlasUrl: string;
  atlasName: string;
  rows: number;
  cols: number;
  onRows: (n: number) => void;
  onCols: (n: number) => void;
  palette: PaletteFrame[];
  onSize: (s: { w: number; h: number }) => void;
  onPick: (index: number) => void;
}) {
  const onSizeRef = useRef(onSize);
  useEffect(() => { onSizeRef.current = onSize; }, [onSize]);

  const [loaded, setLoaded] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      onSizeRef.current({ w: img.naturalWidth, h: img.naturalHeight });
      setLoaded(img);
    };
    img.src = atlasUrl;
    return () => setLoaded(null);
  }, [atlasUrl]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2 flex items-center gap-3 border-b border-line shrink-0 flex-wrap">
        <span className="text-[10px] text-text-subtle font-mono truncate max-w-[12rem]" title={atlasName}>
          {atlasName}
        </span>
        <label className="flex items-center gap-1 text-[10px] text-text-dim">
          rows
          <input
            type="number" min={1} max={32} value={rows}
            onChange={(e) => onRows(Math.max(1, Math.min(32, parseInt(e.target.value, 10) || 1)))}
            className="w-14 bg-bg-subtle border border-line rounded px-1.5 py-1 text-xs"
          />
        </label>
        <label className="flex items-center gap-1 text-[10px] text-text-dim">
          cols
          <input
            type="number" min={1} max={32} value={cols}
            onChange={(e) => onCols(Math.max(1, Math.min(32, parseInt(e.target.value, 10) || 1)))}
            className="w-14 bg-bg-subtle border border-line rounded px-1.5 py-1 text-xs"
          />
        </label>
        <span className="text-[10px] text-text-subtle ml-auto">{palette.length} frames · click to add</span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        <div
          className="grid gap-1 mx-auto"
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`,
            maxWidth: Math.max(1, cols) * 96,
          }}
        >
          {palette.map((p) => (
            <button
              key={p.index}
              onClick={() => onPick(p.index)}
              title={`Frame #${p.index} — click to append`}
              className="relative aspect-square bg-bg-subtle border border-line rounded overflow-hidden hover:border-accent/70 transition-colors group"
              style={{
                background:
                  "repeating-conic-gradient(#222 0% 25%, #2a2a2a 0% 50%) 50%/10px 10px",
              }}
            >
              {loaded && <FrameThumb img={loaded} rect={p.rect} />}
              <span className="absolute top-0.5 left-0.5 text-[8px] font-mono px-1 rounded bg-bg/70 text-text-subtle">
                {p.index}
              </span>
              <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-accent/15 transition-opacity">
                <Plus className="h-4 w-4 text-accent" />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Canvas thumbnail of a single rect cut from a preloaded atlas image. */
function FrameThumb({ img, rect }: { img: HTMLImageElement; rect: [number, number, number, number] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const [sx, sy, sw, sh] = rect;
    const size = 72;
    canvas.width = size;
    canvas.height = size;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    if (sw <= 0 || sh <= 0) return;
    const scale = Math.min(size / sw, size / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(img, sx, sy, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);
  }, [img, rect]);
  return (
    <canvas
      ref={ref}
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Sequence strip — ordered chips, drag to reorder.
// ---------------------------------------------------------------------------

function SequenceStrip({
  atlasUrl,
  palette,
  sequence,
  onReorder,
  onRemove,
}: {
  atlasUrl: string | null;
  palette: PaletteFrame[];
  sequence: number[];
  onReorder: (s: number[]) => void;
  onRemove: (pos: number) => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [dragPos, setDragPos] = useState<number | null>(null);

  useEffect(() => {
    if (!atlasUrl) { setImg(null); return; }
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = atlasUrl;
    return () => setImg(null);
  }, [atlasUrl]);

  const byIndex = useMemo(() => new Map(palette.map((p) => [p.index, p] as const)), [palette]);

  if (sequence.length === 0) {
    return (
      <div className="text-[10px] text-text-subtle border border-dashed border-line rounded py-4 text-center">
        Empty — click palette frames to add them here.
      </div>
    );
  }

  function onDrop(pos: number) {
    if (dragPos === null || dragPos === pos) { setDragPos(null); return; }
    const next = [...sequence];
    const [moved] = next.splice(dragPos, 1);
    next.splice(pos, 0, moved);
    onReorder(next);
    setDragPos(null);
  }

  return (
    <div className="flex flex-wrap gap-1">
      {sequence.map((frameIndex, pos) => {
        const p = byIndex.get(frameIndex);
        return (
          <div
            key={pos}
            draggable
            onDragStart={() => setDragPos(pos)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(pos)}
            className="relative w-12 h-12 bg-bg-subtle border border-line rounded overflow-hidden cursor-grab group"
            style={{
              background:
                "repeating-conic-gradient(#222 0% 25%, #2a2a2a 0% 50%) 50%/8px 8px",
            }}
            title={`#${frameIndex} (position ${pos + 1})`}
          >
            {img && p && <FrameThumb img={img} rect={p.rect} />}
            <button
              onClick={() => onRemove(pos)}
              className="absolute top-0 right-0 bg-bg/80 text-text-dim hover:text-accent-hot rounded-bl opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove"
            >
              <X className="h-3 w-3" />
            </button>
            <span className="absolute bottom-0 left-0 text-[8px] font-mono px-1 bg-bg/70 text-text-subtle">
              {pos + 1}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live preview — requestAnimationFrame cycling the built sequence.
// ---------------------------------------------------------------------------

function LivePreview({
  atlasUrl,
  frames,
  fps,
  loopMode,
  playing,
}: {
  atlasUrl: string | null;
  frames: AnimFrame[];
  fps: number;
  loopMode: LoopMode;
  playing: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number | null>(null);
  // Keep latest values in refs so the rAF loop reads fresh data without
  // restarting on every prop change.
  const stateRef = useRef({ frames, fps, loopMode, playing });
  useEffect(() => { stateRef.current = { frames, fps, loopMode, playing }; }, [frames, fps, loopMode, playing]);

  useEffect(() => {
    if (!atlasUrl) { imgRef.current = null; return; }
    const img = new Image();
    img.onload = () => { imgRef.current = img; };
    img.src = atlasUrl;
    return () => { imgRef.current = null; };
  }, [atlasUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = 200, H = 200;
    canvas.width = W;
    canvas.height = H;

    let pos = 0;
    let dir = 1; // for ping-pong
    let last = performance.now();

    const checker = (cs: number) => {
      for (let y = 0; y < H; y += cs) {
        for (let x = 0; x < W; x += cs) {
          ctx.fillStyle = ((x / cs + y / cs) % 2 === 0) ? "#222" : "#2a2a2a";
          ctx.fillRect(x, y, cs, cs);
        }
      }
    };

    const loop = (t: number) => {
      const { frames: fr, fps: f, loopMode: lm, playing: pl } = stateRef.current;
      ctx.clearRect(0, 0, W, H);
      checker(12);
      const img = imgRef.current;
      if (img && fr.length > 0) {
        const idx = Math.max(0, Math.min(fr.length - 1, pos));
        const [sx, sy, sw, sh] = fr[idx].rect;
        if (sw > 0 && sh > 0) {
          ctx.imageSmoothingEnabled = false;
          const scale = Math.min(W / sw, H / sh);
          const dw = sw * scale, dh = sh * scale;
          ctx.drawImage(img, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
        }
        const frameMs = 1000 / Math.max(1, f);
        if (pl && t - last >= frameMs) {
          last = t;
          pos = advance(pos, fr.length, lm, () => { dir = -dir; }, dir);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [atlasUrl]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full aspect-square rounded border border-line"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

/** Step the playhead per loop mode. `flip` toggles ping-pong direction. */
function advance(pos: number, len: number, mode: LoopMode, flip: () => void, dir: number): number {
  if (len <= 1) return 0;
  if (mode === "reverse") {
    const n = pos - 1;
    return n < 0 ? len - 1 : n;
  }
  if (mode === "ping-pong") {
    let n = pos + dir;
    if (n >= len) { flip(); n = len - 2; }
    else if (n < 0) { flip(); n = 1; }
    return n;
  }
  if (mode === "once") {
    return Math.min(pos + 1, len - 1);
  }
  // loop
  return (pos + 1) % len;
}
