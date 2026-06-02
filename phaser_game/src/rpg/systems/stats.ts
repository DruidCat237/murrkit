/**
 * stats.ts — DERIVE final stats from base + level growth + equipment + buffs.
 *
 * Pure, framework-free math (no Phaser). The combat/inventory systems and the UI
 * all read derived stats through here, so the formula lives in exactly one place
 * and balance changes are a single edit.
 *
 * Layering (applied in order, all additive):
 *   base  →  + level growth (BalanceTable.statsPerLevel × (level-1))
 *         →  + equipped item modifiers
 *         →  + active temporary buffs
 *
 * Leveling: XP accumulates; `levelForXp` walks the BalanceTable.xpToLevel
 * thresholds. Growth is linear by default (statsPerLevel per level); a future
 * non-linear curve can replace `growthAtLevel` without touching callers.
 */

import {
  STAT_KEYS, type StatBlock, type StatModifier, type BalanceTable, type Item,
} from "@/rpg/schema";

/** A timed buff layered on top of derived stats. */
export interface ActiveBuff {
  mods: StatModifier;
  /** Turns remaining; decremented by combat each round, removed at 0. */
  turns: number;
}

/** Everything needed to derive a combatant's final stats. */
export interface DerivationInput {
  base: StatBlock;
  level: number;
  curve: BalanceTable;
  /** Equipped items contributing `stats` modifiers (already resolved from ids). */
  equipment: Item[];
  /** Active temporary buffs. */
  buffs: ActiveBuff[];
}

const ZERO: StatBlock = { hp: 0, mp: 0, atk: 0, def: 0, mat: 0, mdf: 0, spd: 0, luk: 0 };

/** Add a sparse modifier into a full block (mutates + returns `into`). */
export function addModifier(into: StatBlock, mod: StatModifier): StatBlock {
  for (const k of STAT_KEYS) {
    const v = mod[k];
    if (v !== undefined) into[k] += v;
  }
  return into;
}

/** A fresh zeroed StatBlock. */
export function zeroStats(): StatBlock {
  return { ...ZERO };
}

/** Clone a StatBlock. */
export function cloneStats(s: StatBlock): StatBlock {
  return { ...s };
}

/**
 * Linear growth contribution for a given level: statsPerLevel × (level - 1).
 * Level 1 adds nothing (base IS the level-1 stat line). Clamped to maxLevel.
 */
export function growthAtLevel(curve: BalanceTable, level: number): StatBlock {
  const lvl = Math.max(1, Math.min(level, curve.maxLevel));
  const steps = lvl - 1;
  const out = zeroStats();
  for (const k of STAT_KEYS) {
    const per = curve.statsPerLevel[k];
    if (per !== undefined) out[k] = per * steps;
  }
  return out;
}

/**
 * Final derived stats: base + growth + equipment + buffs. HP/MP here are the
 * MAXIMA; the runtime combatant tracks current hp/mp pools separately and clamps
 * them to these values on equip/level changes.
 */
export function deriveStats(input: DerivationInput): StatBlock {
  const out = cloneStats(input.base);
  addModifier(out, growthAtLevel(input.curve, input.level));
  for (const item of input.equipment) {
    if (item.stats) addModifier(out, item.stats);
  }
  for (const buff of input.buffs) {
    addModifier(out, buff.mods);
  }
  // Stats never go negative (a heavy debuff can't make ATK meaningfully < 0).
  for (const k of STAT_KEYS) out[k] = Math.max(0, Math.round(out[k]));
  return out;
}

// ---- Leveling --------------------------------------------------------------

/** Total cumulative XP required to be AT `level` (level 1 = 0). */
export function totalXpForLevel(curve: BalanceTable, level: number): number {
  const lvl = Math.max(1, Math.min(level, curve.maxLevel));
  let sum = 0;
  for (let i = 0; i < lvl - 1; i++) sum += curve.xpToLevel[i] ?? 0;
  return sum;
}

/** The level a given total-XP value corresponds to (clamped to maxLevel). */
export function levelForXp(curve: BalanceTable, totalXp: number): number {
  let level = 1;
  let acc = 0;
  while (level < curve.maxLevel) {
    const need = curve.xpToLevel[level - 1] ?? Infinity;
    if (totalXp < acc + need) break;
    acc += need;
    level += 1;
  }
  return level;
}

/** XP remaining until the next level (0 at max level). */
export function xpToNextLevel(curve: BalanceTable, totalXp: number): number {
  const level = levelForXp(curve, totalXp);
  if (level >= curve.maxLevel) return 0;
  return totalXpForLevel(curve, level + 1) - totalXp;
}
