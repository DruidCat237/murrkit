"use client";

/**
 * GeneratePanel — combined Sprite + Asset generator. Uses the new
 * queue endpoints so each click drops a job in the gen-queue and we
 * watch it in the queue panel rather than blocking the UI.
 */

import { useState } from "react";
import {
  Wand2, Image as ImageIcon, Grid3X3, Sparkles, Square, Layers, Cat, Send, Plus, X,
} from "lucide-react";
import { enqueueSprite, enqueueAsset } from "@/lib/api";
import { useToasts } from "./Toaster";
import { useSession } from "@/store/session";
import { useLayout } from "@/store/layout";

type Tab = "sprite" | "background" | "tileset" | "ui-element" | "particle-fx";

interface TabDef {
  key: Tab; label: string; icon: React.ReactNode;
}

const TABS: TabDef[] = [
  { key: "sprite",       label: "Character Sprite Sheet", icon: <Cat className="h-3.5 w-3.5" /> },
  { key: "background",   label: "Background",              icon: <ImageIcon className="h-3.5 w-3.5" /> },
  { key: "tileset",      label: "Tileset",                 icon: <Grid3X3 className="h-3.5 w-3.5" /> },
  { key: "ui-element",   label: "UI element",              icon: <Square className="h-3.5 w-3.5" /> },
  { key: "particle-fx",  label: "Particle FX",             icon: <Sparkles className="h-3.5 w-3.5" /> },
];

const SAMPLE_PROMPTS: Record<Tab, string[]> = {
  sprite: [
    "a cute orange cat warrior with idle/walk/attack animations",
    "a pixel-art knight with sword, idle and walking animation",
    "a black ninja with throwing-star animation",
  ],
  background: [
    "lush jungle parallax background with 3 depth layers",
    "neon cyberpunk city skyline at night, parallax",
    "soft pastel sky with floating islands, 2 layers",
  ],
  tileset: [
    "grass + dirt + stone tileset for top-down 2D game",
    "snow + ice + mountain tileset, pixel art",
    "lava cave tileset with glowing accents",
  ],
  "ui-element": [
    "rounded green button with stitched fabric look",
    "rpg-maker style health bar with gold border",
    "settings gear icon, flat outlined",
  ],
  "particle-fx": [
    "dust kicked up from a footstep, 4 frames",
    "sparkle of magical attack, 6 frames",
    "smoke puff fade-out, 5 frames",
  ],
};

export default function GeneratePanel() {
  const [tab, setTab] = useState<Tab>("sprite");
  const [prompt, setPrompt] = useState("");
  const [animations, setAnimations] = useState<string[]>(["idle", "walk"]);
  const [framesPerAnim, setFramesPerAnim] = useState(4);
  const [style, setStyle] = useState("pixel_art");
  const project = useSession((s) => s.activeProject);
  const openBottomTab = useLayout((s) => s.openOrFocusBottomTab);
  const toast = useToasts();
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!prompt.trim()) {
      toast.warn("Type a prompt first");
      return;
    }
    setSubmitting(true);
    try {
      if (tab === "sprite") {
        const r = await enqueueSprite({
          description: prompt,
          project,
          animations,
          frames_per_anim: framesPerAnim,
          style,
        });
        toast.success(`Queued sprite job ${r.task_id.slice(0, 6)}`);
      } else {
        const r = await enqueueAsset({
          asset_type: tab,
          description: prompt,
          project,
        });
        toast.success(`Queued ${tab} job ${r.task_id.slice(0, 6)}`);
      }
      openBottomTab("gen-queue");
      setPrompt("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line shrink-0">
        <Wand2 className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Generate</h2>
        <span className="text-[10px] text-text-subtle ml-2">GPT-Image-2 · Kitty App</span>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-line shrink-0 overflow-x-auto no-scrollbar">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
              tab === t.key ? "bg-bg-subtle text-accent border border-accent/40" : "text-text-dim hover:text-text"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto space-y-4">
          <label className="block">
            <span className="text-xs font-semibold text-text-dim">Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`Describe what to generate — e.g. "${SAMPLE_PROMPTS[tab][0]}"`}
              className="mt-1 w-full h-28 bg-bg border border-line rounded-md p-3 text-sm font-mono outline-none focus:border-accent resize-y"
              aria-label="Generation prompt"
            />
          </label>

          {/* Sample prompts */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-subtle mb-1">Sample prompts</div>
            <div className="flex flex-wrap gap-1">
              {SAMPLE_PROMPTS[tab].map((p) => (
                <button
                  key={p}
                  onClick={() => setPrompt(p)}
                  className="text-[11px] px-2 py-1 rounded-full border border-line text-text-dim hover:border-accent hover:text-accent"
                >
                  {p.slice(0, 60)}{p.length > 60 && "…"}
                </button>
              ))}
            </div>
          </div>

          {/* Sprite-only fields */}
          {tab === "sprite" && (
            <div className="panel p-3 space-y-3">
              <h3 className="text-xs font-semibold flex items-center gap-1">
                <Layers className="h-3 w-3" /> Sprite settings
              </h3>

              <div>
                <div className="text-[10px] uppercase text-text-subtle mb-1">Animations</div>
                <div className="flex flex-wrap gap-1">
                  {animations.map((a, i) => (
                    <span key={i} className="badge badge-info flex items-center gap-1 py-1 px-2">
                      {a}
                      <button
                        onClick={() => setAnimations(animations.filter((_, idx) => idx !== i))}
                        aria-label={`Remove ${a}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                  <button
                    className="text-[11px] px-2 py-0.5 border border-line rounded-full flex items-center gap-1 hover:border-accent text-text-dim"
                    onClick={() => {
                      const promptText = window.prompt("Animation name (idle/walk/attack/hurt/death/jump)") ?? "";
                      if (promptText) setAnimations([...animations, promptText]);
                    }}
                  >
                    <Plus className="h-2.5 w-2.5" /> add
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-2">
                  <span className="text-text-dim">Frames / anim</span>
                  <input
                    type="number" min={1} max={16}
                    value={framesPerAnim}
                    onChange={(e) => setFramesPerAnim(parseInt(e.target.value) || 4)}
                    className="w-16 bg-bg border border-line rounded px-2 py-1"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-text-dim">Style</span>
                  <select
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    className="bg-bg border border-line rounded px-2 py-1"
                  >
                    <option value="pixel_art">Pixel art</option>
                    <option value="cartoon">Cartoon</option>
                    <option value="vector">Vector</option>
                    <option value="hand_painted">Hand painted</option>
                  </select>
                </label>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 justify-end">
            <span className="text-[11px] text-text-subtle mr-auto">
              Will appear in the queue panel below
            </span>
            <button
              onClick={submit}
              disabled={submitting || !prompt.trim()}
              className="btn btn-primary disabled:opacity-50 flex items-center gap-2"
            >
              <Send className="h-3.5 w-3.5" />
              {submitting ? "Queueing…" : "Generate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
