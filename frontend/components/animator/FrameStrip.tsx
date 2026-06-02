"use client";

import { useEffect, useRef, useState } from "react";
import type { AnimFrame } from "@/lib/types";

interface FrameStripProps {
  atlasUrl: string | null;
  frames: AnimFrame[];
  activeFrame: number;
  onSelect: (i: number) => void;
  onReorder: (newOrder: number[]) => void;
  onDelete: (i: number) => void;
  onDurationChange: (i: number, ms: number) => void;
}

export default function FrameStrip({
  atlasUrl, frames, activeFrame, onSelect, onReorder, onDelete, onDurationChange,
}: FrameStripProps) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);

  function onDragStart(i: number) { setDragId(i); }
  function onDragOver(i: number, e: React.DragEvent) { e.preventDefault(); setHoverId(i); }
  function onDrop(i: number, e: React.DragEvent) {
    e.preventDefault();
    if (dragId === null || dragId === i) return;
    const order = frames.map((_, idx) => idx);
    order.splice(i, 0, order.splice(dragId, 1)[0]);
    onReorder(order);
    setDragId(null); setHoverId(null);
  }

  return (
    <div className="border-t border-line bg-bg-panel">
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-dim border-b border-line flex items-center justify-between">
        <span>Frames ({frames.length})</span>
        <span className="text-text-subtle">drag to reorder · right-click for options</span>
      </div>
      <div className="flex gap-2 px-3 py-2 overflow-x-auto">
        {frames.length === 0 ? (
          <div className="py-6 text-center text-text-subtle text-xs flex-1">
            No frames yet. Generate sprites or import an atlas to add frames.
          </div>
        ) : frames.map((f, i) => (
          <div
            key={i}
            draggable
            onDragStart={() => onDragStart(i)}
            onDragOver={(e) => onDragOver(i, e)}
            onDrop={(e) => onDrop(i, e)}
            onClick={() => onSelect(i)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, idx: i }); }}
            className={`flex flex-col items-center cursor-pointer rounded border ${activeFrame === i ? "border-accent shadow-glow" : "border-line"} ${hoverId === i ? "bg-bg-subtle" : ""}`}
            style={{ minWidth: 60 }}
          >
            <FrameThumb atlasUrl={atlasUrl} rect={f.rect} />
            <div className="text-[10px] py-0.5 text-text-dim">{f.duration_ms}ms</div>
            <div className="text-[9px] pb-0.5 text-text-subtle">#{i}{f.tag ? ` · ${f.tag}` : ""}</div>
          </div>
        ))}
      </div>

      {contextMenu && (
        <FrameContextMenu
          x={contextMenu.x} y={contextMenu.y} idx={contextMenu.idx}
          currentDuration={frames[contextMenu.idx]?.duration_ms ?? 100}
          onClose={() => setContextMenu(null)}
          onDelete={() => { onDelete(contextMenu.idx); setContextMenu(null); }}
          onDuration={(ms) => { onDurationChange(contextMenu.idx, ms); setContextMenu(null); }}
        />
      )}
    </div>
  );
}

function FrameThumb({ atlasUrl, rect }: { atlasUrl: string | null; rect: [number, number, number, number] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [w, h] = [48, 48];

  useEffect(() => {
    if (!atlasUrl || !ref.current) return;
    const c = ref.current;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      const [sx, sy, sw, sh] = rect;
      const scale = Math.min(w / sw, h / sh);
      const dw = sw * scale, dh = sh * scale;
      ctx.drawImage(img, sx, sy, sw, sh, (w - dw) / 2, (h - dh) / 2, dw, dh);
    };
    img.src = atlasUrl;
  }, [atlasUrl, rect]);

  return <canvas ref={ref} width={w} height={h} className="block bg-bg" />;
}

function FrameContextMenu({
  x, y, idx, currentDuration, onClose, onDelete, onDuration,
}: { x: number; y: number; idx: number; currentDuration: number; onClose: () => void; onDelete: () => void; onDuration: (ms: number) => void }) {
  const [ms, setMs] = useState(currentDuration);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 panel shadow-elev py-1 text-xs"
        style={{ top: y + 4, left: x + 4 }}
      >
        <div className="px-3 py-1 text-text-dim text-[10px] uppercase tracking-wider">Frame {idx}</div>
        <div className="px-3 py-1.5 flex items-center gap-2">
          <span>Duration</span>
          <input
            type="number"
            value={ms}
            onChange={(e) => setMs(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-20 bg-bg border border-line rounded px-1 py-0.5 text-xs"
            min={1}
          />
          <span className="text-text-subtle">ms</span>
          <button onClick={() => onDuration(ms)} className="btn btn-primary text-[11px]">Apply</button>
        </div>
        <button
          onClick={onDelete}
          className="w-full text-left px-3 py-1.5 hover:bg-bg-subtle text-err"
        >
          Delete frame
        </button>
      </div>
    </>
  );
}
