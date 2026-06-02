import Phaser from "phaser";
import { makeTheme, type UiTheme } from "@/rpg/ui/theme";

/**
 * ActionMenu — a generic vertical command menu (Attack / Skill / Item / …) as a
 * Container. Keyboard-driven (Up/Down to move, Enter/Space to confirm) plus
 * pointer hover/click. Emits `select` (index changed) and `confirm` (chosen) via
 * Phaser's own event channel so a scene can `menu.on("confirm", …)`.
 *
 * It exposes `index` and `options` so the scene's `__gameState()` can surface
 * `menu.actionIndex` for the /drive harness (move cursor ⇒ actionIndex changes).
 */
export interface ActionMenuConfig {
  options: string[];
  width?: number;
  theme?: Partial<UiTheme>;
  /** Bind Up/Down/Enter on the scene keyboard automatically. Default true. */
  bindKeys?: boolean;
}

export const ACTION_MENU_EVENTS = {
  select: "select",
  confirm: "confirm",
} as const;

export class ActionMenu extends Phaser.GameObjects.Container {
  private theme: UiTheme;
  private menuW: number;
  private bg: Phaser.GameObjects.Graphics;
  private rows: Phaser.GameObjects.Text[] = [];
  private _index = 0;
  private _options: string[];
  private readonly rowH = 30;

  constructor(scene: Phaser.Scene, x: number, y: number, config: ActionMenuConfig) {
    super(scene, x, y);
    this.theme = makeTheme(config.theme);
    this.menuW = config.width ?? 150;
    this._options = [...config.options];
    this.bg = scene.add.graphics();
    this.add(this.bg);

    this._options.forEach((label, i) => {
      const row = scene.add.text(this.theme.pad, this.theme.pad + i * this.rowH, label, {
        fontFamily: this.theme.fontFamily, fontSize: "16px", color: this.theme.text,
      });
      row.setInteractive({ useHandCursor: true });
      row.on("pointerover", () => this.setIndex(i));
      row.on("pointerdown", () => { this.setIndex(i); this.confirm(); });
      this.rows.push(row);
      this.add(row);
    });

    this.setDepth(1500);
    scene.add.existing(this);
    this.redraw();

    if (config.bindKeys ?? true) this.bindKeyboard();
  }

  get index(): number { return this._index; }
  get options(): string[] { return [...this._options]; }
  /** The currently-highlighted label. */
  get selected(): string { return this._options[this._index]; }

  /** Move the cursor (wraps around). Emits `select` when it actually changes. */
  setIndex(i: number): void {
    const n = this._options.length;
    if (n === 0) return;
    const next = ((i % n) + n) % n;
    if (next === this._index) return;
    this._index = next;
    this.redraw();
    this.emit(ACTION_MENU_EVENTS.select, this._index, this.selected);
  }

  move(delta: number): void { this.setIndex(this._index + delta); }

  /** Fire the confirm event for the current option. */
  confirm(): void {
    this.emit(ACTION_MENU_EVENTS.confirm, this._index, this.selected);
  }

  /** Replace the option list (e.g. switch from main menu to a skill list). */
  setOptions(options: string[]): void {
    this.destroyRows();
    this._options = [...options];
    this._index = 0;
    this._options.forEach((label, i) => {
      const row = this.scene.add.text(this.theme.pad, this.theme.pad + i * this.rowH, label, {
        fontFamily: this.theme.fontFamily, fontSize: "16px", color: this.theme.text,
      });
      row.setInteractive({ useHandCursor: true });
      row.on("pointerover", () => this.setIndex(i));
      row.on("pointerdown", () => { this.setIndex(i); this.confirm(); });
      this.rows.push(row);
      this.add(row);
    });
    this.redraw();
  }

  private bindKeyboard(): void {
    const kb = this.scene.input.keyboard;
    if (!kb) return;
    kb.on("keydown-UP", this.onUp, this);
    kb.on("keydown-DOWN", this.onDown, this);
    kb.on("keydown-ENTER", this.onEnter, this);
    kb.on("keydown-SPACE", this.onEnter, this);
    // Detach on destroy so a torn-down menu can't intercept keys.
    this.once(Phaser.GameObjects.Events.DESTROY, () => {
      kb.off("keydown-UP", this.onUp, this);
      kb.off("keydown-DOWN", this.onDown, this);
      kb.off("keydown-ENTER", this.onEnter, this);
      kb.off("keydown-SPACE", this.onEnter, this);
    });
  }
  private onUp(): void { if (this.visible) this.move(-1); }
  private onDown(): void { if (this.visible) this.move(1); }
  private onEnter(): void { if (this.visible) this.confirm(); }

  private redraw(): void {
    const h = this.theme.pad * 2 + this._options.length * this.rowH;
    this.bg.clear();
    this.bg.fillStyle(this.theme.panelFill, this.theme.panelFillAlpha)
      .fillRoundedRect(0, 0, this.menuW, h, this.theme.radius);
    this.bg.lineStyle(2, this.theme.panelBorder, this.theme.panelBorderAlpha)
      .strokeRoundedRect(0, 0, this.menuW, h, this.theme.radius);
    this.rows.forEach((row, i) => {
      const active = i === this._index;
      row.setColor(active ? this.theme.accentText : this.theme.text);
      if (active) {
        this.bg.fillStyle(this.theme.accent, 0.18)
          .fillRoundedRect(4, this.theme.pad + i * this.rowH - 4, this.menuW - 8, this.rowH - 2, 6);
      }
    });
  }

  private destroyRows(): void {
    for (const row of this.rows) row.destroy();
    this.rows = [];
  }
}
