import Phaser from "phaser";
import { registerGameState, type GameStateSnapshot } from "@/systems/gameState";

/**
 * StateRecorder — the SLINGSHOT PLAYTEST CONTRACT surface (and the slingshot
 * ADAPTER for the generic `window.__gameState()` contract).
 *
 * Exposes per-frame motion + collision history on `window` so the backend
 * Playwright harness (backend/routers/phaser.py) can run algorithmic anomaly
 * detection WITHOUT screenshots. Field names + semantics are FROZEN — the
 * `_detect_dynamic_anomalies` detector reads them by exact key:
 *   window.__phaserTrace      → [{t,cat,x,y,vx,vy,rot,av,launched,shotsRemaining,score,enemiesAlive}]
 *   window.__phaserCollisions → [{t,a,b,vx,vy,damaged}]
 *   window.__phaserScene      → active scene reference
 *
 * It ALSO registers a generic `window.__gameState()` provider (see
 * gameState.ts) that maps the slingshot fields into the genre-agnostic
 * snapshot, so the additive `/api/phaser/drive` harness can sample slingshot
 * games too. The two contracts are independent: the slingshot
 * `/api/phaser/playtest` path keeps reading the frozen globals above
 * unchanged.
 */

export interface TraceFrame {
  t: number; cat: string; x: number; y: number; vx: number; vy: number;
  rot: number; av: number; launched: boolean;
  shotsRemaining: number; score: number; enemiesAlive: number;
}

export interface CollisionEntry {
  t: number; a: string; b: string; vx: number; vy: number; damaged: boolean;
}

/** Minimal shape the recorder reads off the scene each frame. */
export interface RecordableScene extends Phaser.Scene {
  currentProjectile: Phaser.Physics.Arcade.Sprite | null;
  launched: boolean;
  shotsRemaining: number;
  score: number;
  enemiesAlive: number;
}

export class StateRecorder {
  public readonly trace: TraceFrame[] = [];
  public readonly collisions: CollisionEntry[] = [];
  private readonly MAX_TRACE = 3000;
  private readonly MAX_COLLISIONS = 200;

  constructor(private scene: RecordableScene) {
    const w = window as unknown as Record<string, unknown>;
    w.__phaserTrace = this.trace;
    w.__phaserCollisions = this.collisions;
    w.__phaserScene = scene;
    // Slingshot adapter for the generic contract: map slingshot fields into
    // the genre-agnostic snapshot so /api/phaser/drive can sample this game.
    registerGameState(scene, () => this.snapshot());
  }

  /** Map the live slingshot scene into the generic `__gameState()` snapshot.
   *  The flying cat is the "player" (the only controllable/moving body);
   *  alive enemies become entities. Win/lose read defensively off the scene. */
  private snapshot(): GameStateSnapshot {
    const proj = this.scene.currentProjectile;
    const body = proj?.body as Phaser.Physics.Arcade.Body | null | undefined;
    const s = this.scene as unknown as { win?: boolean; lose?: boolean };
    return {
      t: this.scene.time.now,
      player: proj
        ? {
            x: proj.x,
            y: proj.y,
            vx: body?.velocity.x ?? 0,
            vy: body?.velocity.y ?? 0,
            onGround: body ? body.blocked.down || body.touching.down : undefined,
          }
        : undefined,
      score: this.scene.score,
      scene: {
        key: this.scene.scene.key,
        win: s.win ?? false,
        lose: s.lose ?? false,
      },
      custom: {
        launched: this.scene.launched,
        shotsRemaining: this.scene.shotsRemaining,
        enemiesAlive: this.scene.enemiesAlive,
        cat: proj?.name ?? "",
      },
    };
  }

  /** Push the current projectile's physics state. Call once per frame. */
  recordFrame(): void {
    const proj = this.scene.currentProjectile;
    const body = proj?.body as Phaser.Physics.Arcade.Body | null | undefined;
    this.trace.push({
      t: this.scene.time.now,
      cat: proj?.name ?? "",
      x: proj?.x ?? 0,
      y: proj?.y ?? 0,
      vx: body?.velocity.x ?? 0,
      vy: body?.velocity.y ?? 0,
      rot: proj?.rotation ?? 0,
      av: body?.angularVelocity ?? 0,
      launched: this.scene.launched,
      shotsRemaining: this.scene.shotsRemaining,
      score: this.scene.score,
      enemiesAlive: this.scene.enemiesAlive,
    });
    if (this.trace.length > this.MAX_TRACE) this.trace.splice(0, this.trace.length - this.MAX_TRACE);
  }

  /** Log a projectile↔object collision with impact velocity. */
  logCollision(a: string, b: string, body: Phaser.Physics.Arcade.Body | null, damaged: boolean): void {
    this.collisions.push({
      t: this.scene.time.now, a, b,
      vx: body?.velocity.x ?? 0, vy: body?.velocity.y ?? 0, damaged,
    });
    if (this.collisions.length > this.MAX_COLLISIONS) {
      this.collisions.splice(0, this.collisions.length - this.MAX_COLLISIONS);
    }
  }

  /** Mark the most recent collision as having dealt damage. */
  markLastDamaged(): void {
    if (this.collisions.length) this.collisions[this.collisions.length - 1].damaged = true;
  }
}
