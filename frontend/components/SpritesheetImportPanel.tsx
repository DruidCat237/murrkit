"use client";

/**
 * SpritesheetImportPanel — upload a PNG sprite sheet, set the split grid, see a
 * LIVE grid overlay on the image, then confirm to slice it on the backend.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Spritesheet Import · drop a PNG, set rows × cols        │
 *   ├───────────────────────────┬──────────────────────────────┤
 *   │  [drop zone / preview     │  rows  [ 3 ]                  │
 *   │   with grid overlay]      │  cols  [ 3 ]                  │
 *   │                           │  frame w/h (auto from grid)   │
 *   │                           │  [ Confirm & slice ]          │
 *   ├───────────────────────────┴──────────────────────────────┤
 *   │  Sliced frames strip (served_url thumbnails)             │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Interface contract (backend agent implements):
 *   POST /api/spritesheet/import  (multipart)
 *     file (PNG), rows (int), cols (int)
 *   → { ok, frames: [served_url...], frames_json_url, rows, cols, frame_w, frame_h }
 *
 * The grid overlay is drawn purely client-side on a <canvas> from the picked
 * file, so the user sees the exact split before spending a round-trip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Grid3X3,
  ImageIcon,
  Loader2,
  Scissors,
  Upload,
  X,
} from "lucide-react";
import { BACKEND, importSpritesheet } from "@/lib/api";
import type { SpritesheetImportResponse } from "@/lib/types";
import { useToasts } from "./Toaster";
import { useSession } from "@/store/session";

export default function SpritesheetImportPanel() {
  const project = useSession((s) => s.activeProject);
  const toast = useToasts();

  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<SpritesheetImportResponse | null>(null);
  // Persistent failure banner — a toast alone vanishes while the stale
  // preview keeps looking like a success.
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Revoke the object URL when the file changes / on unmount to avoid leaks.
  useEffect(() => {
    if (!file) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const acceptFile = useCallback((f: File | undefined) => {
    if (!f) return;
    if (!/\.png$/i.test(f.name) && f.type !== "image/png") {
      toast.warn("Please choose a PNG spritesheet");
      return;
    }
    setResult(null);
    setImgSize(null);
    setImportError(null);
    setFile(f);
  }, [toast]);

  // ---- drag-drop ---------------------------------------------------------
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    acceptFile(e.dataTransfer.files[0]);
  }

  // Derived frame size from the grid (whole-pixel floor, like the slicer).
  const frameW = imgSize ? Math.floor(imgSize.w / Math.max(1, cols)) : 0;
  const frameH = imgSize ? Math.floor(imgSize.h / Math.max(1, rows)) : 0;

  async function confirm() {
    if (!file) {
      toast.warn("Drop a PNG spritesheet first");
      return;
    }
    setImporting(true);
    setResult(null);
    setImportError(null);
    try {
      const res = await importSpritesheet({ file, rows, cols, project });
      setResult(res);
      toast.success(`Sliced ${res.frames.length} frames (${res.cols}×${res.rows})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Import failed";
      setImportError(msg);
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line shrink-0">
        <Grid3X3 className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Spritesheet Import</h2>
        <span className="text-[10px] text-text-subtle ml-2">
          Drop a PNG · set rows × cols · live grid preview · slice
        </span>
        <span className="text-[10px] text-text-dim font-mono ml-auto">
          project: {project}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_18rem] gap-4">
          {/* ---- preview / drop zone ------------------------------------ */}
          <div className="space-y-2">
            {!objectUrl ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={[
                  "border-2 border-dashed rounded-md cursor-pointer transition-colors text-center py-16 flex flex-col items-center justify-center",
                  dragOver
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-line text-text-dim hover:border-accent/60 hover:bg-bg-subtle/50",
                ].join(" ")}
              >
                <Upload className="h-7 w-7 mb-2" />
                <div className="text-sm">
                  {dragOver ? "Drop to load" : "Drag a PNG spritesheet here, or click to browse"}
                </div>
                <div className="text-[10px] text-text-subtle mt-1">
                  The grid overlay updates live as you change rows/cols.
                </div>
              </div>
            ) : (
              <div className="panel p-3 space-y-2">
                <div className="flex items-center gap-2 text-[10px] text-text-subtle">
                  <ImageIcon className="h-3 w-3" />
                  <span className="font-mono truncate flex-1" title={file?.name}>
                    {file?.name}
                  </span>
                  {imgSize && (
                    <span className="font-mono">{imgSize.w}×{imgSize.h}px</span>
                  )}
                  <button
                    onClick={() => { setFile(null); setResult(null); }}
                    className="text-text-dim hover:text-accent-hot"
                    title="Clear"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <GridOverlayPreview
                  url={objectUrl}
                  rows={rows}
                  cols={cols}
                  onSize={(w, h) => setImgSize({ w, h })}
                />
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png"
              className="hidden"
              onChange={(e) => {
                acceptFile(e.target.files?.[0]);
                if (e.target) e.target.value = "";
              }}
            />
          </div>

          {/* ---- controls ---------------------------------------------- */}
          <div className="panel p-4 space-y-4 self-start">
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Rows" value={rows} min={1} max={32} onChange={setRows} />
              <NumberField label="Cols" value={cols} min={1} max={32} onChange={setCols} />
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-text-dim">
                Frame size (auto from grid)
              </div>
              <div className="flex items-center gap-2 text-xs font-mono">
                <span className="px-2 py-1 bg-bg-subtle border border-line rounded">
                  {frameW || "—"}
                </span>
                <span className="text-text-subtle">×</span>
                <span className="px-2 py-1 bg-bg-subtle border border-line rounded">
                  {frameH || "—"}
                </span>
                <span className="text-text-subtle">px</span>
              </div>
              <p className="text-[10px] text-text-subtle leading-relaxed">
                Computed as floor(image ÷ grid). The backend slicer writes the
                exact frame rects into a frames.json sidecar.
              </p>
            </div>

            <div className="text-[10px] text-text-subtle">
              {cols} × {rows} grid → <span className="text-text">{rows * cols}</span> frames
            </div>

            <button
              onClick={confirm}
              disabled={importing || !file}
              className="btn btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {importing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Slicing…
                </>
              ) : (
                <>
                  <Scissors className="h-4 w-4" />
                  Confirm &amp; slice
                </>
              )}
            </button>
          </div>
        </div>

        {/* ---- import failure (persistent, selectable) ------------------ */}
        {importError && (
          <div className="mx-4 mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300 select-text">
            Import failed: {importError} — the preview above is the UNSLICED
            upload; fix the grid or pick another file and slice again.
          </div>
        )}

        {/* ---- sliced result strip ------------------------------------- */}
        {result && <SlicedStrip result={result} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live grid overlay — draws the image then row/col gridlines on a canvas.
// ---------------------------------------------------------------------------

function GridOverlayPreview({
  url,
  rows,
  cols,
  onSize,
}: {
  url: string;
  rows: number;
  cols: number;
  onSize: (w: number, h: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Stable callback ref so the draw effect doesn't re-run on every parent render.
  const onSizeRef = useRef(onSize);
  useEffect(() => { onSizeRef.current = onSize; }, [onSize]);

  // Load the image once per URL.
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      onSizeRef.current(img.naturalWidth, img.naturalHeight);
      draw(canvasRef.current, img, rows, cols);
    };
    img.src = url;
    return () => { imgRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Redraw when the grid changes.
  useEffect(() => {
    if (imgRef.current) draw(canvasRef.current, imgRef.current, rows, cols);
  }, [rows, cols]);

  return (
    <div
      className="bg-bg-subtle border border-line rounded overflow-hidden flex items-center justify-center"
      style={{
        background:
          "repeating-conic-gradient(#222 0% 25%, #2a2a2a 0% 50%) 50%/24px 24px",
      }}
    >
      <canvas
        ref={canvasRef}
        className="max-w-full max-h-[60vh] object-contain"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  );
}

function draw(
  canvas: HTMLCanvasElement | null,
  img: HTMLImageElement,
  rows: number,
  cols: number,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  canvas.width = w;
  canvas.height = h;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // Gridlines — accent colour, thin, with a dark halo so they read on any art.
  const r = Math.max(1, Math.floor(rows));
  const c = Math.max(1, Math.floor(cols));
  const cellW = w / c;
  const cellH = h / r;
  const lineW = Math.max(1, Math.round(Math.min(w, h) / 400));

  for (let i = 1; i < c; i++) {
    const x = Math.round(i * cellW);
    strokeLine(ctx, x, 0, x, h, lineW);
  }
  for (let j = 1; j < r; j++) {
    const y = Math.round(j * cellH);
    strokeLine(ctx, 0, y, w, y, lineW);
  }
  // Outer border.
  ctx.strokeStyle = "rgba(95,227,193,0.9)";
  ctx.lineWidth = lineW;
  ctx.strokeRect(lineW / 2, lineW / 2, w - lineW, h - lineW);
}

function strokeLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lineW: number,
) {
  // Dark halo underneath for contrast on light sprites.
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = lineW + 2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  // Accent line on top.
  ctx.strokeStyle = "rgba(95,227,193,0.9)";
  ctx.lineWidth = lineW;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Sliced-frames result strip
// ---------------------------------------------------------------------------

function SlicedStrip({ result }: { result: SpritesheetImportResponse }) {
  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Scissors className="h-3.5 w-3.5 text-accent" />
        <h3 className="text-sm font-medium">Sliced frames</h3>
        <span className="text-[10px] text-text-subtle ml-2">
          {result.frames.length} frames · {result.cols}×{result.rows} ·{" "}
          {result.frame_w}×{result.frame_h}px
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {result.frames.map((src, i) => (
          <div key={i} className="shrink-0 space-y-1">
            <div
              className="w-16 h-16 bg-bg-subtle border border-line rounded overflow-hidden flex items-center justify-center"
              style={{
                background:
                  "repeating-conic-gradient(#222 0% 25%, #2a2a2a 0% 50%) 50%/12px 12px",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${BACKEND}${src}`}
                alt={`frame ${i}`}
                className="max-w-full max-h-full object-contain"
                style={{ imageRendering: "pixelated" }}
              />
            </div>
            <div className="text-[9px] text-text-subtle text-center font-mono">#{i}</div>
          </div>
        ))}
      </div>
      <div className="text-[10px] text-text-subtle flex flex-wrap gap-x-3 gap-y-1">
        <span>
          frames.json:{" "}
          <code className="font-mono text-text">
            {result.frames_json_url.split(/[\\/]/).pop()}
          </code>
        </span>
        <a
          href={`${BACKEND}${result.frames_json_url}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline"
        >
          open sidecar
        </a>
        <span className="text-text-dim">
          Open the Animator tab to build named animations from these frames.
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small labelled number stepper
// ---------------------------------------------------------------------------

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase tracking-wide text-text-dim block">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isNaN(n)) return;
          onChange(Math.max(min, Math.min(max, n)));
        }}
        className="w-full bg-bg-subtle border border-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
      />
    </label>
  );
}
