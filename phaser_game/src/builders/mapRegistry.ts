/**
 * mapRegistry.ts — bundled map lookup, mirroring BootScene's level registry.
 *
 * Maps live in `phaser_game/maps/<id>.map.yaml` and are bundled at build time
 * (Vite raw glob) so `?level=<id>` can boot a map with zero fetches. main.ts
 * consults `hasMap` when routing the boot scene.
 */

const mapTexts = import.meta.glob("@maps/*.map.yaml", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

export function hasMap(id: string): boolean {
  return loadMapText(id) !== undefined;
}

export function loadMapText(id: string): string | undefined {
  for (const [path, text] of Object.entries(mapTexts)) {
    if (path.endsWith(`/${id}.map.yaml`)) return text;
  }
  return undefined;
}

export function listMapIds(): string[] {
  return Object.keys(mapTexts)
    .map((p) => p.split("/").pop()!.replace(/\.map\.yaml$/, ""))
    .sort();
}
