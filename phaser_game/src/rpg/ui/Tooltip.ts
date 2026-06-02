import Phaser from "phaser";
import { makeTheme, type UiTheme } from "@/rpg/ui/theme";

/**
 * Tooltip — a generic hover/info panel as a Container: a bold title line, a body
 * block, and an auto-sized rounded background. Reusable for item stats, skill
 * descriptions, enemy info, etc. Call `show(title, body, x, y)` / `hide()`.
 *
 * It auto-clamps inside the camera so it never renders off-screen, and pins to
 * the camera (scrollFactor 0) so it stays put in a scrolling world.
 */
export interface TooltipConfig {
  maxWidth?: number;
  theme?: Partial<UiTheme>;
}

export class Tooltip extends Phaser.GameObjects.Container {
  private theme: UiTheme;
  private maxWidth: number;
  private bg: Phaser.GameObjects.Graphics;
  private titleText: Phaser.GameObjects.Text;
  private bodyText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, config: TooltipConfig = {}) {
    super(scene, 0, 0);
    this.theme = makeTheme(config.theme);
    this.maxWidth = config.maxWidth ?? 240;
    this.bg = scene.add.graphics();
    this.titleText = scene.add.text(0, 0, "", {
      fontFamily: this.theme.fontFamily, fontSize: "14px", fontStyle: "bold",
      color: this.theme.accentText,
    });
    this.bodyText = scene.add.text(0, 0, "", {
      fontFamily: this.theme.fontFamily, fontSize: "12px", color: this.theme.text,
      wordWrap: { width: this.maxWidth - this.theme.pad * 2, useAdvancedWrap: true },
    });
    this.add([this.bg, this.titleText, this.bodyText]);
    this.setDepth(3000).setScrollFactor(0).setVisible(false);
    scene.add.existing(this);
  }

  /** Show the tooltip at (x, y), clamped inside the camera. */
  show(title: string, body: string, x: number, y: number): void {
    const pad = this.theme.pad;
    this.titleText.setPosition(pad, pad).setText(title);
    this.bodyText.setPosition(pad, pad + 20).setText(body);
    const w = Math.min(
      this.maxWidth,
      Math.max(this.titleText.width, this.bodyText.width) + pad * 2,
    );
    const h = pad * 2 + 20 + this.bodyText.height;
    this.drawBg(w, h);

    const cam = this.scene.cameras.main;
    const cx = Phaser.Math.Clamp(x, 0, Math.max(0, cam.width - w));
    const cy = Phaser.Math.Clamp(y, 0, Math.max(0, cam.height - h));
    this.setPosition(cx, cy).setVisible(true);
  }

  hide(): void { this.setVisible(false); }

  private drawBg(w: number, h: number): void {
    this.bg.clear();
    this.bg.fillStyle(this.theme.panelFill, this.theme.panelFillAlpha)
      .fillRoundedRect(0, 0, w, h, this.theme.radius);
    this.bg.lineStyle(2, this.theme.panelBorder, this.theme.panelBorderAlpha)
      .strokeRoundedRect(0, 0, w, h, this.theme.radius);
  }
}
