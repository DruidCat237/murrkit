"use client";

import { useState } from "react";
import { Layers, Plus, X, Wand2, Download } from "lucide-react";
import { generateCharacterSpritesheet } from "@/lib/api";
import type { SpriteGenRequest, SpriteGenResponse } from "@/lib/types";

const DEFAULT_ANIMATIONS = ["idle", "walk", "attack", "hurt", "death"];
const STYLE_OPTIONS = [
  { value: "pixel_art", label: "Pixel Art" },
  { value: "vector", label: "Vector" },
  { value: "hand_painted", label: "Hand Painted" },
  { value: "cartoon", label: "Cartoon" },
];

export default function SpriteSheetGeneratorPanel() {
  const [description, setDescription] = useState("");
  const [animations, setAnimations] = useState<string[]>([...DEFAULT_ANIMATIONS]);
  const [newAnim, setNewAnim] = useState("");
  const [style, setStyle] = useState<SpriteGenRequest["style"]>("pixel_art");
  const [framesPerAnim, setFramesPerAnim] = useState(4);
  const [spriteSize, setSpriteSize] = useState<[number, number]>([64, 64]);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<SpriteGenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function addAnimation() {
    const name = newAnim.trim().toLowerCase().replace(/\s+/g, "_");
    if (name && !animations.includes(name)) {
      setAnimations((prev) => [...prev, name]);
    }
    setNewAnim("");
  }

  function removeAnimation(name: string) {
    setAnimations((prev) => prev.filter((a) => a !== name));
  }

  async function handleGenerate() {
    if (!description.trim()) {
      setError("Please enter a character description.");
      return;
    }
    setGenerating(true);
    setError(null);
    setResult(null);

    try {
      const req: SpriteGenRequest = {
        description: description.trim(),
        animations,
        frames_per_anim: framesPerAnim,
        style,
        sprite_size: spriteSize,
      };
      const res = await generateCharacterSpritesheet(req);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Layers className="h-5 w-5 text-accent" />
        <h2 className="text-base font-semibold">Spritesheet Generator</h2>
        <span className="text-xs text-text-subtle ml-2">GPT-Image-2 sprite sheets · Kitty App credits</span>
      </div>

      {/* Character description */}
      <div className="panel p-4 space-y-3">
        <label className="text-xs font-medium text-text-dim uppercase tracking-wide block">
          Character Description
        </label>
        <textarea
          className="w-full bg-bg-subtle border border-line rounded-md px-3 py-2 text-sm resize-none h-20 focus:outline-none focus:border-accent"
          placeholder='e.g. "knight in blue armor with longsword, medieval fantasy"'
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* Animations */}
      <div className="panel p-4 space-y-3">
        <label className="text-xs font-medium text-text-dim uppercase tracking-wide block">
          Animations
        </label>
        <div className="flex flex-wrap gap-2">
          {animations.map((anim) => (
            <span
              key={anim}
              className="flex items-center gap-1 bg-accent/10 border border-accent/30 text-accent text-xs px-2 py-1 rounded-md"
            >
              {anim}
              <button
                onClick={() => removeAnimation(anim)}
                className="hover:text-accent-hot ml-0.5"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="flex-1 bg-bg-subtle border border-line rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
            placeholder="Add animation (e.g. run, cast)"
            value={newAnim}
            onChange={(e) => setNewAnim(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAnimation()}
          />
          <button onClick={addAnimation} className="btn border border-line text-xs">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Style + parameters row */}
      <div className="panel p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-dim uppercase tracking-wide block">Style</label>
          <select
            className="w-full bg-bg-subtle border border-line rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
            value={style}
            onChange={(e) => setStyle(e.target.value as SpriteGenRequest["style"])}
          >
            {STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-dim uppercase tracking-wide block">
            Frames / Anim
          </label>
          <select
            className="w-full bg-bg-subtle border border-line rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
            value={framesPerAnim}
            onChange={(e) => setFramesPerAnim(Number(e.target.value))}
          >
            {[2, 4, 6, 8].map((n) => (
              <option key={n} value={n}>{n} frames</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-dim uppercase tracking-wide block">
            Sprite Width
          </label>
          <select
            className="w-full bg-bg-subtle border border-line rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
            value={spriteSize[0]}
            onChange={(e) => setSpriteSize([Number(e.target.value), spriteSize[1]])}
          >
            {[32, 48, 64, 96, 128].map((n) => (
              <option key={n} value={n}>{n}px</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-dim uppercase tracking-wide block">
            Sprite Height
          </label>
          <select
            className="w-full bg-bg-subtle border border-line rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
            value={spriteSize[1]}
            onChange={(e) => setSpriteSize([spriteSize[0], Number(e.target.value)])}
          >
            {[32, 48, 64, 96, 128].map((n) => (
              <option key={n} value={n}>{n}px</option>
            ))}
          </select>
        </div>
      </div>

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={generating || !description.trim()}
        className="btn-primary flex items-center gap-2 w-full justify-center py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {generating ? (
          <>
            <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Generating {animations.length} animations...
          </>
        ) : (
          <>
            <Wand2 className="h-4 w-4" />
            Generate Sprite Sheet ({animations.length} animations)
          </>
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="panel p-3 border-accent-hot/40 bg-accent-hot/5 text-accent-hot text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      {result && <SpriteSheetResults result={result} />}
    </div>
  );
}

function SpriteSheetResults({ result }: { result: SpriteGenResponse }) {
  const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001";

  return (
    <div className="panel p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Generated Sprite Sheet</h3>
        <span className="text-xs text-text-subtle">
          Cost: ${result.cost_usd.toFixed(4)}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {result.strips.map((strip) => (
          <div key={strip.name} className="space-y-1">
            <div className="bg-bg-subtle border border-line rounded-md h-16 flex items-center justify-center text-xs text-text-dim overflow-hidden">
              <span className="font-mono capitalize">{strip.name}</span>
            </div>
            <div className="text-[10px] text-text-subtle text-center">
              {strip.frame_count}f &middot; {strip.frame_width}x{strip.frame_height}
            </div>
            <button
              className="btn border border-line text-[10px] w-full flex items-center justify-center gap-1"
              onClick={async () => {
                try {
                  await fetch(`${BACKEND}/api/unity/import-sprite`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      source_path: strip.path,
                      dest_path: "Assets/Sprites",
                    }),
                  });
                } catch {
                  // ignore
                }
              }}
            >
              <Download className="h-2.5 w-2.5" />
              Import to Unity
            </button>
          </div>
        ))}
      </div>

      <div className="flex gap-2 text-xs text-text-subtle">
        <span>Atlas: <code className="font-mono">{result.atlas_path.split(/[\\/]/).pop()}</code></span>
        <span>&middot;</span>
        <span>Frames: <code className="font-mono">{result.frames_json_path.split(/[\\/]/).pop()}</code></span>
      </div>
    </div>
  );
}
