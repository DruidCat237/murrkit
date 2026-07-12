/**
 * TilemapScene — boots any `phaser_game/maps/<id>.map.yaml` via `?level=<id>`.
 *
 * Flow: parse YAML → preload each biome sheet that declares an `image` →
 * compile to Tiled JSON → build the tilemap (placeholder colours for biomes
 * whose sheet is missing or 404s) → drop a keyboard-driven avatar on `spawn`
 * (WASD/arrows; collides with non-walkable biomes) or free-pan the camera.
 *
 * Playtest contract: registers `window.__gameState()` with `player.x/y`, so
 * `/api/phaser/drive` asserts (`player.x_increased`, …) work on maps with a
 * spawn out of the box; without a spawn it reports the camera scroll instead.
 */

import Phaser from "phaser";
import yaml from "js-yaml";
import { compileMap, buildTilemap, type CompiledMap } from "@/builders/buildMapFromYAML";
import { loadMapText } from "@/builders/mapRegistry";
import { validateMapSpec, type MapSpec } from "@/builders/mapSpec";
import { registerGameState, clearGameState } from "@/systems/gameState";

const AVATAR_SPEED = 220; // px/s

export class TilemapScene extends Phaser.Scene {
  private compiled: CompiledMap | null = null;
  private avatar: Phaser.GameObjects.Arc | null = null;
  private keys: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key[]> = {
    up: [], down: [], left: [], right: [],
  };

  constructor() { super({ key: "TilemapScene" }); }

  preload(): void {
    const status = (msg: string): void => {
      const el = document.getElementById("status-bar");
      if (el) el.textContent = msg;
    };
    const mapId = window.levelId;
    const text = loadMapText(mapId);
    if (text === undefined) {
      status(`murrkit · ❌ map '${mapId}' not bundled`);
      throw new Error(`map '${mapId}' not found in phaser_game/maps/`);
    }
    let spec: MapSpec;
    try {
      const parsed = yaml.load(text);
      validateMapSpec(parsed);
      spec = parsed;
    } catch (e) {
      status(`murrkit · ❌ ${mapId}.map.yaml: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
    this.compiled = compileMap(spec);

    // Queue only sheets the YAML actually points at; a 404 is survivable —
    // create() falls back to the placeholder texture for that biome.
    for (let i = 0; i < spec.tilesets.length; i++) {
      const t = spec.tilesets[i];
      if (t.image) this.load.image(this.compiled.textureKeys[i], t.image);
    }
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      console.warn(`map '${mapId}': tileset sheet missing (${file.key} ← ${file.src}) — using placeholder`);
    });
  }

  create(): void {
    const compiled = this.compiled!;
    const { spec } = compiled;
    const built = buildTilemap(this, compiled);
    const T = spec.tileSize;
    const worldW = spec.width * T, worldH = spec.height * T;

    this.cameras.main.setBounds(0, 0, worldW, worldH);
    this.physics.world.setBounds(0, 0, worldW, worldH);

    if (compiled.spawn) {
      const a = this.add.circle(compiled.spawn.x * T, compiled.spawn.y * T, T * 0.35, 0xffffff)
        .setStrokeStyle(Math.max(2, T / 16), 0x222222)
        .setDepth(10);
      this.physics.add.existing(a);
      const body = a.body as Phaser.Physics.Arcade.Body;
      body.setAllowGravity(false); // global config is a side-view gravity world
      body.setCollideWorldBounds(true);
      body.setCircle(T * 0.35);
      this.physics.add.collider(a, built.groundLayer);
      this.avatar = a;
      this.cameras.main.startFollow(a, true, 0.15, 0.15);
    }

    const kb = this.input.keyboard;
    if (kb) {
      const K = Phaser.Input.Keyboard.KeyCodes;
      this.keys = {
        up: [kb.addKey(K.UP), kb.addKey(K.W)],
        down: [kb.addKey(K.DOWN), kb.addKey(K.S)],
        left: [kb.addKey(K.LEFT), kb.addKey(K.A)],
        right: [kb.addKey(K.RIGHT), kb.addKey(K.D)],
      };
    }
    // Wheel zoom (free look at big maps) — clamped so tiles stay readable.
    this.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      const cam = this.cameras.main;
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.25, 3));
    });

    registerGameState(this, () => {
      const body = this.avatar?.body as Phaser.Physics.Arcade.Body | undefined;
      return {
        t: this.time.now,
        player: this.avatar && body
          ? { x: this.avatar.x, y: this.avatar.y, vx: body.velocity.x, vy: body.velocity.y }
          : { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY, vx: 0, vy: 0 },
        scene: { key: "TilemapScene", win: false, lose: false },
        custom: { mapId: spec.id, placeholderBiomes: built.placeholderBiomes },
      };
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => clearGameState());

    const el = document.getElementById("status-bar");
    if (el) {
      const ph = built.placeholderBiomes.length
        ? ` · placeholder: ${built.placeholderBiomes.join(",")}`
        : "";
      el.textContent =
        `murrkit · map=${spec.id} · ${spec.width}×${spec.height}@${T}px · ` +
        `${spec.tilesets.length} biome(s)${ph}`;
    }
  }

  update(_time: number, deltaMs: number): void {
    const down = (dir: keyof typeof this.keys): boolean =>
      this.keys[dir].some((k) => k.isDown);
    const vx = (down("right") ? 1 : 0) - (down("left") ? 1 : 0);
    const vy = (down("down") ? 1 : 0) - (down("up") ? 1 : 0);

    if (this.avatar) {
      const body = this.avatar.body as Phaser.Physics.Arcade.Body;
      const v = new Phaser.Math.Vector2(vx, vy).normalize().scale(AVATAR_SPEED);
      body.setVelocity(v.x, v.y);
    } else {
      // No spawn → arrows pan the free camera.
      const cam = this.cameras.main;
      const pan = (AVATAR_SPEED * 2 * deltaMs) / 1000 / cam.zoom;
      cam.setScroll(cam.scrollX + vx * pan, cam.scrollY + vy * pan);
    }
  }
}
