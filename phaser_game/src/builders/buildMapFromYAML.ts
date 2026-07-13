/**
 * buildMapFromYAML.ts — deterministic MapSpec → Tiled JSON compiler + Phaser glue.
 *
 * `compileMap` is PURE (spec in → Tiled JSON + biome grid out, seeded PRNG, no
 * Phaser): the same YAML always yields byte-identical map data, so a map bug is
 * always a spec bug, never a builder race. `buildTilemap` is the thin scene
 * glue: it feeds the compiled JSON to Phaser's native Tiled loader, creating
 * placeholder tileset textures for any biome whose sheet isn't loaded yet.
 *
 * Border transitions: along a border the LATER-declared biome (higher index in
 * `spec.tilesets`) stays full interior and the earlier biome renders its edge /
 * corner tile facing it — exactly one side of every border transitions, which
 * reads as "forest sits on top of grass".
 */

import Phaser from "phaser";
import {
  MAP_TILESET_COLUMNS, MAP_TILESET_ROWS, MAP_TILESET_TILECOUNT, TILE,
  biomeColor, validateMapSpec,
  type BiomeTilesetSpec, type MapSpec,
} from "@/builders/mapSpec";

// ---------------------------------------------------------------------------
// Compile: MapSpec → Tiled JSON
// ---------------------------------------------------------------------------

export interface CompiledMap {
  spec: MapSpec;
  /** Standard Tiled JSON — Phaser parses this natively (Formats.TILED_JSON). */
  tiled: Record<string, unknown>;
  /** Per-cell biome index into `spec.tilesets` (row-major, width×height). */
  biomeGrid: Int16Array;
  /** Texture key per biome (index-aligned with `spec.tilesets`). */
  textureKeys: string[];
  /** firstgid per biome (index-aligned with `spec.tilesets`). */
  firstGids: number[];
  /** Ground-layer gids that must collide (all 16 tiles of non-walkable biomes). */
  collisionGids: number[];
  /** Tile coords of the `spawn` object, if any. */
  spawn: { x: number; y: number } | null;
}

/** mulberry32 — tiny deterministic PRNG so variant/decor picks are stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function textureKeyFor(t: BiomeTilesetSpec): string {
  return t.key ?? `tiles_${t.biome}`;
}

export function compileMap(spec: MapSpec): CompiledMap {
  validateMapSpec(spec);
  const { width: W, height: H, tileSize: T } = spec;
  const rand = mulberry32(spec.seed ?? hashString(spec.id));

  const biomeIndex = new Map(spec.tilesets.map((t, i) => [t.biome, i]));
  const defaultIdx = biomeIndex.get(spec.defaultBiome ?? spec.tilesets[0].biome) ?? 0;

  // ---- paint biome grid: rects in order (later wins), then Voronoi seeds ----
  const grid = new Int16Array(W * H).fill(defaultIdx);
  const claimed = new Uint8Array(W * H); // painted by a rect
  const seeds: Array<{ x: number; y: number; bi: number }> = [];

  for (const region of spec.biomes ?? []) {
    const bi = biomeIndex.get(region.biome)!;
    if (region.rect) {
      const [rx, ry, rw, rh] = region.rect;
      const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry));
      const x1 = Math.min(W, Math.floor(rx + rw)), y1 = Math.min(H, Math.floor(ry + rh));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) { grid[y * W + x] = bi; claimed[y * W + x] = 1; }
      }
    }
    if (region.seed) seeds.push({ x: region.seed[0], y: region.seed[1], bi });
  }
  if (seeds.length > 0) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (claimed[i]) continue;
        let best = 0, bestD = Infinity;
        for (let s = 0; s < seeds.length; s++) {
          const dx = x - seeds[s].x, dy = y - seeds[s].y;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = s; }
        }
        grid[i] = seeds[best].bi;
      }
    }
  }

  // ---- paint layer: per-cell overrides win over every region --------------
  // (Validation already guaranteed legend chars map to declared biomes.)
  if (spec.paint) {
    const legend = spec.paint.legend;
    const nRows = Math.min(H, spec.paint.rows.length);
    for (let y = 0; y < nRows; y++) {
      const row = spec.paint.rows[y];
      const nCols = Math.min(W, row.length);
      for (let x = 0; x < nCols; x++) {
        const ch = row[x];
        if (ch === ".") continue;
        const bi = biomeIndex.get(legend[ch]);
        if (bi !== undefined) grid[y * W + x] = bi;
      }
    }
  }

  // ---- pick tiles: interior variants + edge/corner transitions ------------
  const firstGids = spec.tilesets.map((_, i) => 1 + i * MAP_TILESET_TILECOUNT);
  const at = (x: number, y: number, self: number): number =>
    x < 0 || y < 0 || x >= W || y >= H ? self : grid[y * W + x]; // world border = same biome

  const ground = new Array<number>(W * H);
  const decor = new Array<number>(W * H).fill(0);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const p = grid[i];
      // A neighbour of a LATER-declared biome overlaps us → transition that way.
      const n = at(x, y - 1, p) > p, e = at(x + 1, y, p) > p,
            s = at(x, y + 1, p) > p, w = at(x - 1, y, p) > p;
      let tile: number;
      const sides = (n ? 1 : 0) + (e ? 1 : 0) + (s ? 1 : 0) + (w ? 1 : 0);
      if (sides === 0) {
        const r = rand();
        tile = r < 0.55 ? TILE.C : r < 0.7 ? TILE.V1 : r < 0.85 ? TILE.V2 : TILE.V3;
        const t0 = spec.tilesets[p];
        const density = t0.decorDensity ?? 0;
        if (density > 0 && rand() < density) {
          decor[i] = firstGids[p] + TILE.D0 + Math.floor(rand() * 4);
        }
      } else if (sides === 1) {
        tile = n ? TILE.T : e ? TILE.R : s ? TILE.B : TILE.L;
      } else if (sides === 2 && ((n && w) || (n && e) || (s && w) || (s && e))) {
        tile = n && w ? TILE.TL : n && e ? TILE.TR : s && w ? TILE.BL : TILE.BR;
      } else {
        tile = TILE.C; // opposite sides / 3-4 neighbours: strip too thin, stay plain
      }
      ground[i] = firstGids[p] + tile;
    }
  }

  // ---- objects -------------------------------------------------------------
  let spawn: { x: number; y: number } | null = null;
  const tiledObjects = (spec.objects ?? []).map((o, idx) => {
    if ((o.type ?? "marker") === "spawn" && spawn === null) spawn = { x: o.x, y: o.y };
    return {
      id: idx + 1, name: o.name, type: o.type ?? "marker",
      x: o.x * T, y: o.y * T, width: 0, height: 0,
      point: true, visible: true, rotation: 0,
    };
  });

  // ---- Tiled JSON ------------------------------------------------------------
  const textureKeys = spec.tilesets.map(textureKeyFor);
  const sheetPx = MAP_TILESET_COLUMNS * T;
  const tiled: Record<string, unknown> = {
    type: "map", version: "1.10", tiledversion: "1.10.2",
    orientation: "orthogonal", renderorder: "right-down", infinite: false,
    width: W, height: H, tilewidth: T, tileheight: T,
    nextlayerid: 4, nextobjectid: tiledObjects.length + 1,
    tilesets: spec.tilesets.map((t, i) => ({
      firstgid: firstGids[i],
      name: textureKeys[i],
      tilewidth: T, tileheight: T,
      tilecount: MAP_TILESET_TILECOUNT, columns: MAP_TILESET_COLUMNS,
      image: t.image ?? `__placeholder__/${t.biome}.png`,
      imagewidth: sheetPx, imageheight: MAP_TILESET_ROWS * T,
      margin: 0, spacing: 0,
    })),
    layers: [
      { id: 1, name: "ground", type: "tilelayer", width: W, height: H,
        x: 0, y: 0, opacity: 1, visible: true, data: ground },
      { id: 2, name: "decor", type: "tilelayer", width: W, height: H,
        x: 0, y: 0, opacity: 1, visible: true, data: decor },
      { id: 3, name: "objects", type: "objectgroup", objects: tiledObjects,
        x: 0, y: 0, opacity: 1, visible: true },
    ],
  };

  const collisionGids: number[] = [];
  spec.tilesets.forEach((t, i) => {
    if (t.walkable === false) {
      for (let k = 0; k < MAP_TILESET_TILECOUNT; k++) collisionGids.push(firstGids[i] + k);
    }
  });

  return { spec, tiled, biomeGrid: grid, textureKeys, firstGids, collisionGids, spawn };
}

// ---------------------------------------------------------------------------
// Scene glue: compiled map → live Phaser tilemap
// ---------------------------------------------------------------------------

export interface BuiltMap {
  map: Phaser.Tilemaps.Tilemap;
  groundLayer: Phaser.Tilemaps.TilemapLayer;
  decorLayer: Phaser.Tilemaps.TilemapLayer | null;
  compiled: CompiledMap;
  /** Biomes that rendered with placeholder colours (sheet missing / not loaded). */
  placeholderBiomes: string[];
}

/**
 * Build the tilemap into `scene`. Any biome whose texture key is not already
 * loaded gets a deterministic placeholder sheet drawn on a CanvasTexture —
 * the map ALWAYS renders, art streams in later without touching the YAML.
 */
export function buildTilemap(scene: Phaser.Scene, compiled: CompiledMap): BuiltMap {
  const { spec, tiled, textureKeys, collisionGids } = compiled;

  const placeholderBiomes: string[] = [];
  spec.tilesets.forEach((t, i) => {
    // NOTE: a texture created here persists in the TextureManager for the
    // Game's lifetime. Today that's safe — swapping placeholder→real art
    // always goes through a Vite full page reload (yaml edits invalidate the
    // eager raw glob; no import.meta.hot handler exists). IF a live editor
    // ever calls scene.restart() with a changed tileSize or freshly-published
    // sheet, this check must also compare the existing texture's dimensions
    // and destroy/recreate on mismatch.
    if (!scene.textures.exists(textureKeys[i])) {
      makePlaceholderTexture(scene, textureKeys[i], t, spec.tileSize);
      placeholderBiomes.push(t.biome);
    }
  });

  const cacheKey = `map_${spec.id}`;
  scene.cache.tilemap.remove(cacheKey); // idempotent rebuild (scene restarts)
  scene.cache.tilemap.add(cacheKey, { format: Phaser.Tilemaps.Formats.TILED_JSON, data: tiled });

  const map = scene.make.tilemap({ key: cacheKey });
  const tilesets = spec.tilesets.map((_, i) =>
    map.addTilesetImage(textureKeys[i], textureKeys[i])!,
  );
  const groundLayer = map.createLayer("ground", tilesets, 0, 0)!;
  const decorLayer = map.createLayer("decor", tilesets, 0, 0);
  if (collisionGids.length > 0) groundLayer.setCollision(collisionGids);

  return { map, groundLayer, decorLayer, compiled, placeholderBiomes };
}

/**
 * Draw a 4×4 placeholder sheet for a biome: interior cells in the biome colour
 * (variants jittered), edge/corner cells with a darker band on the sides that
 * transition, decor cells as small alpha dots. Layout mirrors the real
 * generated sheets, so transitions are previewable before any art exists.
 */
function makePlaceholderTexture(
  scene: Phaser.Scene, key: string, t: BiomeTilesetSpec, tileSize: number,
): void {
  const cols = MAP_TILESET_COLUMNS, rows = MAP_TILESET_ROWS;
  const tex = scene.textures.createCanvas(key, cols * tileSize, rows * tileSize);
  if (!tex) return; // key collision — texture already exists
  const ctx = tex.getContext();
  const base = biomeColor(t);
  const rgb = { r: (base >> 16) & 0xff, g: (base >> 8) & 0xff, b: base & 0xff };
  const css = (f: number): string =>
    `rgb(${Math.round(rgb.r * f)},${Math.round(rgb.g * f)},${Math.round(rgb.b * f)})`;

  // Which sides of each role tile carry the transition band.
  const bands: Record<number, Array<"n" | "e" | "s" | "w">> = {
    [TILE.TL]: ["n", "w"], [TILE.T]: ["n"], [TILE.TR]: ["n", "e"],
    [TILE.L]: ["w"], [TILE.C]: [], [TILE.R]: ["e"],
    [TILE.BL]: ["s", "w"], [TILE.B]: ["s"], [TILE.BR]: ["s", "e"],
  };
  const bw = Math.max(2, Math.floor(tileSize / 6)); // band width

  for (let idx = 0; idx < MAP_TILESET_TILECOUNT; idx++) {
    const cx = (idx % cols) * tileSize, cy = Math.floor(idx / cols) * tileSize;
    if (idx >= TILE.D0) {
      // decor: transparent cell with a small dot so scattering is visible
      ctx.clearRect(cx, cy, tileSize, tileSize);
      ctx.fillStyle = css(0.7);
      ctx.beginPath();
      ctx.arc(cx + tileSize / 2, cy + tileSize / 2, tileSize / (5 + (idx - TILE.D0)), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const jitter = idx >= TILE.V1 ? 1 + 0.06 * (idx - TILE.V1 + 1) : 1;
    ctx.fillStyle = css(jitter);
    ctx.fillRect(cx, cy, tileSize, tileSize);
    for (const side of bands[idx] ?? []) {
      ctx.fillStyle = css(0.55);
      if (side === "n") ctx.fillRect(cx, cy, tileSize, bw);
      if (side === "s") ctx.fillRect(cx, cy + tileSize - bw, tileSize, bw);
      if (side === "w") ctx.fillRect(cx, cy, bw, tileSize);
      if (side === "e") ctx.fillRect(cx + tileSize - bw, cy, bw, tileSize);
    }
  }
  tex.refresh();
}
