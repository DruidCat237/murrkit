import Phaser from "phaser";
import { makeTheme, type UiTheme } from "@/rpg/ui/theme";
import { EQUIPMENT_SLOTS, type EquipmentSlot, type Item } from "@/rpg/schema";

/** One slot row's resolved content: the slot + the worn item (or null). */
export type EquipmentSlotView = Record<EquipmentSlot, Item | null>;

/**
 * EquipmentPanel — a generic worn-equipment panel as a Container: one row per
 * EquipmentSlot showing the slot name + equipped item (or "—"). Clicking a row
 * emits `slotSelect` (the slot + its current item) so the scene can unequip or
 * open a picker. Re-render with `setSlots(view)`.
 */
export interface EquipmentPanelConfig {
  width?: number;
  title?: string;
  theme?: Partial<UiTheme>;
}

export const EQUIPMENT_PANEL_EVENTS = {
  slotSelect: "slotSelect",
} as const;

export class EquipmentPanel extends Phaser.GameObjects.Container {
  private theme: UiTheme;
  private panelW: number;
  private bg: Phaser.GameObjects.Graphics;
  private titleText: Phaser.GameObjects.Text | null = null;
  private rowTexts = new Map<EquipmentSlot, Phaser.GameObjects.Text>();
  private readonly rowH = 26;

  constructor(scene: Phaser.Scene, x: number, y: number, config: EquipmentPanelConfig = {}) {
    super(scene, x, y);
    this.theme = makeTheme(config.theme);
    this.panelW = config.width ?? 220;
    this.bg = scene.add.graphics();
    this.add(this.bg);

    let top = this.theme.pad;
    if (config.title) {
      this.titleText = scene.add.text(this.theme.pad, top - 2, config.title, {
        fontFamily: this.theme.fontFamily, fontSize: "15px", fontStyle: "bold",
        color: this.theme.accentText,
      });
      this.add(this.titleText);
      top += 24;
    }

    EQUIPMENT_SLOTS.forEach((slot, i) => {
      const rowY = top + i * this.rowH;
      const t = scene.add.text(this.theme.pad, rowY, this.rowLabel(slot, null), {
        fontFamily: this.theme.fontFamily, fontSize: "13px", color: this.theme.text,
      });
      t.setInteractive({ useHandCursor: true });
      t.on("pointerover", () => t.setColor(this.theme.accentText));
      t.on("pointerout", () => t.setColor(this.theme.text));
      t.on("pointerdown", () => this.emit(EQUIPMENT_PANEL_EVENTS.slotSelect, slot, this.current.get(slot) ?? null));
      this.rowTexts.set(slot, t);
      this.add(t);
    });

    this.setDepth(1600);
    scene.add.existing(this);
    this.redraw();
  }

  private current = new Map<EquipmentSlot, Item | null>();

  get size(): { width: number; height: number } {
    const top = (this.titleText ? 24 : 0) + this.theme.pad;
    return { width: this.panelW, height: top + EQUIPMENT_SLOTS.length * this.rowH + this.theme.pad - 6 };
  }

  /** Update every slot row from a resolved view. */
  setSlots(view: EquipmentSlotView): void {
    for (const slot of EQUIPMENT_SLOTS) {
      const item = view[slot] ?? null;
      this.current.set(slot, item);
      this.rowTexts.get(slot)?.setText(this.rowLabel(slot, item));
    }
  }

  private rowLabel(slot: EquipmentSlot, item: Item | null): string {
    const name = item ? item.name : "—";
    return `${capitalize(slot)}: ${name}`;
  }

  private redraw(): void {
    const { width, height } = this.size;
    this.bg.clear();
    this.bg.fillStyle(this.theme.panelFill, this.theme.panelFillAlpha)
      .fillRoundedRect(0, 0, width, height, this.theme.radius);
    this.bg.lineStyle(2, this.theme.panelBorder, this.theme.panelBorderAlpha)
      .strokeRoundedRect(0, 0, width, height, this.theme.radius);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
