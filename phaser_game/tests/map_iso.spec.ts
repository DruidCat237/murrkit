/**
 * map_iso.spec.ts — smoke for the TRUE-ISOMETRIC Map Studio path.
 *
 * Uses maps/iso_meadow.map.yaml (the meadow twin with `projection: isometric`):
 *   - boots on placeholders (diamond sheets drawn on canvas textures),
 *   - avatar moves along SCREEN axes (D → +x with ~flat y; S → +y),
 *   - the lake blocks screen-down movement via the manual iso collision path
 *     (arcade tile collision is orthogonal-only, so this exercises the
 *     TilemapScene.walkableAt sampling, not physics).
 *
 * The spawn (26.5, 20) sits NW of the lake rect [30, 22, 12, 9]; holding S
 * descends through tiles (27,20)→(27,21)→(28,21)→(28,22)→(29,22)→(29,23) and
 * must stop before entering water at (30,23)/(30,24).
 */
import { test, expect, type Page } from "@playwright/test";

interface IsoGameState {
  t: number;
  player: { x: number; y: number; vx: number; vy: number };
  scene: { key: string; win: boolean; lose: boolean };
  custom: {
    mapId: string;
    placeholderBiomes: string[];
    projection: string;
    playerTile: { x: number; y: number } | null;
  };
}

const readState = (page: Page): Promise<IsoGameState> =>
  page.evaluate(() => (window as unknown as { __gameState: () => IsoGameState }).__gameState());

const boot = async (page: Page): Promise<void> => {
  await page.goto("/?level=iso_meadow");
  // Generous timeouts: the FIRST test of a run pays vite's cold-start dep
  // optimization (phaser is a big chunk), which can eat well over 8s.
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(
    () => typeof (window as unknown as { __gameState?: unknown }).__gameState === "function",
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(400); // let the first frames settle
};

// Water cells of iso_meadow: lake rect [30,22,12,9] + west bay [28,24,2,5].
const isWater = (x: number, y: number): boolean =>
  (x >= 30 && x < 42 && y >= 22 && y < 31) || (x >= 28 && x < 30 && y >= 24 && y < 29);

test("iso map boots on diamond placeholders", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await boot(page);
  const s = await readState(page);
  expect(s.custom.mapId).toBe("iso_meadow");
  expect(s.custom.projection).toBe("isometric");
  // No biome declares an `image:` → all four render as placeholders.
  expect(s.custom.placeholderBiomes.sort()).toEqual(["forest", "grass", "sand", "water"]);
  expect(s.custom.playerTile).not.toBeNull();
  await expect(page.locator("#status-bar")).toContainText("iso 2:1");
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/iso-meadow.png" }); // visual reference
});

test("avatar moves along screen axes in iso", async ({ page }) => {
  await boot(page);
  const s0 = await readState(page);
  await page.keyboard.down("d");
  await page.waitForTimeout(600);
  await page.keyboard.up("d");
  const s1 = await readState(page);
  // Screen-right: x grows a real distance, y stays flat (manual mover keeps
  // axes independent — any drift means the projection leaked into input).
  expect(s1.player.x - s0.player.x).toBeGreaterThan(60);
  expect(Math.abs(s1.player.y - s0.player.y)).toBeLessThan(3);

  await page.keyboard.down("s");
  await page.waitForTimeout(400);
  await page.keyboard.up("s");
  const s2 = await readState(page);
  expect(s2.player.y - s1.player.y).toBeGreaterThan(40);
});

test("lake blocks screen-down movement (manual iso collision)", async ({ page }) => {
  await boot(page);
  const start = await readState(page);
  expect(start.custom.playerTile).not.toBeNull();

  await page.keyboard.down("s");
  let last = start.player.y;
  let plateau = 0;
  for (let i = 0; i < 12 && plateau < 3; i++) {
    await page.waitForTimeout(250);
    const y = (await readState(page)).player.y;
    plateau = y - last < 0.5 ? plateau + 1 : 0;
    last = y;
  }
  const end = await readState(page);
  await page.keyboard.up("s");

  // Moved at all, then stopped while the key was still held…
  expect(end.player.y).toBeGreaterThan(start.player.y + 30);
  expect(plateau).toBeGreaterThanOrEqual(3);

  // …on a walkable tile with water on the screen-down side.
  const t = end.custom.playerTile!;
  expect(isWater(t.x, t.y)).toBe(false);
  const blockedByWater =
    isWater(t.x + 1, t.y) || isWater(t.x, t.y + 1) || isWater(t.x + 1, t.y + 1);
  expect(blockedByWater).toBe(true);
});
