"use client";

/**
 * MapPainter — RPG-Maker-style per-cell biome painting for Map Studio.
 *
 * Edits an in-memory override layer (−1 = transparent → procedural base shows
 * through) over the compiled region base. Nothing touches the yaml until the
 * user hits "Apply to YAML" (panel does line surgery, then the normal
 * validating Save flow runs). Tools: brush 1/3/5, rectangle, flood fill,
 * eyedropper, eraser; undo/redo; zoom; auto-paint presets; AI paint (backend
 * /ai-paint proposes rows — applied as ONE undoable stroke).
 *
 * Rendering is split across two stacked canvases: `main` (cells + grid,
 * bulk-redrawn) and `overlay` (hover cursor / rect preview, redrawn per
 * mouse-move) — so a 512×512 map never repaints 262k cells on hover.
 * Strokes draw their dirty cells straight onto `main`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brush, Check, Eraser, Loader2, PaintBucket, Pipette, Redo2, Square, Undo2, Wand2,
} from "lucide-react";
import {
  PRESETS, computeBaseGrid, deriveLegend, floodFill, gridToFullRows, gridToPaintRows,
  rowsToGrid, runPreset, serializePaintBlock, specPaintToGrid,
  type PaintableSpec, type PresetId,
} from "@/lib/mapPaint";

type Tool = "brush" | "rect" | "fill" | "eyedropper" | "erase";

const MAX_UNDO = 50;

export interface MapPainterProps {
  /** Valid parsed spec (panel passes null while the yaml is broken). */
  spec: PaintableSpec | null;
  aiBusy: boolean;
  /** Serialize the paint layer into the yaml text (null = remove the block). */
  onApply: (block: string | null) => void;
  /** Ask the backend AI painter; resolves null on error (panel toasts). */
  onAiPaint: (
    instruction: string, rowsHint: string[],
  ) => Promise<{ legend: Record<string, string>; rows: string[] } | null>;
}

export default function MapPainter({ spec, aiBusy, onApply, onAiPaint }: MapPainterProps) {
  const W = spec?.width ?? 0, H = spec?.height ?? 0;
  const tilesets = useMemo(() => spec?.tilesets ?? [], [spec]);
  const baseGrid = useMemo(
    () => (spec ? computeBaseGrid(spec) : new Int16Array(0)),
    [spec],
  );
  const colors = useMemo(
    () => tilesets.map((t) => t.color ?? fallbackColor(t.biome)),
    [tilesets],
  );

  const paintRef = useRef<Int16Array>(new Int16Array(0));
  const undoRef = useRef<Int16Array[]>([]);
  const redoRef = useRef<Int16Array[]>([]);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(1); // 1 | 3 | 5 cells
  const [biomeSel, setBiomeSel] = useState(0);
  const [cellPx, setCellPx] = useState(14);
  const [unapplied, setUnapplied] = useState(false);
  const unappliedRef = useRef(false);
  useEffect(() => { unappliedRef.current = unapplied; }, [unapplied]);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [paintOnly, setPaintOnly] = useState(false);
  const [preset, setPreset] = useState<PresetId>("island");
  const [aiText, setAiText] = useState("");

  const strokeRef = useRef(false);
  const rectAnchorRef = useRef<{ x: number; y: number } | null>(null);

  const mainRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // ---- lifecycle: (re)load the layer from the spec --------------------------
  // Skipped while the painter is "ahead" of the yaml (unapplied strokes), so
  // hand edits in the YAML tab can't silently wipe unsaved painting — unless
  // the map dimensions changed, which forces a rebuild.
  useEffect(() => {
    if (!spec) return;
    const size = W * H;
    if (!unappliedRef.current || paintRef.current.length !== size) {
      paintRef.current = specPaintToGrid(spec);
      undoRef.current = [];
      redoRef.current = [];
      setUnapplied(false);
      bump();
    }
  }, [spec, W, H, bump]);

  // ---- full redraw (bulk ops, zoom, spec change) -----------------------------
  useEffect(() => {
    const canvas = mainRef.current;
    if (!canvas || !spec || W < 1) return;
    canvas.width = W * cellPx;
    canvas.height = H * cellPx;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const paint = paintRef.current;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        drawCell(ctx, x, y, cellPx, paint[i], baseGrid[i], colors, paintOnly);
      }
    }
    if (cellPx >= 8) drawGridLines(ctx, W, H, cellPx);
  }, [version, cellPx, spec, W, H, baseGrid, colors, paintOnly]);

  // ---- overlay: hover cursor + rect preview ---------------------------------
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || W < 1) return;
    canvas.width = W * cellPx;
    canvas.height = H * cellPx;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!hover) return;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    const a = rectAnchorRef.current;
    if (tool === "rect" && a) {
      const x0 = Math.min(a.x, hover.x), y0 = Math.min(a.y, hover.y);
      const x1 = Math.max(a.x, hover.x), y1 = Math.max(a.y, hover.y);
      ctx.strokeRect(x0 * cellPx + 1, y0 * cellPx + 1, (x1 - x0 + 1) * cellPx - 2, (y1 - y0 + 1) * cellPx - 2);
    } else {
      const r = tool === "brush" || tool === "erase" ? Math.floor(brushSize / 2) : 0;
      ctx.strokeRect(
        (hover.x - r) * cellPx + 1, (hover.y - r) * cellPx + 1,
        (2 * r + 1) * cellPx - 2, (2 * r + 1) * cellPx - 2,
      );
    }
  }, [hover, tool, brushSize, cellPx, W, H]);

  // ---- edit primitives -------------------------------------------------------
  const pushUndo = useCallback(() => {
    undoRef.current.push(paintRef.current.slice());
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    redoRef.current = [];
  }, []);

  const paintCells = useCallback((cx: number, cy: number) => {
    const ctx = mainRef.current?.getContext("2d");
    const value = tool === "erase" ? -1 : biomeSel;
    const r = Math.floor(brushSize / 2);
    for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
        const i = y * W + x;
        if (paintRef.current[i] === value) continue;
        paintRef.current[i] = value;
        if (ctx) {
          drawCell(ctx, x, y, cellPx, value, baseGrid[i], colors, paintOnly);
          if (cellPx >= 8) strokeCellBorder(ctx, x, y, cellPx);
        }
      }
    }
    if (!unappliedRef.current) setUnapplied(true);
  }, [tool, biomeSel, brushSize, W, H, cellPx, baseGrid, colors, paintOnly]);

  const cellFromEvent = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / cellPx);
    const y = Math.floor((e.clientY - rect.top) / cellPx);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    return { x, y };
  }, [cellPx, W, H]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !spec) return;
    const c = cellFromEvent(e);
    if (!c) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch { /* invalid/synthetic pointerId — capture is best-effort */ }
    const i = c.y * W + c.x;
    if (tool === "eyedropper") {
      const merged = paintRef.current[i] >= 0 ? paintRef.current[i] : baseGrid[i];
      setBiomeSel(merged);
      setTool("brush");
      return;
    }
    if (tool === "fill") {
      pushUndo();
      floodFill(paintRef.current, baseGrid, W, H, c.x, c.y, biomeSel);
      setUnapplied(true);
      bump();
      return;
    }
    if (tool === "rect") {
      rectAnchorRef.current = c;
      return;
    }
    pushUndo();
    strokeRef.current = true;
    paintCells(c.x, c.y);
  }, [spec, cellFromEvent, tool, W, H, baseGrid, biomeSel, pushUndo, paintCells, bump]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = cellFromEvent(e);
    setHover(c);
    if (c && strokeRef.current) paintCells(c.x, c.y);
  }, [cellFromEvent, paintCells]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = rectAnchorRef.current;
    if (tool === "rect" && a) {
      const c = cellFromEvent(e) ?? a;
      pushUndo();
      const value = biomeSel;
      const x0 = Math.min(a.x, c.x), y0 = Math.min(a.y, c.y);
      const x1 = Math.max(a.x, c.x), y1 = Math.max(a.y, c.y);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) paintRef.current[y * W + x] = value;
      }
      rectAnchorRef.current = null;
      setUnapplied(true);
      bump();
    }
    strokeRef.current = false;
  }, [tool, cellFromEvent, pushUndo, biomeSel, W, bump]);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(paintRef.current);
    paintRef.current = prev;
    setUnapplied(true);
    bump();
  }, [bump]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(paintRef.current);
    paintRef.current = next;
    setUnapplied(true);
    bump();
  }, [bump]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Never steal keystrokes from the AI instruction input / selects.
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey && e.key.toLowerCase() === "y") || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z")) {
      e.preventDefault(); redo(); return;
    }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= tilesets.length) { setBiomeSel(n - 1); return; }
    const map: Record<string, Tool> = { b: "brush", r: "rect", f: "fill", i: "eyedropper", e: "erase" };
    const t = map[e.key.toLowerCase()];
    if (t) setTool(t);
  }, [undo, redo, tilesets.length]);

  // ---- bulk actions -----------------------------------------------------------
  const doApply = useCallback(() => {
    if (!spec) return;
    const { legend, rows } = gridToPaintRows(
      paintRef.current, W, H, tilesets, spec.paint?.legend,
    );
    onApply(serializePaintBlock(legend, rows));
    setUnapplied(false);
  }, [spec, W, H, tilesets, onApply]);

  const doPreset = useCallback(() => {
    pushUndo();
    paintRef.current = runPreset(
      preset, W, H, tilesets, biomeSel, (Math.random() * 2 ** 31) | 0,
    );
    setUnapplied(true);
    bump();
  }, [preset, W, H, tilesets, biomeSel, pushUndo, bump]);

  const doAi = useCallback(async () => {
    if (!spec || !aiText.trim()) return;
    const legend = deriveLegend(tilesets, spec.paint?.legend);
    const hint = gridToFullRows(paintRef.current, W, H, tilesets, legend);
    const res = await onAiPaint(aiText.trim(), hint);
    if (!res) return;
    pushUndo();
    paintRef.current = rowsToGrid(res.rows, res.legend, W, H, tilesets);
    setUnapplied(true);
    bump();
  }, [spec, aiText, tilesets, W, H, onAiPaint, pushUndo, bump]);

  if (!spec || W < 1) {
    return (
      <div className="flex-1 grid place-items-center text-xs opacity-60 p-6 text-center">
        Painter czeka na poprawny YAML — napraw błędy walidacji, żeby malować.
      </div>
    );
  }

  const toolBtn = (t: Tool, icon: React.ReactNode, title: string): React.ReactNode => (
    <button
      className={`btn-ghost rounded p-1.5 ${tool === t ? "bg-white/15" : ""}`}
      title={title}
      onClick={() => setTool(t)}
    >
      {icon}
    </button>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col" tabIndex={0} onKeyDown={onKeyDown}>
      {/* ---- toolbar: tools ---- */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-line flex-wrap">
        {toolBtn("brush", <Brush className="h-3.5 w-3.5" />, "Pędzel (B)")}
        {toolBtn("rect", <Square className="h-3.5 w-3.5" />, "Prostokąt (R)")}
        {toolBtn("fill", <PaintBucket className="h-3.5 w-3.5" />, "Wypełnij obszar (F)")}
        {toolBtn("eyedropper", <Pipette className="h-3.5 w-3.5" />, "Pobierz biom z komórki (I)")}
        {toolBtn("erase", <Eraser className="h-3.5 w-3.5" />, "Gumka — wraca do proceduralnej bazy (E)")}
        <select
          value={brushSize}
          onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
          className="bg-bg border border-line rounded px-1 py-0.5 text-xs"
          title="Rozmiar pędzla"
        >
          <option value={1}>1×1</option>
          <option value={3}>3×3</option>
          <option value={5}>5×5</option>
        </select>
        <span className="mx-1 opacity-30">|</span>
        <button className="btn-ghost rounded p-1.5 disabled:opacity-40" title="Cofnij (Ctrl+Z)"
          onClick={undo} disabled={undoRef.current.length === 0}>
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button className="btn-ghost rounded p-1.5 disabled:opacity-40" title="Ponów (Ctrl+Y)"
          onClick={redo} disabled={redoRef.current.length === 0}>
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        <span className="mx-1 opacity-30">|</span>
        <input
          type="range" min={4} max={28} step={2} value={cellPx}
          onChange={(e) => setCellPx(parseInt(e.target.value, 10))}
          className="w-24" title={`Zoom: ${cellPx}px / kafel`}
        />
        <button
          className={`btn-ghost rounded px-1.5 py-0.5 text-[10px] ${paintOnly ? "bg-white/15" : ""}`}
          title="Pokaż tylko warstwę paint (szare = proceduralna baza)"
          onClick={() => setPaintOnly((v) => !v)}
        >
          paint-only
        </button>
        <div className="flex-1" />
        {hover && <span className="text-[10px] opacity-60 font-mono">{hover.x},{hover.y}</span>}
        {unapplied && (
          <span className="text-[10px] text-accent-warn" title="Painter ma zmiany, których nie ma jeszcze w YAML">
            ● nie w YAML
          </span>
        )}
        <button
          className="btn btn-primary text-xs px-2 py-1 inline-flex items-center gap-1 disabled:opacity-50"
          disabled={!unapplied}
          title="Zapisz warstwę paint do YAML w edytorze (potem Save)"
          onClick={doApply}
        >
          <Check className="h-3 w-3" /> Apply to YAML
        </button>
      </div>

      {/* ---- toolbar: palette + auto modes ---- */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-line flex-wrap">
        {tilesets.map((t, i) => (
          <button
            key={t.biome}
            className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
              biomeSel === i ? "border-white/70 bg-white/10" : "border-line"
            }`}
            title={`${t.biome} (klawisz ${i + 1})${t.walkable === false ? " — solid" : ""}`}
            onClick={() => setBiomeSel(i)}
          >
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: colors[i] }} />
            {t.biome}
          </button>
        ))}
        <span className="mx-1 opacity-30">|</span>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as PresetId)}
          className="bg-bg border border-line rounded px-1 py-0.5 text-xs"
          title="Auto-malowanie proceduralne (nadpisuje warstwę — Ctrl+Z cofa)"
        >
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <button className="btn text-xs px-2 py-1" onClick={doPreset} title="Uruchom preset">
          Auto
        </button>
        <span className="mx-1 opacity-30">|</span>
        <input
          value={aiText}
          onChange={(e) => setAiText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !aiBusy) void doAi(); }}
          placeholder="AI: „wyspa z rzeką i lasem na północy…”"
          className="flex-1 min-w-[140px] bg-bg border border-line rounded px-2 py-1 text-xs"
          title="Instrukcja dla AI-malarza (DeepSeek) — wynik wchodzi jako jeden cofalny ruch"
        />
        <button
          className="btn text-xs px-2 py-1 inline-flex items-center gap-1 disabled:opacity-50"
          disabled={aiBusy || !aiText.trim()}
          onClick={() => void doAi()}
          title="AI maluje warstwę wg instrukcji (Ctrl+Z cofa)"
        >
          {aiBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          AI paint
        </button>
      </div>

      {/* ---- canvas ---- */}
      <div className="flex-1 min-h-0 overflow-auto bg-black/20">
        <div className="relative inline-block m-2" style={{ lineHeight: 0 }}>
          <canvas ref={mainRef} style={{ imageRendering: "pixelated" }} />
          <canvas
            ref={overlayRef}
            className="absolute left-0 top-0 cursor-crosshair touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function drawCell(
  ctx: CanvasRenderingContext2D, x: number, y: number, cell: number,
  paintVal: number, baseVal: number, colors: string[], paintOnly: boolean,
): void {
  if (paintOnly) {
    ctx.fillStyle = paintVal >= 0 ? (colors[paintVal] ?? "#666") : "#3a3a3a";
  } else {
    const v = paintVal >= 0 ? paintVal : baseVal;
    ctx.fillStyle = colors[v] ?? "#666";
  }
  ctx.fillRect(x * cell, y * cell, cell, cell);
}

function strokeCellBorder(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number): void {
  ctx.strokeStyle = "rgba(0,0,0,0.15)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x * cell + 0.5, y * cell + 0.5, cell - 1, cell - 1);
}

function drawGridLines(ctx: CanvasRenderingContext2D, W: number, H: number, cell: number): void {
  ctx.strokeStyle = "rgba(0,0,0,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x++) { ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, H * cell); }
  for (let y = 0; y <= H; y++) { ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(W * cell, y * cell + 0.5); }
  ctx.stroke();
}

/** Same FNV-1a fallback hue as mapSpec.biomeColor / the panel swatches. */
function fallbackColor(biome: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < biome.length; i++) { h ^= biome.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `hsl(${(h >>> 0) % 360}deg 45% 45%)`;
}
