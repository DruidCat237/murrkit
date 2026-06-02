import Phaser from "phaser";
import type { ObjectSpec } from "@/builders/levelSpec";
import { sliceFrame } from "@/systems/textureFrames";

export interface DamageResult { destroyed: boolean; score: number; }

/**
 * Enemy — a mouse target with a 3-state machine (idle / scared / defeated).
 * Static body (won't fall on its own). Counts toward `enemiesAlive`. King
 * variant wears a programmatic crown that reacts to damage.
 *
 * CONTRACT: keeps getData('spec').destroyOnHit === true so the playtest bot
 * targets it, and stays `.active` until defeated.
 */
export class Enemy extends Phaser.Physics.Arcade.Sprite {
  public readonly spec: ObjectSpec;
  public hp: number;
  public defeated = false;
  public readonly isKing: boolean;

  private idleFrame?: string;
  private blinkFrame?: string;
  private scaredTex?: string;
  private defeatedTex?: string;
  private crown: Phaser.GameObjects.Graphics | null = null;
  private blinkEvent?: Phaser.Time.TimerEvent;
  private scaredResetEvent?: Phaser.Time.TimerEvent;

  constructor(scene: Phaser.Scene, spec: ObjectSpec, baseFrame: { key: string; frame?: string }) {
    super(scene, spec.x, spec.y, baseFrame.key, baseFrame.frame);
    scene.add.existing(this);
    scene.physics.add.existing(this, true); // static body
    this.spec = spec;
    this.hp = spec.hp ?? 1;
    this.isKing = !!spec.isKing;
    this.idleFrame = baseFrame.frame;
    this.setName(spec.name);
    if (spec.scale !== undefined) this.setScale(spec.scale);
    this.setOrigin(spec.origin?.[0] ?? 0.5, spec.origin?.[1] ?? 0.92);
    if (spec.flipX) this.setFlipX(true);
    if (spec.depth !== undefined) this.setDepth(spec.depth);
    this.setData("spec", spec);
    this.setData("hp", this.hp);
    (this.body as Phaser.Physics.Arcade.StaticBody).updateFromGameObject();

    // Resolve a blink frame (frame 1) if the source is a multi-frame sheet.
    if ((spec.sprite.framesX ?? 1) > 1) {
      this.blinkFrame = sliceFrame(scene, { ...spec.sprite, frame: 1 }).frame;
    }
    if (spec.scaredKey) this.scaredTex = spec.scaredKey;
    if (spec.defeatedKey) this.defeatedTex = spec.defeatedKey;

    this.startIdle();
    if (this.isKing) this.renderCrown();
  }

  // ---- idle: breathe + blink --------------------------------------------
  private startIdle(): void {
    this.scene.tweens.add({
      targets: this,
      scaleY: { from: this.scaleY, to: this.scaleY * 0.92 },
      duration: 1100 + Math.random() * 400,
      yoyo: true, repeat: -1, ease: "Sine.inOut", delay: Math.random() * 600,
    });
    this.blinkEvent = this.scene.time.addEvent({
      delay: 2200 + Math.random() * 1500, loop: true,
      callback: () => this.blink(),
    });
  }

  private blink(): void {
    if (!this.active || this.defeated) return;
    if (this.blinkFrame && this.idleFrame) {
      this.setFrame(this.blinkFrame);
      this.scene.time.delayedCall(150, () => { if (this.active && !this.defeated) this.setFrame(this.idleFrame!); });
    } else {
      const base = this.scaleY;
      this.scene.tweens.add({ targets: this, scaleY: base * 0.78, duration: 70, yoyo: true, ease: "Cubic.inOut" });
    }
  }

  // ---- damage ------------------------------------------------------------
  takeDamage(amount = 1): DamageResult {
    if (this.defeated || !this.active) return { destroyed: false, score: 0 };
    this.hp -= amount;
    this.setData("hp", this.hp);
    if (this.hp > 0) {
      this.showScared();
      this.wobble();
      this.tiltCrown();
      return { destroyed: false, score: 0 };
    }
    return { destroyed: true, score: this.defeat() };
  }

  private showScared(): void {
    if (this.scaredTex && this.scene.textures.exists(this.scaredTex)) {
      this.setTexture(this.scaredTex);
      this.scaredResetEvent?.remove();
      this.scaredResetEvent = this.scene.time.delayedCall(600, () => {
        if (this.active && !this.defeated && this.idleFrame !== undefined) {
          this.setTexture(this.spec.sprite.key, this.idleFrame);
        } else if (this.active && !this.defeated) {
          this.setTexture(this.spec.sprite.key);
        }
      });
    }
  }

  private wobble(): void {
    const r0 = this.rotation;
    this.scene.tweens.add({
      targets: this, rotation: { from: r0 - 0.12, to: r0 + 0.12 },
      duration: 70, yoyo: true, repeat: 2, ease: "Sine.inOut",
      onComplete: () => { this.rotation = r0; },
    });
  }

  /** Defeat sequence: pop → defeated pose → spin-fall-fade → destroy. Returns score. */
  private defeat(): number {
    this.defeated = true;
    this.blinkEvent?.remove();
    if (this.defeatedTex && this.scene.textures.exists(this.defeatedTex)) this.setTexture(this.defeatedTex);
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.add({
      targets: this, scaleX: this.scaleX * 1.15, scaleY: this.scaleY * 1.15,
      duration: 110, ease: "Back.out",
      onComplete: () => {
        this.scene.tweens.add({
          targets: this, y: this.y + 60, angle: (Math.random() < 0.5 ? -1 : 1) * 200,
          alpha: 0, duration: 420, ease: "Cubic.in",
          onComplete: () => this.destroy(),
        });
      },
    });
    this.destroyCrown();
    return this.spec.scoreOnDestroy ?? 100;
  }

  // ---- king crown --------------------------------------------------------
  private renderCrown(): void {
    const w = this.displayWidth * 0.85;
    const h = this.displayHeight * 0.30;
    const cx = this.x;
    const headTop = this.y - this.displayHeight * 0.70;
    const cy = headTop - h * 0.35;
    const g = this.scene.add.graphics().setDepth((this.depth || 0) + 5);
    const bandH = h * 0.32;
    const bandTopY = cy + h * 0.5 - bandH;
    g.fillStyle(0xb8860b, 1);
    g.fillTriangle(cx - w * 0.5, cy + h * 0.5, cx + w * 0.5, cy + h * 0.5, cx + w * 0.45, bandTopY);
    g.fillTriangle(cx - w * 0.5, cy + h * 0.5, cx + w * 0.45, bandTopY, cx - w * 0.45, bandTopY);
    g.fillStyle(0xffd700, 1);
    g.fillRect(cx - w * 0.42, bandTopY, w * 0.84, bandH * 0.55);
    const peakBaseY = bandTopY;
    const centerTopY = cy - h * 0.55;
    const sideTopY = cy - h * 0.20;
    g.fillStyle(0xffd700, 1);
    g.fillTriangle(cx - w * 0.15, peakBaseY, cx + w * 0.15, peakBaseY, cx, centerTopY);
    g.fillTriangle(cx - w * 0.42, peakBaseY, cx - w * 0.22, peakBaseY, cx - w * 0.32, sideTopY);
    g.fillTriangle(cx + w * 0.22, peakBaseY, cx + w * 0.42, peakBaseY, cx + w * 0.32, sideTopY);
    g.lineStyle(2, 0xd4a017, 1);
    g.strokeTriangle(cx - w * 0.15, peakBaseY, cx + w * 0.15, peakBaseY, cx, centerTopY);
    g.fillStyle(0xdc143c, 1);
    g.fillCircle(cx, centerTopY + h * 0.05, h * 0.10);
    g.fillStyle(0xffd700, 1);
    g.fillCircle(cx - w * 0.32, sideTopY + h * 0.03, h * 0.07);
    g.fillCircle(cx + w * 0.32, sideTopY + h * 0.03, h * 0.07);
    this.scene.tweens.add({ targets: g, y: { from: 0, to: -3 }, duration: 750, yoyo: true, repeat: -1, ease: "Sine.inOut" });
    this.crown = g;
  }

  private tiltCrown(): void {
    if (!this.crown) return;
    this.scene.tweens.add({
      targets: this.crown, rotation: { from: -0.15, to: 0.15 },
      duration: 80, yoyo: true, repeat: 1, ease: "Sine.inOut",
      onComplete: () => { if (this.crown) this.crown.rotation = 0; },
    });
  }

  private destroyCrown(): void {
    if (this.crown) { this.crown.destroy(); this.crown = null; }
  }

  destroy(fromScene?: boolean): void {
    this.blinkEvent?.remove();
    this.scaredResetEvent?.remove();
    this.destroyCrown();
    super.destroy(fromScene);
  }
}
