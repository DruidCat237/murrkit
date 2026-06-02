/**
 * schema.ts — typed schemas for a DATA-DRIVEN RPG engine (RPG-Maker-class).
 *
 * This is the single source of truth for every data shape the engine consumes.
 * Game content (items, skills, enemies, balance curves) lives in plain JSON under
 * `src/rpg/data/*.json`; deterministic builders (systems/) turn that JSON into
 * live runtime state. Designers tune the game by editing data, never code.
 *
 * VALIDATION: zod-free. Each schema has a hand-written `isX(value): value is X`
 * type-guard + a `parseX(value, ctx): X` that throws loudly on malformed data
 * (swe-agent-rigor: fail loudly, do not silently coerce). Validators are pure,
 * dependency-free, and tree-shakeable — usable in the browser or a build step.
 *
 * No Phaser import here on purpose: schemas are framework-agnostic so the same
 * data layer could feed a headless balance simulator or a server.
 */

// ---------------------------------------------------------------------------
// Core enums / unions
// ---------------------------------------------------------------------------

/** Equipment slots a character can fill. Extend freely — UI iterates the union. */
export const EQUIPMENT_SLOTS = ["weapon", "offhand", "head", "body", "accessory"] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

/** Elemental affinities. `physical` is the no-element default. */
export const ELEMENTS = ["physical", "fire", "ice", "thunder", "earth", "light", "dark"] as const;
export type Element = (typeof ELEMENTS)[number];

/** Who a skill / item can be aimed at. */
export const TARGETING = ["self", "single-ally", "all-allies", "single-enemy", "all-enemies"] as const;
export type Targeting = (typeof TARGETING)[number];

/** Broad item categories (drives inventory tab + usage rules). */
export const ITEM_KINDS = ["consumable", "equipment", "material", "key"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

// ---------------------------------------------------------------------------
// StatBlock — the numeric heart of the engine
// ---------------------------------------------------------------------------

/**
 * A full stat block. `hp`/`mp` are maxima; current pools live on the runtime
 * combatant (systems/combat), not in static data. Every field is required so the
 * derive math (systems/stats) never has to guess a missing stat — partial deltas
 * use {@link StatModifier} instead.
 */
export interface StatBlock {
  /** Max health. */
  hp: number;
  /** Max magic / skill points. */
  mp: number;
  /** Physical attack power. */
  atk: number;
  /** Physical defence. */
  def: number;
  /** Magical attack power. */
  mat: number;
  /** Magical defence. */
  mdf: number;
  /** Speed — drives turn order (higher acts first). */
  spd: number;
  /** Luck — crit chance / drop-rate nudges. */
  luk: number;
}

/** The eight stat keys, for iteration (sum equipment, render a sheet, …). */
export const STAT_KEYS = ["hp", "mp", "atk", "def", "mat", "mdf", "spd", "luk"] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/** A sparse additive modifier — equipment / buffs contribute only what they touch. */
export type StatModifier = Partial<StatBlock>;

// ---------------------------------------------------------------------------
// Item & Equipment
// ---------------------------------------------------------------------------

/**
 * A single item definition. `kind:"equipment"` items carry `slot` + `stats`
 * (the modifier they grant while equipped). `kind:"consumable"` items carry a
 * `useEffect`. `stackMax` caps inventory stacking (1 = unique).
 */
export interface Item {
  id: string;
  name: string;
  kind: ItemKind;
  description: string;
  /** Resale / shop base price in gold. */
  price: number;
  /** Max stack size in one inventory slot (1 = non-stackable). */
  stackMax: number;
  /** Equipment-only: which slot this occupies. */
  slot?: EquipmentSlot;
  /** Equipment-only: additive stat modifier while equipped. */
  stats?: StatModifier;
  /** Equipment-only: elemental damage tag a weapon imparts. */
  element?: Element;
  /** Consumable-only: what happens when used. */
  useEffect?: ItemEffect;
  /** Optional texture key for the icon (UI falls back to a generated swatch). */
  icon?: string;
}

/** A consumable's effect — restorative pools and/or a one-shot stat buff. */
export interface ItemEffect {
  /** Flat HP restored (negative = damage, e.g. a trap item). */
  hp?: number;
  /** Flat MP restored. */
  mp?: number;
  /** Temporary stat buff applied for `buffTurns` turns. */
  buff?: StatModifier;
  buffTurns?: number;
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

/**
 * An active skill / spell. Damage = scale of the relevant offence stat (mat for
 * magical, atk for physical) times `power`, mitigated by the target's matching
 * defence and the element multiplier (see systems/combat).
 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  /** MP spent to cast. */
  cost: number;
  /** Base power coefficient (multiplies the offence stat). */
  power: number;
  element: Element;
  targeting: Targeting;
  /** "physical" reads atk/def; "magical" reads mat/mdf. */
  category: "physical" | "magical";
  /** Optional self/target buff layered on top of damage (turns-limited). */
  buff?: StatModifier;
  buffTurns?: number;
}

// ---------------------------------------------------------------------------
// Enemy & loot
// ---------------------------------------------------------------------------

/** One weighted drop. `chance` is 0..1; `itemId` indexes the item table. */
export interface DropEntry {
  itemId: string;
  chance: number;
  /** Quantity granted when the drop hits (default 1). */
  qty?: number;
}

/** A monster's loot table: gold range + a list of independent weighted drops. */
export interface DropTable {
  goldMin: number;
  goldMax: number;
  drops: DropEntry[];
}

/** A monster definition. `skills` lists Skill ids it may use; AI picks among them. */
export interface Enemy {
  id: string;
  name: string;
  stats: StatBlock;
  /** XP awarded to the party on defeat. */
  xp: number;
  /** Skill ids this enemy can cast (empty = basic attack only). */
  skills: string[];
  /** Per-element damage multipliers vs THIS enemy (weakness > 1, resist < 1). */
  resistances?: Partial<Record<Element, number>>;
  drops: DropTable;
  /** Optional texture key for the battler sprite. */
  sprite?: string;
}

// ---------------------------------------------------------------------------
// Dialogue & Shop
// ---------------------------------------------------------------------------

/** One line of branching dialogue. `next` chains to another node id; choices fork. */
export interface DialogueLine {
  speaker: string;
  text: string;
  next?: string;
  choices?: DialogueChoice[];
}

export interface DialogueChoice {
  label: string;
  next: string;
}

/** A full dialogue graph keyed by node id, with a declared entry node. */
export interface Dialogue {
  id: string;
  start: string;
  nodes: Record<string, DialogueLine>;
}

/** One row in a shop's inventory. Price overrides the item's base if set. */
export interface ShopEntry {
  itemId: string;
  /** Override price; falls back to Item.price when omitted. */
  price?: number;
  /** Limited stock (omit = unlimited). */
  stock?: number;
}

// ---------------------------------------------------------------------------
// BalanceTable — the leveling / growth curve
// ---------------------------------------------------------------------------

/**
 * A growth curve. `xpToLevel[i]` = total XP needed to reach level (i+2) from
 * (i+1) — i.e. xpToLevel[0] is the cost of the first level-up (1→2). `statsPerLevel`
 * is added to base stats each level (linear growth; non-linear curves can ship a
 * full `statTable` instead, leaving systems/stats to interpolate).
 */
export interface BalanceTable {
  id: string;
  /** Maximum attainable level. */
  maxLevel: number;
  /** XP cost of each successive level-up; length should be maxLevel - 1. */
  xpToLevel: number[];
  /** Linear per-level stat gain added on top of base. */
  statsPerLevel: StatModifier;
}

// ---------------------------------------------------------------------------
// Aggregate database shape (what a fully-loaded game holds)
// ---------------------------------------------------------------------------

/**
 * The whole content database, keyed by id for O(1) lookup. Builders (systems/db)
 * assemble this from the raw JSON arrays. Kept flat + serialisable on purpose.
 */
export interface RpgDatabase {
  items: Record<string, Item>;
  skills: Record<string, Skill>;
  enemies: Record<string, Enemy>;
  balance: Record<string, BalanceTable>;
}

// ===========================================================================
// Runtime validators — zod-free, fail-loud. Each `isX` is a pure type guard;
// each `parseX` throws an Error with a precise path on the first bad field.
// ===========================================================================

/** Internal: assert a condition or throw with a contextual message. */
function check(cond: boolean, ctx: string, msg: string): asserts cond {
  if (!cond) throw new Error(`[rpg/schema] ${ctx}: ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isOneOf<T extends readonly string[]>(v: unknown, allowed: T): v is T[number] {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

// ---- StatBlock -------------------------------------------------------------

export function isStatBlock(v: unknown): v is StatBlock {
  return isObject(v) && STAT_KEYS.every((k) => isFiniteNumber(v[k]));
}

export function parseStatBlock(v: unknown, ctx = "StatBlock"): StatBlock {
  check(isObject(v), ctx, "expected an object");
  for (const k of STAT_KEYS) check(isFiniteNumber(v[k]), `${ctx}.${k}`, "expected a finite number");
  return {
    hp: v.hp as number, mp: v.mp as number, atk: v.atk as number, def: v.def as number,
    mat: v.mat as number, mdf: v.mdf as number, spd: v.spd as number, luk: v.luk as number,
  };
}

/** Validate a sparse modifier: every PRESENT key must be a finite number. */
export function parseStatModifier(v: unknown, ctx = "StatModifier"): StatModifier {
  check(isObject(v), ctx, "expected an object");
  const out: StatModifier = {};
  for (const k of STAT_KEYS) {
    if (v[k] === undefined) continue;
    check(isFiniteNumber(v[k]), `${ctx}.${k}`, "expected a finite number");
    out[k] = v[k] as number;
  }
  return out;
}

// ---- Item ------------------------------------------------------------------

export function parseItem(v: unknown, ctx = "Item"): Item {
  check(isObject(v), ctx, "expected an object");
  check(isNonEmptyString(v.id), `${ctx}.id`, "expected a non-empty string");
  check(isNonEmptyString(v.name), `${ctx}.name`, "expected a non-empty string");
  check(isOneOf(v.kind, ITEM_KINDS), `${ctx}.kind`, `expected one of ${ITEM_KINDS.join("|")}`);
  check(typeof v.description === "string", `${ctx}.description`, "expected a string");
  check(isFiniteNumber(v.price) && (v.price as number) >= 0, `${ctx}.price`, "expected a number >= 0");
  check(isFiniteNumber(v.stackMax) && (v.stackMax as number) >= 1, `${ctx}.stackMax`, "expected a number >= 1");

  const item: Item = {
    id: v.id,
    name: v.name,
    kind: v.kind,
    description: v.description,
    price: v.price as number,
    stackMax: v.stackMax as number,
  };

  if (v.kind === "equipment") {
    check(isOneOf(v.slot, EQUIPMENT_SLOTS), `${ctx}.slot`, `equipment requires a slot (${EQUIPMENT_SLOTS.join("|")})`);
    item.slot = v.slot;
    if (v.stats !== undefined) item.stats = parseStatModifier(v.stats, `${ctx}.stats`);
    if (v.element !== undefined) {
      check(isOneOf(v.element, ELEMENTS), `${ctx}.element`, `expected one of ${ELEMENTS.join("|")}`);
      item.element = v.element;
    }
  }
  if (v.kind === "consumable" && v.useEffect !== undefined) {
    item.useEffect = parseItemEffect(v.useEffect, `${ctx}.useEffect`);
  }
  if (v.icon !== undefined) {
    check(isNonEmptyString(v.icon), `${ctx}.icon`, "expected a non-empty string");
    item.icon = v.icon;
  }
  return item;
}

export function parseItemEffect(v: unknown, ctx = "ItemEffect"): ItemEffect {
  check(isObject(v), ctx, "expected an object");
  const out: ItemEffect = {};
  if (v.hp !== undefined) { check(isFiniteNumber(v.hp), `${ctx}.hp`, "expected a finite number"); out.hp = v.hp as number; }
  if (v.mp !== undefined) { check(isFiniteNumber(v.mp), `${ctx}.mp`, "expected a finite number"); out.mp = v.mp as number; }
  if (v.buff !== undefined) out.buff = parseStatModifier(v.buff, `${ctx}.buff`);
  if (v.buffTurns !== undefined) { check(isFiniteNumber(v.buffTurns), `${ctx}.buffTurns`, "expected a finite number"); out.buffTurns = v.buffTurns as number; }
  return out;
}

// ---- Skill -----------------------------------------------------------------

export function parseSkill(v: unknown, ctx = "Skill"): Skill {
  check(isObject(v), ctx, "expected an object");
  check(isNonEmptyString(v.id), `${ctx}.id`, "expected a non-empty string");
  check(isNonEmptyString(v.name), `${ctx}.name`, "expected a non-empty string");
  check(typeof v.description === "string", `${ctx}.description`, "expected a string");
  check(isFiniteNumber(v.cost) && (v.cost as number) >= 0, `${ctx}.cost`, "expected a number >= 0");
  check(isFiniteNumber(v.power) && (v.power as number) >= 0, `${ctx}.power`, "expected a number >= 0");
  check(isOneOf(v.element, ELEMENTS), `${ctx}.element`, `expected one of ${ELEMENTS.join("|")}`);
  check(isOneOf(v.targeting, TARGETING), `${ctx}.targeting`, `expected one of ${TARGETING.join("|")}`);
  check(v.category === "physical" || v.category === "magical", `${ctx}.category`, 'expected "physical" or "magical"');
  const skill: Skill = {
    id: v.id, name: v.name, description: v.description,
    cost: v.cost as number, power: v.power as number,
    element: v.element, targeting: v.targeting, category: v.category,
  };
  if (v.buff !== undefined) skill.buff = parseStatModifier(v.buff, `${ctx}.buff`);
  if (v.buffTurns !== undefined) { check(isFiniteNumber(v.buffTurns), `${ctx}.buffTurns`, "expected a finite number"); skill.buffTurns = v.buffTurns as number; }
  return skill;
}

// ---- Enemy / DropTable -----------------------------------------------------

export function parseDropTable(v: unknown, ctx = "DropTable"): DropTable {
  check(isObject(v), ctx, "expected an object");
  check(isFiniteNumber(v.goldMin) && (v.goldMin as number) >= 0, `${ctx}.goldMin`, "expected a number >= 0");
  check(isFiniteNumber(v.goldMax) && (v.goldMax as number) >= (v.goldMin as number), `${ctx}.goldMax`, "expected a number >= goldMin");
  check(Array.isArray(v.drops), `${ctx}.drops`, "expected an array");
  const drops = (v.drops as unknown[]).map((d, i) => parseDropEntry(d, `${ctx}.drops[${i}]`));
  return { goldMin: v.goldMin as number, goldMax: v.goldMax as number, drops };
}

export function parseDropEntry(v: unknown, ctx = "DropEntry"): DropEntry {
  check(isObject(v), ctx, "expected an object");
  check(isNonEmptyString(v.itemId), `${ctx}.itemId`, "expected a non-empty string");
  check(isFiniteNumber(v.chance) && (v.chance as number) >= 0 && (v.chance as number) <= 1, `${ctx}.chance`, "expected a number in 0..1");
  const out: DropEntry = { itemId: v.itemId, chance: v.chance as number };
  if (v.qty !== undefined) { check(isFiniteNumber(v.qty) && (v.qty as number) >= 1, `${ctx}.qty`, "expected a number >= 1"); out.qty = v.qty as number; }
  return out;
}

export function parseEnemy(v: unknown, ctx = "Enemy"): Enemy {
  check(isObject(v), ctx, "expected an object");
  check(isNonEmptyString(v.id), `${ctx}.id`, "expected a non-empty string");
  check(isNonEmptyString(v.name), `${ctx}.name`, "expected a non-empty string");
  check(isFiniteNumber(v.xp) && (v.xp as number) >= 0, `${ctx}.xp`, "expected a number >= 0");
  check(Array.isArray(v.skills) && (v.skills as unknown[]).every(isNonEmptyString), `${ctx}.skills`, "expected an array of non-empty strings");
  const enemy: Enemy = {
    id: v.id, name: v.name,
    stats: parseStatBlock(v.stats, `${ctx}.stats`),
    xp: v.xp as number,
    skills: v.skills as string[],
    drops: parseDropTable(v.drops, `${ctx}.drops`),
  };
  if (v.resistances !== undefined) {
    check(isObject(v.resistances), `${ctx}.resistances`, "expected an object");
    const res: Partial<Record<Element, number>> = {};
    for (const el of ELEMENTS) {
      const r = (v.resistances as Record<string, unknown>)[el];
      if (r === undefined) continue;
      check(isFiniteNumber(r) && r >= 0, `${ctx}.resistances.${el}`, "expected a number >= 0");
      res[el] = r;
    }
    enemy.resistances = res;
  }
  if (v.sprite !== undefined) { check(isNonEmptyString(v.sprite), `${ctx}.sprite`, "expected a non-empty string"); enemy.sprite = v.sprite; }
  return enemy;
}

// ---- Dialogue --------------------------------------------------------------

export function parseDialogue(v: unknown, ctx = "Dialogue"): Dialogue {
  check(isObject(v), ctx, "expected an object");
  check(isNonEmptyString(v.id), `${ctx}.id`, "expected a non-empty string");
  check(isNonEmptyString(v.start), `${ctx}.start`, "expected a non-empty string");
  check(isObject(v.nodes), `${ctx}.nodes`, "expected an object");
  const nodes: Record<string, DialogueLine> = {};
  for (const [key, line] of Object.entries(v.nodes as Record<string, unknown>)) {
    nodes[key] = parseDialogueLine(line, `${ctx}.nodes.${key}`);
  }
  check(nodes[v.start] !== undefined, `${ctx}.start`, `start node "${v.start}" not found in nodes`);
  return { id: v.id, start: v.start, nodes };
}

export function parseDialogueLine(v: unknown, ctx = "DialogueLine"): DialogueLine {
  check(isObject(v), ctx, "expected an object");
  check(isNonEmptyString(v.speaker), `${ctx}.speaker`, "expected a non-empty string");
  check(typeof v.text === "string", `${ctx}.text`, "expected a string");
  const line: DialogueLine = { speaker: v.speaker, text: v.text };
  if (v.next !== undefined) { check(isNonEmptyString(v.next), `${ctx}.next`, "expected a non-empty string"); line.next = v.next; }
  if (v.choices !== undefined) {
    check(Array.isArray(v.choices), `${ctx}.choices`, "expected an array");
    line.choices = (v.choices as unknown[]).map((c, i) => {
      check(isObject(c), `${ctx}.choices[${i}]`, "expected an object");
      check(isNonEmptyString(c.label), `${ctx}.choices[${i}].label`, "expected a non-empty string");
      check(isNonEmptyString(c.next), `${ctx}.choices[${i}].next`, "expected a non-empty string");
      return { label: c.label, next: c.next };
    });
  }
  return line;
}

// ---- ShopEntry -------------------------------------------------------------

export function parseShopEntry(v: unknown, ctx = "ShopEntry"): ShopEntry {
  check(isObject(v), ctx, "expected an object");
  check(isNonEmptyString(v.itemId), `${ctx}.itemId`, "expected a non-empty string");
  const out: ShopEntry = { itemId: v.itemId };
  if (v.price !== undefined) { check(isFiniteNumber(v.price) && (v.price as number) >= 0, `${ctx}.price`, "expected a number >= 0"); out.price = v.price as number; }
  if (v.stock !== undefined) { check(isFiniteNumber(v.stock) && (v.stock as number) >= 0, `${ctx}.stock`, "expected a number >= 0"); out.stock = v.stock as number; }
  return out;
}

// ---- BalanceTable ----------------------------------------------------------

export function parseBalanceTable(v: unknown, ctx = "BalanceTable"): BalanceTable {
  check(isObject(v), ctx, "expected an object");
  check(isNonEmptyString(v.id), `${ctx}.id`, "expected a non-empty string");
  check(isFiniteNumber(v.maxLevel) && (v.maxLevel as number) >= 1, `${ctx}.maxLevel`, "expected a number >= 1");
  check(Array.isArray(v.xpToLevel) && (v.xpToLevel as unknown[]).every(isFiniteNumber), `${ctx}.xpToLevel`, "expected an array of finite numbers");
  return {
    id: v.id,
    maxLevel: v.maxLevel as number,
    xpToLevel: v.xpToLevel as number[],
    statsPerLevel: parseStatModifier(v.statsPerLevel, `${ctx}.statsPerLevel`),
  };
}

// ---- Bulk array parsers (used by the db builder over JSON imports) ---------

export function parseItems(v: unknown, ctx = "items"): Item[] {
  check(Array.isArray(v), ctx, "expected an array");
  return (v as unknown[]).map((x, i) => parseItem(x, `${ctx}[${i}]`));
}
export function parseSkills(v: unknown, ctx = "skills"): Skill[] {
  check(Array.isArray(v), ctx, "expected an array");
  return (v as unknown[]).map((x, i) => parseSkill(x, `${ctx}[${i}]`));
}
export function parseEnemies(v: unknown, ctx = "enemies"): Enemy[] {
  check(Array.isArray(v), ctx, "expected an array");
  return (v as unknown[]).map((x, i) => parseEnemy(x, `${ctx}[${i}]`));
}
export function parseBalanceTables(v: unknown, ctx = "balance"): BalanceTable[] {
  check(Array.isArray(v), ctx, "expected an array");
  return (v as unknown[]).map((x, i) => parseBalanceTable(x, `${ctx}[${i}]`));
}
