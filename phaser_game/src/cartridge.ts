import type Phaser from "phaser";

/**
 * Cartridge model — external games live OUTSIDE the engine's tracked source.
 *
 * Drop a game into `src/cartridges/<name>/` with an `index.ts` that default-
 * exports a {@link CartridgeModule}. That folder is **git-ignored**, so:
 *   - a clean clone has no cartridges → this glob resolves to nothing → only the
 *     built-in engine examples (slingshot / rpg_demo / platformer) are available;
 *   - locally, every cartridge is discovered automatically and reachable via
 *     `?level=<cartridge id>` — `git pull` never touches your private games.
 *
 * This file (the loader) is the only tracked, public part — it names no game.
 */
export type SceneCtor = new (...args: unknown[]) => Phaser.Scene;

export interface CartridgeModule {
  /** Routed via `?level=<id>` (e.g. "volleyball"). */
  id: string;
  /** Human label (for menus / dropdowns). */
  title: string;
  /** Scene classes; the FIRST one auto-starts (it should chain to the rest). */
  scenes: SceneCtor[];
}

// Vite evaluates this glob at build time. Zero matches → `{}` (no error).
const modules = import.meta.glob<{ default: CartridgeModule }>(
  "./cartridges/*/index.ts",
  { eager: true },
);

export const CARTRIDGES: Record<string, CartridgeModule> = {};
for (const mod of Object.values(modules)) {
  const c = mod?.default;
  if (c && typeof c.id === "string") CARTRIDGES[c.id] = c;
}

/** Scene list for a cartridge `?level=<id>`, or `null` if no such cartridge. */
export function cartridgeScenes(levelId: string): SceneCtor[] | null {
  return CARTRIDGES[levelId]?.scenes ?? null;
}
