import Phaser from "phaser";
import { sliceFrame } from "@/systems/textureFrames";

/**
 * anims.ts — wire generated sprite sheets into Phaser so their animations
 * actually PLAY. Bridges the two worlds we generate frames in:
 *
 *   1. A `*_frames.json` sidecar (what the sprite-gen backend writes): named
 *      sub-sprites with pixel rects + named animation → sprite-name lists.
 *   2. A plain `framesX × framesY` grid (what level YAML / AssetRef describe):
 *      a uniform NxN sheet, optionally with named animations over frame indices.
 *
 * Both paths register Phaser texture frames on the already-loaded texture and
 * create `scene.anims` entries via `scene.anims.create(...)`. Animation keys are
 * namespaced `"<textureKey>:<animName>"` so multiple atlases never collide.
 *
 * Idempotent throughout: re-registering a frame or anim is a no-op, so calling
 * this twice (e.g. BootScene + a later hot reload) is safe.
 */

// ---------------------------------------------------------------------------
// frames.json (sprite-gen sidecar) shape — only the fields we consume.
// ---------------------------------------------------------------------------

interface FramesJsonRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FramesJsonSprite {
  name: string;
  rect: FramesJsonRect;
}

/**
 * The on-disk sidecar the backend emits. `animations` maps an animation name to
 * an ordered list of sprite names (which index into `sprites[]`).
 */
export interface FramesJson {
  sprites?: FramesJsonSprite[];
  animations?: Record<string, string[]>;
  /** Optional global default playback rate (frames/sec). */
  fps?: number;
}

/** Spec for the grid path: a uniform sheet sliced framesX across × framesY down. */
export interface GridAnimSpec {
  framesX: number;
  framesY: number;
  fps?: number;
  /**
   * Named animations over 0-based frame indices. When omitted, a single "play"
   * animation spanning every frame in row-major order is created.
   */
  animations?: Record<string, number[]>;
}

const DEFAULT_FPS = 8;

/** Namespaced animation key so two atlases can both define e.g. "idle". */
export function animKey(textureKey: string, animName: string): string {
  return `${textureKey}:${animName}`;
}

// ---------------------------------------------------------------------------
// frames.json path
// ---------------------------------------------------------------------------

/**
 * Register one texture frame per named sprite in a frames.json sidecar, then
 * create a Phaser animation for each named animation entry. Returns the list of
 * namespaced animation keys created (existing ones are skipped, not re-created).
 */
export function registerAnimsFromFramesJson(
  scene: Phaser.Scene,
  textureKey: string,
  data: FramesJson,
): string[] {
  if (!scene.textures.exists(textureKey)) {
    console.warn(`anims: texture "${textureKey}" not loaded — skipping frames.json wiring`);
    return [];
  }
  const tex = scene.textures.get(textureKey);
  const sprites = data.sprites ?? [];

  // Register a named frame per sprite rect (idempotent — skip if already there).
  for (const sp of sprites) {
    if (!sp?.name || !sp.rect) continue;
    if (!tex.has(sp.name)) {
      tex.add(sp.name, 0, sp.rect.x, sp.rect.y, sp.rect.width, sp.rect.height);
    }
  }

  const created: string[] = [];
  const animations = data.animations ?? {};
  const fps = data.fps ?? DEFAULT_FPS;

  for (const [name, spriteNames] of Object.entries(animations)) {
    const key = animKey(textureKey, name);
    if (scene.anims.exists(key)) {
      created.push(key);
      continue;
    }
    // Keep only sprite names we actually registered as frames.
    const frames = spriteNames
      .filter((n) => tex.has(n))
      .map((n) => ({ key: textureKey, frame: n }));
    if (frames.length === 0) continue;
    scene.anims.create({
      key,
      frames,
      frameRate: fps,
      repeat: -1,
    });
    created.push(key);
  }
  return created;
}

// ---------------------------------------------------------------------------
// grid path
// ---------------------------------------------------------------------------

/**
 * Register a uniform framesX×framesY grid and create animations over frame
 * indices. Reuses `sliceFrame`'s `f<idx>` frame-key convention so frames stay
 * shared with on-demand slicing elsewhere. Returns the namespaced anim keys.
 */
export function registerAnimsFromGrid(
  scene: Phaser.Scene,
  textureKey: string,
  spec: GridAnimSpec,
): string[] {
  if (!scene.textures.exists(textureKey)) {
    console.warn(`anims: texture "${textureKey}" not loaded — skipping grid wiring`);
    return [];
  }
  const fx = Math.max(1, Math.floor(spec.framesX));
  const fy = Math.max(1, Math.floor(spec.framesY));
  const total = fx * fy;
  if (total <= 1) return [];

  // Ensure every grid cell is registered as an `f<idx>` frame. sliceFrame is
  // idempotent and computes the rect from the source image dimensions.
  for (let i = 0; i < total; i++) sliceFrame(scene, { key: textureKey, framesX: fx, framesY: fy, frame: i });

  const fps = spec.fps ?? DEFAULT_FPS;
  const animations: Record<string, number[]> =
    spec.animations && Object.keys(spec.animations).length > 0
      ? spec.animations
      : { play: Array.from({ length: total }, (_, i) => i) };

  const created: string[] = [];
  for (const [name, indices] of Object.entries(animations)) {
    const key = animKey(textureKey, name);
    if (scene.anims.exists(key)) {
      created.push(key);
      continue;
    }
    const frames = indices
      .filter((i) => i >= 0 && i < total)
      .map((i) => ({ key: textureKey, frame: `f${i}` }));
    if (frames.length === 0) continue;
    scene.anims.create({
      key,
      frames,
      frameRate: fps,
      repeat: -1,
    });
    created.push(key);
  }
  return created;
}
