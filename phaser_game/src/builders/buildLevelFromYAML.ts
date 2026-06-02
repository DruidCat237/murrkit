import Phaser from "phaser";
import { type LevelSpec, type ObjectSpec, inferKind } from "@/builders/levelSpec";
import { Cat } from "@/prefabs/Cat";
import { Enemy } from "@/prefabs/Enemy";
import { Block } from "@/prefabs/Block";
import { sliceFrame } from "@/systems/textureFrames";

export interface BuiltLevel {
  objectsByName: Map<string, Phaser.GameObjects.GameObject>;
  cats: Cat[];
  enemies: Enemy[];
  blocks: Block[];
  slingshotAnchor: Phaser.GameObjects.Sprite | null;
}

export interface BuildHooks {
  /** Fired when a cat collides with one of its `collidesWith` targets. */
  onCollision(projName: string, targetName: string): void;
}

/**
 * Deterministically turn a LevelSpec into a Phaser scene-graph. The ONLY way a
 * level is built — every fix is a whole-scene rebuild from spec, so compounding
 * regressions can't accumulate. Wires cat↔target colliders (overlap for the
 * fast-cat's phaseThrough list) and cat↔ground.
 */
export function buildLevel(scene: Phaser.Scene, spec: LevelSpec, hooks: BuildHooks): BuiltLevel {
  const objectsByName = new Map<string, Phaser.GameObjects.GameObject>();
  const cats: Cat[] = [];
  const enemies: Enemy[] = [];
  const blocks: Block[] = [];

  buildBackground(scene, spec);
  const ground = buildGround(scene, spec, objectsByName);

  for (const obj of spec.objects) {
    const kind = inferKind(obj);
    if (kind === "cat") {
      const tx = sliceFrame(scene, obj.sprite);
      const cat = new Cat(scene, obj, tx.key, tx.frame);
      cats.push(cat);
      objectsByName.set(obj.name, cat);
    } else if (kind === "enemy") {
      const base = sliceFrame(scene, obj.sprite);
      const e = new Enemy(scene, obj, base);
      enemies.push(e);
      objectsByName.set(obj.name, e);
    } else if (kind === "block") {
      const b = new Block(scene, obj, obj.sprite.key);
      blocks.push(b);
      objectsByName.set(obj.name, b);
    } else {
      objectsByName.set(obj.name, buildProp(scene, obj));
    }
  }

  // Configure cat slots (ability/phaseThrough/alt textures) before wiring colliders.
  for (const slot of spec.slingshot?.cats ?? []) {
    cats.find((c) => c.name === slot.name)?.configureSlot(slot);
  }

  wireColliders(scene, spec, objectsByName, cats, ground, hooks);

  // Camera + physics world bounds.
  const wb = spec.camera.worldBounds;
  if (wb) {
    scene.cameras.main.setBounds(wb[0], wb[1], wb[2], wb[3]);
    scene.physics.world.setBounds(wb[0], wb[1], wb[2], wb[3]);
  }

  const slingshotAnchor = spec.slingshot
    ? (objectsByName.get(spec.slingshot.anchor) as Phaser.GameObjects.Sprite | undefined) ?? null
    : null;

  return { objectsByName, cats, enemies, blocks, slingshotAnchor };
}

function buildBackground(scene: Phaser.Scene, spec: LevelSpec): void {
  const layers = spec.background?.layers;
  if (!layers) return;
  const wb = spec.camera.worldBounds;
  const fullW = wb ? wb[2] : spec.camera.width * 4;
  const camH = spec.camera.height;
  for (const layer of layers) {
    const tile = scene.add.tileSprite(0, 0, fullW, camH, layer.key).setOrigin(0, 0);
    tile.setScrollFactor(layer.scrollFactor ?? 1);
    if (layer.alpha !== undefined) tile.setAlpha(layer.alpha);
    tile.setDepth(-100);
  }
}

function buildGround(
  scene: Phaser.Scene, spec: LevelSpec, reg: Map<string, Phaser.GameObjects.GameObject>,
): Phaser.GameObjects.GameObject | null {
  const g = spec.ground;
  if (!g) return null;
  let ground: Phaser.GameObjects.GameObject;
  if (g.tile) {
    const t = scene.add.tileSprite(0, g.y, g.width, g.height, g.tile.key).setOrigin(0, 0).setDepth(-10);
    scene.physics.add.existing(t, true);
    ground = t;
  } else {
    const r = scene.add.rectangle(0, g.y, g.width, g.height, parseInt((g.color ?? "#6b4f2a").replace("#", "0x"), 16)).setOrigin(0, 0);
    scene.physics.add.existing(r, true);
    ground = r;
  }
  ground.setName("Ground");
  reg.set("Ground", ground);
  return ground;
}

function buildProp(scene: Phaser.Scene, obj: ObjectSpec): Phaser.GameObjects.Sprite {
  const tx = sliceFrame(scene, obj.sprite);
  const s = tx.frame ? scene.physics.add.staticSprite(obj.x, obj.y, tx.key, tx.frame)
                     : scene.physics.add.staticSprite(obj.x, obj.y, tx.key);
  s.setName(obj.name);
  if (obj.scale !== undefined) s.setScale(obj.scale);
  s.setOrigin(obj.origin?.[0] ?? 0.5, obj.origin?.[1] ?? 1.0);
  if (obj.rotation !== undefined) s.setRotation(obj.rotation);
  if (obj.alpha !== undefined) s.setAlpha(obj.alpha);
  if (obj.flipX) s.setFlipX(true);
  if (obj.depth !== undefined) s.setDepth(obj.depth);
  s.setData("spec", obj);
  (s.body as Phaser.Physics.Arcade.StaticBody).updateFromGameObject();
  return s;
}

function wireColliders(
  scene: Phaser.Scene, spec: LevelSpec,
  reg: Map<string, Phaser.GameObjects.GameObject>, cats: Cat[],
  ground: Phaser.GameObjects.GameObject | null, hooks: BuildHooks,
): void {
  const specByName = new Map(spec.objects.map((o) => [o.name, o]));
  for (const cat of cats) {
    if (ground) scene.physics.add.collider(cat, ground);
    const catSpec = specByName.get(cat.name);
    for (const targetName of catSpec?.collidesWith ?? []) {
      const target = reg.get(targetName);
      if (!target) continue;
      if (cat.phaseThrough.has(targetName)) {
        scene.physics.add.overlap(cat, target, () => cat.markPhase());
      } else {
        scene.physics.add.collider(cat, target, () => hooks.onCollision(cat.name, targetName));
      }
    }
  }
}
