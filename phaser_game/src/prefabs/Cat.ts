import Phaser from "phaser";
import type { CatSlotSpec, ObjectSpec } from "@/builders/levelSpec";
import { PHYSICS, applyCatBody, catProfile, launchImpulse } from "@/systems/physics";

export type CatState = "parked" | "loaded" | "aiming" | "flying" | "landed";

/**
 * Cat — slingshot projectile with a real state machine + per-type personality.
 * Owns its own flight trail (comet tail). Split / collision-wiring is driven by
 * GameScene (which has the scene-level collider context); Cat just exposes the
 * ability DATA (phaseThrough set, split params) it was configured with.
 */
export class Cat extends Phaser.Physics.Arcade.Sprite {
  public state: CatState = "parked";
  public readonly spec: ObjectSpec;
  public slot: CatSlotSpec | null = null;

  // ability data (populated from slot)
  public phaseThrough = new Set<string>();
  public splitInto = 0;
  public splitDelayMs = 320;
  public splitSpreadX = 200;
  public haloColor = 0xffe066;
  private flyingKey?: string;
  private hitKey?: string;
  private restPose: { key: string; frame?: string | number };

  private idleTween: Phaser.Tweens.Tween | null = null;
  private trail: Phaser.GameObjects.Graphics | null = null;
  private trailPts: { x: number; y: number }[] = [];
  private lastPhaseTick = 0;

  constructor(scene: Phaser.Scene, spec: ObjectSpec, texKey: string, frame?: string | number) {
    super(scene, spec.x, spec.y, texKey, frame);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.spec = spec;
    this.restPose = { key: texKey, frame };
    this.setName(spec.name);
    this.setData("spec", spec);
    if (spec.scale !== undefined) this.setScale(spec.scale);
    this.setOrigin(spec.origin?.[0] ?? 0.5, spec.origin?.[1] ?? 0.5);
    if (spec.depth !== undefined) this.setDepth(spec.depth);
  }

  /** Apply slingshot-slot config (ability, alt textures, halo). */
  configureSlot(slot: CatSlotSpec): void {
    this.slot = slot;
    if (slot.phaseThrough) this.phaseThrough = new Set(slot.phaseThrough);
    this.splitInto = slot.splitInto ?? 0;
    this.splitDelayMs = slot.splitDelayMs ?? 320;
    this.splitSpreadX = slot.splitSpreadX ?? 200;
    if (slot.haloColor) this.haloColor = parseInt(slot.haloColor.replace("#", "0x"), 16);
    this.flyingKey = slot.flyingSpriteKey;
    this.hitKey = slot.hitSpriteKey;
  }

  private body2(): Phaser.Physics.Arcade.Body { return this.body as Phaser.Physics.Arcade.Body; }

  /** Hide off-stage; disable physics + input. */
  park(): void {
    this.state = "parked";
    this.setVisible(false);
    this.disableInteractive();
    const b = this.body2();
    if (b) { b.setVelocity(0, 0); b.setAllowGravity(false); b.enable = false; }
    this.stopIdle();
  }

  /** Mount into the slingshot pouch, ready to be dragged. */
  mountAt(x: number, y: number): void {
    this.state = "loaded";
    this.setPosition(x, y).setVisible(true).setRotation(0);
    this.setTexture(this.restPose.key, this.restPose.frame);
    const profile = catProfile(this.slot?.ability);
    const b = this.body2();
    b.enable = true;
    applyCatBody(this, profile);
    b.setAllowGravity(false);
    b.setVelocity(0, 0);
    b.setAngularVelocity(0);
    b.setImmovable(false);
    this.setInteractive({ draggable: true, useHandCursor: true });
    this.scene.input.setDraggable(this, true);
    this.startIdle();
  }

  beginAim(): void {
    if (this.state !== "loaded") return;
    this.state = "aiming";
    this.stopIdle();
    this.setData("baseSx", this.scaleX);
    this.setData("baseSy", this.scaleY);
    this.scene.tweens.add({
      targets: this, scaleX: this.scaleX * 0.88, scaleY: this.scaleY * 1.12,
      duration: 220, ease: "Sine.out",
    });
  }

  /** Rotate to face the launch direction (pouch → cat reversed). */
  aimFace(pouchX: number, pouchY: number): void {
    this.setRotation(Math.atan2(pouchY - this.y, pouchX - this.x));
  }

  snapBackTo(x: number, y: number): void {
    this.setPosition(x, y).setRotation(0);
    this.restoreScale();
    this.state = "loaded";
    this.startIdle();
  }

  private restoreScale(): void {
    const sx = (this.getData("baseSx") as number) ?? this.scaleX;
    const sy = (this.getData("baseSy") as number) ?? this.scaleY;
    this.setScale(sx, sy);
  }

  /** Fire! Impulse is the pull vector (pouch − cat) scaled. */
  launch(pullX: number, pullY: number): void {
    this.state = "flying";
    this.restoreScale();
    this.stopIdle();
    const { vx, vy } = launchImpulse(pullX, pullY);
    const b = this.body2();
    b.setAllowGravity(true);
    b.setVelocity(vx, vy);
    b.setAngularVelocity(PHYSICS.flight.launchAngularVelocity);
    if (this.flyingKey && this.scene.textures.exists(this.flyingKey)) this.setTexture(this.flyingKey);
    this.startTrail();
  }

  /** Come to rest — flip out of flight so contract anomaly checks ignore us. */
  settle(): void {
    if (this.state === "landed") return;
    this.state = "landed";
    const b = this.body2();
    if (b) {
      b.setVelocity(0, 0);
      b.setAngularVelocity(0);
      b.setAllowGravity(false);
      b.setImmovable(true);
    }
    this.setRotation(0);
    if (this.hitKey && this.scene.textures.exists(this.hitKey)) this.setTexture(this.hitKey);
    this.destroyTrail();
  }

  isFlying(): boolean { return this.state === "flying"; }

  // ---- idle breathing ----------------------------------------------------
  private startIdle(): void {
    this.stopIdle();
    const baseY = this.y;
    this.idleTween = this.scene.tweens.add({
      targets: this,
      scaleX: { from: this.scaleX, to: this.scaleX * 1.04 },
      scaleY: { from: this.scaleY, to: this.scaleY * 0.96 },
      y: { from: baseY, to: baseY - 3 },
      duration: 800, yoyo: true, repeat: -1, ease: "Sine.inOut",
    });
  }
  private stopIdle(): void {
    if (this.idleTween) { this.idleTween.stop(); this.idleTween = null; }
  }

  // ---- comet trail -------------------------------------------------------
  private startTrail(): void {
    this.destroyTrail();
    this.trail = this.scene.add.graphics().setDepth(40);
    this.trailPts = [];
  }

  /** Called each frame while flying. Emits a fading comet tail BEHIND the cat. */
  updateTrail(): void {
    if (!this.trail || this.state !== "flying") return;
    const b = this.body2();
    const vmag = Math.hypot(b.velocity.x, b.velocity.y);
    if (vmag < 50) return;
    const radius = Math.max(this.displayWidth, this.displayHeight) * 0.5;
    const nx = -b.velocity.x / vmag, ny = -b.velocity.y / vmag;
    this.trailPts.unshift({ x: this.x + nx * radius, y: this.y + ny * radius });
    if (this.trailPts.length > 18) this.trailPts.pop();
    this.trail.clear();
    for (let i = 0; i < this.trailPts.length; i++) {
      const p = this.trailPts[i];
      const life = 1 - i / Math.max(1, this.trailPts.length);
      this.trail.fillStyle(this.haloColor, 0.5 * life);
      this.trail.fillCircle(p.x, p.y, 10 * life + 3);
    }
  }

  private destroyTrail(): void {
    if (this.trail) { this.trail.destroy(); this.trail = null; }
    this.trailPts = [];
  }

  // ---- ghost phase (fast-cat passes through wood) ------------------------
  /** Called on overlap with a phaseThrough target — go translucent. */
  markPhase(): void {
    this.setAlpha(0.5);
    this.lastPhaseTick = this.scene.time.now;
  }

  /** Restore opacity ~120ms after the last phase overlap. Call each frame. */
  ghostTick(): void {
    if (!this.lastPhaseTick) { if (this.alpha < 1) this.setAlpha(1); return; }
    if (this.scene.time.now - this.lastPhaseTick > 120 && this.alpha < 1) {
      this.scene.tweens.add({ targets: this, alpha: 1, duration: 120, ease: "Cubic.out" });
      this.lastPhaseTick = 0;
    }
  }

  destroy(fromScene?: boolean): void {
    this.stopIdle();
    this.destroyTrail();
    super.destroy(fromScene);
  }
}
