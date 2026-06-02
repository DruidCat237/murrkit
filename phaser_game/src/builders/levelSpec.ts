/**
 * levelSpec.ts — declarative YAML schema for murrkit levels.
 *
 * Claude authors YAML matching this shape; `buildLevelFromYAML` turns it into a
 * Phaser scene-graph deterministically. Every fix is a whole-scene rebuild from
 * spec, so compounding regressions are structurally impossible.
 *
 * Prefab routing: `kind` chooses which prefab class instantiates the object.
 *   enemy  → Enemy   (mouse; MUST keep destroyOnHit:true — playtest contract)
 *   block  → Block   (wood/glass/stone destructible structure)
 *   cat    → Cat     (slingshot projectile)
 *   prop   → plain decorative sprite (slingshot Y, barrel, etc.)
 */

export interface AssetRef {
  key: string;
  path: string;
  /** Sprite-sheet slicing: frames across / down. Default 1×1 = single image. */
  framesX?: number;
  framesY?: number;
  /** Which frame to display (0-based). Default 0. */
  frame?: number;
}

export interface BackgroundLayer extends AssetRef {
  scrollFactor?: number;
  alpha?: number;
}

export interface GroundSpec {
  y: number;
  width: number;
  height: number;
  tile?: AssetRef;
  color?: string;
}

export interface PhysicsSpec {
  type?: "static" | "dynamic";
  mass?: number;
  bounce?: number;
  drag?: number;
  angularDrag?: number;
  gravityScale?: number;
  isProjectile?: boolean;
}

export type ObjectKind = "enemy" | "block" | "cat" | "prop";
export type Material = "wood" | "glass" | "stone";

export interface ObjectSpec {
  name: string;
  kind?: ObjectKind;          // prefab router; inferred if omitted (see builder)
  sprite: AssetRef;
  x: number;
  y: number;
  scale?: number;
  origin?: [number, number];
  rotation?: number;          // radians
  alpha?: number;
  flipX?: boolean;
  depth?: number;
  physics?: PhysicsSpec;
  collidesWith?: string[];    // object names this collides with

  // ---- enemy fields ----
  destroyOnHit?: boolean;     // CONTRACT: bot targets objects where this is true
  hp?: number;
  scoreOnDestroy?: number;
  isKing?: boolean;           // boss mouse — programmatic crown overlay
  /** Optional alternate textures for enemy state machine. */
  scaredKey?: string;
  scaredPath?: string;
  defeatedKey?: string;
  defeatedPath?: string;

  // ---- block fields ----
  material?: Material;        // wood | glass | stone — drives hp + break FX
  breakable?: boolean;        // if true, collisions damage it (default true for blocks)
  /** Glass-only: cracked texture swapped in before shatter. */
  crackKey?: string;
  crackPath?: string;
}

export interface BackgroundSpec {
  layers?: BackgroundLayer[];
}

export interface CameraSpec {
  width: number;
  height: number;
  backgroundColor?: string;
  followTarget?: string;
  worldBounds?: [number, number, number, number];
}

export type CatAbility = "heavy" | "fast" | "light";

export interface CatSlotSpec {
  name: string;               // name of an ObjectSpec with kind:cat
  label?: string;             // HUD display label
  ability?: CatAbility;       // selects physics profile + behaviour
  flyingSpriteKey?: string;
  flyingSpritePath?: string;
  hitSpriteKey?: string;
  hitSpritePath?: string;
  haloColor?: string;         // trail colour hex
  /** Light-cat special: splits mid-flight into N projectiles (blue-bird style). */
  splitInto?: number;
  splitDelayMs?: number;
  splitSpreadX?: number;
  /** Fast-cat special: object names this cat ghosts THROUGH (alpha 0.5, no separation). */
  phaseThrough?: string[];
}

export interface SlingshotSpec {
  anchor: string;             // object name (the slingshot prop)
  projectile: string;         // fallback first cat name if `cats` empty
  pouchOffset?: [number, number];
  maxPullDistance?: number;
  launchPowerScale?: number;
  cats?: CatSlotSpec[];
}

export interface WinSpec {
  type: "all_targets_destroyed" | "score_threshold";
  scoreThreshold?: number;
}

export interface LoseSpec {
  type: "no_shots_left" | "time_limit";
  shots?: number;
  timeLimit?: number;
}

export interface LevelSpec {
  id: string;
  camera: CameraSpec;
  background?: BackgroundSpec;
  ground?: GroundSpec;
  objects: ObjectSpec[];
  slingshot?: SlingshotSpec;
  win: WinSpec;
  lose: LoseSpec;
  notes?: string;
}

/** Infer prefab kind when YAML omits it (keeps level files terse). */
export function inferKind(o: ObjectSpec): ObjectKind {
  if (o.kind) return o.kind;
  if (o.destroyOnHit && o.hp !== undefined) return "enemy";
  if (o.material) return "block";
  return "prop";
}
