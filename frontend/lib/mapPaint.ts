/**
 * mapPaint.ts — pure helpers behind the Map Studio painter.
 *
 * The paint model mirrors the game compiler exactly (keep in LOCKSTEP with
 * `phaser_game/src/builders/buildMapFromYAML.ts`):
 *   base   = defaultBiome, then region rects in order, then Voronoi seeds
 *   paint  = per-cell overrides (-1 = transparent → base shows through)
 * Serialization writes a `paint:` block with QUOTED single-char legend keys
 * and QUOTED row strings (bare y/n would parse as booleans in PyYAML), and
 * `applyPaintBlockToYaml` swaps ONLY that block via line surgery so hand
 * comments elsewhere in the file survive untouched.
 */

export interface PaintableTileset {
  biome: string;
  color?: string;
  walkable?: boolean;
}

export interface PaintableSpec {
  width?: number;
  height?: number;
  defaultBiome?: string;
  tilesets?: PaintableTileset[];
  biomes?: Array<{ biome: string; rect?: number[]; seed?: number[] }>;
  paint?: { legend?: Record<string, string>; rows?: string[] };
}

/** Same PRNG family as the game compiler — used only for preset generators. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Procedural base per cell (regions ONLY — no paint): biome index into tilesets. */
export function computeBaseGrid(spec: PaintableSpec): Int16Array {
  const W = spec.width ?? 0, H = spec.height ?? 0;
  const tilesets = spec.tilesets ?? [];
  const biomeIndex = new Map(tilesets.map((t, i) => [t.biome, i]));
  const defaultIdx = biomeIndex.get(spec.defaultBiome ?? tilesets[0]?.biome ?? "") ?? 0;
  const grid = new Int16Array(W * H).fill(defaultIdx);
  const claimed = new Uint8Array(W * H);
  const seeds: Array<{ x: number; y: number; bi: number }> = [];
  for (const r of spec.biomes ?? []) {
    const bi = biomeIndex.get(r.biome);
    if (bi === undefined) continue;
    if (r.rect && r.rect.length === 4) {
      const [rx, ry, rw, rh] = r.rect;
      for (let y = Math.max(0, Math.floor(ry)); y < Math.min(H, Math.floor(ry + rh)); y++) {
        for (let x = Math.max(0, Math.floor(rx)); x < Math.min(W, Math.floor(rx + rw)); x++) {
          grid[y * W + x] = bi; claimed[y * W + x] = 1;
        }
      }
    }
    if (r.seed && r.seed.length === 2) seeds.push({ x: r.seed[0], y: r.seed[1], bi });
  }
  if (seeds.length > 0) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
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
  return grid;
}

/** spec.paint → override grid (-1 where untouched). */
export function specPaintToGrid(spec: PaintableSpec): Int16Array {
  const W = spec.width ?? 0, H = spec.height ?? 0;
  const grid = new Int16Array(W * H).fill(-1);
  const paint = spec.paint;
  if (!paint?.legend || !paint.rows) return grid;
  const biomeIndex = new Map((spec.tilesets ?? []).map((t, i) => [t.biome, i]));
  for (let y = 0; y < Math.min(H, paint.rows.length); y++) {
    const row = paint.rows[y] ?? "";
    for (let x = 0; x < Math.min(W, row.length); x++) {
      const ch = row[x];
      if (ch === ".") continue;
      const bi = biomeIndex.get(paint.legend[ch] ?? "");
      if (bi !== undefined) grid[y * W + x] = bi;
    }
  }
  return grid;
}

/** Mirror of the backend's `_derive_legend`: reuse existing chars, then fill. */
export function deriveLegend(
  tilesets: PaintableTileset[],
  existing?: Record<string, string>,
): Record<string, string> {
  const legend: Record<string, string> = {};
  const biomes = tilesets.map((t) => t.biome);
  for (const [ch, b] of Object.entries(existing ?? {})) {
    if (ch.length === 1 && ch !== "." && biomes.includes(b)) legend[ch] = b;
  }
  const assigned = new Set(Object.values(legend));
  const pool = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (const b of biomes) {
    if (assigned.has(b)) continue;
    const candidates = (b[0]?.toLowerCase() ?? "") + b.toLowerCase() + pool;
    const ch = [...candidates].find((c) => /[a-z0-9]/.test(c) && legend[c] === undefined);
    if (ch) { legend[ch] = b; assigned.add(b); }
  }
  return legend;
}

/** Paint grid → trimmed rows + minimal legend (only chars actually used). */
export function gridToPaintRows(
  grid: Int16Array, W: number, H: number, tilesets: PaintableTileset[],
  existingLegend?: Record<string, string>,
): { legend: Record<string, string>; rows: string[] } {
  const legend = deriveLegend(tilesets, existingLegend);
  const charFor = new Map(Object.entries(legend).map(([ch, b]) => [
    tilesets.findIndex((t) => t.biome === b), ch,
  ]));
  const rows: string[] = [];
  for (let y = 0; y < H; y++) {
    let row = "";
    for (let x = 0; x < W; x++) {
      const v = grid[y * W + x];
      row += v >= 0 ? (charFor.get(v) ?? ".") : ".";
    }
    rows.push(row.replace(/\.+$/, "")); // trim trailing dots — minimal diffs
  }
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  const used = new Set(rows.join(""));
  const usedLegend: Record<string, string> = {};
  for (const [ch, b] of Object.entries(legend)) if (used.has(ch)) usedLegend[ch] = b;
  return { legend: usedLegend, rows };
}

/** rows+legend (e.g. from /ai-paint) → override grid. */
export function rowsToGrid(
  rows: string[], legend: Record<string, string>,
  W: number, H: number, tilesets: PaintableTileset[],
): Int16Array {
  return specPaintToGrid({ width: W, height: H, tilesets, paint: { legend, rows } });
}

/** Serialize the yaml `paint:` block (null when the layer is empty). */
export function serializePaintBlock(
  legend: Record<string, string>, rows: string[],
): string | null {
  if (rows.length === 0 || Object.keys(legend).length === 0) return null;
  const legendInline = Object.entries(legend)
    .map(([ch, b]) => `"${ch}": ${b}`)
    .join(", ");
  const lines = [
    "paint:",
    `  legend: { ${legendInline} }`,
    "  rows:",
    ...rows.map((r) => `    - "${r}"`),
  ];
  return lines.join("\n");
}

/**
 * Replace (or insert / remove) the top-level `paint:` block in yaml TEXT.
 * Line surgery only — never re-serializes the document, so comments and
 * formatting everywhere else survive. `block === null` removes the layer.
 */
export function applyPaintBlockToYaml(yamlText: string, block: string | null): string {
  const lines = yamlText.split("\n");
  const isTop = (l: string): boolean => /^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(l);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^paint\s*:/.test(lines[i])) { start = i; break; }
  }
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !isTop(lines[end])) end++;
    // Preserve the blank line the block usually trails with.
    while (end > start + 1 && lines[end - 1].trim() === "") end--;
    const replacement = block === null ? [] : block.split("\n");
    lines.splice(start, end - start, ...replacement);
    return lines.join("\n");
  }
  if (block === null) return yamlText;
  // No existing block: insert before `objects:` when present, else append.
  const objIdx = lines.findIndex((l) => /^objects\s*:/.test(l));
  const insertion = [...block.split("\n"), ""];
  if (objIdx >= 0) lines.splice(objIdx, 0, ...insertion);
  else {
    if (lines[lines.length - 1]?.trim() !== "") lines.push("");
    lines.push(...block.split("\n"), "");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Auto-paint presets — deterministic given a seed; they OVERWRITE the layer.
// Interiors stay "." wherever possible so procedural variety shows through.
// ---------------------------------------------------------------------------

export type PresetId = "island" | "river" | "blobs" | "clear";

export const PRESETS: Array<{ id: PresetId; label: string }> = [
  { id: "island", label: "Wyspa (woda dookoła)" },
  { id: "river", label: "Rzeka (północ→południe)" },
  { id: "blobs", label: "Plamy wybranego biomu" },
  { id: "clear", label: "Wyczyść warstwę paint" },
];

export function runPreset(
  id: PresetId, W: number, H: number, tilesets: PaintableTileset[],
  selectedBiome: number, seed: number,
): Int16Array {
  const grid = new Int16Array(W * H).fill(-1);
  if (id === "clear" || W < 4 || H < 4) return grid;
  const rand = mulberry32(seed);
  const waterIdx = Math.max(0, tilesets.findIndex((t) => t.walkable === false));

  if (id === "island") {
    // Everything beyond a noisy radius becomes the solid biome; the island
    // interior stays "." so regions/variants render inside it.
    const cx = W / 2, cy = H / 2;
    const rBase = 0.86;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const nx = (x - cx) / cx, ny = (y - cy) / cy;
      const d = Math.sqrt(nx * nx + ny * ny) + (rand() - 0.5) * 0.22;
      if (d > rBase) grid[y * W + x] = waterIdx;
    }
  } else if (id === "river") {
    let x = Math.floor(W * (0.3 + rand() * 0.4));
    for (let y = 0; y < H; y++) {
      const width = 2 + Math.floor(rand() * 2);
      for (let dx = 0; dx < width; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx));
        grid[y * W + xx] = waterIdx;
      }
      x += Math.floor(rand() * 3) - 1;
      x = Math.min(W - 3, Math.max(1, x));
    }
  } else if (id === "blobs") {
    const nBlobs = 3 + Math.floor(rand() * 3);
    for (let b = 0; b < nBlobs; b++) {
      const bx = Math.floor(rand() * W), by = Math.floor(rand() * H);
      const r = 2 + rand() * Math.min(W, H) * 0.12;
      for (let y = Math.max(0, Math.floor(by - r)); y < Math.min(H, Math.ceil(by + r)); y++) {
        for (let x2 = Math.max(0, Math.floor(bx - r)); x2 < Math.min(W, Math.ceil(bx + r)); x2++) {
          const dx = x2 - bx, dy = y - by;
          if (dx * dx + dy * dy <= r * r * (0.7 + rand() * 0.5)) {
            grid[y * W + x2] = selectedBiome;
          }
        }
      }
    }
  }
  return grid;
}

/** Flood fill on the MERGED view (what the user sees), writing into paint. */
export function floodFill(
  paint: Int16Array, base: Int16Array, W: number, H: number,
  startX: number, startY: number, target: number,
): void {
  const merged = (i: number): number => (paint[i] >= 0 ? paint[i] : base[i]);
  const from = merged(startY * W + startX);
  if (from === target) return;
  // Pre-push filter: a cell enters the stack only while it still matches
  // `from`, so each cell is pushed at most once from each side BEFORE being
  // painted and the stack stays O(region). (Pushing all 4 neighbours
  // unconditionally let duplicates burn a W·H guard at ~25% region size.)
  const stack = [startY * W + startX];
  let guard = 4 * W * H + 8; // hard backstop only — never the fill limiter
  while (stack.length > 0 && guard-- > 0) {
    const i = stack.pop()!;
    if (merged(i) !== from) continue;
    paint[i] = target;
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && merged(i - 1) === from) stack.push(i - 1);
    if (x < W - 1 && merged(i + 1) === from) stack.push(i + 1);
    if (y > 0 && merged(i - W) === from) stack.push(i - W);
    if (y < H - 1 && merged(i + W) === from) stack.push(i + W);
  }
}

/** Full-width rows of the CURRENT paint layer (for the /ai-paint refine hint). */
export function gridToFullRows(
  grid: Int16Array, W: number, H: number, tilesets: PaintableTileset[],
  legend: Record<string, string>,
): string[] {
  const charFor = new Map(Object.entries(legend).map(([ch, b]) => [
    tilesets.findIndex((t) => t.biome === b), ch,
  ]));
  const rows: string[] = [];
  for (let y = 0; y < H; y++) {
    let row = "";
    for (let x = 0; x < W; x++) {
      const v = grid[y * W + x];
      row += v >= 0 ? (charFor.get(v) ?? ".") : ".";
    }
    rows.push(row);
  }
  return rows;
}
