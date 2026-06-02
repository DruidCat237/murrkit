import Phaser from "phaser";
import { makeTheme, type UiTheme } from "@/rpg/ui/theme";

/**
 * HpMpBars — a generic, theme-able HP (+ optional MP) bar widget as a Container.
 *
 * Drop it anywhere (over a battler, in a party panel) and call `set(hp, maxHp,
 * mp, maxMp)` to redraw. Pure Graphics + Text, no textures required, so it works
 * before any sprite art exists. The fill tweens smoothly toward the new ratio.
 */
export interface HpMpBarsConfig {
  width?: number;
  /** Show the MP bar under the HP bar. Default true. */
  showMp?: boolean;
  /** Optional label drawn above the bars (e.g. the unit's name). */
  label?: string;
  theme?: Partial<UiTheme>;
}

export class HpMpBars extends Phaser.GameObjects.Container {
  private theme: UiTheme;
  private barW: number;
  private showMp: boolean;
  private g: Phaser.GameObjects.Graphics;
  private labelText: Phaser.GameObjects.Text | null = null;
  private hpText: Phaser.GameObjects.Text;
  private hpRatio = 1;
  private mpRatio = 1;
  private readonly barH = 12;
  private readonly gap = 4;

  constructor(scene: Phaser.Scene, x: number, y: number, config: HpMpBarsConfig = {}) {
    super(scene, x, y);
    this.theme = makeTheme(config.theme);
    this.barW = config.width ?? 160;
    this.showMp = config.showMp ?? true;
    this.g = scene.add.graphics();
    this.add(this.g);

    let topY = 0;
    if (config.label) {
      this.labelText = scene.add.text(0, topY, config.label, {
        fontFamily: this.theme.fontFamily, fontSize: "13px", fontStyle: "bold",
        color: this.theme.text, stroke: "#000", strokeThickness: 3,
      });
      this.add(this.labelText);
      topY += 18;
    }
    this.hpText = scene.add.text(this.barW + 6, topY - 1, "", {
      fontFamily: this.theme.fontFamily, fontSize: "11px", color: this.theme.textMuted,
    });
    this.add(this.hpText);

    scene.add.existing(this);
    this.redraw(topY);
  }

  /** Update the bars. Ratios tween toward the target over `tweenMs`. */
  set(hp: number, maxHp: number, mp = 0, maxMp = 0, tweenMs = 200): void {
    const targetHp = maxHp > 0 ? Phaser.Math.Clamp(hp / maxHp, 0, 1) : 0;
    const targetMp = maxMp > 0 ? Phaser.Math.Clamp(mp / maxMp, 0, 1) : 0;
    this.hpText.setText(`${hp}/${maxHp}`);
    const topY = this.labelText ? 18 : 0;
    if (tweenMs <= 0) {
      this.hpRatio = targetHp; this.mpRatio = targetMp; this.redraw(topY);
      return;
    }
    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: tweenMs, ease: "Cubic.out",
      onUpdate: (tw) => {
        const k = tw.getValue() ?? 1;
        this.hpRatio = Phaser.Math.Linear(this.hpRatio, targetHp, k);
        this.mpRatio = Phaser.Math.Linear(this.mpRatio, targetMp, k);
        this.redraw(topY);
      },
      onComplete: () => { this.hpRatio = targetHp; this.mpRatio = targetMp; this.redraw(topY); },
    });
  }

  private redraw(topY: number): void {
    const g = this.g;
    g.clear();
    // HP track + fill.
    g.fillStyle(this.theme.barTrack, 1).fillRoundedRect(0, topY, this.barW, this.barH, 4);
    g.fillStyle(this.theme.hpFill, 1).fillRoundedRect(0, topY, Math.max(2, this.barW * this.hpRatio), this.barH, 4);
    g.lineStyle(1, 0x000000, 0.6).strokeRoundedRect(0, topY, this.barW, this.barH, 4);
    if (this.showMp) {
      const my = topY + this.barH + this.gap;
      g.fillStyle(this.theme.barTrack, 1).fillRoundedRect(0, my, this.barW, this.barH, 4);
      g.fillStyle(this.theme.mpFill, 1).fillRoundedRect(0, my, Math.max(2, this.barW * this.mpRatio), this.barH, 4);
      g.lineStyle(1, 0x000000, 0.6).strokeRoundedRect(0, my, this.barW, this.barH, 4);
    }
  }
}
