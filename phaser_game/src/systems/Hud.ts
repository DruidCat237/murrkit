import Phaser from "phaser";

/**
 * Hud — score/shots/targets badge + cat-picker row + floating score popups +
 * win/lose end overlay. Pinned to the camera (scrollFactor 0), responsive to
 * canvas width so the line never clips.
 */
export class Hud {
  private badge: Phaser.GameObjects.Graphics;
  private statusText: Phaser.GameObjects.Text;
  private pickerText: Phaser.GameObjects.Text;

  constructor(private scene: Phaser.Scene, camW: number) {
    const badgeW = 470, badgeH = 78;
    const x = camW - badgeW - 12, y = 10;
    this.badge = scene.add.graphics().setScrollFactor(0).setDepth(999);
    this.badge.fillStyle(0x1a1a2e, 0.55);
    this.badge.fillRoundedRect(x, y, badgeW, badgeH, 14);
    this.badge.lineStyle(2, 0xffd84a, 0.85);
    this.badge.strokeRoundedRect(x, y, badgeW, badgeH, 14);
    this.statusText = scene.add.text(x + 16, y + 8, "", {
      fontFamily: "Verdana, Arial Black, sans-serif", fontStyle: "bold",
      fontSize: "22px", color: "#ffd84a", stroke: "#1a1a2e", strokeThickness: 5,
      shadow: { offsetX: 0, offsetY: 2, color: "#000", blur: 4, fill: true },
    }).setScrollFactor(0).setDepth(1000);
    this.pickerText = scene.add.text(x + 16, y + 44, "", {
      fontFamily: "Verdana, Arial, sans-serif", fontSize: "15px",
      color: "#fff5d6", stroke: "#1a1a2e", strokeThickness: 3,
    }).setScrollFactor(0).setDepth(1000);
  }

  update(shots: number, score: number, targets: number, queue: { label: string; active: boolean }[]): void {
    this.statusText.setText(`Strzały: ${shots} · Wynik: ${score} · Cele: ${targets}`);
    if (queue.length) {
      const parts = queue.map((q, i) => `${q.active ? "▶" : i + 1} ${q.label}`);
      this.pickerText.setText(`Koty (1/2/3): ${parts.join("  ")}`);
    } else this.pickerText.setText("");
  }

  /** Floating "+N" score popup at a world position. */
  floatScore(x: number, y: number, amount: number): void {
    const t = this.scene.add.text(x, y, `+${amount}`, {
      fontFamily: "Verdana, sans-serif", fontStyle: "bold", fontSize: "26px",
      color: "#ffe066", stroke: "#5a3a00", strokeThickness: 4,
    }).setOrigin(0.5).setDepth(1500);
    this.scene.tweens.add({
      targets: t, y: y - 60, alpha: 0, scale: 1.3,
      duration: 800, ease: "Cubic.out", onComplete: () => t.destroy(),
    });
  }

  showEnd(message: string, onRestart: () => void): void {
    const cam = this.scene.cameras.main;
    const txt = this.scene.add.text(cam.width / 2, cam.height / 2, message, {
      fontFamily: "Verdana, sans-serif", fontSize: "26px", fontStyle: "bold",
      color: "#ffffff", backgroundColor: "rgba(10,10,25,0.72)",
      stroke: "#000000", strokeThickness: 4, padding: { x: 26, y: 16 },
      align: "center", wordWrap: { width: 520, useAdvancedWrap: true },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2000);
    this.scene.tweens.add({ targets: txt, scale: { from: 0.7, to: 1 }, duration: 320, ease: "Back.out" });
    this.scene.input.keyboard?.once("keydown-R", onRestart);
  }
}
