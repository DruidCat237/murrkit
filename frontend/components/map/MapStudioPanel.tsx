"use client";

/**
 * MapStudioPanel — the "Map" dock tab (Map Studio phase 4).
 *
 * One shared file per map: `phaser_game/maps/<id>.map.yaml` is edited here by
 * the human AND written by the captain — this panel never invents its own map
 * format. It offers: map list, YAML editor with LIVE backend validation
 * (`POST /api/maps/parse`, same rules the game compiler enforces), an
 * approximate biome-region preview, per-biome tileset generation staged
 * through the gen-queue accept-gate, and an "open in game" link.
 *
 * The canvas preview intentionally repaints ONLY regions (rects in order +
 * Voronoi seeds for unclaimed cells) — transitions/variants are the Phaser
 * compiler's job. Keep the painting rules in lockstep with
 * `phaser_game/src/builders/buildMapFromYAML.ts` `compileMap`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Map as MapIcon, Plus, RefreshCw, Save, Wand2 } from "lucide-react";
import { aiPaintMap, getMap, listMaps, parseMap, planBiomeTilesets, saveMap } from "@/lib/api";
import type { MapDetail, MapListEntry, MapTilesetStatus } from "@/lib/types";
import { applyPaintBlockToYaml, type PaintableSpec } from "@/lib/mapPaint";
import MapPainter from "./MapPainter";
import { useToasts } from "../Toaster";
import { useLayout } from "@/store/layout";

const NEW_MAP_TEMPLATE = (id: string): string => `id: ${id}
tileSize: 32
width: 40
height: 30
seed: 1

tilesets:
  - biome: grass
    color: "#5da548"
    decorDensity: 0.06
  - biome: water
    color: "#3a76c4"
    walkable: false

biomes:
  - { biome: water, rect: [26, 18, 10, 8] }

objects:
  - { name: hero_start, type: spawn, x: 6, y: 6 }
`;

type SpecLite = PaintableSpec & { notes?: string };

export default function MapStudioPanel({ projectName }: { projectName: string }) {
  const toast = useToasts();
  const openQueue = useLayout((s) => s.setActiveBottomTab);

  const [maps, setMaps] = useState<MapListEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MapDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [yamlText, setYamlText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [liveErrors, setLiveErrors] = useState<string[]>([]);
  const [liveSpec, setLiveSpec] = useState<SpecLite | null>(null);

  const [newId, setNewId] = useState("");
  const [creating, setCreating] = useState(false);

  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [staging, setStaging] = useState<string | null>(null); // biome being staged, or "*"
  const [viewMode, setViewMode] = useState<"paint" | "yaml">("paint");
  const [aiBusy, setAiBusy] = useState(false);

  // Refs mirroring fast-changing state, so async callbacks can check the
  // LATEST value after an await instead of their stale closure copy.
  const yamlRef = useRef("");
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const applyYaml = useCallback((text: string) => {
    yamlRef.current = text;
    setYamlText(text);
  }, []);

  const refreshList = useCallback(async (selectFirst = false) => {
    setListError(null);
    try {
      const res = await listMaps();
      setMaps(res.maps);
      if (selectFirst && res.maps.length > 0) setSelected((cur) => cur ?? res.maps[0].id);
    } catch (e) {
      setMaps([]);
      setListError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refreshList(true); }, [refreshList]);

  // Seq guard: click A then quickly B — A's slow response must not overwrite
  // B's editor (worst case the user would SAVE A's yaml into B's file).
  const loadSeq = useRef(0);
  const loadDetail = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    setDetailLoading(true);
    setSaveError(null);
    try {
      const d = await getMap(id, projectName);
      if (seq !== loadSeq.current) return; // stale — a newer load started
      setDetail(d);
      applyYaml(d.yaml);
      setDirty(false);
      setPrompts({}); // per-map prompts — grass of map A must not leak into map B
      setLiveErrors(d.errors);
      setLiveSpec((d.spec as SpecLite) ?? null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setDetail(null);
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setDetailLoading(false);
    }
  }, [projectName, applyYaml]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  // Live validation, debounced. Seq guard: a slow older parse must not
  // overwrite the verdict of a newer keystroke.
  const parseSeq = useRef(0);
  useEffect(() => {
    if (!dirty) return;
    const seq = ++parseSeq.current;
    const t = setTimeout(() => {
      parseMap(yamlText)
        .then((r) => {
          if (parseSeq.current !== seq) return;
          setLiveErrors(r.errors);
          setLiveSpec((r.spec as SpecLite) ?? null);
        })
        .catch((e) => {
          if (parseSeq.current !== seq) return;
          setLiveErrors([e instanceof Error ? e.message : String(e)]);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [yamlText, dirty]);

  const onSave = useCallback(async () => {
    if (!selected) return;
    const mapId = selected;
    const savedText = yamlRef.current;
    setSaving(true);
    setSaveError(null);
    try {
      await saveMap(mapId, savedText);
      toast.success(`Saved ${mapId}.map.yaml`);
      // Keystrokes typed DURING the round-trip must survive: only clear the
      // dirty flag when the editor still holds exactly what was written.
      if (yamlRef.current === savedText) setDirty(false);
      // Refresh tileset statuses WITHOUT touching the editor text.
      const d = await getMap(mapId, projectName);
      if (selectedRef.current === mapId) {
        setDetail(d);
        if (yamlRef.current === savedText) {
          setLiveErrors(d.errors);
          setLiveSpec((d.spec as SpecLite) ?? null);
        }
      }
      void refreshList();
    } catch (e) {
      // Keep the message inline AND selectable — a toast alone vanishes.
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, projectName, toast, refreshList]);

  const onCreate = useCallback(async () => {
    const id = newId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      toast.error("Map id: lowercase letters, digits, _ or - (starts alphanumeric)");
      return;
    }
    setCreating(true);
    try {
      await saveMap(id, NEW_MAP_TEMPLATE(id));
      toast.success(`Created ${id}.map.yaml`);
      setNewId("");
      await refreshList();
      setSelected(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [newId, toast, refreshList]);

  const themeHint = useMemo(() => {
    const notes = (liveSpec as { notes?: string } | null)?.notes;
    return typeof notes === "string" && notes.trim() ? notes.trim().split("\n")[0] : "";
  }, [liveSpec]);

  const promptFor = useCallback((biome: string): string => {
    return prompts[biome] ?? `${themeHint || detail?.id || "game world"} — ${biome} terrain, cohesive pixel art`;
  }, [prompts, themeHint, detail]);

  const stageBiomes = useCallback(async (targets: MapTilesetStatus[], label: string) => {
    if (targets.length === 0) return;
    if (dirty) {
      toast.warn("Save the map first — staging uses the saved biome list.");
      return;
    }
    setStaging(label);
    try {
      // Style anchor: the first ALREADY-generated biome's sheet (if any).
      const anchor = detail?.tilesets.find((t) => t.published_disk_path)?.published_disk_path ?? undefined;
      const res = await planBiomeTilesets(
        projectName,
        targets.map((t) => ({
          biome: t.biome,
          prompt: promptFor(t.biome),
          baseImagePath: t.published_disk_path ? undefined : anchor,
        })),
      );
      toast.success(
        `Staged ${res.count} biome tileset${res.count === 1 ? "" : "s"} ` +
        `($${res.total_cost_usd.toFixed(2)}) — Accept in the Queue to generate`,
      );
      openQueue("bot-gen-queue");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStaging(null);
    }
  }, [detail, dirty, projectName, promptFor, toast, openQueue]);

  // Painter → yaml: swap only the `paint:` block (comments elsewhere survive),
  // then the normal dirty/validate/Save flow takes over.
  const onApplyPaint = useCallback((block: string | null) => {
    applyYaml(applyPaintBlockToYaml(yamlRef.current, block));
    setDirty(true);
  }, [applyYaml]);

  const onAiPaint = useCallback(async (instruction: string, rowsHint: string[]) => {
    if (!selected) return null;
    if (dirty) {
      toast.warn("Zapisz mapę przed AI paint — model czyta zapisany plik.");
      return null;
    }
    setAiBusy(true);
    try {
      const res = await aiPaintMap(selected, instruction, rowsHint);
      toast.success(
        `AI pomalowało mapę ($${res.cost_usd.toFixed(3)}` +
        `${res.downscale > 1 ? `, malowane w skali 1/${res.downscale}` : ""}) — Ctrl+Z cofa`,
      );
      return { legend: res.legend, rows: res.rows };
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setAiBusy(false);
    }
  }, [selected, dirty, toast]);

  const valid = liveErrors.length === 0;
  const missing = detail?.tilesets.filter((t) => !t.suggested_exists && !t.image_exists) ?? [];

  return (
    <div className="flex h-full min-h-0">
      {/* ---- left: map list ---- */}
      <aside className="w-52 shrink-0 border-r border-line flex flex-col">
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line">
          <MapIcon className="h-3.5 w-3.5 opacity-70" />
          <span className="text-xs font-semibold flex-1">Maps</span>
          <button
            className="btn-ghost rounded p-1"
            title="Refresh map list"
            onClick={() => void refreshList()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {maps === null && (
            <div className="p-3 text-xs opacity-60 flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          )}
          {listError && (
            <div className="p-3 text-xs text-red-400 select-text">
              {listError}
              <button className="btn text-xs px-2 py-1 mt-2 w-full" onClick={() => void refreshList()}>Retry</button>
            </div>
          )}
          {maps !== null && !listError && maps.length === 0 && (
            <div className="p-3 text-xs opacity-60">
              No maps yet. Create one below — it is playable immediately with
              placeholder colours.
            </div>
          )}
          {maps?.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                if (m.id === selected) return;
                if (dirty && !window.confirm("Discard unsaved changes to the current map?")) return;
                setSelected(m.id);
              }}
              className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 ${
                selected === m.id ? "bg-white/10 font-semibold" : ""
              }`}
            >
              {m.id}
            </button>
          ))}
        </div>
        <div className="p-2 border-t border-line flex gap-1">
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); }}
            placeholder="new_map_id"
            className="flex-1 min-w-0 bg-bg border border-line rounded px-2 py-1 text-xs"
          />
          <button
            className="btn text-xs px-2 py-1 disabled:opacity-50"
            disabled={creating || newId.trim() === ""}
            title="Create map from starter template"
            onClick={() => void onCreate()}
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </button>
        </div>
      </aside>

      {/* ---- main ---- */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!selected && (
          <div className="flex-1 grid place-items-center text-sm opacity-60 p-6 text-center">
            Select a map — or create one. The captain follows the same files
            (phaser_game/maps/*.map.yaml).
          </div>
        )}
        {selected && (
          <>
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line text-xs">
              <span className="font-semibold">{selected}.map.yaml</span>
              {dirty && <span className="opacity-60">• unsaved</span>}
              <span className={`ml-2 ${valid ? "text-emerald-400" : "text-red-400"}`}>
                {valid ? "✓ valid" : `${liveErrors.length} problem${liveErrors.length === 1 ? "" : "s"}`}
              </span>
              <div className="flex-1" />
              <a
                className="btn text-xs px-2 py-1 inline-flex items-center gap-1 disabled:opacity-50"
                href={`http://localhost:5173/?level=${encodeURIComponent(selected)}`}
                target="_blank"
                rel="noreferrer"
                title="Open this map in the running Phaser dev server"
              >
                <ExternalLink className="h-3 w-3" /> Open in game
              </a>
              <button
                className="btn btn-primary text-xs px-2 py-1 inline-flex items-center gap-1 disabled:opacity-50"
                disabled={saving || !dirty || !valid}
                title={!valid ? "Fix validation problems first" : !dirty ? "No changes" : "Save map.yaml"}
                onClick={() => void onSave()}
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </button>
            </div>

            {detailLoading && (
              <div className="p-4 text-xs opacity-60 flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading map…
              </div>
            )}

            {!detailLoading && (
              <div className="flex-1 min-h-0 flex">
                {/* editor area: RPG-Maker painter | raw YAML */}
                <div className="flex-1 min-w-0 flex flex-col border-r border-line">
                  <div className="flex items-center gap-1 px-2 py-1 border-b border-line">
                    <button
                      className={`btn-ghost rounded px-2 py-0.5 text-xs ${viewMode === "paint" ? "bg-white/15 font-semibold" : ""}`}
                      onClick={() => setViewMode("paint")}
                      title="Maluj mapę per-kafel (pędzel, prostokąt, wypełnianie, AI)"
                    >
                      Paint
                    </button>
                    <button
                      className={`btn-ghost rounded px-2 py-0.5 text-xs ${viewMode === "yaml" ? "bg-white/15 font-semibold" : ""}`}
                      onClick={() => setViewMode("yaml")}
                      title="Surowy map.yaml — ten sam plik edytuje kapitan"
                    >
                      YAML
                    </button>
                  </div>
                  {viewMode === "paint" ? (
                    <MapPainter
                      key={selected /* full remount per map — unapplied strokes must never leak across maps */}
                      spec={valid ? (liveSpec as SpecLite) : null}
                      aiBusy={aiBusy}
                      onApply={onApplyPaint}
                      onAiPaint={onAiPaint}
                    />
                  ) : (
                    <textarea
                      value={yamlText}
                      onChange={(e) => { applyYaml(e.target.value); setDirty(true); }}
                      spellCheck={false}
                      className="flex-1 min-h-0 w-full resize-none bg-transparent p-3 font-mono text-xs outline-none"
                    />
                  )}
                  {(liveErrors.length > 0 || saveError) && (
                    <div className="max-h-28 overflow-y-auto border-t border-line p-2 text-xs text-red-400 select-text space-y-0.5">
                      {saveError && <div>save failed: {saveError}</div>}
                      {liveErrors.map((e, i) => <div key={i}>• {e}</div>)}
                    </div>
                  )}
                </div>

                {/* right: biome tilesets */}
                <div className="w-72 shrink-0 flex flex-col overflow-y-auto">
                  <div className="px-3 py-2 border-t border-line">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold">Biome tilesets</span>
                      <button
                        className="btn text-xs px-2 py-1 inline-flex items-center gap-1 disabled:opacity-50"
                        disabled={staging !== null || missing.length === 0}
                        title={
                          missing.length === 0
                            ? "Every biome already has a generated sheet"
                            : `Stage ${missing.length} missing tileset(s) in the gen-queue`
                        }
                        onClick={() => void stageBiomes(missing, "*")}
                      >
                        {staging === "*" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                        Generate missing
                      </button>
                    </div>
                    {(detail?.tilesets ?? []).length === 0 && (
                      <div className="text-xs opacity-60">Declare biomes under `tilesets:` to see them here.</div>
                    )}
                    {(detail?.tilesets ?? []).map((t) => (
                      <div key={t.biome} className="mb-2 rounded border border-line p-2">
                        <div className="flex items-center gap-2 text-xs">
                          <span
                            className="inline-block h-3 w-3 rounded-sm border border-white/20"
                            style={{ backgroundColor: t.color ?? "#888" }}
                          />
                          <span className="font-semibold flex-1">{t.biome}</span>
                          {!t.walkable && <span className="opacity-60" title="Avatar collides with this biome">solid</span>}
                          <span
                            className={t.suggested_exists || t.image_exists ? "text-emerald-400" : "opacity-60"}
                            title={t.suggested_exists || t.image_exists
                              ? "A generated sheet is published for this biome"
                              : "Renders as placeholder colours until generated"}
                          >
                            {t.suggested_exists || t.image_exists ? "art ✓" : "placeholder"}
                          </span>
                        </div>
                        <input
                          value={promptFor(t.biome)}
                          onChange={(e) => setPrompts((p) => ({ ...p, [t.biome]: e.target.value }))}
                          className="mt-1.5 w-full bg-bg border border-line rounded px-2 py-1 text-xs"
                          title="Generation prompt for this biome's tileset"
                        />
                        <button
                          className="btn text-xs px-2 py-1 mt-1.5 w-full disabled:opacity-50"
                          disabled={staging !== null}
                          onClick={() => void stageBiomes([t], t.biome)}
                          title="Stage ONE biome_tileset row in the gen-queue (accept-gate applies)"
                        >
                          {staging === t.biome
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : (t.suggested_exists || t.image_exists ? "Regenerate" : "Generate")}
                        </button>
                      </div>
                    ))}
                    <p className="text-[10px] leading-snug opacity-50 mt-1">
                      Sheets publish to <code className="select-text">/assets/tilesets/{projectName || "default"}/&lt;biome&gt;/sheet.png</code>.
                      Reference that path as <code>image:</code> in the YAML (a 404 falls back to placeholder).
                    </p>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// (The old approximate RegionPreview was superseded by MapPainter, which
// renders the exact base+paint merge and edits it in place.)
