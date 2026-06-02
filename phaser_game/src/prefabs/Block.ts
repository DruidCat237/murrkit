import Phaser from "phaser";
import type { Material, ObjectSpec } from "@/builders/levelSpec";
import { PHYSICS } from "@/systems/physics";

export interface BlockHitResult { destroyed: boolean; score: number; }

const SCORE_BY_MATERIAL: Record<Material, number> = { glass: 50, wood: 30, stone: 25 };

/**
 * Block — destructible structure (wood / glass / stone). Static body for stable
 * stacking; collapse is SCRIPTED (topple/shatter tween + particles) rather than
 * rigid-body sim, which keeps Arcade physics stable and the anomaly detector
 * happy while still looking like a real collapse. Chain damage to nearby
 * enemies is delegated to GameScene via the returned break position.
 */
export class Block extends Phaser.Physics.Arcade.Sprite {
  public readonly spec: ObjectSpec;
  public readonly material: Material;
  public hp: number;
  public broken = false;

  constructor(scene: Phaser.Scene, spec: ObjectSpec, texKey: string) {
    super(scene, spec.x, spec.y, texKey);
    scene.add.existing(this);
    scene.physics.add.existing(this, true);
    this.spec = spec;
    this.material = spec.material ?? "wood";
    this.hp = spec.hp ?? PHYSICS.materials[this.material]?.hp ?? 1;
    this.setName(spec.name);
    if (spec.scale !== undefined) this.setScale(spec.scale);
    this.setOrigin(spec.origin?.[0] ?? 0.5, spec.origin?.[1] ?? 1.0);
    if (spec.rotation !== undefined) this.setRotation(spec.rotation);
    if (spec.alpha !== undefined) this.setAlpha(spec.alpha);
    if (spec.depth !== undefined) this.setDepth(spec.depth);
    this.setData("spec", spec);
    this.syncBody();
  }

  /** Rotated planks need their AABB body swapped to match the visual column. */
  private syncBody(): void {
    const b = this.body as Phaser.Physics.Arcade.StaticBody;
    if (this.spec.rotation !== undefined && Math.abs(Math.sin(this.spec.rotation)) > 0.5) {
      b.setSize(this.height, this.width);
    }
    b.updateFromGameObject();
  }

  /** Apply an impact. Returns whether it broke + score. dir = sign of cat vx. */
  takeDamage(impactSpeed: number, dir = 1): BlockHitResult {
    if (this.broken || this.spec.breakable === false) {
      this.shudder();
      return { destroyed: false, score: 0 };
    }
    // Glancing taps don't damage stone/wood — only real hits.
    const minImpact = this.material === "glass" ? 60 : 140;
    if (impactSpeed < minImpact) { this.shudder(); return { destroyed: false, score: 0 }; }

    this.hp -= 1;
    this.setData("hp", this.hp);
    if (this.hp > 0) {
      if (this.material === "glass") this.crack();
      else this.shudder();
      return { destroyed: false, score: 0 };
    }
    return { destroyed: true, score: this.break(dir) };
  }

  private shudder(): void {
    const x0 = this.x;
    this.scene.tweens.add({
      targets: this, x: { from: x0 - 3, to: x0 + 3 },
      duration: 45, yoyo: true, repeat: 2, ease: "Sine.inOut",
      onComplete: () => { this.x = x0; },
    });
  }

  private crack(): void {
    if (this.spec.crackKey && this.scene.textures.exists(this.spec.crackKey)) {
      this.setTexture(this.spec.crackKey);
    }
    this.shudder();
  }

  /** Run the material-specific destruction sequence; returns score. */
  private break(dir: number): number {
    this.broken = true;
    const b = this.body as Phaser.Physics.Arcade.StaticBody;
    b.enable = false;
    if (this.material === "glass") this.shatterGlass();
    else if (this.material === "stone") this.crumbleStone();
    else this.toppleWood(dir);
    return this.spec.scoreOnDestroy ?? SCORE_BY_MATERIAL[this.material];
  }

  private toppleWood(dir: number): void {
    this.spawnDebris(7, 0x8a5a2b, 0xb5793f);
    this.scene.tweens.add({
      targets: this,
      angle: this.angle + dir * 78,
      y: this.y + this.displayHeight * 0.35,
      alpha: 0, duration: 480, ease: "Cubic.in",
      onComplete: () => this.destroy(),
    });
  }

  private crumbleStone(): void {
    this.spawnDebris(9, 0x8d8d8d, 0xb0b0b0, true);
    this.scene.cameras.main.shake(120, 0.004);
    this.scene.tweens.add({
      targets: this, alpha: 0, scaleY: this.scaleY * 0.7, y: this.y + 14,
      duration: 320, ease: "Cubic.in", onComplete: () => this.destroy(),
    });
  }

  private shatterGlass(): void {
    if (this.spec.crackKey && this.scene.textures.exists(this.spec.crackKey)) this.setTexture(this.spec.crackKey);
    const cx = this.x, cy = this.y - this.displayHeight * 0.5;
    const w = this.displayWidth, h = this.displayHeight;
    const quads = [
      { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: 1, dy: 1 },
      { dx: -0.6, dy: -1 }, { dx: 0.6, dy: -1 }, { dx: -0.6, dy: 1 }, { dx: 0.6, dy: 1 },
    ];
    for (const q of quads) {
      const g = this.scene.add.graphics().setDepth((this.depth || 0) + 5);
      g.fillStyle(0xcfe4ed, 0.78);
      const sx = w * 0.45 * Math.random() + w * 0.2;
      const sy = h * 0.45 * Math.random() + h * 0.2;
      g.fillTriangle(0, 0, sx, sy * 0.3, sx * 0.4, sy);
      g.lineStyle(1.5, 0x95b8c2, 0.85);
      g.strokeTriangle(0, 0, sx, sy * 0.3, sx * 0.4, sy);
      g.x = cx + q.dx * w * 0.15; g.y = cy + q.dy * h * 0.15;
      this.scene.tweens.add({
        targets: g, x: g.x + q.dx * (130 + Math.random() * 60),
        y: g.y + q.dy * (90 + Math.random() * 60) - 30,
        angle: q.dx * (q.dy < 0 ? -120 : 220), alpha: 0,
        duration: 600 + Math.random() * 200, ease: "Cubic.out",
        onComplete: () => g.destroy(),
      });
    }
    this.scene.tweens.add({ targets: this, alpha: 0, duration: 220, onComplete: () => this.destroy() });
  }

  /** Generic chunk/splinter burst — n pieces fanning out with gravity-ish fall. */
  private spawnDebris(n: number, c1: number, c2: number, blocky = false): void {
    const cx = this.x, cy = this.y - this.displayHeight * 0.45;
    for (let i = 0; i < n; i++) {
      const g = this.scene.add.graphics().setDepth((this.depth || 0) + 4);
      g.fillStyle(i % 2 ? c1 : c2, 0.95);
      const s = 4 + Math.random() * 6;
      if (blocky) g.fillRect(-s, -s, s * 2, s * 1.6);
      else g.fillRect(-s, -s * 0.35, s * 2, s * 0.7);
      g.x = cx + (Math.random() - 0.5) * this.displayWidth * 0.6;
      g.y = cy + (Math.random() - 0.5) * this.displayHeight * 0.4;
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const sp = 80 + Math.random() * 90;
      this.scene.tweens.add({
        targets: g, x: g.x + Math.cos(ang) * sp, y: g.y + Math.sin(ang) * sp + 120,
        angle: (Math.random() - 0.5) * 360, alpha: 0,
        duration: 600 + Math.random() * 250, ease: "Quad.in",
        onComplete: () => g.destroy(),
      });
    }
  }
}
