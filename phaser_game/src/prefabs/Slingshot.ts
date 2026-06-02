import Phaser from "phaser";
import type { SlingshotSpec } from "@/builders/levelSpec";
import { Cat } from "@/prefabs/Cat";
import { PHYSICS, launchImpulse } from "@/systems/physics";

export interface SlingshotHooks {
  /** Fired the instant a cat is released. GameScene handles shots/camera/split/reload. */
  onLaunch(cat: Cat): void;
}

/**
 * Slingshot — launch mechanics + cat queue. Owns the authoritative `launched`
 * flight flag (the playtest contract reads scene.launched, which delegates
 * here). Draws the elastic band (a 3D cradle: far strand BEHIND the cat, near
 * strand IN FRONT) whenever a cat is loaded or being aimed, plus a dotted
 * trajectory preview while aiming.
 */
export class Slingshot {
  public launched = false;
  private queue: Cat[];
  private currentIdx = 0;

  private readonly maxPull: number;
  private readonly pouchOffX: number;
  private readonly pouchOffY: number;

  /** Front strand (drawn above the cat) + dotted aim preview. */
  private band: Phaser.GameObjects.Graphics;
  /** Back strand (drawn below the cat's depth so the cat sits INSIDE the sling). */
  private bandBack: Phaser.GameObjects.Graphics;
  private aimDots: Phaser.GameObjects.Graphics;
  private dragging = false;

  constructor(
    scene: Phaser.Scene,
    private anchor: Phaser.GameObjects.Sprite,
    spec: SlingshotSpec,
    cats: Cat[],
    private hooks: SlingshotHooks,
  ) {
    this.queue = cats.slice();
    this.maxPull = spec.maxPullDistance ?? PHYSICS.slingshot.maxPullDistance;
    this.pouchOffX = spec.pouchOffset?.[0] ?? 0;
    this.pouchOffY = spec.pouchOffset?.[1] ?? -30;
    // Cats render at depth 8 (see level YAML). Back strand sits behind them,
    // front strand well above so the band visibly wraps the loaded cat.
    this.bandBack = scene.add.graphics().setDepth(7);
    this.band = scene.add.graphics().setDepth(50);
    this.aimDots = scene.add.graphics().setDepth(49);
  }

  get current(): Cat | null { return this.queue[this.currentIdx] ?? null; }
  get remaining(): number { return this.queue.length; }
  get queueLabels(): { label: string; active: boolean }[] {
    return this.queue.map((c, i) => ({
      label: c.slot?.label ?? c.name, active: i === this.currentIdx,
    }));
  }

  private pouchX(): number { return this.anchor.x + this.pouchOffX; }
  private pouchY(): number { return this.anchor.y + this.pouchOffY; }

  /** Park every cat, mount the first, wire its drag handlers. */
  init(): void {
    for (const c of this.queue) c.park();
    this.currentIdx = 0;
    this.mountCurrent();
  }

  private mountCurrent(): void {
    const cat = this.current;
    if (!cat) return;
    cat.mountAt(this.pouchX(), this.pouchY());
    this.launched = false;
    this.dragging = false;
    this.wireDrag(cat);
  }

  private wireDrag(cat: Cat): void {
    cat.removeAllListeners("dragstart");
    cat.removeAllListeners("drag");
    cat.removeAllListeners("dragend");
    cat.on("dragstart", () => {
      if (this.launched) return;
      this.dragging = true;
      cat.beginAim();
    });
    cat.on("drag", (_p: Phaser.Input.Pointer, dx: number, dy: number) => {
      if (this.launched) return;
      const ax = this.pouchX(), ay = this.pouchY();
      const vx = dx - ax, vy = dy - ay;
      const dist = Math.hypot(vx, vy);
      const k = dist > this.maxPull ? this.maxPull / dist : 1;
      cat.setPosition(ax + vx * k, ay + vy * k);
      cat.aimFace(ax, ay);
    });
    cat.on("dragend", () => {
      if (this.launched || !this.dragging) return;
      this.dragging = false;
      this.release(cat);
    });
  }

  private release(cat: Cat): void {
    const ax = this.pouchX(), ay = this.pouchY();
    const pullX = ax - cat.x, pullY = ay - cat.y;
    const dist = Math.hypot(pullX, pullY);
    if (dist < PHYSICS.slingshot.minPullDistance) {
      cat.snapBackTo(ax, ay);
      return;
    }
    this.clearBands();
    cat.launch(pullX, pullY);
    this.launched = true;
    this.hooks.onLaunch(cat);
  }

  /** Consume the current cat and mount the next. Returns false if queue empty. */
  advance(): boolean {
    const spent = this.queue.splice(this.currentIdx, 1)[0];
    if (spent) spent.park();
    this.currentIdx = 0;
    if (this.queue.length === 0) { this.clearBands(); return false; }
    this.mountCurrent();
    return true;
  }

  /** Cat-picker: bring slot `idx` to the front and mount it (only when loaded). */
  swap(idx: number): void {
    if (this.launched || idx < 0 || idx >= this.queue.length || idx === this.currentIdx) return;
    const cur = this.current;
    if (cur) cur.park();
    const [picked] = this.queue.splice(idx, 1);
    this.queue.unshift(picked);
    this.currentIdx = 0;
    this.mountCurrent();
  }

  /** Per-frame: redraw the cradle band (rest + aim) + trajectory (aim only). */
  update(): void {
    this.clearBands();
    const cat = this.current;
    if (this.launched || !cat) return;
    if (cat.state !== "loaded" && cat.state !== "aiming") return;
    this.drawBand(cat);
    if (cat.state === "aiming") {
      const ax = this.pouchX(), ay = this.pouchY();
      if (Math.hypot(ax - cat.x, ay - cat.y) > 4) this.drawTrajectory(cat, ax, ay);
    }
  }

  private clearBands(): void {
    this.band.clear();
    this.bandBack.clear();
    this.aimDots.clear();
  }

  private prongs(): { left: { x: number; y: number }; right: { x: number; y: number } } {
    const a = this.anchor;
    const sw = a.displayWidth || 80, sh = a.displayHeight || 200;
    const cos = Math.cos(a.rotation), sin = Math.sin(a.rotation);
    const off = (lx: number, ly: number) => ({ x: a.x + lx * cos - ly * sin, y: a.y + lx * sin + ly * cos });
    return { left: off(-sw * 0.34, -sh * 0.92), right: off(sw * 0.34, -sh * 0.92) };
  }

  /** Two leather strands from the prong tops wrapping to the cat's grip point.
   *  Far strand drawn on bandBack (behind cat), near strand on band (in front). */
  private drawBand(cat: Cat): void {
    const { left, right } = this.prongs();
    // Both strands converge on the cat's grip just below centre and draw in
    // FRONT (depth 50) so the V-cradle is clearly visible over the chubby cat
    // that fills the fork (the fork tips barely clear the cat, so a behind
    // strand would be fully occluded).
    const gx = cat.x, gy = cat.y + cat.displayHeight * 0.06;
    this.strand(this.band, left.x, left.y, gx, gy);
    this.strand(this.band, right.x, right.y, gx, gy);
  }

  private strand(g: Phaser.GameObjects.Graphics, fx: number, fy: number, tx: number, ty: number): void {
    g.lineStyle(7, 0x4a2a1a, 1);
    g.beginPath(); g.moveTo(fx, fy); g.lineTo(tx, ty); g.strokePath();
    g.lineStyle(3, 0x8b5a3c, 0.9);
    g.beginPath(); g.moveTo(fx, fy); g.lineTo(tx, ty); g.strokePath();
  }

  private drawTrajectory(cat: Cat, ax: number, ay: number): void {
    const { vx, vy } = launchImpulse(ax - cat.x, ay - cat.y);
    const g = PHYSICS.gravityY;
    let px = cat.x, py = cat.y, t = 0;
    for (let i = 0; i < 14; i++) {
      t = i * 0.07;
      px = cat.x + vx * t;
      py = cat.y + vy * t + 0.5 * g * t * t;
      if (py > ay + 600) break;
      const fade = 1 - i / 14;
      this.aimDots.fillStyle(cat.haloColor, 0.7 * fade);
      this.aimDots.fillCircle(px, py, 5 * fade + 2);
    }
  }
}
