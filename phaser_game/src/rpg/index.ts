/**
 * rpg/index.ts — public surface of the data-driven RPG engine scaffold.
 *
 * Re-exports the schema, systems, and UI kit so consumers import from one place:
 *   import { Inventory, Combat, loadDatabase, HpMpBars } from "@/rpg";
 *
 * The engine is layered:
 *   schema.ts            → framework-free types + zod-free validators
 *   systems/db.ts        → JSON data → validated RpgDatabase (the "builder")
 *   systems/stats.ts     → derive stats from base + level + equipment + buffs
 *   systems/inventory.ts → bag + equipment (add/remove/stack/equip), events
 *   systems/combat.ts    → turn order, damage formula, skills, death
 *   ui/*                 → reusable, theme-able Phaser Containers
 */

export * from "@/rpg/schema";
export * from "@/rpg/systems/db";
export * from "@/rpg/systems/stats";
export * from "@/rpg/systems/inventory";
export * from "@/rpg/systems/combat";
export * from "@/rpg/systems/events";

export { makeTheme, DEFAULT_THEME, type UiTheme } from "@/rpg/ui/theme";
export { HpMpBars, type HpMpBarsConfig } from "@/rpg/ui/HpMpBars";
export { DamageNumber, type DamagePopOptions } from "@/rpg/ui/DamageNumber";
export { Tooltip, type TooltipConfig } from "@/rpg/ui/Tooltip";
export { ActionMenu, ACTION_MENU_EVENTS, type ActionMenuConfig } from "@/rpg/ui/ActionMenu";
export { InventoryGrid, INVENTORY_GRID_EVENTS, type InventoryGridConfig, type InventoryCell } from "@/rpg/ui/InventoryGrid";
export { EquipmentPanel, EQUIPMENT_PANEL_EVENTS, type EquipmentPanelConfig, type EquipmentSlotView } from "@/rpg/ui/EquipmentPanel";
