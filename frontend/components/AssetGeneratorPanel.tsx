"use client";

import { useState } from "react";
import { Wand2, Image, Grid, Sparkles, Square } from "lucide-react";

type AssetTab = "background" | "tileset" | "ui" | "particle";

export default function AssetGeneratorPanel() {
  const [activeTab, setActiveTab] = useState<AssetTab>("background");

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-2">
        <Wand2 className="h-5 w-5 text-accent" />
        <h2 className="text-base font-semibold">Asset Generator</h2>
        <span className="text-xs text-text-subtle ml-2">
          Backgrounds, tilesets, UI, particle FX
        </span>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 border-b border-line pb-2">
        {(
          [
            { key: "background", label: "Background", icon: <Image className="h-3.5 w-3.5" /> },
            { key: "tileset",    label: "Tileset",    icon: <Grid className="h-3.5 w-3.5" /> },
            { key: "ui",        label: "UI Element",  icon: <Square className="h-3.5 w-3.5" /> },
            { key: "particle",  label: "Particle FX", icon: <Sparkles className="h-3.5 w-3.5" /> },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={[
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              activeTab === tab.key
                ? "bg-accent/20 text-accent border border-accent/40"
                : "text-text-subtle hover:text-text hover:bg-bg-subtle border border-transparent",
            ].join(" ")}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "background" && <BackgroundGenerator />}
      {activeTab === "tileset"    && <TilesetGenerator />}
      {activeTab === "ui"         && <UIElementGenerator />}
      {activeTab === "particle"   && <ParticleFXGenerator />}
    </div>
  );
}


function GenForm({
  endpoint,
  extraFields,
}: {
  endpoint: string;
  extraFields: React.ReactNode;
}) {
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate(formData: Record<string, unknown>) {
    if (!description.trim()) { setError("Enter a description."); return; }
    setGenerating(true);
    setError(null);
    setResult(null);

    try {
      const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001";
      const res = await fetch(`${BACKEND}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim(), ...formData }),
      });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <GenFormInner
      description={description}
      setDescription={setDescription}
      generating={generating}
      result={result}
      error={error}
      onGenerate={handleGenerate}
      extraFields={extraFields}
    />
  );
}

function GenFormInner({
  description,
  setDescription,
  generating,
  result,
  error,
  onGenerate,
  extraFields,
}: {
  description: string;
  setDescription: (v: string) => void;
  generating: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  onGenerate: (data: Record<string, unknown>) => void;
  extraFields: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="panel p-4 space-y-3">
        <label className="text-xs font-medium text-text-dim uppercase tracking-wide block">
          Description
        </label>
        <textarea
          className="w-full bg-bg-subtle border border-line rounded-md px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:border-accent"
          placeholder="Describe the asset..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {extraFields}
      </div>

      <button
        onClick={() => onGenerate({})}
        disabled={generating || !description.trim()}
        className="btn-primary flex items-center gap-2 w-full justify-center py-2.5 text-sm disabled:opacity-50"
      >
        {generating ? (
          <>
            <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Generating...
          </>
        ) : (
          <>
            <Wand2 className="h-4 w-4" />
            Generate
          </>
        )}
      </button>

      {error && (
        <div className="panel p-3 border-accent-hot/40 bg-accent-hot/5 text-accent-hot text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="panel p-3 space-y-1">
          <p className="text-xs font-medium text-text-dim uppercase tracking-wide">Result</p>
          <p className="text-xs text-text-subtle font-mono">
            {(result.files as string[] | undefined)?.join(", ") ?? JSON.stringify(result).slice(0, 200)}
          </p>
          <p className="text-xs text-text-subtle">
            Cost: ${((result.cost_usd as number) ?? 0).toFixed(4)}
          </p>
        </div>
      )}
    </div>
  );
}

function BackgroundGenerator() {
  const [layers, setLayers] = useState("sky,far,mid,near");
  return (
    <SimpleGenForm
      endpoint="/api/asset-gen/background"
      placeholder='"misty forest with pine trees at golden hour"'
      extraContent={
        <div className="space-y-1">
          <label className="text-xs text-text-dim">Layers (comma-separated)</label>
          <input
            className="w-full bg-bg-subtle border border-line rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
            value={layers}
            onChange={(e) => setLayers(e.target.value)}
          />
        </div>
      }
      extraData={{ layers: layers.split(",").map((l) => l.trim()).filter(Boolean) }}
    />
  );
}

function TilesetGenerator() {
  const [tileType, setTileType] = useState("ground");
  return (
    <SimpleGenForm
      endpoint="/api/asset-gen/tileset"
      placeholder='"mossy stone dungeon floor with cracks"'
      extraContent={
        <div className="space-y-1">
          <label className="text-xs text-text-dim">Tile Type</label>
          <select
            className="w-full bg-bg-subtle border border-line rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
            value={tileType}
            onChange={(e) => setTileType(e.target.value)}
          >
            {["ground", "wall", "platform", "decoration"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      }
      extraData={{ tile_type: tileType }}
    />
  );
}

function UIElementGenerator() {
  const [elementType, setElementType] = useState("button");
  return (
    <SimpleGenForm
      endpoint="/api/asset-gen/ui-element"
      placeholder='"fantasy wooden button with gold border"'
      extraContent={
        <div className="space-y-1">
          <label className="text-xs text-text-dim">Element Type</label>
          <select
            className="w-full bg-bg-subtle border border-line rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
            value={elementType}
            onChange={(e) => setElementType(e.target.value)}
          >
            {["button", "panel", "health_bar", "icon", "frame"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      }
      extraData={{ element_type: elementType }}
    />
  );
}

function ParticleFXGenerator() {
  const [fxType, setFxType] = useState("dust");
  return (
    <SimpleGenForm
      endpoint="/api/asset-gen/particle-fx"
      placeholder='"golden sparkle burst with warm glow"'
      extraContent={
        <div className="space-y-1">
          <label className="text-xs text-text-dim">FX Type</label>
          <select
            className="w-full bg-bg-subtle border border-line rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
            value={fxType}
            onChange={(e) => setFxType(e.target.value)}
          >
            {["dust", "spark", "impact", "magic", "smoke"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      }
      extraData={{ fx_type: fxType }}
    />
  );
}


function SimpleGenForm({
  endpoint,
  placeholder,
  extraContent,
  extraData,
}: {
  endpoint: string;
  placeholder: string;
  extraContent: React.ReactNode;
  extraData: Record<string, unknown>;
}) {
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (!description.trim()) { setError("Enter a description."); return; }
    setGenerating(true); setError(null); setResult(null);
    try {
      const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001";
      const res = await fetch(`${BACKEND}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim(), ...extraData }),
      });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
    finally { setGenerating(false); }
  }

  return (
    <div className="space-y-4">
      <div className="panel p-4 space-y-3">
        <textarea
          className="w-full bg-bg-subtle border border-line rounded-md px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:border-accent"
          placeholder={placeholder}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {extraContent}
      </div>

      <button
        onClick={generate}
        disabled={generating || !description.trim()}
        className="btn-primary flex items-center gap-2 w-full justify-center py-2.5 text-sm disabled:opacity-50"
      >
        {generating
          ? <><div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />Generating...</>
          : <><Wand2 className="h-4 w-4" />Generate</>}
      </button>

      {error && <div className="panel p-3 border-accent-hot/40 bg-accent-hot/5 text-accent-hot text-sm">{error}</div>}
      {result && (
        <div className="panel p-3 text-xs text-text-subtle space-y-1">
          <p className="font-mono">{(result.files as string[] | undefined)?.join(", ")}</p>
          <p>Cost: ${((result.cost_usd as number) ?? 0).toFixed(4)}</p>
        </div>
      )}
    </div>
  );
}
