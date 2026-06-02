import Phaser from "phaser";
import { makeTheme, type UiTheme } from "@/rpg/ui/theme";
import type { Item } from "@/rpg/schema";
import type { ItemStack } from "@/rpg/systems/inventory";

/** What InventoryGrid needs to render one cell: the stack + its resolved item. */
export interface InventoryCell {
  stack: ItemStack;
  item: Item;
}

/**
 * InventoryGrid — a generic R×C bag grid as a Container. Each cell shows an item
 * swatch (icon texture if present, else a coloured tile) + quantity badge.
 * Hover/click emit `hover` / `select` (with the cell + its item) so the scene
 * can drive a Tooltip or an equip action. Re-render with `setCells(cells)`.
 *
 * Generic + theme-able: it knows nothing about WHERE items come from — the scene
 * feeds it resolved cells from an Inventory snapshot.
 */
export interface InventoryGridConfig {
  cols?: number;
  rows?: number;
  cellSize?: number;
  title?: string;
  theme?: Partial<UiTheme>;
}

export const INVENTORY_GRID_EVENTS = {
  hover: "hover",
  select: "select",
} as const;

export class InventoryGrid extends Phaser.GameObjects.Container {
  private theme: UiTheme;
  private cols: number;
  private rowsCount: number;
  private cell: number;
  private bg: Phaser.GameObjects.Graphics;
  private titleText: Phaser.GameObjects.Text | null = null;
  private cellObjects: Phaser.GameObjects.Container[] = [];
  private readonly gap = 6;

  constructor(scene: Phaser.Scene, x: number, y: number, config: InventoryGridConfig = {}) {
    super(scene, x, y);
    this.theme = makeTheme(config.theme);
    this.cols = config.cols ?? 4;
    this.rowsCount = config.rows ?? 3;
    this.cell = config.cellSize ?? 52;
    this.bg = scene.add.graphics();
    this.add(this.bg);
    if (config.title) {
      this.titleText = scene.add.text(this.theme.pad, this.theme.pad - 2, config.title, {
        fontFamily: this.theme.fontFamily, fontSize: "15px", fontStyle: "bold",
        color: this.theme.accentText,
      });
      this.add(this.titleText);
    }
    this.setDepth(1600);
    scene.add.existing(this);
    this.drawFrame();
  }

  /** Total grid pixel size (for layout / centring by the scene). */
  get size(): { width: number; height: number } {
    const top = this.titleText ? 24 : 0;
    return {
      width: this.theme.pad * 2 + this.cols * this.cell + (this.cols - 1) * this.gap,
      height: this.theme.pad * 2 + top + this.rowsCount * this.cell + (this.rowsCount - 1) * this.gap,
    };
  }

  /** Re-render the grid from resolved cells (row-major; extras beyond capacity are ignored). */
  setCells(cells: InventoryCell[]): void {
    this.clearCells();
    const top = this.titleText ? 24 : 0;
    const capacity = this.cols * this.rowsCount;
    for (let i = 0; i < Math.min(cells.length, capacity); i++) {
      const col = i % this.cols;
      const row = Math.floor(i / this.cols);
      const cx = this.theme.pad + col * (this.cell + this.gap);
      const cy = this.theme.pad + top + row * (this.cell + this.gap);
      this.add(this.makeCell(cells[i], cx, cy));
    }
  }

  private makeCell(cell: InventoryCell, x: number, y: number): Phaser.GameObjects.Container {
    const c = this.scene.add.container(x, y);
    const tile = this.scene.add.graphics();
    tile.fillStyle(0x000000, 0.35).fillRoundedRect(0, 0, this.cell, this.cell, 6);
    tile.lineStyle(1, this.theme.panelBorder, 0.4).strokeRoundedRect(0, 0, this.cell, this.cell, 6);
    c.add(tile);

    // Icon: a real texture if it exists, else a coloured swatch keyed off the id.
    if (cell.item.icon && this.scene.textures.exists(cell.item.icon)) {
      const img = this.scene.add.image(this.cell / 2, this.cell / 2 - 4, cell.item.icon);
      const fit = (this.cell - 14) / Math.max(img.width, img.height);
      img.setScale(fit);
      c.add(img);
    } else {
      const sw = this.scene.add.graphics();
      sw.fillStyle(swatchColor(cell.item.id), 1).fillRoundedRect(10, 8, this.cell - 20, this.cell - 26, 4);
      c.add(sw);
    }

    // Quantity badge (only when > 1).
    if (cell.stack.qty > 1) {
      const q = this.scene.add.text(this.cell - 5, this.cell - 5, `${cell.stack.qty}`, {
        fontFamily: this.theme.fontFamily, fontSize: "12px", fontStyle: "bold",
        color: this.theme.text, stroke: "#000", strokeThickness: 3,
      }).setOrigin(1, 1);
      c.add(q);
    }

    const hit = new Phaser.Geom.Rectangle(0, 0, this.cell, this.cell);
    c.setInteractive(hit, Phaser.Geom.Rectangle.Contains);
    c.input!.cursor = "pointer";
    c.on("pointerover", () => {
      tile.clear();
      tile.fillStyle(this.theme.accent, 0.22).fillRoundedRect(0, 0, this.cell, this.cell, 6);
      tile.lineStyle(2, this.theme.panelBorder, 0.9).strokeRoundedRect(0, 0, this.cell, this.cell, 6);
      this.emit(INVENTORY_GRID_EVENTS.hover, cell);
    });
    c.on("pointerout", () => {
      tile.clear();
      tile.fillStyle(0x000000, 0.35).fillRoundedRect(0, 0, this.cell, this.cell, 6);
      tile.lineStyle(1, this.theme.panelBorder, 0.4).strokeRoundedRect(0, 0, this.cell, this.cell, 6);
    });
    c.on("pointerdown", () => this.emit(INVENTORY_GRID_EVENTS.select, cell));

    this.cellObjects.push(c);
    return c;
  }

  private drawFrame(): void {
    const { width, height } = this.size;
    this.bg.clear();
    this.bg.fillStyle(this.theme.panelFill, this.theme.panelFillAlpha)
      .fillRoundedRect(0, 0, width, height, this.theme.radius);
    this.bg.lineStyle(2, this.theme.panelBorder, this.theme.panelBorderAlpha)
      .strokeRoundedRect(0, 0, width, height, this.theme.radius);
  }

  private clearCells(): void {
    for (const c of this.cellObjects) c.destroy();
    this.cellObjects = [];
  }
}

/** Deterministic pastel swatch from an item id (placeholder until real icons). */
function swatchColor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  const hue = h % 360;
  const c = Phaser.Display.Color.HSVToRGB(hue / 360, 0.5, 0.85) as Phaser.Types.Display.ColorObject;
  return Phaser.Display.Color.GetColor(c.r, c.g, c.b);
}
