import Phaser from "phaser";
import { registerGameState, clearGameState, type GameStateSnapshot } from "@/systems/gameState";
import {
  loadDatabase, getEnemy, getBalance,
  Inventory, Combat, makeCombatant, BASIC_ATTACK,
  deriveStats, levelForXp,
  type RpgDatabase, type Combatant, type Skill,
} from "@/rpg";
import { HpMpBars } from "@/rpg/ui/HpMpBars";
import { ActionMenu, ACTION_MENU_EVENTS } from "@/rpg/ui/ActionMenu";
import { InventoryGrid, INVENTORY_GRID_EVENTS, type InventoryCell } from "@/rpg/ui/InventoryGrid";
import { EquipmentPanel, EQUIPMENT_PANEL_EVENTS, type EquipmentSlotView } from "@/rpg/ui/EquipmentPanel";
import { DamageNumber } from "@/rpg/ui/DamageNumber";
import { Tooltip } from "@/rpg/ui/Tooltip";
import { EQUIPMENT_SLOTS, type StatBlock } from "@/rpg/schema";

/**
 * RpgDemoScene — a MINIMAL, self-contained demo wiring the data-driven RPG
 * engine scaffold together: one player vs one enemy, HP/MP bars, an action menu
 * (Attack / Skill / Item / Defend), a working attack, and an inventory panel you
 * can open (I) to equip gear. It draws its own placeholder textures so it needs
 * NO external art — it is a FOUNDATION demo, not a finished game.
 *
 * The whole point is the rich `window.__gameState()` snapshot it registers (see
 * `snapshot()`), so the `/api/phaser/drive` harness can smoke-test menus, combat,
 * and inventory without screenshots:
 *   - press I            ⇒ menu.inventoryOpen = true
 *   - Down/Up            ⇒ menu.actionIndex changes
 *   - Enter on Attack    ⇒ custom.enemyHp decreases
 *   - equip a weapon     ⇒ custom.equippedAtk increases
 *
 * Activate via `?level=rpg_demo` (BootScene ignores it; main.ts starts this
 * scene directly when the level id is "rpg_demo").
 */

const PLAYER_ID = "hero";
const ENEMY_ID = "enemy0";
const HERO_BASE: StatBlock = { hp: 80, mp: 30, atk: 14, def: 8, mat: 12, mdf: 6, spd: 10, luk: 5 };

export class RpgDemoScene extends Phaser.Scene {
  // contract-exposed state
  public score = 0;
  public win = false;
  public lose = false;

  private db!: RpgDatabase;
  private inventory!: Inventory;
  private combat!: Combat;
  private player!: Combatant;
  private enemy!: Combatant;

  // sprites + ui
  private playerSprite!: Phaser.GameObjects.Image;
  private enemySprite!: Phaser.GameObjects.Image;
  private playerBars!: HpMpBars;
  private enemyBars!: HpMpBars;
  private actionMenu!: ActionMenu;
  private inventoryGrid!: InventoryGrid;
  private equipPanel!: EquipmentPanel;
  private tooltip!: Tooltip;
  private logText!: Phaser.GameObjects.Text;

  // ui state surfaced to __gameState
  private inventoryOpen = false;
  /** Last battle log line — handy for the harness / humans. */
  private lastLog = "";

  constructor() { super({ key: "RpgDemoScene" }); }

  preload(): void {
    // Generate all placeholder textures procedurally — zero external assets.
    this.makeRectTexture("rpg_hero", 0x4caf50, 64, 96);
    this.makeRectTexture("rpg_enemy", 0x9b4dca, 80, 80);
    this.makeRectTexture("rpg_bg", 0x101826, 1280, 720);
  }

  create(): void {
    this.db = loadDatabase();

    // --- background -------------------------------------------------------
    this.add.image(640, 360, "rpg_bg").setDepth(-10);
    this.add.text(640, 30, "RPG Engine Demo", {
      fontFamily: "Verdana, Arial, sans-serif", fontSize: "22px", fontStyle: "bold",
      color: "#ffd84a", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5).setDepth(1000);
    this.add.text(640, 60, "[I] inventory   [Up/Down] move cursor   [Enter] confirm", {
      fontFamily: "Verdana, Arial, sans-serif", fontSize: "13px", color: "#9aa0b5",
    }).setOrigin(0.5).setDepth(1000);

    // --- model: inventory + combat ---------------------------------------
    this.inventory = new Inventory(this.db);
    this.inventory.addGold(120);
    // Seed the bag with starter gear + consumables (template data).
    this.inventory.add("rusty_sword", 1);
    this.inventory.add("flame_blade", 1);
    this.inventory.add("leather_armor", 1);
    this.inventory.add("iron_shield", 1);
    this.inventory.add("luck_charm", 1);
    this.inventory.add("potion", 3);
    this.inventory.add("ether", 1);

    this.buildCombat();

    // --- sprites ----------------------------------------------------------
    this.playerSprite = this.add.image(360, 430, "rpg_hero").setDepth(10);
    this.enemySprite = this.add.image(920, 430, "rpg_enemy").setDepth(10);

    // --- HP/MP bars -------------------------------------------------------
    this.playerBars = new HpMpBars(this, 300, 320, { label: this.player.name, width: 180 });
    this.enemyBars = new HpMpBars(this, 840, 330, { label: this.enemy.name, width: 180, showMp: false });
    this.refreshBars(0);

    // --- action menu ------------------------------------------------------
    this.actionMenu = new ActionMenu(this, 60, 470, {
      options: ["Attack", "Fireball", "Guard", "Potion"],
      width: 160,
    });
    this.actionMenu.on(ACTION_MENU_EVENTS.confirm, (_i: number, label: string) => this.onAction(label));

    // --- battle log -------------------------------------------------------
    this.logText = this.add.text(60, 650, "", {
      fontFamily: "Verdana, Arial, sans-serif", fontSize: "14px", color: "#fff5e6",
      stroke: "#000", strokeThickness: 3, wordWrap: { width: 700 },
    }).setDepth(1000);

    // --- inventory / equipment panels (hidden until I) -------------------
    this.tooltip = new Tooltip(this, { maxWidth: 240 });
    this.inventoryGrid = new InventoryGrid(this, 360, 150, { title: "Inventory (click to equip)", cols: 4, rows: 3 });
    this.equipPanel = new EquipmentPanel(this, 360, 150, { title: "Equipped (click to unequip)", width: 220 });
    this.layoutPanels();
    this.wireInventoryPanels();
    this.setInventoryOpen(false);

    // --- input ------------------------------------------------------------
    this.input.keyboard?.on("keydown-I", () => this.toggleInventory());
    this.input.keyboard?.on("keydown-ESC", () => this.setInventoryOpen(false));

    // --- the generic playtest contract -----------------------------------
    registerGameState(this, () => this.snapshot());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, clearGameState);

    this.log(`A wild ${this.enemy.name} appears!`);
  }

  // ---- combat model ------------------------------------------------------

  /** Build (or rebuild) the player + enemy combatants from data. */
  private buildCombat(): void {
    const curve = getBalance(this.db, "hero_growth");
    const level = levelForXp(curve, 0) + 2; // start a few levels in so stats are interesting
    const playerStats = deriveStats({
      base: HERO_BASE, level, curve,
      equipment: this.inventory.equippedItems(), buffs: [],
    });
    this.player = makeCombatant(PLAYER_ID, "Hero", "ally", playerStats);

    const enemyDef = getEnemy(this.db, "slime");
    this.enemy = makeCombatant(ENEMY_ID, enemyDef.name, "enemy", enemyDef.stats, enemyDef.resistances ?? {});

    this.combat = new Combat([this.player, this.enemy]);
    this.combat.events.on("end", ({ winner }) => this.onBattleEnd(winner));
  }

  /** Re-derive the player's stats after an equip/unequip and clamp pools. */
  private rederivePlayer(): void {
    const curve = getBalance(this.db, "hero_growth");
    const level = levelForXp(curve, 0) + 2;
    const next = deriveStats({
      base: HERO_BASE, level, curve,
      equipment: this.inventory.equippedItems(), buffs: this.player.buffs,
    });
    const c = this.player as Combatant & { _baseStats?: StatBlock };
    delete c._baseStats; // stats change → drop the combat buff stash baseline
    this.player.stats = next;
    this.player.hp = Math.min(this.player.hp, next.hp);
    this.player.mp = Math.min(this.player.mp, next.mp);
    this.refreshBars();
  }

  // ---- actions -----------------------------------------------------------

  private onAction(label: string): void {
    if (this.win || this.lose) return;
    if (this.inventoryOpen) return; // menu inert while the bag is open
    if (this.combat.active()?.id !== PLAYER_ID) return; // only on the player's turn

    switch (label) {
      case "Attack": this.playerSkill(BASIC_ATTACK); break;
      case "Fireball": this.playerSkill(this.db.skills.fireball); break;
      case "Guard": this.playerSkill(this.db.skills.guard_up); break;
      case "Potion": this.usePotion(); break;
      default: break;
    }
  }

  /** Player casts a skill at the enemy (or self for buffs), then the enemy acts. */
  private playerSkill(skill: Skill): void {
    if (this.player.mp < skill.cost) { this.log(`Not enough MP for ${skill.name}.`); return; }
    const targetId = skill.targeting === "self" ? PLAYER_ID : ENEMY_ID;
    const res = this.combat.useSkill(PLAYER_ID, targetId, skill);
    if (skill.power > 0) {
      DamageNumber.pop(this, this.enemySprite.x, this.enemySprite.y - 40, res.amount, { crit: res.crit });
      this.log(`Hero uses ${skill.name} — ${res.amount} dmg${res.crit ? " (CRIT!)" : ""}.`);
    } else {
      this.log(`Hero uses ${skill.name}.`);
    }
    this.refreshBars();
    if (this.combat.isOver()) return;
    this.time.delayedCall(450, () => this.enemyTurn());
  }

  /** Use a Potion from the bag on the player. */
  private usePotion(): void {
    if (this.inventory.countOf("potion") <= 0) { this.log("No potions left."); return; }
    const effect = this.db.items.potion.useEffect;
    this.inventory.remove("potion", 1);
    const heal = effect?.hp ?? 0;
    this.combat.applyHeal(PLAYER_ID, heal);
    DamageNumber.pop(this, this.playerSprite.x, this.playerSprite.y - 40, heal, { heal: true });
    this.log(`Hero drinks a Potion (+${heal} HP).`);
    this.refreshBars();
    this.combat.advanceTurn();
    this.time.delayedCall(450, () => this.enemyTurn());
  }

  /** Enemy AI: basic attack (slime has no offensive skills). */
  private enemyTurn(): void {
    if (this.combat.isOver()) return;
    this.combat.advanceTurn(); // hand the turn to the enemy
    if (this.combat.active()?.id !== ENEMY_ID) { this.refreshBars(); return; }
    const res = this.combat.basicAttack(ENEMY_ID, PLAYER_ID);
    DamageNumber.pop(this, this.playerSprite.x, this.playerSprite.y - 40, res.amount, { crit: res.crit });
    this.log(`${this.enemy.name} attacks — ${res.amount} dmg.`);
    this.refreshBars();
    if (!this.combat.isOver()) this.combat.advanceTurn(); // back to the player
  }

  // ---- inventory panel ---------------------------------------------------

  private toggleInventory(): void { this.setInventoryOpen(!this.inventoryOpen); }

  private setInventoryOpen(open: boolean): void {
    this.inventoryOpen = open;
    this.inventoryGrid.setVisible(open);
    this.equipPanel.setVisible(open);
    if (!open) this.tooltip.hide();
    if (open) this.refreshInventoryPanels();
  }

  private wireInventoryPanels(): void {
    this.inventoryGrid.on(INVENTORY_GRID_EVENTS.hover, (cell: InventoryCell) => {
      const it = cell.item;
      const stats = it.stats
        ? Object.entries(it.stats).map(([k, v]) => `${k.toUpperCase()} ${(v as number) >= 0 ? "+" : ""}${v}`).join("  ")
        : "";
      this.tooltip.show(it.name, [it.description, stats].filter(Boolean).join("\n"),
        this.inventoryGrid.x - 250, this.inventoryGrid.y);
    });
    this.inventoryGrid.on(INVENTORY_GRID_EVENTS.select, (cell: InventoryCell) => {
      if (cell.item.kind === "equipment") {
        this.inventory.equip(cell.item.id);
        this.log(`Equipped ${cell.item.name}.`);
        this.rederivePlayer();
        this.refreshInventoryPanels();
      }
    });
    this.equipPanel.on(EQUIPMENT_PANEL_EVENTS.slotSelect, (slot: typeof EQUIPMENT_SLOTS[number]) => {
      if (this.inventory.equippedIn(slot)) {
        this.inventory.unequip(slot);
        this.log(`Unequipped ${slot}.`);
        this.rederivePlayer();
        this.refreshInventoryPanels();
      }
    });
  }

  private refreshInventoryPanels(): void {
    const snap = this.inventory.snapshot();
    const cells: InventoryCell[] = snap.bag.map((stack) => ({ stack, item: this.db.items[stack.itemId] }));
    this.inventoryGrid.setCells(cells);
    const view = {} as EquipmentSlotView;
    for (const slot of EQUIPMENT_SLOTS) {
      const id = snap.equipped[slot];
      view[slot] = id ? this.db.items[id] : null;
    }
    this.equipPanel.setSlots(view);
  }

  // ---- presentation helpers ----------------------------------------------

  private layoutPanels(): void {
    const gw = this.inventoryGrid.size.width;
    this.inventoryGrid.setPosition((1280 - gw) / 2 - 130, 140);
    this.equipPanel.setPosition(this.inventoryGrid.x + gw + 20, 140);
  }

  private refreshBars(tweenMs = 200): void {
    this.playerBars.set(this.player.hp, this.player.stats.hp, this.player.mp, this.player.stats.mp, tweenMs);
    this.enemyBars.set(this.enemy.hp, this.enemy.stats.hp, 0, 0, tweenMs);
  }

  private log(msg: string): void {
    this.lastLog = msg;
    this.logText.setText(msg);
  }

  private onBattleEnd(winner: "ally" | "enemy"): void {
    if (winner === "ally") {
      this.win = true;
      this.score += getEnemy(this.db, "slime").xp;
      this.log(`Victory! +${getEnemy(this.db, "slime").xp} XP. Press R to restart.`);
    } else {
      this.lose = true;
      this.log("Defeat… Press R to restart.");
    }
    this.input.keyboard?.once("keydown-R", () => this.scene.restart());
  }

  // ---- the generic playtest contract snapshot ----------------------------

  /**
   * The rich, genre-aware snapshot the /drive harness samples. Fields are chosen
   * so each RPG feature has an assertable delta (see the plan's smoke-tests):
   *   player {x,y} · hp · mp · score · scene{key,win,lose}
   *   menu  {inventoryOpen, actionIndex, actionLabel}
   *   custom{enemyHp, enemyMaxHp, playerMaxHp, playerMaxMp, equippedAtk, gold,
   *          turn, round, bagCount, log}
   */
  private snapshot(): GameStateSnapshot {
    const inv = this.inventory.snapshot();
    const bagCount = inv.bag.reduce((n, s) => n + s.qty, 0);
    return {
      t: this.time.now,
      player: { x: this.playerSprite?.x ?? 0, y: this.playerSprite?.y ?? 0, vx: 0, vy: 0 },
      hp: this.player?.hp ?? 0,
      mp: this.player?.mp ?? 0,
      score: this.score,
      scene: { key: this.scene.key, win: this.win, lose: this.lose },
      menu: {
        inventoryOpen: this.inventoryOpen,
        actionIndex: this.actionMenu?.index ?? 0,
        actionLabel: this.actionMenu?.selected ?? "",
      },
      custom: {
        enemyHp: this.enemy?.hp ?? 0,
        enemyMaxHp: this.enemy?.stats.hp ?? 0,
        playerMaxHp: this.player?.stats.hp ?? 0,
        playerMaxMp: this.player?.stats.mp ?? 0,
        equippedAtk: inv.equippedAtk,
        gold: inv.gold,
        bagCount,
        turn: this.combat?.active()?.id ?? "",
        round: this.combat?.currentRound() ?? 0,
        log: this.lastLog,
      },
    };
  }

  // ---- texture helper ----------------------------------------------------

  /** Draw a flat rounded-rect texture so the demo needs no PNG assets. */
  private makeRectTexture(key: string, color: number, w: number, h: number): void {
    if (this.textures.exists(key)) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(color, 1).fillRoundedRect(0, 0, w, h, 10);
    g.lineStyle(3, 0x000000, 0.4).strokeRoundedRect(0, 0, w, h, 10);
    g.generateTexture(key, w, h);
    g.destroy();
  }
}
