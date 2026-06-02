import { test, expect } from "@playwright/test";

test("game boots and renders Phaser canvas", async ({ page }) => {
  await page.goto("/?level=level_01");
  await page.waitForSelector("canvas", { timeout: 5000 });
  await page.waitForTimeout(800);
  const hasGame = await page.evaluate(() => typeof window.game !== "undefined");
  expect(hasGame).toBeTruthy();
  // Capture a baseline screenshot
  await page.screenshot({ path: "test-results/smoke-boot.png" });
});

test("level_01 has the expected named objects", async ({ page }) => {
  await page.goto("/?level=level_01");
  await page.waitForSelector("canvas");
  await page.waitForTimeout(800);
  const dump = await page.evaluate(() => {
    const game = (window as unknown as { game: Phaser.Game }).game;
    const scene = game.scene.scenes.find((s) => s.scene.isActive());
    if (!scene) return { names: [] as string[], enemyCount: 0 };
    const collected: string[] = [];
    let enemyCount = 0;
    const stack = scene.children.list.slice();
    while (stack.length) {
      const o = stack.pop() as Phaser.GameObjects.GameObject & {
        name?: string;
        list?: unknown[];
        getData?: (k: string) => unknown;
      };
      if (o.name) collected.push(o.name);
      const spec = o.getData?.("spec") as { destroyOnHit?: boolean; kind?: string } | undefined;
      if (spec && (spec.destroyOnHit || spec.kind === "enemy")) enemyCount++;
      if (Array.isArray(o.list)) stack.push(...(o.list as Phaser.GameObjects.GameObject[]));
    }
    return { names: collected.sort(), enemyCount };
  });
  // Slingshot + base + at least one cat + at least one destroyable enemy must be present.
  // Enemies are matched by their game-object spec (destroyOnHit / kind === "enemy"),
  // NOT by name: level enemy names are role-based and change across redesigns
  // (e.g. Mouse* -> ScoutMouse -> Scout/GlassMouse/King). The spec is the stable contract.
  expect(dump.names).toContain("Slingshot");
  expect(dump.names).toContain("SlingshotBase");
  expect(dump.names.some((n) => n.startsWith("Cat"))).toBe(true);
  expect(dump.enemyCount).toBeGreaterThanOrEqual(1);
});

test("HUD shows shot counter and score", async ({ page }) => {
  await page.goto("/?level=level_01");
  await page.waitForSelector("canvas");
  await page.waitForTimeout(800);
  // Read game state from window.game
  const state = await page.evaluate(() => {
    const game = (window as unknown as { game: Phaser.Game }).game;
    const scene = game.scene.scenes.find((s) => s.scene.isActive()) as unknown as {
      score?: number;
      shotsRemaining?: number;
      enemiesAlive?: number;
    };
    return {
      score: scene?.score,
      shots: scene?.shotsRemaining,
      enemies: scene?.enemiesAlive,
    };
  });
  expect(state.score).toBe(0);
  expect(state.shots).toBeGreaterThan(0);
  expect(state.enemies).toBeGreaterThan(0);
});
