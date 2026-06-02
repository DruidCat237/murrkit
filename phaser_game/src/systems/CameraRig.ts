import Phaser from "phaser";

/**
 * CameraRig — follows the cat in flight, eases back to the slingshot on settle,
 * and supports manual pan (right/middle-drag + arrow keys) while aiming.
 */
export class CameraRig {
  private cam: Phaser.Cameras.Scene2D.Camera;
  private panAnchor: { px: number; sx: number } | null = null;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;

  constructor(private scene: Phaser.Scene, private homeScrollX = 0) {
    this.cam = scene.cameras.main;
    this.cursors = scene.input.keyboard?.createCursorKeys();
    scene.input.mouse?.disableContextMenu();
    scene.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (p.button === 1 || p.button === 2) this.panAnchor = { px: p.x, sx: this.cam.scrollX };
    });
    scene.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.panAnchor) return;
      this.cam.stopFollow();
      this.cam.scrollX = this.panAnchor.sx - (p.x - this.panAnchor.px);
    });
    scene.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (p.button === 1 || p.button === 2) this.panAnchor = null;
    });
  }

  followCat(cat: Phaser.GameObjects.GameObject): void {
    this.cam.startFollow(cat, true, 0.1, 0.1);
  }

  /** Stop following + glide back to the launch position. */
  returnHome(): void {
    this.cam.stopFollow();
    this.scene.tweens.add({
      targets: this.cam, scrollX: this.homeScrollX,
      duration: 600, ease: "Cubic.inOut",
    });
  }

  update(dt: number, locked: boolean): void {
    if (locked || !this.cursors) return;
    const speed = 0.6;
    if (this.cursors.left?.isDown) this.cam.scrollX -= speed * dt;
    if (this.cursors.right?.isDown) this.cam.scrollX += speed * dt;
  }
}
