/**
 * db.ts — the DATA → RUNTIME bridge.
 *
 * Loads the raw `data/*.json` content arrays, validates each row through the
 * schema parsers (fail-loud on malformed data at startup, not mid-battle), and
 * indexes them by id into a typed {@link RpgDatabase}. This is the deterministic
 * "builder" half of the data-driven flow: JSON in, validated lookup tables out.
 *
 * `resolveJsonModule` (tsconfig) lets us import the JSON directly so the content
 * is bundled at build time — no async fetch, same as how levels are bundled.
 */

import itemsJson from "@/rpg/data/items.json";
import skillsJson from "@/rpg/data/skills.json";
import enemiesJson from "@/rpg/data/enemies.json";
import balanceJson from "@/rpg/data/balance.json";
import {
  parseItems, parseSkills, parseEnemies, parseBalanceTables,
  type RpgDatabase, type Item, type Skill, type Enemy, type BalanceTable,
} from "@/rpg/schema";

/** Index an array of {id}-bearing rows into a Record, throwing on duplicate ids. */
function indexById<T extends { id: string }>(rows: T[], label: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const row of rows) {
    if (out[row.id] !== undefined) throw new Error(`[rpg/db] duplicate ${label} id: "${row.id}"`);
    out[row.id] = row;
  }
  return out;
}

let cached: RpgDatabase | null = null;

/**
 * Build (once, memoised) the validated content database from the bundled JSON.
 * Throws loudly via the schema parsers if any row is malformed.
 */
export function loadDatabase(): RpgDatabase {
  if (cached) return cached;
  const items = parseItems(itemsJson);
  const skills = parseSkills(skillsJson);
  const enemies = parseEnemies(enemiesJson);
  const balance = parseBalanceTables(balanceJson);

  // Cross-reference integrity: every id a row points at must resolve.
  const itemIds = new Set(items.map((i) => i.id));
  const skillIds = new Set(skills.map((s) => s.id));
  for (const e of enemies) {
    for (const sid of e.skills) {
      if (!skillIds.has(sid)) throw new Error(`[rpg/db] enemy "${e.id}" references unknown skill "${sid}"`);
    }
    for (const d of e.drops.drops) {
      if (!itemIds.has(d.itemId)) throw new Error(`[rpg/db] enemy "${e.id}" drops unknown item "${d.itemId}"`);
    }
  }

  cached = {
    items: indexById<Item>(items, "item"),
    skills: indexById<Skill>(skills, "skill"),
    enemies: indexById<Enemy>(enemies, "enemy"),
    balance: indexById<BalanceTable>(balance, "balance"),
  };
  return cached;
}

/** Reset the memoised db (tests / hot-reload). */
export function resetDatabase(): void {
  cached = null;
}

// ---- Typed lookups (throw on miss — a bad id is a bug, not a soft state) ----

export function getItem(db: RpgDatabase, id: string): Item {
  const it = db.items[id];
  if (!it) throw new Error(`[rpg/db] unknown item id: "${id}"`);
  return it;
}
export function getSkill(db: RpgDatabase, id: string): Skill {
  const sk = db.skills[id];
  if (!sk) throw new Error(`[rpg/db] unknown skill id: "${id}"`);
  return sk;
}
export function getEnemy(db: RpgDatabase, id: string): Enemy {
  const en = db.enemies[id];
  if (!en) throw new Error(`[rpg/db] unknown enemy id: "${id}"`);
  return en;
}
export function getBalance(db: RpgDatabase, id: string): BalanceTable {
  const bt = db.balance[id];
  if (!bt) throw new Error(`[rpg/db] unknown balance table id: "${id}"`);
  return bt;
}
