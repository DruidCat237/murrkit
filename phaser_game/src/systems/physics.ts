/**
 * physics.ts — SINGLE SOURCE OF TRUTH for every physics constant in the game.
 *
 * No magic numbers live in scenes/prefabs. Tune the game from here.
 *
 * ⚠ CONTRACT WITH backend/routers/phaser.py anomaly detector ⚠
 * `body.angularVelocity` in Phaser Arcade is DEGREES/sec (not rad/s). The
 * detector flags `rotation_overflow` when |av| stays > 286 deg/s for > 600ms.
 * Launch spin MUST start below 286 and decay fast via angularDrag. It also
 * flags `lateral_drift` / `hover_after_settle` on frames where `launched=true`
 * — which is why the slingshot flips `launched=false` the moment a cat rests.
 */

import Phaser from "phaser";

/** Per-cat-type physical character. Keys match CatSpec.abilityKind / cat names. */
export interface CatProfile {
  mass: number;
  bounce: number;
  /** Linear damping factor for setDamping(true) — fraction of velocity kept per
   *  second-ish. 0.55 ≈ ~45%/s bleed → graceful arc decay, never a brick. */
  drag: number;
  /** gravityScale 1.0 = world gravity. <1 floats (banned — causes hover), >1 sinks. */
  gravityScale: number;
}

export const PHYSICS = {
  /** World gravity (px/s²) — mirrors Phaser.Game arcade config. */
  gravityY: 900,

  /** Slingshot launch tuning. */
  slingshot: {
    maxPullDistance: 280,
    /** impulse = pullVector * launchPowerScale. At full 280px pull → ~1400px/s
     *  raw, clamped by drag to a satisfying ~900px/s peak. */
    launchPowerScale: 5.0,
    /** Below this pull distance the release is treated as a mis-grab — the cat
     *  snaps back to the pouch, no shot consumed. */
    minPullDistance: 8,
  },

  /** Spin applied at launch + how fast it bleeds off. */
  flight: {
    /** deg/s — well under the 286 deg/s rotation_overflow threshold. */
    launchAngularVelocity: 180,
    /** deg/s² — 180/300 = 0.6s to full stop, far inside the 600ms gate window. */
    angularDrag: 300,
    /** Collision body radius = min(displayW, displayH) / this. Smaller divisor =
     *  bigger circle. 2.2 → smooth round bounces, no corner-snagging. */
    bodyRadiusDivisor: 2.2,
  },

  /** When a launched cat is considered "at rest" → flip launched=false + reload. */
  settle: {
    /** px/s — speed below which the cat counts as slowing to a stop. */
    velocityThreshold: 40,
    /** ms the cat must stay below velocityThreshold before we settle it. */
    holdMs: 250,
    /** Hard ceiling: even a cat ping-ponging off structures settles after this. */
    maxFlightMs: 2600,
    /** ms after settle before the next cat mounts. */
    reloadDelayMs: 550,
  },

  /** Per-type profiles. Selected by Cat by its `abilityKind` (falls back heavy). */
  catProfiles: {
    heavy:  { mass: 1.4, bounce: 0.30, drag: 0.55, gravityScale: 1.0 },
    fast:   { mass: 1.0, bounce: 0.42, drag: 0.55, gravityScale: 1.0 },
    light:  { mass: 0.8, bounce: 0.50, drag: 0.55, gravityScale: 1.0 },
  } as Record<string, CatProfile>,

  /** Material strength for destructible blocks. hp = hits before break. */
  materials: {
    glass: { hp: 1, topple: false },
    wood:  { hp: 2, topple: true },
    stone: { hp: 3, topple: true },
  } as Record<string, { hp: number; topple: boolean }>,

  /** Radius (px) within which a collapsing block damages neighbouring enemies. */
  chainDamageRadius: 90,
} as const;

/** Resolve a cat profile by ability kind, defaulting to heavy. */
export function catProfile(kind: string | undefined): CatProfile {
  return PHYSICS.catProfiles[kind ?? "heavy"] ?? PHYSICS.catProfiles.heavy;
}

/**
 * Apply a profile + projectile setup to an arcade body. Used by Cat on mount.
 * Sets a CIRCULAR body for smooth bounces (Arcade AABB corners snag otherwise).
 */
export function applyCatBody(sprite: Phaser.Physics.Arcade.Sprite, profile: CatProfile): void {
  const body = sprite.body as Phaser.Physics.Arcade.Body;
  body.setMass(profile.mass);
  body.setBounce(profile.bounce);
  body.setDamping(true);
  body.setDrag(profile.drag);
  body.setAngularDrag(PHYSICS.flight.angularDrag);
  if (profile.gravityScale !== 1.0) {
    body.setGravityY(PHYSICS.gravityY * (profile.gravityScale - 1));
  }
  const r = Math.min(sprite.displayWidth, sprite.displayHeight) / PHYSICS.flight.bodyRadiusDivisor;
  // setCircle takes unscaled radius + offset; convert display radius back to source px.
  const srcR = r / (sprite.scaleX || 1);
  const offX = sprite.width / 2 - srcR;
  const offY = sprite.height / 2 - srcR;
  body.setCircle(srcR, offX, offY);
}

/** Launch impulse from a pull vector (pouch → cat, i.e. the stretch). */
export function launchImpulse(pullX: number, pullY: number): { vx: number; vy: number } {
  const scale = PHYSICS.slingshot.launchPowerScale;
  return { vx: pullX * scale, vy: pullY * scale };
}
