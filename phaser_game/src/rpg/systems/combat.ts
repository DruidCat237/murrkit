/**
 * combat.ts — turn-based battle engine, data-driven and event-emitting.
 *
 * Responsibilities (all framework-free — no Phaser):
 *   - model COMBATANTS (current hp/mp pools over a derived StatBlock)
 *   - build TURN ORDER each round, fastest SPD first
 *   - resolve the DAMAGE FORMULA: offence/defence ratio × skill power × element
 *   - APPLY SKILLS (spend MP, deal damage, layer buffs) and items
 *   - detect DEATH and battle end (all enemies or all allies down)
 *
 * Exposes full state via `snapshot()` so the /drive harness can assert
 * "attack ⇒ enemyHp decreased", "cast ⇒ MP down + enemy hp down".
 */

import {
  STAT_KEYS, type Element, type Skill, type StatBlock, type StatModifier,
} from "@/rpg/schema";
import { addModifier, cloneStats, type ActiveBuff } from "@/rpg/systems/stats";
import { TypedEmitter } from "@/rpg/systems/events";

export type Side = "ally" | "enemy";

/** A live participant in a battle. `stats` are the DERIVED maxima; hp/mp are pools. */
export interface Combatant {
  id: string;
  name: string;
  side: Side;
  stats: StatBlock;
  hp: number;
  mp: number;
  /** Per-element incoming-damage multipliers (weakness > 1, resist < 1). */
  resistances: Partial<Record<Element, number>>;
  buffs: ActiveBuff[];
  alive: boolean;
}

/** The result of resolving one skill/attack against one target. */
export interface DamageResult {
  targetId: string;
  /** Positive = damage dealt, negative = healing. */
  amount: number;
  element: Element;
  /** Whether this strike was a critical hit. */
  crit: boolean;
  /** Whether the target died from this strike. */
  killed: boolean;
}

export interface CombatEvents {
  turn: { actorId: string; round: number };
  damage: DamageResult;
  death: { combatantId: string };
  buff: { combatantId: string; mods: StatModifier; turns: number };
  end: { winner: Side };
  [key: string]: unknown;
}

export interface CombatSnapshot {
  round: number;
  activeId: string | null;
  over: boolean;
  winner: Side | null;
  combatants: Array<{
    id: string; name: string; side: Side;
    hp: number; maxHp: number; mp: number; maxMp: number; alive: boolean;
  }>;
}

/** Crit multiplier applied on a lucky strike. */
const CRIT_MULT = 1.5;
/** Each point of LUK adds this to crit chance (0.002 = 0.2%/LUK). */
const LUK_TO_CRIT = 0.002;

/** Build a fresh combatant from a derived stat block (hp/mp start full). */
export function makeCombatant(
  id: string, name: string, side: Side, stats: StatBlock,
  resistances: Partial<Record<Element, number>> = {},
): Combatant {
  return {
    id, name, side,
    stats: cloneStats(stats),
    hp: stats.hp, mp: stats.mp,
    resistances, buffs: [], alive: true,
  };
}

/**
 * The damage formula. Physical reads atk/def; magical reads mat/mdf. Output =
 * (offence² / (offence + defence)) × power × element, then crit, floored at 1
 * for any non-heal offensive hit so attacks always chip something.
 */
export function computeDamage(
  attacker: Combatant, defender: Combatant, skill: Skill, opts: { rng?: () => number } = {},
): DamageResult {
  const rng = opts.rng ?? Math.random;
  const offence = skill.category === "magical" ? attacker.stats.mat : attacker.stats.atk;
  const defence = skill.category === "magical" ? defender.stats.mdf : defender.stats.def;

  // Diminishing-returns curve: high defence matters but never fully negates.
  const raw = (offence * offence) / (offence + defence + 1);
  const elementMult = defender.resistances[skill.element] ?? 1;
  const crit = rng() < attacker.stats.luk * LUK_TO_CRIT;
  const critMult = crit ? CRIT_MULT : 1;

  let amount = raw * skill.power * elementMult * critMult;
  amount = Math.max(1, Math.round(amount));

  return { targetId: defender.id, amount, element: skill.element, crit, killed: false };
}

/** A no-op "basic attack" skill used when an actor has no skill selected. */
export const BASIC_ATTACK: Skill = {
  id: "__basic_attack", name: "Attack", description: "A basic physical strike.",
  cost: 0, power: 1.0, element: "physical", targeting: "single-enemy", category: "physical",
};

export class Combat {
  readonly events = new TypedEmitter<CombatEvents>();
  private combatants: Combatant[] = [];
  private order: string[] = [];
  private orderIdx = 0;
  private round = 0;
  private over = false;
  private winner: Side | null = null;

  constructor(combatants: Combatant[], private rng: () => number = Math.random) {
    this.combatants = combatants;
    this.startRound();
  }

  // ---- queries -------------------------------------------------------------

  get(id: string): Combatant {
    const c = this.combatants.find((x) => x.id === id);
    if (!c) throw new Error(`[rpg/combat] unknown combatant "${id}"`);
    return c;
  }
  allies(): Combatant[] { return this.combatants.filter((c) => c.side === "ally"); }
  enemies(): Combatant[] { return this.combatants.filter((c) => c.side === "enemy"); }
  livingEnemies(): Combatant[] { return this.enemies().filter((c) => c.alive); }
  livingAllies(): Combatant[] { return this.allies().filter((c) => c.alive); }
  isOver(): boolean { return this.over; }
  currentRound(): number { return this.round; }

  /** The combatant whose turn it is, or null if the battle is over. */
  active(): Combatant | null {
    if (this.over) return null;
    const id = this.order[this.orderIdx];
    return id ? this.get(id) : null;
  }

  // ---- turn order ----------------------------------------------------------

  /** Recompute the turn order (living combatants, fastest SPD first) for a round. */
  private startRound(): void {
    this.round += 1;
    this.order = this.combatants
      .filter((c) => c.alive)
      .sort((a, b) => b.stats.spd - a.stats.spd || a.id.localeCompare(b.id))
      .map((c) => c.id);
    this.orderIdx = 0;
    this.tickBuffs();
    const actor = this.active();
    if (actor) this.events.emit("turn", { actorId: actor.id, round: this.round });
  }

  /**
   * Advance to the next living actor. Rolls into a fresh round (new SPD order)
   * when the current order is exhausted. Skips the dead. Emits `turn`.
   */
  advanceTurn(): void {
    if (this.over) return;
    do {
      this.orderIdx += 1;
      if (this.orderIdx >= this.order.length) { this.startRound(); return; }
    } while (!this.get(this.order[this.orderIdx]).alive);
    const actor = this.active();
    if (actor) this.events.emit("turn", { actorId: actor.id, round: this.round });
  }

  /** Decrement buff timers at the top of each round; drop expired buffs. */
  private tickBuffs(): void {
    for (const c of this.combatants) {
      if (!c.alive || c.buffs.length === 0) continue;
      for (const b of c.buffs) b.turns -= 1;
      c.buffs = c.buffs.filter((b) => b.turns > 0);
      // Re-derive the effective block: buffs are folded into `stats` at apply
      // time, so on expiry we rebuild from the stashed unbuffed base below.
      this.recomputeBuffedStats(c);
    }
  }

  // ---- actions -------------------------------------------------------------

  /**
   * Apply a skill from `actorId` to `targetId` (single-target path; AoE callers
   * loop over targets). Spends MP, deals damage/heal, layers any buff, resolves
   * death, then checks battle end. Returns the damage result.
   */
  useSkill(actorId: string, targetId: string, skill: Skill): DamageResult {
    const actor = this.get(actorId);
    const target = this.get(targetId);
    if (!actor.alive) throw new Error(`[rpg/combat] dead actor "${actorId}" cannot act`);
    if (actor.mp < skill.cost) throw new Error(`[rpg/combat] "${actorId}" lacks MP for "${skill.id}"`);

    actor.mp -= skill.cost;

    let result: DamageResult = { targetId, amount: 0, element: skill.element, crit: false, killed: false };
    if (skill.power > 0) {
      result = computeDamage(actor, target, skill, { rng: this.rng });
      this.applyDamage(target, result.amount);
      result.killed = !target.alive;
    }

    // Buffs land on the skill's target (self-target skills buff the actor).
    if (skill.buff && skill.buffTurns) {
      const who = skill.targeting === "self" ? actor : target;
      this.applyBuff(who, skill.buff, skill.buffTurns);
    }

    this.events.emit("damage", result);
    if (result.killed) this.events.emit("death", { combatantId: target.id });
    this.checkEnd();
    return result;
  }

  /** Convenience: the basic no-MP attack. */
  basicAttack(actorId: string, targetId: string): DamageResult {
    return this.useSkill(actorId, targetId, BASIC_ATTACK);
  }

  /** Apply a flat HP/MP item effect to a combatant (healing path). */
  applyHeal(targetId: string, hp = 0, mp = 0): void {
    const c = this.get(targetId);
    if (!c.alive) return;
    if (hp) c.hp = Math.min(c.stats.hp, c.hp + hp);
    if (mp) c.mp = Math.min(c.stats.mp, c.mp + mp);
  }

  /** Subtract damage, clamp at 0, flip `alive`, never heal via negative dmg here. */
  private applyDamage(target: Combatant, amount: number): void {
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp === 0 && target.alive) target.alive = false;
  }

  /** Layer a timed buff and fold it into the live stat block immediately. */
  private applyBuff(c: Combatant, mods: StatModifier, turns: number): void {
    c.buffs.push({ mods: { ...mods }, turns });
    this.recomputeBuffedStats(c);
    this.events.emit("buff", { combatantId: c.id, mods, turns });
  }

  /**
   * Rebuild `stats` = unbuffed maxima + currently-active buffs. We stash the
   * unbuffed block on first buff so HP/MP maxima don't drift across apply/expire
   * cycles, then clamp current pools to the new maxima.
   */
  private recomputeBuffedStats(c: Combatant): void {
    const stash = c as Combatant & { _baseStats?: StatBlock };
    if (!stash._baseStats) stash._baseStats = cloneStats(c.stats);
    const next = cloneStats(stash._baseStats);
    for (const b of c.buffs) addModifier(next, b.mods);
    for (const k of STAT_KEYS) next[k] = Math.max(0, Math.round(next[k]));
    c.stats = next;
    c.hp = Math.min(c.hp, c.stats.hp);
    c.mp = Math.min(c.mp, c.stats.mp);
  }

  /** End the battle when one side is wiped out. Emits `end` once. */
  private checkEnd(): void {
    if (this.over) return;
    if (this.livingEnemies().length === 0) { this.finish("ally"); }
    else if (this.livingAllies().length === 0) { this.finish("enemy"); }
  }

  private finish(winner: Side): void {
    this.over = true;
    this.winner = winner;
    this.events.emit("end", { winner });
  }

  // ---- snapshot ------------------------------------------------------------

  snapshot(): CombatSnapshot {
    return {
      round: this.round,
      activeId: this.active()?.id ?? null,
      over: this.over,
      winner: this.winner,
      combatants: this.combatants.map((c) => ({
        id: c.id, name: c.name, side: c.side,
        hp: c.hp, maxHp: c.stats.hp, mp: c.mp, maxMp: c.stats.mp, alive: c.alive,
      })),
    };
  }
}
