import Phaser from "phaser";
import type { LevelSpec } from "@/builders/levelSpec";
import { buildLevel, type BuiltLevel } from "@/builders/buildLevelFromYAML";
import { Cat } from "@/prefabs/Cat";
import { Enemy } from "@/prefabs/Enemy";
import { Block } from "@/prefabs/Block";
import { Slingshot } from "@/prefabs/Slingshot";
import { Hud } from "@/systems/Hud";
import { CameraRig } from "@/systems/CameraRig";
import { StateRecorder, type RecordableScene } from "@/systems/StateRecorder";
import { clearGameState } from "@/systems/gameState";
import { PHYSICS } from "@/systems/physics";

/**
 * GameScene — thin orchestrator. Builds the level from YAML, wires input, runs
 * the game loop, and exposes the PLAYTEST CONTRACT (currentProjectile, launched,
 * shotsRemaining, score, enemiesAlive, win, lose, objectsByName + window globals
 * via StateRecorder). All heavy lifting lives in prefabs/systems.
 */
export class GameScene extends Phaser.Scene implements RecordableScene {
  public score = 0;
  public shotsRemaining = 3;
  public enemiesAlive = 0;
  public win = false;
  public lose = false;

  private spec!: LevelSpec;
  private built!: BuiltLevel;
  private slingshot!: Slingshot;
  private hud!: Hud;
  private rig!: CameraRig;
  private recorder!: StateRecorder;

  private flightStart = 0;
  private settleSince: number | null = null;

  constructor() { super({ key: "GameScene" }); }

  // ---- contract getters (delegate to subsystems) -------------------------
  get currentProjectile(): Phaser.Physics.Arcade.Sprite | null { return this.slingshot?.current ?? null; }
  get launched(): boolean { return this.slingshot?.launched ?? false; }
  get objectsByName(): Map<string, Phaser.GameObjects.GameObject> { return this.built.objectsByName; }

  create(): void {
    this.spec = this.registry.get("levelSpec") as LevelSpec;
    if (this.scene.isActive("BootScene")) this.scene.stop("BootScene");

    this.built = buildLevel(this, this.spec, { onCollision: (p, t) => this.onCollision(p, t) });
    this.enemiesAlive = this.built.enemies.length;
    this.shotsRemaining = this.spec.lose?.shots ?? this.built.cats.length;

    this.recorder = new StateRecorder(this);
    // Drop the generic __gameState() closure on shutdown so the additive
    // /drive harness can't sample a torn-down scene (restart re-registers).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, clearGameState);
    this.rig = new CameraRig(this, 0);
    this.hud = new Hud(this, this.spec.camera.width);

    if (this.built.slingshotAnchor && this.spec.slingshot) {
      this.slingshot = new Slingshot(this, this.built.slingshotAnchor, this.spec.slingshot, this.built.cats, {
        onLaunch: (cat) => this.onLaunch(cat),
      });
      this.slingshot.init();
    }

    this.input.keyboard?.on("keydown", (e: KeyboardEvent) => {
      if (e.key >= "1" && e.key <= "9") this.swapCat(parseInt(e.key, 10) - 1);
    });

    this.refreshHud();
  }

  update(_t: number, dt: number): void {
    this.recorder.recordFrame();
    this.slingshot?.update(); // redraw cradle band (rest + aim) + trajectory preview
    const cat = this.slingshot?.current;
    if (cat) { cat.updateTrail(); cat.ghostTick(); }
    if (this.slingshot?.launched && cat?.isFlying()) this.tickFlight(cat);
    this.rig?.update(dt, this.launched);
  }

  // ---- launch / flight / settle ------------------------------------------
  private onLaunch(cat: Cat): void {
    this.shotsRemaining = Math.max(0, this.shotsRemaining - 1);
    this.flightStart = this.time.now;
    this.settleSince = null;
    this.rig.followCat(cat);
    if (cat.splitInto >= 2) this.scheduleSplit(cat);
    this.refreshHud();
  }

  private tickFlight(cat: Cat): void {
    const b = cat.body as Phaser.Physics.Arcade.Body;
    const vmag = Math.hypot(b.velocity.x, b.velocity.y);
    if (vmag < PHYSICS.settle.velocityThreshold) {
      if (this.settleSince === null) this.settleSince = this.time.now;
      else if (this.time.now - this.settleSince > PHYSICS.settle.holdMs) this.settleCat(cat);
    } else this.settleSince = null;
    if (this.time.now - this.flightStart > PHYSICS.settle.maxFlightMs) this.settleCat(cat);
  }

  private settleCat(cat: Cat): void {
    cat.settle();
    this.slingshot.launched = false;
    this.settleSince = null;
    this.rig.returnHome();
    this.time.delayedCall(PHYSICS.settle.reloadDelayMs, () => this.reload());
  }

  private reload(): void {
    if (this.win || this.lose) return;
    const hasNext = this.slingshot.advance();
    if (!hasNext || this.shotsRemaining <= 0) {
      if (this.enemiesAlive > 0) this.loseGame();
    }
    this.refreshHud();
  }

  private swapCat(idx: number): void {
    if (this.launched) return;
    this.slingshot.swap(idx);
    this.refreshHud();
  }

  // ---- collisions / damage ------------------------------------------------
  private onCollision(projName: string, targetName: string): void {
    const proj = this.objectsByName.get(projName) as Phaser.Physics.Arcade.Sprite | undefined;
    if (proj) this.resolveHit(proj, targetName);
  }

  private resolveHit(proj: Phaser.Physics.Arcade.Sprite, targetName: string): void {
    const body = proj.body as Phaser.Physics.Arcade.Body | null;
    const impact = body ? Math.hypot(body.velocity.x, body.velocity.y) : 0;
    const dir = body && body.velocity.x < 0 ? -1 : 1;
    this.recorder.logCollision(proj.name, targetName, body, false);
    const target = this.objectsByName.get(targetName);
    if (target instanceof Enemy) {
      this.applyEnemyDamage(target);
    } else if (target instanceof Block) {
      const bx = target.x, by = target.y;
      const res = target.takeDamage(impact, dir);
      if (res.destroyed) {
        this.recorder.markLastDamaged();
        this.addScore(res.score, bx, by - target.displayHeight * 0.5);
        this.objectsByName.delete(targetName);
        this.chainDamage(bx, by);
      }
    }
    this.refreshHud();
    this.checkWin();
  }

  private applyEnemyDamage(enemy: Enemy): void {
    const res = enemy.takeDamage();
    if (res.destroyed) {
      this.recorder.markLastDamaged();
      this.addScore(res.score, enemy.x, enemy.y - enemy.displayHeight * 0.4);
      this.enemiesAlive = Math.max(0, this.enemiesAlive - 1);
      this.objectsByName.delete(enemy.name);
    }
  }

  /** A collapsing block crushes nearby mice. */
  private chainDamage(x: number, y: number): void {
    for (const enemy of this.built.enemies) {
      if (!enemy.active || enemy.defeated) continue;
      if (Math.hypot(enemy.x - x, enemy.y - y) <= PHYSICS.chainDamageRadius) this.applyEnemyDamage(enemy);
    }
    this.checkWin();
  }

  private addScore(amount: number, x: number, y: number): void {
    this.score += amount;
    this.hud.floatScore(x, y, amount);
  }

  // ---- light-cat split ----------------------------------------------------
  private scheduleSplit(cat: Cat): void {
    const n = cat.splitInto, spread = cat.splitSpreadX;
    this.time.delayedCall(cat.splitDelayMs, () => {
      const b = cat.body as Phaser.Physics.Arcade.Body | null;
      if (!cat.active || !b) return;
      const vx = b.velocity.x, vy = b.velocity.y;
      for (let i = 1; i < n; i++) {
        const offset = (i - (n - 1) / 2) * spread / Math.max(1, n - 1);
        const baby = this.physics.add.sprite(cat.x, cat.y, cat.texture.key, cat.frame.name);
        baby.setScale(cat.scaleX, cat.scaleY).setName(`${cat.name}_split_${i}`);
        const bb = baby.body as Phaser.Physics.Arcade.Body;
        bb.setAllowGravity(true);
        bb.setBounce(0.4).setVelocity(vx + offset, vy + (Math.random() - 0.5) * 80);
        bb.setAngularVelocity(PHYSICS.flight.launchAngularVelocity).setAngularDrag(PHYSICS.flight.angularDrag);
        this.wireClone(baby);
      }
      // Parent keeps flying with a slight nudge so the spread feels symmetric.
      b.setVelocity(vx - spread / 2, vy);
    });
  }

  private wireClone(baby: Phaser.Physics.Arcade.Sprite): void {
    const ground = this.objectsByName.get("Ground");
    if (ground) this.physics.add.collider(baby, ground);
    for (const target of [...this.built.enemies, ...this.built.blocks]) {
      this.physics.add.collider(baby, target, () => this.resolveHit(baby, target.name));
    }
    this.time.delayedCall(4000, () => baby.destroy());
  }

  // ---- win / lose ---------------------------------------------------------
  private checkWin(): void {
    if (this.win || this.lose) return;
    const w = this.spec.win;
    const won = w.type === "score_threshold"
      ? this.score >= (w.scoreThreshold ?? Infinity)
      : this.enemiesAlive === 0;
    if (won) {
      this.win = true;
      this.hud.showEnd("Wygrana! Wszyscy wrogowie pokonani — R = restart", () => this.scene.restart());
    }
  }

  private loseGame(): void {
    if (this.win) return;
    this.lose = true;
    this.hud.showEnd("Przegrana — zabrakło kotów. R = restart", () => this.scene.restart());
  }

  private refreshHud(): void {
    this.hud.update(this.shotsRemaining, this.score, this.enemiesAlive, this.slingshot?.queueLabels ?? []);
  }
}
