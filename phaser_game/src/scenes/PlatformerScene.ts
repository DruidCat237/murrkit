import Phaser from "phaser";
import { registerGameState, clearGameState } from "@/systems/gameState";

/**
 * PlatformerScene — genre proof: a cold-prompt side-scroll platformer driven by
 * the generic /api/phaser/drive harness. Run via ?level=platformer.
 *
 * Player runs left/right + jumps (coyote-time + jump-buffer), collects mouse
 * "coins" for score, and wins by touching the flag. Falling out of the world
 * respawns at the start. All physics is Arcade; assets are reused angrycat
 * placeholders; platforms are flat rectangles (proof gameplay, not final art).
 *
 * Exposes the genre-neutral playtest contract via registerGameState():
 *   { t, player:{x,y,vx,vy,onGround}, score, scene:{key,win,lose} }
 */

const WORLD_W = 2000;
const WORLD_H = 720;
const GROUND_TOP = 660;

const RUN_SPEED = 240;
const JUMP_VELOCITY = -520;
const COYOTE_MS = 80;
const JUMP_BUFFER_MS = 120;
const RESPAWN_Y = 800;

const SPAWN_X = 120;
const SPAWN_Y = GROUND_TOP - 4;

const PLAYER_KEY = "pf_player";
const COIN_KEY = "pf_coin";
// frame0 is a single trimmed cat (418x418); the *_idle.png is a 2x2 grid.
const PLAYER_URL =
  "assets/angrycat/Sprites/grumpy_fat_round_black_cat_cha/grumpy_fat_round_black_cat_cha_frame0.png";
// mouse_scared_v2 is a 2x2 grid of 512x512 frames — load as a sheet, use frame 0.
const COIN_URL = "assets/angrycat/Sprites/mouse_scared_v2/mouse_scared_v2.png";
const COIN_FRAME = 512;

interface PlatformDef { x: number; y: number; w: number; h: number; }
interface CoinDef { x: number; y: number; }

const PLATFORMS: PlatformDef[] = [
  { x: 480, y: 540, w: 200, h: 26 },
  { x: 760, y: 440, w: 180, h: 26 },
  { x: 1080, y: 540, w: 200, h: 26 },
  { x: 1450, y: 500, w: 200, h: 26 },
];

// Coin y = platform-top - 22 (mouse sits on the surface); ground coins at y=612.
const COINS: CoinDef[] = [
  { x: 300, y: 612 },
  { x: 480, y: 505 },
  { x: 760, y: 405 },
  { x: 1080, y: 505 },
  { x: 1300, y: 612 },
  { x: 1450, y: 465 },
];

const FLAG_X = 1850;

export class PlatformerScene extends Phaser.Scene {
  public score = 0;
  public win = false;
  public lose = false;

  private player!: Phaser.Physics.Arcade.Sprite;
  private body!: Phaser.Physics.Arcade.Body;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keySpace!: Phaser.Input.Keyboard.Key;

  private platformRects: Phaser.GameObjects.Rectangle[] = [];
  private coins!: Phaser.Physics.Arcade.Group;
  private totalCoins = COINS.length;

  private scoreText!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;

  private lastGroundedAt = -1e9;
  private jumpBufferedAt = -1e9;
  private deaths = 0;

  constructor() {
    super({ key: "PlatformerScene" });
  }

  preload(): void {
    this.load.image(PLAYER_KEY, PLAYER_URL);
    this.load.spritesheet(COIN_KEY, COIN_URL, {
      frameWidth: COIN_FRAME, frameHeight: COIN_FRAME,
    });
  }

  create(): void {
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H + 240);
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.setBackgroundColor("#87CEEB");

    this.addClouds();
    this.addGroundAndPlatforms();
    this.addPlayer();
    this.addCoins();
    this.addFlag();
    this.addHud();
    this.wireInput();

    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);

    registerGameState(this, () => ({
      t: this.time.now,
      player: {
        x: this.player.x,
        y: this.player.y,
        vx: this.body.velocity.x,
        vy: this.body.velocity.y,
        onGround: this.body.blocked.down || this.body.touching.down,
      },
      score: this.score,
      scene: { key: this.scene.key, win: this.win, lose: this.lose },
    }));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, clearGameState);
  }

  // ---- world build -------------------------------------------------------

  private addClouds(): void {
    const positions = [
      { x: 220, y: 120 }, { x: 620, y: 90 }, { x: 1020, y: 150 },
      { x: 1480, y: 100 }, { x: 1820, y: 140 },
    ];
    for (const p of positions) {
      const cloud = this.add.ellipse(p.x, p.y, 160, 64, 0xffffff, 0.85);
      cloud.setScrollFactor(0.3);
      cloud.setDepth(-10);
    }
  }

  private addGroundAndPlatforms(): void {
    const groundH = WORLD_H - GROUND_TOP + 60;
    const ground = this.add.rectangle(
      WORLD_W / 2, GROUND_TOP + groundH / 2, WORLD_W, groundH, 0x8a5a2b,
    );
    ground.setName("Ground");
    this.physics.add.existing(ground, true);
    this.platformRects.push(ground);
    // grass strip on top of the dirt
    this.add.rectangle(WORLD_W / 2, GROUND_TOP + 6, WORLD_W, 12, 0x5bbf4a).setDepth(1);

    for (const def of PLATFORMS) {
      const r = this.add.rectangle(def.x, def.y, def.w, def.h, 0x6b4f2a);
      this.add.rectangle(def.x, def.y - def.h / 2 + 5, def.w, 10, 0x5bbf4a).setDepth(1);
      this.physics.add.existing(r, true);
      this.platformRects.push(r);
    }
  }

  private addPlayer(): void {
    this.player = this.physics.add.sprite(SPAWN_X, SPAWN_Y, PLAYER_KEY);
    this.player.setOrigin(0.5, 1);
    this.player.setDisplaySize(56, 64);
    this.player.setName("Player");
    this.player.setDepth(5);
    this.body = this.player.body as Phaser.Physics.Arcade.Body;
    this.body.setCollideWorldBounds(false);
    this.physics.add.collider(this.player, this.platformRects);
  }

  private addCoins(): void {
    this.coins = this.physics.add.group({ allowGravity: false, immovable: true });
    for (const c of COINS) {
      const coin = this.coins.create(c.x, c.y, COIN_KEY, 0) as Phaser.Physics.Arcade.Sprite;
      coin.setOrigin(0.5, 0.5);
      coin.setDisplaySize(40, 40);
      coin.setDepth(4);
      const b = coin.body as Phaser.Physics.Arcade.Body;
      b.setAllowGravity(false);
      b.setImmovable(true);
    }
    this.physics.add.overlap(
      this.player, this.coins,
      (_p, coinObj) => this.collectCoin(coinObj as Phaser.Physics.Arcade.Sprite),
    );
  }

  private addFlag(): void {
    const pole = this.add.rectangle(FLAG_X, GROUND_TOP, 8, 150, 0x4a3a2a);
    pole.setOrigin(0.5, 1);
    pole.setDepth(3);
    const cloth = this.add.triangle(
      FLAG_X + 4, GROUND_TOP - 150, 0, 0, 48, 18, 0, 36, 0xff3b30,
    );
    cloth.setOrigin(0, 0);
    cloth.setDepth(3);

    const zone = this.add.zone(FLAG_X, GROUND_TOP - 75, 50, 150);
    this.physics.add.existing(zone, true);
    this.physics.add.overlap(this.player, zone, () => this.onWin());
  }

  private addHud(): void {
    this.scoreText = this.add.text(24, 20, "", {
      fontFamily: "Arial, sans-serif",
      fontSize: "30px",
      color: "#ffffff",
      fontStyle: "bold",
    });
    this.scoreText.setStroke("#000000", 5);
    this.scoreText.setScrollFactor(0);
    this.scoreText.setDepth(1000);
    this.refreshHud();

    this.banner = this.add.text(640, 300, "", {
      fontFamily: "Arial, sans-serif",
      fontSize: "72px",
      color: "#ffe14d",
      fontStyle: "bold",
      align: "center",
    });
    this.banner.setOrigin(0.5, 0.5);
    this.banner.setStroke("#000000", 8);
    this.banner.setScrollFactor(0);
    this.banner.setDepth(2000);
    this.banner.setVisible(false);
  }

  private refreshHud(): void {
    this.scoreText.setText(`Monety: ${this.score}/${this.totalCoins}`);
  }

  private wireInput(): void {
    const kb = this.input.keyboard;
    if (!kb) throw new Error("PlatformerScene requires a keyboard plugin");
    this.cursors = kb.createCursorKeys();
    this.keyA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keySpace = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
  }

  // ---- gameplay events ---------------------------------------------------

  private collectCoin(coin: Phaser.Physics.Arcade.Sprite): void {
    if (!coin.active) return;
    coin.active = false;
    (coin.body as Phaser.Physics.Arcade.Body).enable = false;
    this.score += 1;
    this.refreshHud();
    this.tweens.add({
      targets: coin,
      scale: coin.scale * 1.6,
      alpha: 0,
      y: coin.y - 30,
      duration: 250,
      ease: "Quad.easeOut",
      onComplete: () => coin.destroy(),
    });
  }

  private onWin(): void {
    if (this.win) return;
    this.win = true;
    this.body.setVelocity(0, 0);
    this.body.setAllowGravity(false);
    this.cameras.main.flash(400, 255, 255, 255);
    this.banner.setText("WYGRANA!").setVisible(false);
    this.banner.setText("WYGRANA!");
    this.banner.setVisible(true);
    this.tweens.add({
      targets: this.player, scaleX: this.player.scaleX * 1.15,
      scaleY: this.player.scaleY * 1.15, yoyo: true, repeat: 3, duration: 180,
    });
  }

  private respawn(): void {
    this.deaths += 1;
    this.lose = true;
    this.player.setPosition(SPAWN_X, SPAWN_Y);
    this.body.setVelocity(0, 0);
    this.cameras.main.shake(180, 0.01);
  }

  private doJump(now: number): void {
    this.body.setVelocityY(JUMP_VELOCITY);
    this.lastGroundedAt = -1e9;
    this.jumpBufferedAt = -1e9;
    this.tweens.add({
      targets: this.player, scaleY: this.player.scaleY * 0.82,
      yoyo: true, duration: 110, ease: "Quad.easeOut",
    });
    void now;
  }

  // ---- main loop ---------------------------------------------------------

  update(_time: number, _delta: number): void {
    if (this.win) return;
    const now = this.time.now;
    const onGround = this.body.blocked.down || this.body.touching.down;
    if (onGround) this.lastGroundedAt = now;

    const left = this.cursors.left.isDown || this.keyA.isDown;
    const right = this.cursors.right.isDown || this.keyD.isDown;
    if (left && !right) {
      this.body.setVelocityX(-RUN_SPEED);
      this.player.setFlipX(true);
    } else if (right && !left) {
      this.body.setVelocityX(RUN_SPEED);
      this.player.setFlipX(false);
    } else {
      this.body.setVelocityX(0);
    }

    const jumpPressed =
      Phaser.Input.Keyboard.JustDown(this.keySpace) ||
      Phaser.Input.Keyboard.JustDown(this.cursors.space) ||
      Phaser.Input.Keyboard.JustDown(this.cursors.up);
    if (jumpPressed) this.jumpBufferedAt = now;

    const buffered = now - this.jumpBufferedAt <= JUMP_BUFFER_MS;
    const coyote = now - this.lastGroundedAt <= COYOTE_MS;
    if (buffered && coyote) this.doJump(now);

    if (this.player.y > RESPAWN_Y) this.respawn();
  }
}
