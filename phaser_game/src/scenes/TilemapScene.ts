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
import { compileMap, buildTilemap, type BuiltMap, type CompiledMap } from "@/builders/buildMapFromYAML";
import { loadMapText } from "@/builders/mapRegistry";
import { tileDims, validateMapSpec, type MapSpec } from "@/builders/mapSpec";
import { registerGameState, clearGameState } from "@/systems/gameState";

const AVATAR_SPEED = 220; // px/s

export class TilemapScene extends Phaser.Scene {
  private compiled: CompiledMap | null = null;
  private built: BuiltMap | null = null;
  private avatar: Phaser.GameObjects.Shape | null = null;
  // Isometric avatars move manually (arcade tile collision is ortho-only);
  // this mirrors body.velocity so `/drive` vx/vy asserts work in both modes.
  private manualVel = { x: 0, y: 0 };
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
    this.built = built;
    const T = spec.tileSize;
    const iso = spec.projection === "isometric";
    const { tileW, tileH } = tileDims(spec);

    // World box from the map's corner tiles — projection-agnostic (for
    // orthogonal this is exactly [0, 0, W·T, H·T]; for isometric the diamond's
    // bounding box, whose min X is negative).
    const { width: W, height: H } = spec;
    const corners = [
      built.map.tileToWorldXY(0, 0)!, built.map.tileToWorldXY(W - 1, 0)!,
      built.map.tileToWorldXY(0, H - 1)!, built.map.tileToWorldXY(W - 1, H - 1)!,
    ];
    const minX = Math.min(...corners.map((c) => c.x));
    const minY = Math.min(...corners.map((c) => c.y));
    const maxX = Math.max(...corners.map((c) => c.x)) + tileW;
    const maxY = Math.max(...corners.map((c) => c.y)) + tileH;

    this.cameras.main.setBounds(minX, minY, maxX - minX, maxY - minY);
    this.physics.world.setBounds(minX, minY, maxX - minX, maxY - minY);

    if (compiled.spawn) {
      let a: Phaser.GameObjects.Shape;
      if (iso) {
        // tileToWorldXY returns the diamond's bbox top-left (Phaser's iso
        // convention) — +half cell puts the avatar on the tile's centre.
        const p = built.map.tileToWorldXY(compiled.spawn.x, compiled.spawn.y)!;
        a = this.add.ellipse(p.x + tileW / 2, p.y + tileH / 2, tileW * 0.55, tileH * 0.55, 0xffffff)
          .setStrokeStyle(Math.max(2, T / 16), 0x222222)
          .setDepth(10);
        // No arcade body: tile collision is orthogonal-only in arcade physics,
        // so update() moves the avatar manually against the biome grid.
      } else {
        a = this.add.circle(compiled.spawn.x * T, compiled.spawn.y * T, T * 0.35, 0xffffff)
          .setStrokeStyle(Math.max(2, T / 16), 0x222222)
          .setDepth(10);
        this.physics.add.existing(a);
        const body = a.body as Phaser.Physics.Arcade.Body;
        body.setAllowGravity(false); // global config is a side-view gravity world
        body.setCollideWorldBounds(true);
        body.setCircle(T * 0.35);
        this.physics.add.collider(a, built.groundLayer);
      }
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
      const player = this.avatar
        ? {
            x: this.avatar.x, y: this.avatar.y,
            vx: body ? body.velocity.x : this.manualVel.x,
            vy: body ? body.velocity.y : this.manualVel.y,
          }
        : { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY, vx: 0, vy: 0 };
      const tile = this.avatar
        ? built.map.worldToTileXY(this.avatar.x, this.avatar.y, true)
        : null;
      return {
        t: this.time.now,
        player,
        scene: { key: "TilemapScene", win: false, lose: false },
        custom: {
          mapId: spec.id,
          placeholderBiomes: built.placeholderBiomes,
          projection: spec.projection ?? "orthogonal",
          playerTile: tile ? { x: tile.x, y: tile.y } : null,
        },
      };
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => clearGameState());

    const el = document.getElementById("status-bar");
    if (el) {
      const ph = built.placeholderBiomes.length
        ? ` · placeholder: ${built.placeholderBiomes.join(",")}`
        : "";
      const proj = iso ? ` · iso 2:1 (${tileW}×${tileH})` : "";
      el.textContent =
        `murrkit · map=${spec.id} · ${spec.width}×${spec.height}@${T}px${proj} · ` +
        `${spec.tilesets.length} biome(s)${ph}`;
    }
  }

  /** True when every collision sample around (x, y) lands on a walkable tile
   *  INSIDE the map. Manual replacement for arcade layer collision, which
   *  only supports orthogonal maps — used by the isometric avatar. */
  private walkableAt(x: number, y: number): boolean {
    const built = this.built!;
    const { spec, biomeGrid } = built.compiled;
    const { tileW, tileH } = tileDims(spec);
    const rx = tileW * 0.22, ry = tileH * 0.22;
    const samples: Array<[number, number]> = [
      [x, y], [x - rx, y], [x + rx, y], [x, y - ry], [x, y + ry],
    ];
    for (const [sx, sy] of samples) {
      const t = built.map.worldToTileXY(sx, sy, true);
      if (!t || t.x < 0 || t.y < 0 || t.x >= spec.width || t.y >= spec.height) return false;
      const biome = spec.tilesets[biomeGrid[t.y * spec.width + t.x]];
      if (biome.walkable === false) return false;
    }
    return true;
  }

  update(_time: number, deltaMs: number): void {
    const down = (dir: keyof typeof this.keys): boolean =>
      this.keys[dir].some((k) => k.isDown);
    const vx = (down("right") ? 1 : 0) - (down("left") ? 1 : 0);
    const vy = (down("down") ? 1 : 0) - (down("up") ? 1 : 0);

    if (this.avatar && this.avatar.body) {
      // Orthogonal: arcade physics moves the body, the layer collider blocks.
      const body = this.avatar.body as Phaser.Physics.Arcade.Body;
      const v = new Phaser.Math.Vector2(vx, vy).normalize().scale(AVATAR_SPEED);
      body.setVelocity(v.x, v.y);
    } else if (this.avatar) {
      // Isometric: keys still mean SCREEN axes; move manually and block each
      // axis against the biome grid (slide along diamond edges axis-by-axis).
      const dt = deltaMs / 1000;
      const v = new Phaser.Math.Vector2(vx, vy).normalize().scale(AVATAR_SPEED);
      const a = this.avatar;
      let nx = a.x + v.x * dt, ny = a.y;
      if (v.x !== 0 && !this.walkableAt(nx, a.y)) nx = a.x;
      ny = a.y + v.y * dt;
      if (v.y !== 0 && !this.walkableAt(nx, ny)) ny = a.y;
      this.manualVel = { x: dt > 0 ? (nx - a.x) / dt : 0, y: dt > 0 ? (ny - a.y) / dt : 0 };
      a.setPosition(nx, ny);
    } else {
      // No spawn → arrows pan the free camera.
      const cam = this.cameras.main;
      const pan = (AVATAR_SPEED * 2 * deltaMs) / 1000 / cam.zoom;
      cam.setScroll(cam.scrollX + vx * pan, cam.scrollY + vy * pan);
    }
  }
}
