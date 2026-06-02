import Phaser from "phaser";
import { makeTheme, type UiTheme } from "@/rpg/ui/theme";

/**
 * DamageNumber — floating combat text that rises and fades, then self-destroys.
 *
 * Stateless façade: call the static `pop(scene, x, y, amount, opts)` to spawn one
 * at a world position. Crits render bigger + accent-coloured; healing (negative
 * amount) renders green with a `+`. Theme-able via the optional theme override.
 */
export interface DamagePopOptions {
  crit?: boolean;
  /** Treat the value as healing (green, prefixed +). */
  heal?: boolean;
  theme?: Partial<UiTheme>;
}

export class DamageNumber {
  /** Spawn one floating number at (x, y). Returns the text object (already animating). */
  static pop(
    scene: Phaser.Scene, x: number, y: number, amount: number, opts: DamagePopOptions = {},
  ): Phaser.GameObjects.Text {
    const theme = makeTheme(opts.theme);
    const heal = opts.heal ?? false;
    const crit = opts.crit ?? false;
    const color = heal ? theme.healText : crit ? theme.critText : theme.damageText;
    const size = crit ? 30 : 22;
    const label = heal ? `+${Math.abs(amount)}` : `${amount}`;

    const t = scene.add.text(x, y, label, {
      fontFamily: theme.fontFamily, fontStyle: "bold", fontSize: `${size}px`,
      color, stroke: "#1a0a00", strokeThickness: crit ? 6 : 4,
    }).setOrigin(0.5).setDepth(2000);

    // Crits get a brief punch-in before the rise.
    if (crit) {
      t.setScale(0.4);
      scene.tweens.add({ targets: t, scale: 1.2, duration: 140, ease: "Back.out" });
    }
    scene.tweens.add({
      targets: t,
      y: y - (crit ? 80 : 56),
      alpha: 0,
      duration: crit ? 900 : 720,
      ease: "Cubic.out",
      onComplete: () => t.destroy(),
    });
    return t;
  }
}
