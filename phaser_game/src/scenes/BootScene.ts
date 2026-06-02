import Phaser from "phaser";
import yaml from "js-yaml";
import type { AssetRef, LevelSpec } from "@/builders/levelSpec";
import {
  registerAnimsFromFramesJson,
  registerAnimsFromGrid,
  type FramesJson,
} from "@/systems/anims";

// Level YAML is bundled at build time (Phaser preload can't await fetches).
const levelTexts = import.meta.glob("@levels/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function loadLevelText(levelId: string): string | undefined {
  for (const [path, text] of Object.entries(levelTexts)) {
    if (path.endsWith(`/${levelId}.yaml`)) return text;
  }
  return undefined;
}

/**
 * BootScene — parse the bundled level YAML, queue every texture it references
 * (object sprites, alt poses, background/ground, slingshot cat poses, glass
 * cracks), then hand off to GameScene. Atlases load as plain images and are
 * sliced into frames on demand by `textureFrames.sliceFrame`.
 */
export class BootScene extends Phaser.Scene {
  constructor() { super({ key: "BootScene" }); }

  /** JSON keys for frames.json sidecars we OPTIONALLY probe — a 404 is normal. */
  private sidecarKeys = new Set<string>();

  preload(): void {
    this.load.on("progress", (p: number) => {
      const el = document.getElementById("status-bar");
      if (el) el.textContent = `murrkit · loading… ${Math.round(p * 100)}%`;
    });
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      // Optional anim sidecars frequently 404 (most sprites have none) — that's
      // expected, so don't surface it as a hard error or clobber the status bar.
      if (this.sidecarKeys.has(file.key)) return;
      console.error("Phaser load error:", file.key, file.src);
      const el = document.getElementById("status-bar");
      if (el) el.textContent = `murrkit · ❌ load error: ${file.key}`;
    });
  }

  create(): void {
    const levelId = window.levelId || "level_01";
    const text = loadLevelText(levelId);
    let spec: LevelSpec;
    if (text) {
      try { spec = yaml.load(text) as LevelSpec; }
      catch (e) { console.error("YAML parse failed:", e); spec = DEFAULT_LEVEL; }
    } else {
      console.warn(`level YAML '${levelId}' not bundled — using DEFAULT_LEVEL`);
      spec = DEFAULT_LEVEL;
    }
    this.registry.set("levelSpec", spec);

    const seen = new Set<string>();
    // Grid-based anim candidates: any AssetRef describing a >1-frame sheet.
    const gridRefs = new Map<string, AssetRef>();
    // texture key → frames.json sidecar JSON key (queued via this.load.json).
    const sidecarByTexture = new Map<string, string>();

    const queue = (key?: string, path?: string, ref?: AssetRef): void => {
      if (!key || !path || seen.has(key)) return;
      seen.add(key);
      this.load.image(key, path);
      // Grid sheet → remember for grid-anim registration on complete.
      if (ref && (ref.framesX ?? 1) * (ref.framesY ?? 1) > 1) gridRefs.set(key, ref);
      // Optionally probe a frames.json sidecar next to the image. A 404 is
      // normal (most sprites have none) and suppressed in the loaderror handler.
      const sidecarUrl = framesJsonUrlFor(path);
      if (sidecarUrl) {
        const jsonKey = `__frames__${key}`;
        this.sidecarKeys.add(jsonKey);
        sidecarByTexture.set(key, jsonKey);
        this.load.json(jsonKey, sidecarUrl);
      }
    };

    for (const layer of spec.background?.layers ?? []) queue(layer.key, layer.path, layer);
    if (spec.ground?.tile) queue(spec.ground.tile.key, spec.ground.tile.path, spec.ground.tile);
    for (const obj of spec.objects) {
      queue(obj.sprite.key, obj.sprite.path, obj.sprite);
      queue(obj.scaredKey, obj.scaredPath);
      queue(obj.defeatedKey, obj.defeatedPath);
      queue(obj.crackKey, obj.crackPath);
    }
    for (const slot of spec.slingshot?.cats ?? []) {
      queue(slot.flyingSpriteKey, slot.flyingSpritePath);
      queue(slot.hitSpriteKey, slot.hitSpritePath);
    }

    const finish = (): void => {
      this.registerAnimations(gridRefs, sidecarByTexture);
      const el = document.getElementById("status-bar");
      if (el) el.textContent = `murrkit · level=${window.levelId} · ${seen.size} assets`;
      this.scene.start("GameScene");
    };

    if (this.load.list.size === 0) { finish(); return; }
    this.load.once("complete", finish);
    this.load.start();
  }

  /**
   * After load completes, turn loaded sheets into playable Phaser animations:
   * a `*_frames.json` sidecar wins (named sprites + named anims); otherwise a
   * uniform grid (framesX×framesY) yields a single "play" animation. Purely
   * additive — GameScene/prefabs may `play()` these but nothing is forced to.
   */
  private registerAnimations(
    gridRefs: Map<string, AssetRef>,
    sidecarByTexture: Map<string, string>,
  ): void {
    const wiredFromJson = new Set<string>();
    for (const [texKey, jsonKey] of sidecarByTexture) {
      if (!this.cache.json.exists(jsonKey)) continue; // sidecar 404'd — fine
      const data = this.cache.json.get(jsonKey) as FramesJson | null;
      if (!data) continue;
      const keys = registerAnimsFromFramesJson(this, texKey, data);
      if (keys.length > 0) wiredFromJson.add(texKey);
    }
    // Grid fallback only where a frames.json didn't already define animations.
    for (const [texKey, ref] of gridRefs) {
      if (wiredFromJson.has(texKey)) continue;
      registerAnimsFromGrid(this, texKey, {
        framesX: ref.framesX ?? 1,
        framesY: ref.framesY ?? 1,
      });
    }
  }
}

/**
 * Derive the conventional `*_frames.json` sidecar URL for a sprite path, or
 * null if the path isn't a PNG we'd expect a sidecar for. The sprite-gen
 * backend writes `<slug>_atlas.png` alongside `<slug>_frames.json`; for any
 * other PNG we try `<path-without-ext>_frames.json`.
 */
function framesJsonUrlFor(path: string): string | null {
  if (!/\.png$/i.test(path)) return null;
  if (/_atlas\.png$/i.test(path)) return path.replace(/_atlas\.png$/i, "_frames.json");
  return path.replace(/\.png$/i, "_frames.json");
}

const DEFAULT_LEVEL: LevelSpec = {
  id: "level_01",
  camera: { width: 1280, height: 720, backgroundColor: "#87CEEB" },
  ground: { y: 650, width: 3000, height: 70, color: "#6b4f2a" },
  objects: [],
  win: { type: "all_targets_destroyed" },
  lose: { type: "no_shots_left", shots: 3 },
};
