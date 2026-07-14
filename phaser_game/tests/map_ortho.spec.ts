/**
 * map_ortho.spec.ts — regression guard for the ORTHOGONAL Map Studio path.
 *
 * The iso work (projection: isometric) rewired shared code — the Tiled JSON
 * emitter, placeholder painter, camera bounds and the avatar branch in
 * TilemapScene. This pins the original meadow behaviour: square placeholders,
 * arcade-physics avatar, movement on both axes.
 */
import { test, expect, type Page } from "@playwright/test";

interface OrthoGameState {
  player: { x: number; y: number; vx: number; vy: number };
  custom: { mapId: string; placeholderBiomes: string[]; projection: string };
}

const readState = (page: Page): Promise<OrthoGameState> =>
  page.evaluate(() => (window as unknown as { __gameState: () => OrthoGameState }).__gameState());

test("orthogonal meadow boots and the avatar still moves", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/?level=meadow");
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(
    () => typeof (window as unknown as { __gameState?: unknown }).__gameState === "function",
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(400);

  const s0 = await readState(page);
  expect(s0.custom.mapId).toBe("meadow");
  expect(s0.custom.projection).toBe("orthogonal");
  expect(s0.custom.placeholderBiomes.sort()).toEqual(["forest", "grass", "sand", "water"]);

  await page.keyboard.down("d");
  await page.waitForTimeout(500);
  await page.keyboard.up("d");
  const s1 = await readState(page);
  expect(s1.player.x - s0.player.x).toBeGreaterThan(50);

  await page.keyboard.down("s");
  await page.waitForTimeout(400);
  await page.keyboard.up("s");
  const s2 = await readState(page);
  expect(s2.player.y - s1.player.y).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});
