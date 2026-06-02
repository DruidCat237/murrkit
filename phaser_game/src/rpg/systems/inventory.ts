/**
 * inventory.ts — bag + equipment, data-driven and event-emitting.
 *
 * Holds stackable item slots (the bag) and a slot→itemId map (worn equipment).
 * All mutations go through methods that emit typed events so UI panels and the
 * `__gameState()` provider can react without polling. State is fully exposed via
 * `snapshot()` for the /drive harness (equip ⇒ ATK↑ smoke-test).
 *
 * Framework-free (no Phaser). Pairs with stats.deriveStats: the equipped item
 * objects are handed to the stat derivation so equipping a sword raises ATK.
 */

import {
  EQUIPMENT_SLOTS, type EquipmentSlot, type Item, type RpgDatabase,
} from "@/rpg/schema";
import { getItem } from "@/rpg/systems/db";
import { TypedEmitter } from "@/rpg/systems/events";

/** One bag entry: an item id and how many are stacked. */
export interface ItemStack {
  itemId: string;
  qty: number;
}

/** Equipment map: each slot holds an item id or null. */
export type Equipped = Record<EquipmentSlot, string | null>;

/** Serialisable inventory state for snapshots / saves. */
export interface InventorySnapshot {
  gold: number;
  bag: ItemStack[];
  equipped: Equipped;
  /** Total ATK contributed by equipment (convenience for smoke-tests). */
  equippedAtk: number;
}

/** Event payloads emitted by the inventory. */
export interface InventoryEvents {
  add: { itemId: string; qty: number };
  remove: { itemId: string; qty: number };
  equip: { slot: EquipmentSlot; itemId: string; previous: string | null };
  unequip: { slot: EquipmentSlot; itemId: string };
  gold: { gold: number; delta: number };
  [key: string]: unknown;
}

function emptyEquipped(): Equipped {
  const eq = {} as Equipped;
  for (const slot of EQUIPMENT_SLOTS) eq[slot] = null;
  return eq;
}

export class Inventory {
  readonly events = new TypedEmitter<InventoryEvents>();
  private bag: ItemStack[] = [];
  private equipped: Equipped = emptyEquipped();
  private gold = 0;

  constructor(private db: RpgDatabase) {}

  // ---- gold ----------------------------------------------------------------

  getGold(): number { return this.gold; }

  addGold(delta: number): void {
    this.gold = Math.max(0, this.gold + delta);
    this.events.emit("gold", { gold: this.gold, delta });
  }

  /** Spend gold; returns false (and no-op) if the wallet can't cover it. */
  spendGold(amount: number): boolean {
    if (amount > this.gold) return false;
    this.addGold(-amount);
    return true;
  }

  // ---- bag: add / remove / stack -------------------------------------------

  /** Quantity of an item currently in the bag (across stacks). */
  countOf(itemId: string): number {
    return this.bag.filter((s) => s.itemId === itemId).reduce((n, s) => n + s.qty, 0);
  }

  /** All bag stacks (defensive copy). */
  getBag(): ItemStack[] { return this.bag.map((s) => ({ ...s })); }

  /**
   * Add `qty` of an item, respecting its `stackMax`. Overflow opens new stacks.
   * Validates the id against the db (unknown id throws — bad data is a bug).
   */
  add(itemId: string, qty = 1): void {
    if (qty <= 0) return;
    const def = getItem(this.db, itemId);
    let remaining = qty;
    // Top up existing non-full stacks first.
    for (const stack of this.bag) {
      if (stack.itemId !== itemId || stack.qty >= def.stackMax) continue;
      const room = def.stackMax - stack.qty;
      const put = Math.min(room, remaining);
      stack.qty += put;
      remaining -= put;
      if (remaining === 0) break;
    }
    // Open new stacks for any overflow.
    while (remaining > 0) {
      const put = Math.min(def.stackMax, remaining);
      this.bag.push({ itemId, qty: put });
      remaining -= put;
    }
    this.events.emit("add", { itemId, qty });
  }

  /** Remove `qty` of an item; returns false if not enough are held. */
  remove(itemId: string, qty = 1): boolean {
    if (qty <= 0) return true;
    if (this.countOf(itemId) < qty) return false;
    let remaining = qty;
    for (const stack of this.bag) {
      if (stack.itemId !== itemId) continue;
      const take = Math.min(stack.qty, remaining);
      stack.qty -= take;
      remaining -= take;
      if (remaining === 0) break;
    }
    this.bag = this.bag.filter((s) => s.qty > 0);
    this.events.emit("remove", { itemId, qty });
    return true;
  }

  // ---- equipment -----------------------------------------------------------

  /** The item id worn in a slot, or null. */
  equippedIn(slot: EquipmentSlot): string | null { return this.equipped[slot]; }

  /** Resolved item objects currently equipped (for stats.deriveStats). */
  equippedItems(): Item[] {
    const out: Item[] = [];
    for (const slot of EQUIPMENT_SLOTS) {
      const id = this.equipped[slot];
      if (id) out.push(getItem(this.db, id));
    }
    return out;
  }

  /**
   * Equip an item FROM the bag into its declared slot. Any previously-worn item
   * returns to the bag. Throws if the item isn't equipment / not in the bag.
   */
  equip(itemId: string): void {
    const def = getItem(this.db, itemId);
    if (def.kind !== "equipment" || !def.slot) {
      throw new Error(`[rpg/inventory] item "${itemId}" is not equippable`);
    }
    if (this.countOf(itemId) <= 0) {
      throw new Error(`[rpg/inventory] cannot equip "${itemId}" — not in bag`);
    }
    const slot = def.slot;
    const previous = this.equipped[slot];
    this.remove(itemId, 1);
    if (previous) this.add(previous, 1); // swap the old piece back into the bag
    this.equipped[slot] = itemId;
    this.events.emit("equip", { slot, itemId, previous });
  }

  /** Unequip whatever is in a slot back into the bag. No-op if empty. */
  unequip(slot: EquipmentSlot): void {
    const itemId = this.equipped[slot];
    if (!itemId) return;
    this.equipped[slot] = null;
    this.add(itemId, 1);
    this.events.emit("unequip", { slot, itemId });
  }

  /** Sum of ATK granted by all equipped items (smoke-test convenience). */
  equippedAtk(): number {
    return this.equippedItems().reduce((n, it) => n + (it.stats?.atk ?? 0), 0);
  }

  // ---- snapshot ------------------------------------------------------------

  /** Serialisable state for `__gameState()` / saves. */
  snapshot(): InventorySnapshot {
    return {
      gold: this.gold,
      bag: this.getBag(),
      equipped: { ...this.equipped },
      equippedAtk: this.equippedAtk(),
    };
  }
}
