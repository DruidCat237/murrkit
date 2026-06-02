"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Pause, Square, Rewind, FastForward,
  Plus, Save, Download, Layers, Tag, Gauge, RotateCcw,
} from "lucide-react";
import FrameStrip from "./FrameStrip";
import type { AnimationSpec, AnimFrame, LoopMode } from "@/lib/types";
import { createAnimationClip, previewGifUrl, saveAnimationSpec, BACKEND } from "@/lib/api";
import { useToasts } from "../Toaster";
import { useSession } from "@/store/session";

const DEFAULT_SPEC: AnimationSpec = {
  name: "new_animation",
  atlas: "",
  fps: 12,
  loop_mode: "loop",
  frames: [],
};

const SAMPLE_FRAMES: AnimFrame[] = [
  { rect: [0,   0, 64, 64], duration_ms: 100, tag: "walk" },
  { rect: [64,  0, 64, 64], duration_ms: 100, tag: "walk" },
  { rect: [128, 0, 64, 64], duration_ms: 100, tag: "walk" },
  { rect: [192, 0, 64, 64], duration_ms: 100, tag: "walk" },
];

// Sensible FPS presets — matches how animators commonly think about timing.
const FPS_PRESETS = [6, 8, 12, 15, 24, 30, 60];

export default function AnimationEditor() {
  const project = useSession((s) => s.activeProject);
  const toast = useToasts();
  const [spec, setSpec] = useState<AnimationSpec>({ ...DEFAULT_SPEC, frames: SAMPLE_FRAMES });
  const [activeFrame, setActiveFrame] = useState(0);
  // Auto-play by default so the user sees the animation immediately and can
  // judge speed without hunting for the play button.
  const [playing, setPlaying] = useState(true);
  const [onionSkin, setOnionSkin] = useState(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Playback timer
  useEffect(() => {
    if (!playing || spec.frames.length === 0) return;
    const interval = Math.max(1, Math.round(1000 / spec.fps));
    playRef.current = setInterval(() => {
      setActiveFrame((i) => {
        const next = i + 1;
        if (next >= spec.frames.length) {
          if (spec.loop_mode === "once") {
            setPlaying(false);
            return spec.frames.length - 1;
          }
          if (spec.loop_mode === "reverse") return spec.frames.length - 1;
          if (spec.loop_mode === "ping-pong") return spec.frames.length - 2 >= 0 ? spec.frames.length - 2 : 0;
          return 0;
        }
        return next;
      });
    }, interval);
    return () => { if (playRef.current) clearInterval(playRef.current); };
  }, [playing, spec.fps, spec.frames.length, spec.loop_mode]);

  // Derived timing — shown in the speed panel so the user understands what
  // the FPS number means concretely.
  const frameDurationMs = Math.round(1000 / Math.max(1, spec.fps));
  const totalDurationMs = frameDurationMs * spec.frames.length;
  const totalDurationSec = totalDurationMs / 1000;

  // Keyboard shortcuts: Space toggles play, ←/→ step frames.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      // Ignore when typing in name/atlas/tag inputs
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        setActiveFrame((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        setActiveFrame((i) => Math.min(spec.frames.length - 1, i + 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spec.frames.length]);

  function update<K extends keyof AnimationSpec>(key: K, value: AnimationSpec[K]) {
    setSpec((s) => ({ ...s, [key]: value }));
  }

  function onReorder(order: number[]) {
    setSpec((s) => ({ ...s, frames: order.map((i) => s.frames[i]) }));
  }
  function onDelete(i: number) {
    setSpec((s) => ({ ...s, frames: s.frames.filter((_, idx) => idx !== i) }));
    if (activeFrame >= i) setActiveFrame(Math.max(0, activeFrame - 1));
  }
  function onDurationChange(i: number, ms: number) {
    setSpec((s) => ({ ...s, frames: s.frames.map((f, idx) => idx === i ? { ...f, duration_ms: ms } : f) }));
  }
  function addFrame() {
    const last = spec.frames[spec.frames.length - 1];
    const nextRect: AnimFrame["rect"] = last
      ? [last.rect[0] + last.rect[2], last.rect[1], last.rect[2], last.rect[3]]
      : [0, 0, 64, 64];
    setSpec((s) => ({ ...s, frames: [...s.frames, { rect: nextRect, duration_ms: 100 }] }));
  }

  const atlasUrl = useMemo(() => {
    if (!spec.atlas) return null;
    if (spec.atlas.startsWith("http")) return spec.atlas;
    if (spec.atlas.startsWith("/files")) return `${BACKEND}${spec.atlas}`;
    // try assuming relative file under /files/
    return `${BACKEND}/files/${spec.atlas.split(/[/\\]/).pop()}`;
  }, [spec.atlas]);

  async function saveSpec() {
    await toast.loading(`Saving ${spec.name} @ ${spec.fps} FPS`, {
      promise: saveAnimationSpec(project, spec.name, spec),
      success: () => `Saved spec @ ${spec.fps} FPS`,
      error: (e) => `Save failed: ${(e as Error).message}`,
    }).catch(() => { /* already toasted */ });
  }

  const gifUrl = useMemo(() => {
    if (!spec.atlas) return null;
    return previewGifUrl(spec.atlas, spec.fps);
  }, [spec.atlas, spec.fps]);

  async function saveAndExport() {
    if (spec.frames.length === 0) {
      toast.warn("Add some frames before exporting");
      return;
    }
    // Save the spec first so the FPS the user sees is the FPS that lands in
    // the persisted .json spec — single click, single canonical speed.
    try {
      await saveAnimationSpec(project, spec.name, spec);
    } catch (e) {
      toast.error(`Save spec failed: ${(e as Error).message}`);
      return;
    }
    await toast.loading(`Saving ${spec.name} @ ${spec.fps} FPS clip spec`, {
      promise: createAnimationClip({
        sprite_atlas_path: spec.atlas,
        name: spec.name,
        frames: spec.frames,
        loop_mode: spec.loop_mode,
        fps: spec.fps,
      }),
      success: (r) => `Saved spec @ ${spec.fps} FPS → ${r.spec_path}`,
      error: (e) => `Save failed: ${(e as Error).message}`,
    }).catch(() => { /* already toasted */ });
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg overflow-hidden">
      {/* top toolbar: identity + transport */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0 flex-wrap">
        <input
          value={spec.name}
          onChange={(e) => update("name", e.target.value)}
          className="bg-bg border border-line rounded px-2 py-1 text-xs w-40"
          placeholder="animation name"
          aria-label="animation name"
        />
        <input
          value={spec.atlas}
          onChange={(e) => update("atlas", e.target.value)}
          className="bg-bg border border-line rounded px-2 py-1 text-xs w-72 font-mono"
          placeholder="path/to/atlas.png (relative or /files/...)"
          aria-label="atlas path"
        />

        <div className="border-l border-line h-5 mx-1" />

        <button onClick={() => setPlaying((v) => !v)} className="btn btn-ghost p-1.5" title="Play / Pause (Space)" aria-label="Play or pause">
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button onClick={() => { setPlaying(false); setActiveFrame(0); }} className="btn btn-ghost p-1.5" title="Stop" aria-label="Stop">
          <Square className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => setActiveFrame((i) => Math.max(0, i - 1))} className="btn btn-ghost p-1.5" title="Previous frame (←)" aria-label="Prev frame"><Rewind className="h-3.5 w-3.5" /></button>
        <button onClick={() => setActiveFrame((i) => Math.min(spec.frames.length - 1, i + 1))} className="btn btn-ghost p-1.5" title="Next frame (→)" aria-label="Next frame"><FastForward className="h-3.5 w-3.5" /></button>

        <div className="flex items-center gap-1 ml-2">
          <span className="text-xs text-text-dim">Loop</span>
          <select
            value={spec.loop_mode}
            onChange={(e) => update("loop_mode", e.target.value as LoopMode)}
            className="bg-bg border border-line rounded px-2 py-1 text-xs"
          >
            <option value="once">once</option>
            <option value="loop">loop</option>
            <option value="ping-pong">ping-pong</option>
            <option value="reverse">reverse</option>
          </select>
        </div>

        <label className="ml-2 flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={onionSkin} onChange={(e) => setOnionSkin(e.target.checked)} />
          <Layers className="h-3 w-3" /> Onion skin
        </label>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={saveAndExport}
            className="btn btn-primary text-xs flex items-center gap-1.5 px-3 py-1.5 font-medium"
            title={`Saves the spec at ${spec.fps} FPS and writes the .anim into your Unity project at the same speed.`}
          >
            <Download className="h-3.5 w-3.5" /> Save &amp; export @ {spec.fps} FPS
          </button>
        </div>
      </div>

      {/* speed panel — prominent so the user can dial timing while watching the preview */}
      <div className="px-4 py-3 border-b border-line bg-bg-subtle/40 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <Gauge className="h-4 w-4 text-accent" />
            <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">
              Playback speed
            </span>
          </div>

          {/* Big slider */}
          <input
            type="range"
            min={1}
            max={60}
            step={1}
            value={spec.fps}
            onChange={(e) => update("fps", parseInt(e.target.value, 10))}
            className="flex-1 min-w-[180px] accent-accent cursor-pointer"
            aria-label="Playback FPS"
          />

          {/* Live readout */}
          <div className="flex items-baseline gap-1 shrink-0">
            <span className="text-2xl font-bold font-mono tabular-nums text-accent">
              {spec.fps}
            </span>
            <span className="text-xs text-text-dim">FPS</span>
          </div>

          {/* Timing breakdown */}
          <div className="flex items-center gap-3 text-[10px] text-text-subtle shrink-0 border-l border-line pl-3">
            <div>
              <div className="text-text-dim uppercase tracking-wider">per frame</div>
              <div className="font-mono tabular-nums text-text">{frameDurationMs} ms</div>
            </div>
            <div>
              <div className="text-text-dim uppercase tracking-wider">total loop</div>
              <div className="font-mono tabular-nums text-text">
                {totalDurationSec >= 1
                  ? `${totalDurationSec.toFixed(2)} s`
                  : `${totalDurationMs} ms`}
              </div>
            </div>
            <div>
              <div className="text-text-dim uppercase tracking-wider">cycles/sec</div>
              <div className="font-mono tabular-nums text-text">
                {spec.frames.length > 0
                  ? (1000 / Math.max(1, totalDurationMs)).toFixed(2)
                  : "—"}
              </div>
            </div>
          </div>

          {/* Reset to 12 */}
          <button
            onClick={() => update("fps", 12)}
            className="text-[10px] text-text-dim hover:text-text flex items-center gap-1 shrink-0"
            title="Reset to default 12 FPS"
          >
            <RotateCcw className="h-3 w-3" /> reset
          </button>
        </div>

        {/* Quick presets */}
        <div className="flex items-center gap-1 mt-2">
          <span className="text-[10px] text-text-subtle mr-1">Presets:</span>
          {FPS_PRESETS.map((p) => {
            const active = spec.fps === p;
            return (
              <button
                key={p}
                onClick={() => update("fps", p)}
                className={[
                  "text-[10px] px-2 py-0.5 rounded-full border transition-colors font-mono tabular-nums",
                  active
                    ? "bg-accent text-bg border-accent"
                    : "border-line text-text-dim hover:border-accent/40 hover:text-text",
                ].join(" ")}
                title={`${p} FPS · ${Math.round(1000 / p)} ms/frame`}
              >
                {p}
              </button>
            );
          })}
          <span className="text-[10px] text-text-subtle ml-2">
            The animation auto-plays — drag the slider to see speed change live.
          </span>
        </div>
      </div>

      {/* main pane: canvas + side info */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 flex items-center justify-center bg-bg-subtle p-6">
          <AnimationPreview
            atlasUrl={atlasUrl}
            frames={spec.frames}
            activeIndex={activeFrame}
            onionSkin={onionSkin}
            playing={playing}
            fps={spec.fps}
          />
        </div>

        <aside className="w-72 shrink-0 border-l border-line bg-bg-panel p-3 text-xs overflow-y-auto">
          <h3 className="font-semibold mb-2">Frame {activeFrame + 1} / {spec.frames.length}</h3>
          {spec.frames[activeFrame] && (
            <>
              <div className="space-y-2">
                <PropRow label="X" value={spec.frames[activeFrame].rect[0]} />
                <PropRow label="Y" value={spec.frames[activeFrame].rect[1]} />
                <PropRow label="Width" value={spec.frames[activeFrame].rect[2]} />
                <PropRow label="Height" value={spec.frames[activeFrame].rect[3]} />
                <PropRow label="Duration" value={`${spec.frames[activeFrame].duration_ms} ms`} />
                <div className="flex items-center gap-2">
                  <Tag className="h-3 w-3 text-text-dim" />
                  <input
                    value={spec.frames[activeFrame].tag ?? ""}
                    placeholder="tag…"
                    onChange={(e) => {
                      const v = e.target.value;
                      setSpec((s) => ({
                        ...s,
                        frames: s.frames.map((f, i) => i === activeFrame ? { ...f, tag: v } : f),
                      }));
                    }}
                    className="bg-bg border border-line rounded px-2 py-1 text-xs flex-1"
                  />
                </div>
              </div>

              <hr className="my-3 border-line" />

              <h4 className="font-semibold mb-1">GIF preview</h4>
              {gifUrl ? (
                <img
                  src={gifUrl}
                  alt="gif preview"
                  className="block w-full bg-bg border border-line rounded"
                />
              ) : (
                <p className="text-text-subtle">Set atlas path to see a server-side GIF.</p>
              )}
            </>
          )}

          <hr className="my-3 border-line" />
          <button onClick={addFrame} className="btn btn-ghost w-full text-xs flex items-center justify-center gap-1">
            <Plus className="h-3 w-3" /> Add frame
          </button>
          <button
            onClick={saveSpec}
            className="btn btn-ghost w-full text-xs flex items-center justify-center gap-1 mt-1 text-text-dim"
            title="Save the JSON spec only — no Unity export"
          >
            <Save className="h-3 w-3" /> Save spec only
          </button>
        </aside>
      </div>

      <FrameStrip
        atlasUrl={atlasUrl}
        frames={spec.frames}
        activeFrame={activeFrame}
        onSelect={setActiveFrame}
        onReorder={onReorder}
        onDelete={onDelete}
        onDurationChange={onDurationChange}
      />
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-dim">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

interface AnimationPreviewProps {
  atlasUrl: string | null;
  frames: AnimFrame[];
  activeIndex: number;
  onionSkin: boolean;
  playing: boolean;
  fps: number;
}

function AnimationPreview({ atlasUrl, frames, activeIndex, onionSkin }: AnimationPreviewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const W = 256, H = 256;

  useEffect(() => {
    if (!ref.current) return;
    const ctx = ref.current.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);

    // Checkerboard background
    const cs = 8;
    for (let y = 0; y < H; y += cs) {
      for (let x = 0; x < W; x += cs) {
        ctx.fillStyle = ((x / cs + y / cs) % 2 === 0) ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)";
        ctx.fillRect(x, y, cs, cs);
      }
    }

    if (!atlasUrl || frames.length === 0) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      // Onion skin: draw prev/next at lower alpha
      if (onionSkin) {
        if (activeIndex > 0) {
          ctx.globalAlpha = 0.25;
          drawFrame(ctx, img, frames[activeIndex - 1].rect, W, H);
        }
        if (activeIndex < frames.length - 1) {
          ctx.globalAlpha = 0.25;
          drawFrame(ctx, img, frames[activeIndex + 1].rect, W, H);
        }
      }
      ctx.globalAlpha = 1;
      drawFrame(ctx, img, frames[activeIndex].rect, W, H);
    };
    img.src = atlasUrl;
  }, [atlasUrl, frames, activeIndex, onionSkin]);

  if (!atlasUrl) {
    return (
      <div className="text-center text-text-subtle">
        <Layers className="h-10 w-10 mx-auto mb-2 opacity-40" />
        <div className="text-sm">No atlas loaded</div>
        <div className="text-xs mt-1">Enter an atlas path above to start animating.</div>
      </div>
    );
  }

  return (
    <canvas
      ref={ref} width={W} height={H}
      className="rounded border border-line"
      style={{ width: 256, height: 256, imageRendering: "pixelated" }}
    />
  );
}

function drawFrame(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  rect: [number, number, number, number], W: number, H: number
) {
  const [sx, sy, sw, sh] = rect;
  const scale = Math.min(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(img, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}
